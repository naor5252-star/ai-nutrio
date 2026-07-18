import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { apiRequest, ClientApiError } from "../../app/api";
import type { AnalysisResult } from "../../app/types";

type EditableItem = {
  id: string;
  nameHe: string;
  grams: string;
  calories: string;
  protein: string;
  carbs: string;
  fat: string;
  confidence: "high" | "medium" | "low";
};

type JobResponse = {
  job: {
    id: string;
    status: string;
    error_message_he: string | null;
    updated_at: string;
  };
  result: AnalysisResult | null;
};

export function AnalysisReviewPage(): React.JSX.Element {
  const { jobId } = useParams<{ jobId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [items, setItems] = useState<EditableItem[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ["analysis", jobId],
    queryFn: () => apiRequest<JobResponse>(`/api/v1/analysis/jobs/${jobId ?? ""}`),
    enabled: Boolean(jobId),
    refetchInterval: (state) => {
      const data = state.state.data;
      return data && ["completed", "needs_user_input", "failed"].includes(data.job.status)
        ? false
        : 2_000;
    },
  });

  useEffect(() => {
    if (!query.data?.result || items.length > 0) return;
    setItems(
      query.data.result.detectedItems.map((item) => ({
        id: item.temporaryId,
        nameHe: item.candidateNameHe,
        grams: item.estimatedGrams?.toString() ?? "",
        calories:
          item.plausibleCaloriesMin !== null && item.plausibleCaloriesMax !== null
            ? Math.round((item.plausibleCaloriesMin + item.plausibleCaloriesMax) / 2).toString()
            : "",
        protein: "",
        carbs: "",
        fat: "",
        confidence: [
          item.foodIdentityConfidence,
          item.quantityConfidence,
          item.nutritionConfidence,
        ].includes("low")
          ? "low"
          : item.foodIdentityConfidence,
      })),
    );
  }, [items.length, query.data?.result]);

  const canSave = useMemo(
    () =>
      items.length > 0 &&
      items.every(
        (item) => item.nameHe.trim() && numericOrBlank(item.grams) && numericOrBlank(item.calories),
      ),
    [items],
  );
  const save = useMutation({
    mutationFn: () =>
      apiRequest<{ mealId: string }>(`/api/v1/analysis/jobs/${jobId ?? ""}/confirm`, {
        method: "POST",
        body: JSON.stringify({
          clientMutationId: crypto.randomUUID(),
          occurredAt: new Date().toISOString(),
          category: suggestedCategory(),
          customCategoryName: null,
          title: items
            .map((item) => item.nameHe)
            .slice(0, 3)
            .join(", "),
          notes: null,
          items: items.map((item) => ({
            nameHe: item.nameHe,
            quantity: item.grams ? Number(item.grams) : 1,
            unit: item.grams ? "גרם" : "יחידה",
            grams: item.grams ? Number(item.grams) : null,
            calories: item.calories ? Number(item.calories) : null,
            proteinGrams: item.protein ? Number(item.protein) : null,
            carbohydrateGrams: item.carbs ? Number(item.carbs) : null,
            fatGrams: item.fat ? Number(item.fat) : null,
            fiberGrams: null,
            sourceType: "ai_estimate",
          })),
        }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["meals"] });
      void navigate("/diary");
    },
    onError: (error) =>
      setMessage(error instanceof ClientApiError ? error.messageHe : "לא הצלחנו לשמור את הארוחה"),
  });

  if (query.isLoading || !query.data) {
    return (
      <div className="page analysis-wait">
        <div className="analysis-pulse">
          <span />
          <span />
          <span />
        </div>
        <h1>בודקים את הארוחה</h1>
        <p>אפשר לעבור למסך אחר. התוצאה תישמר ביומן כממתינה.</p>
      </div>
    );
  }
  const status = query.data.job.status;
  if (["queued", "uploading", "processing"].includes(status)) {
    return (
      <div className="page analysis-wait">
        <div className="analysis-pulse">
          <span />
          <span />
          <span />
        </div>
        <p className="eyebrow">הניתוח מתבצע</p>
        <h1>מפרידים את הארוחה לרכיבים</h1>
        <p>אנחנו בודקים זהות וכמות בנפרד, כדי שיהיה קל לתקן.</p>
        <small>
          עודכן{" "}
          {new Intl.DateTimeFormat("he-IL", { hour: "2-digit", minute: "2-digit" }).format(
            new Date(query.data.job.updated_at),
          )}
        </small>
      </div>
    );
  }
  if (status === "failed") {
    return (
      <div className="page error-page">
        <h1>לא הצלחנו לזהות את הארוחה</h1>
        <p>{query.data.job.error_message_he ?? "התמונות נשמרו זמנית ואפשר לנסות שוב."}</p>
        <button
          onClick={() => {
            void apiRequest(`/api/v1/analysis/jobs/${jobId ?? ""}/retry`, { method: "POST" })
              .then(() => {
                void query.refetch();
              })
              .catch(() => {
                setMessage("לא הצלחנו להתחיל ניסיון נוסף");
              });
          }}
        >
          נסה שוב
        </button>
        <button
          className="text-action"
          onClick={() => {
            void navigate("/add");
          }}
        >
          הוספה ידנית
        </button>
      </div>
    );
  }

  return (
    <div className="page analysis-review-page">
      <section className="page-title">
        <p className="eyebrow">הניתוח מוכן</p>
        <h1>בדוק את הזיהוי</h1>
        <p>כל רכיב מסומן כהערכה עד שתאשר או תתקן אותו.</p>
      </section>
      {query.data.result?.needsAnotherImage && (
        <div className="uncertainty-banner">
          <strong>תמונה נוספת יכולה לעזור</strong>
          <p>
            {query.data.result.anotherImageReasonHe ?? "הזווית הנוכחית אינה מספיקה לזיהוי בטוח."}
          </p>
        </div>
      )}
      <div className="component-confirmation">
        {items.map((item, index) => (
          <article className="food-component" key={item.id}>
            <header>
              <span className={`confidence-mark confidence-mark--${item.confidence}`}>
                {confidenceName(item.confidence)}
              </span>
              <button
                aria-label="הסרת רכיב"
                onClick={() =>
                  setItems((current) => current.filter((candidate) => candidate.id !== item.id))
                }
              >
                ×
              </button>
            </header>
            <label>
              <span>מה זה?</span>
              <input
                value={item.nameHe}
                onChange={(event) => update(index, "nameHe", event.target.value)}
              />
            </label>
            <div className="quantity-pair">
              <label>
                <span>כמות בגרמים</span>
                <input
                  inputMode="decimal"
                  value={item.grams}
                  onChange={(event) => update(index, "grams", event.target.value)}
                  placeholder="לא ידוע"
                />
              </label>
              <label>
                <span>קלוריות משוערות</span>
                <input
                  inputMode="decimal"
                  value={item.calories}
                  onChange={(event) => update(index, "calories", event.target.value)}
                  placeholder="לא ידוע"
                />
              </label>
            </div>
            <details>
              <summary>ערכים נוספים</summary>
              <div className="macro-inputs">
                <label>
                  חלבון
                  <input
                    inputMode="decimal"
                    value={item.protein}
                    onChange={(event) => update(index, "protein", event.target.value)}
                  />
                </label>
                <label>
                  פחמימות
                  <input
                    inputMode="decimal"
                    value={item.carbs}
                    onChange={(event) => update(index, "carbs", event.target.value)}
                  />
                </label>
                <label>
                  שומן
                  <input
                    inputMode="decimal"
                    value={item.fat}
                    onChange={(event) => update(index, "fat", event.target.value)}
                  />
                </label>
              </div>
            </details>
          </article>
        ))}
        <button
          className="add-component"
          onClick={() =>
            setItems((current) => [
              ...current,
              {
                id: crypto.randomUUID(),
                nameHe: "",
                grams: "",
                calories: "",
                protein: "",
                carbs: "",
                fat: "",
                confidence: "low",
              },
            ])
          }
        >
          + הוספת רכיב
        </button>
      </div>
      {items.some((item) => item.confidence === "low") && (
        <p className="confirmation-required">נדרש אישור: לפחות רכיב אחד זוהה בביטחון נמוך.</p>
      )}
      {message && (
        <p className="status-message" role="alert">
          {message}
        </p>
      )}
      <button
        className="sticky-primary"
        disabled={!canSave || save.isPending}
        onClick={() => save.mutate()}
      >
        {save.isPending ? "שומרים…" : "אישור ושמירת הארוחה"}
      </button>
    </div>
  );

  function update(index: number, key: keyof EditableItem, value: string): void {
    setItems((current) =>
      current.map((item, itemIndex) => (itemIndex === index ? { ...item, [key]: value } : item)),
    );
  }
}

function numericOrBlank(value: string): boolean {
  return value === "" || (Number.isFinite(Number(value)) && Number(value) >= 0);
}
function confidenceName(value: "high" | "medium" | "low"): string {
  return value === "high" ? "זיהוי ברור" : value === "medium" ? "כדאי לבדוק" : "נדרש אישור";
}
function suggestedCategory(): "breakfast" | "lunch" | "dinner" | "snack" {
  const hour = new Date().getHours();
  if (hour < 11) return "breakfast";
  if (hour < 16) return "lunch";
  if (hour < 21) return "dinner";
  return "snack";
}
