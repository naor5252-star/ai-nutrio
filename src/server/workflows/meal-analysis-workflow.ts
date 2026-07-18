import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import {
  analysisWorkflowParamsSchema,
  type AnalysisWorkflowParams,
  type MealAnalysisResult,
} from "../../shared/schemas/meal-analysis";
import type { RuntimeEnv } from "../context";
import { analyzeMealImages, type ImageInput } from "../ai/model-router";
import { nowIso } from "../repositories/db";
import { secureUuid } from "../security/crypto";
import { logEvent } from "../services/logger";

type ImageReference = { key: string; contentType: string; sizeBytes: number };

export class MealAnalysisWorkflow extends WorkflowEntrypoint<RuntimeEnv, AnalysisWorkflowParams> {
  override async run(
    event: WorkflowEvent<AnalysisWorkflowParams>,
    step: WorkflowStep,
  ): Promise<{ status: string }> {
    const params = analysisWorkflowParamsSchema.parse(event.payload);
    const startedAt = Date.now();
    try {
      await step.do(
        "validate ownership and start",
        { retries: { limit: 2, delay: "2 seconds", backoff: "linear" } },
        async () => {
          const job = await this.env.DB.prepare(
            "SELECT owner_user_id, status FROM analysis_jobs WHERE id = ?",
          )
            .bind(params.jobId)
            .first<{ owner_user_id: string; status: string }>();
          if (!job || job.owner_user_id !== params.userId)
            throw new Error("Analysis job ownership validation failed");
          if (["cancelled", "expired"].includes(job.status))
            throw new Error("Analysis job cannot be processed");
          await this.env.DB.prepare(
            "UPDATE analysis_jobs SET status = 'processing', updated_at = ? WHERE id = ? AND owner_user_id = ?",
          )
            .bind(nowIso(), params.jobId, params.userId)
            .run();
          return { ok: true };
        },
      );

      const references = await step.do("validate R2 references", async () => {
        const rows = await this.env.DB.prepare(
          `SELECT mo.r2_object_key AS key, mo.content_type AS contentType, mo.size_bytes AS sizeBytes
             FROM analysis_job_images aji
             JOIN media_objects mo ON mo.id = aji.media_object_id
            WHERE aji.analysis_job_id = ? AND mo.owner_user_id = ? AND mo.deleted_at IS NULL AND mo.logical_expires_at > ?
            ORDER BY aji.image_order`,
        )
          .bind(params.jobId, params.userId, nowIso())
          .all<ImageReference>();
        if (rows.results.length === 0) throw new Error("No valid images found");
        for (const reference of rows.results) {
          if (reference.sizeBytes > 5 * 1024 * 1024) throw new Error("Image exceeds maximum size");
          const head = await this.env.MEDIA.head(reference.key);
          if (!head) throw new Error("R2 image missing");
        }
        return rows.results;
      });

      const route = await step.do(
        "analyze images and validate output",
        { retries: { limit: 2, delay: "5 seconds", backoff: "exponential" }, timeout: "3 minutes" },
        async () => {
          const images: ImageInput[] = [];
          for (const reference of references) {
            const object = await this.env.MEDIA.get(reference.key);
            if (!object) throw new Error("R2 image disappeared during analysis");
            images.push({ contentType: reference.contentType, bytes: await object.arrayBuffer() });
          }
          return analyzeMealImages(this.env, images);
        },
      );

      await step.do(
        "persist validated result",
        { retries: { limit: 3, delay: "2 seconds", backoff: "linear" } },
        async () => {
          const now = nowIso();
          const statements: D1PreparedStatement[] = [
            this.env.DB.prepare("DELETE FROM analysis_candidates WHERE analysis_job_id = ?").bind(
              params.jobId,
            ),
            this.env.DB.prepare(
              "DELETE FROM analysis_clarifications WHERE analysis_job_id = ?",
            ).bind(params.jobId),
            this.env.DB.prepare(
              `INSERT INTO analysis_results (analysis_job_id, result_json, source_model, model_route, validated, created_at)
             VALUES (?, ?, ?, ?, 1, ?)
             ON CONFLICT(analysis_job_id) DO UPDATE SET result_json = excluded.result_json, source_model = excluded.source_model,
               model_route = excluded.model_route, validated = 1, created_at = excluded.created_at`,
            ).bind(params.jobId, JSON.stringify(route.result), route.model, route.route, now),
          ];
          route.result.detectedItems.forEach((item, index) => {
            statements.push(
              this.env.DB.prepare(
                `INSERT INTO analysis_candidates (
                id, analysis_job_id, temporary_id, candidate_name_he, candidate_name_en, alternatives_json,
                estimated_quantity, estimated_unit, estimated_grams, identity_confidence, quantity_confidence,
                nutrition_confidence, plausible_calories_min, plausible_calories_max, notes_json, sort_order
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              ).bind(
                secureUuid(),
                params.jobId,
                item.temporaryId,
                item.candidateNameHe,
                item.candidateNameEn ?? null,
                JSON.stringify(item.alternativeCandidates ?? []),
                item.estimatedQuantity,
                item.estimatedUnit,
                item.estimatedGrams,
                item.foodIdentityConfidence,
                item.quantityConfidence,
                item.nutritionConfidence,
                item.plausibleCaloriesMin,
                item.plausibleCaloriesMax,
                JSON.stringify(item.notes ?? []),
                index,
              ),
            );
          });
          for (const question of route.result.clarificationQuestions ?? []) {
            statements.push(
              this.env.DB.prepare(
                "INSERT INTO analysis_clarifications (id, analysis_job_id, question_he, answer_options_json, created_at) VALUES (?, ?, ?, ?, ?)",
              ).bind(
                secureUuid(),
                params.jobId,
                question.questionHe,
                JSON.stringify(question.answerOptions ?? []),
                now,
              ),
            );
          }
          await this.env.DB.batch(statements);
          return { itemCount: route.result.detectedItems.length };
        },
      );

      const status = requiresUserInput(route.result) ? "needs_user_input" : "completed";
      await step.do("complete job", async () => {
        const now = nowIso();
        await this.env.DB.prepare(
          "UPDATE analysis_jobs SET status = ?, overall_confidence = ?, analysis_version = ?, updated_at = ?, completed_at = ? WHERE id = ? AND owner_user_id = ?",
        )
          .bind(
            status,
            route.result.overallConfidence,
            route.result.analysisVersion,
            now,
            now,
            params.jobId,
            params.userId,
          )
          .run();
        return { status };
      });

      logEvent({
        severity: "info",
        event: "meal_analysis_completed",
        correlationId: event.instanceId,
        userId: params.userId,
        jobId: params.jobId,
        durationMs: Date.now() - startedAt,
        outcome: status,
      });
      return { status };
    } catch (error) {
      await this.env.DB.prepare(
        "UPDATE analysis_jobs SET status = 'failed', error_code = 'ANALYSIS_FAILED', error_message_he = ?, updated_at = ? WHERE id = ? AND owner_user_id = ?",
      )
        .bind(
          "לא הצלחנו לנתח את התמונה. התמונה נשמרה זמנית ואפשר לנסות שוב.",
          nowIso(),
          params.jobId,
          params.userId,
        )
        .run();
      logEvent({
        severity: "error",
        event: "meal_analysis_failed",
        correlationId: event.instanceId,
        userId: params.userId,
        jobId: params.jobId,
        durationMs: Date.now() - startedAt,
        outcome: error instanceof Error ? error.name : "unknown",
        retryable: true,
        details: {
          errorMessage:
            error instanceof Error ? error.message.slice(0, 500) : "Unknown workflow error",
          fastModel: this.env.AI_FAST_MODEL,
          strongModel: this.env.AI_STRONG_MODEL,
        },
      });
      throw error;
    }
  }
}

function requiresUserInput(result: MealAnalysisResult): boolean {
  return (
    result.overallConfidence === "low" ||
    result.needsAnotherImage ||
    result.detectedItems.some(
      (item) =>
        item.foodIdentityConfidence === "low" ||
        item.quantityConfidence === "low" ||
        item.nutritionConfidence === "low",
    )
  );
}
