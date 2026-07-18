import { app } from "./server/app";
import { MealAnalysisWorkflow } from "./server/workflows/meal-analysis-workflow";
import { prepareDueSummaries, runCleanup } from "./server/scheduled/cleanup";

export { MealAnalysisWorkflow };

export default {
  fetch: app.fetch,
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    context: ExecutionContext,
  ): Promise<void> {
    const correlationId = crypto.randomUUID();
    context.waitUntil(
      Promise.all([runCleanup(env, correlationId), prepareDueSummaries(env, correlationId)]).then(
        () => undefined,
      ),
    );
  },
} satisfies ExportedHandler<Env>;
