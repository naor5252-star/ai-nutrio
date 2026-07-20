import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { apiRequest, ClientApiError } from "../../app/api";
import type { AnalysisResult } from "../../app/types";

type MealSourceType = "label" | "database" | "manual" | "ai_estimate";

type ProductSummary = {
  id: string;
  canonical_name_he: string;
  brand: string | null;
  barcode: string | null;
  energy_kcal: number | null;
  protein: number | null;
  carbohydrate: number | null;
  fat: number | null;
  fiber: number | null;
  base_quantity: number;
  base_unit: "g" | "ml";
  source_type: MealSourceType;
};

type ExternalProductCandidate = {
  externalId: string;
  barcode: string | null;
  nameHe: string;
  nameOriginal: string | null;
  brand: string | null;
  baseQuantity: number;
  baseUnit: "g" | "ml";
  servingDescriptionHe: string | null;
  servingWeight: number | null;
  nutrients: {
    energyKcal: number | null;
    protein: number | null;
    carbohydrate: number | null;
    fat: number | null;
    fiber: number | null;
  };
  providerName: "open_food_facts_israel" | "open_food_facts_world";
  sourceLabelHe: string;
  sourceRegion: "israel" | "international";
  imageUrl: string | null;
  countries: string[];
};

type ProductBasis = {
  energy_kcal: number | null;
  protein: number | null;
  carbohydrate: number | null;
  fat: number | null;
  fiber: number | null;
  base_quantity: number;
  base_unit: "g" | "ml";
};

type EditableItem = {
  id: string;
  nameHe: string;
  amount: string;
  baseUnit: "g" | "ml";
  calories: string;
  protein: string;
  carbs: string;
  fat: string;
  fiber: string;
  confidence: "high" | "medium" | "low";
  foodId: string | null;
  sourceType: MealSourceType;
  productBasis: ProductBasis | null;
};

type JobResponse = {
  job: {
    id: string;
    status: string;
    error_message_he: string | null;
    updated_at: string;
  };
  result: AnalysisResult | null;
  model: string | null;
  modelRoute: string | null;
};

export function AnalysisReviewPage(): React.JSX.Element {
  const { jobId } = useParams<{ jobId: string }>();
  const [searchParams] = useSearchParams();
  const requestedSource = searchParams.get("source");
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
    const manualEntry = query.data.result.analysisVersion === "manual-entry-v1";
    setItems(
      query.data.result.detectedItems.map((item) => ({
        id: item.temporaryId,
        nameHe: manualEntry ? "" : item.candidateNameHe,
        amount: item.estimatedGrams?.toString() ?? "",
        baseUnit: "g",
        calories:
          item.plausibleCaloriesMin !== null && item.plausibleCaloriesMax !== null
            ? Math.round((item.plausibleCaloriesMin + item.plausibleCaloriesMax) / 2).toString()
            : "",
        protein: "",
        carbs: "",
        fat: "",
        fiber: "",
        confidence: manualEntry
          ? "high"
          : [
                item.foodIdentityConfidence,
                item.quantityConfidence,
                item.nutritionConfidence,
              ].includes("low")
            ? "low"
            : item.foodIdentityConfidence,
        foodId: null,
        sourceType: manualEntry ? "manual" : "ai_estimate",
        productBasis: null,
      })),
    );
  }, [items.length, query.data?.result]);

  const canSave = useMemo(
    () =>
      items.length > 0 &&
      items.every(
        (item) =>
          item.nameHe.trim() && numericOrBlank(item.amount) && numericOrBlank(item.calories),
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
          items: items.map((item) => {
            const amount = item.amount ? Number(item.amount) : 1;
            return {
              foodId: item.foodId,
              nameHe: item.nameHe,
              quantity: amount,
              unit: item.baseUnit === "ml" ? "מ״ל" : "גרם",
              grams: item.baseUnit === "g" && item.amount ? amount : null,
              calories: item.calories ? Number(item.calories) : null,
              proteinGrams: item.protein ? Number(item.protein) : null,
              carbohydrateGrams: item.carbs ? Number(item.carbs) : null,
              fatGrams: item.fat ? Number(item.fat) : null,
              fiberGrams: item.fiber ? Number(item.fiber) : null,
              sourceType: item.sourceType,
            };
          }),
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
  const analysisVersion = query.data.result?.analysisVersion ?? "";
  const isManualEntry = analysisVersion === "manual-entry-v1" || requestedSource === "manual";
  const isTextEntry = analysisVersion.startsWith("meal-text") || requestedSource === "text";
  const textAnalysisFallback =
    analysisVersion === "meal-text-fallback-v2" || query.data.modelRoute === "disabled";
  if (["queued", "uploading", "processing"].includes(status)) {
    return (
      <div className="page analysis-wait">
        <div className="analysis-pulse">
          <span />
          <span />
          <span />
        </div>
        <p className="eyebrow">{isTextEntry ? "הטקסט התקבל" : "הניתוח מתבצע"}</p>
        <h1>{isTextEntry ? "ה־AI מנתח את תיאור הארוחה" : "מפרידים את הארוחה לרכיבים"}</h1>
        <p>
          {isTextEntry
            ? "המסך יתעדכן אוטומטית כשהרכיבים והכמויות יהיו מוכנים לבדיקה."
            : "אנחנו בודקים זהות וכמות בנפרד, כדי שיהיה קל לתקן."}
        </p>
        <small>
          עודכן{" "}
          {new Intl.DateTimeFormat("he-IL", {
            hour: "2-digit",
            minute: "2-digit",
          }).format(new Date(query.data.job.updated_at))}
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
            void apiRequest(`/api/v1/analysis/jobs/${jobId ?? ""}/retry`, {
              method: "POST",
            })
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
        <p className="eyebrow">
          {isManualEntry ? "הזנה ידנית" : isTextEntry ? "ניתוח טקסט מוכן" : "הניתוח מוכן"}
        </p>
        <h1>
          {isManualEntry
            ? "הוסף את רכיבי הארוחה"
            : isTextEntry
              ? "בדוק את הרכיבים מהתיאור"
              : "בדוק את הזיהוי"}
        </h1>
        <p>
          {isManualEntry
            ? "חפש קודם במוצרים שלך. אם אין התאמה, נחפש אוטומטית במאגר הישראלי והבינלאומי. אפשר גם להקליד מוצר חדש."
            : "אפשר לתקן ידנית, או לקשר כל רכיב למוצר ששמרת בעבר."}
        </p>
      </section>
      {isTextEntry && (
        <div
          className={`text-analysis-result${textAnalysisFallback ? " text-analysis-result--fallback" : ""}`}
          role="status"
        >
          <span aria-hidden="true">{textAnalysisFallback ? "!" : "✦"}</span>
          <div>
            <strong>
              {textAnalysisFallback
                ? "הטקסט נשמר, אך ה־AI לא הצליח לפרק אותו במלואו"
                : "הטקסט נותח באמצעות AI"}
            </strong>
            <p>
              {textAnalysisFallback
                ? "השארנו את התיאור כרכיב שניתן לערוך. אפשר לפצל אותו לרכיבים ולהשלים כמויות ידנית."
                : `נמצאו ${items.length} רכיבים. בדוק את הכמויות והערכים לפני השמירה.`}
            </p>
            {!textAnalysisFallback && query.data.model && <small>הניתוח הושלם במודל AI.</small>}
          </div>
        </div>
      )}
      {!isManualEntry && !isTextEntry && query.data.result?.needsAnotherImage && (
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
                type="button"
                aria-label="הסרת רכיב"
                onClick={() =>
                  setItems((current) => current.filter((candidate) => candidate.id !== item.id))
                }
              >
                ×
              </button>
            </header>
            {item.foodId && (
              <div className="selected-product-note">
                <span aria-hidden="true">✓</span>
                מחובר למוצר שמור. הערכים מחושבים לפי הכמות.
                <button
                  type="button"
                  onClick={() =>
                    updateItem(index, {
                      foodId: null,
                      sourceType: "manual",
                      productBasis: null,
                    })
                  }
                >
                  ניתוק
                </button>
              </div>
            )}
            <label>
              <span>מה זה?</span>
              <input
                value={item.nameHe}
                onChange={(event) => updateItem(index, { nameHe: event.target.value })}
              />
            </label>
            <SavedProductPicker
              initialQuery={item.nameHe}
              onChoose={(product) => chooseProduct(index, product)}
              onChooseExternal={(candidate) => chooseExternalProduct(index, candidate)}
            />
            <div className="quantity-pair">
              <label>
                <span>כמות ב{item.baseUnit === "ml" ? "מ״ל" : "גרמים"}</span>
                <input
                  inputMode="decimal"
                  value={item.amount}
                  onChange={(event) => updateAmount(index, event.target.value)}
                  placeholder="לא ידוע"
                />
              </label>
              <label>
                <span>קלוריות</span>
                <input
                  inputMode="decimal"
                  value={item.calories}
                  onChange={(event) => updateItem(index, { calories: event.target.value })}
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
                    onChange={(event) => updateItem(index, { protein: event.target.value })}
                  />
                </label>
                <label>
                  פחמימות
                  <input
                    inputMode="decimal"
                    value={item.carbs}
                    onChange={(event) => updateItem(index, { carbs: event.target.value })}
                  />
                </label>
                <label>
                  שומן
                  <input
                    inputMode="decimal"
                    value={item.fat}
                    onChange={(event) => updateItem(index, { fat: event.target.value })}
                  />
                </label>
                <label>
                  סיבים
                  <input
                    inputMode="decimal"
                    value={item.fiber}
                    onChange={(event) => updateItem(index, { fiber: event.target.value })}
                  />
                </label>
              </div>
            </details>
          </article>
        ))}
        <button
          type="button"
          className="add-component"
          onClick={() =>
            setItems((current) => [
              ...current,
              {
                id: crypto.randomUUID(),
                nameHe: "",
                amount: "",
                baseUnit: "g",
                calories: "",
                protein: "",
                carbs: "",
                fat: "",
                fiber: "",
                confidence: "low",
                foodId: null,
                sourceType: "manual",
                productBasis: null,
              },
            ])
          }
        >
          + הוספת רכיב
        </button>
      </div>
      {!isManualEntry && items.some((item) => item.confidence === "low") && (
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

  function updateItem(index: number, changes: Partial<EditableItem>): void {
    setItems((current) =>
      current.map((item, itemIndex) => (itemIndex === index ? { ...item, ...changes } : item)),
    );
  }

  function updateAmount(index: number, value: string): void {
    setItems((current) =>
      current.map((item, itemIndex) => {
        if (itemIndex !== index) return item;
        const next = { ...item, amount: value };
        if (!item.productBasis) return next;
        return { ...next, ...scaledNutrients(item.productBasis, value) };
      }),
    );
  }

  function chooseProduct(index: number, product: ProductSummary): void {
    setMessage("נבחר מוצר מהמוצרים שלך והערכים חושבו לפי הכמות.");
    setItems((current) =>
      current.map((item, itemIndex) => {
        if (itemIndex !== index) return item;
        const amount =
          item.amount && Number(item.amount) > 0 ? item.amount : String(product.base_quantity);
        return {
          ...item,
          nameHe: product.canonical_name_he,
          amount,
          baseUnit: product.base_unit,
          foodId: product.id,
          sourceType: normalizeProductSource(product.source_type),
          productBasis: product,
          confidence: "high",
          ...scaledNutrients(product, amount),
        };
      }),
    );
  }

  function chooseExternalProduct(index: number, candidate: ExternalProductCandidate): void {
    const basis: ProductBasis = {
      energy_kcal: candidate.nutrients.energyKcal,
      protein: candidate.nutrients.protein,
      carbohydrate: candidate.nutrients.carbohydrate,
      fat: candidate.nutrients.fat,
      fiber: candidate.nutrients.fiber,
      base_quantity: candidate.baseQuantity,
      base_unit: candidate.baseUnit,
    };
    setMessage(
      `נבחר ${candidate.nameHe} מ${candidate.sourceLabelHe}. המוצר נוסף לארוחה ואפשר לערוך את הכמות.`,
    );
    setItems((current) =>
      current.map((item, itemIndex) => {
        if (itemIndex !== index) return item;
        const suggestedAmount = candidate.servingWeight ?? candidate.baseQuantity;
        const amount =
          item.amount && Number(item.amount) > 0 ? item.amount : String(suggestedAmount);
        return {
          ...item,
          nameHe: candidate.nameHe,
          amount,
          baseUnit: candidate.baseUnit,
          foodId: null,
          sourceType: "database",
          productBasis: basis,
          confidence: "medium",
          ...scaledNutrients(basis, amount),
        };
      }),
    );
  }
}

function SavedProductPicker(props: {
  initialQuery: string;
  onChoose: (product: ProductSummary) => void;
  onChooseExternal: (candidate: ExternalProductCandidate) => void;
}): React.JSX.Element {
  const [searchText, setSearchText] = useState(props.initialQuery);
  const normalizedQuery = searchText.trim();

  useEffect(() => {
    setSearchText(props.initialQuery);
  }, [props.initialQuery]);

  const products = useQuery({
    queryKey: ["meal-product-picker", normalizedQuery],
    queryFn: () =>
      apiRequest<{ results: ProductSummary[] }>(
        `/api/v1/products/search?q=${encodeURIComponent(normalizedQuery)}`,
      ),
    enabled: normalizedQuery.length > 1,
  });
  const localResults = products.data?.results ?? [];
  const shouldSearchCatalog =
    normalizedQuery.length > 1 && products.isSuccess && localResults.length === 0;
  const catalog = useQuery({
    queryKey: ["meal-product-catalog", normalizedQuery],
    queryFn: () => {
      if (/^\d{8,14}$/u.test(normalizedQuery)) {
        return apiRequest<{ candidates: ExternalProductCandidate[] }>(
          `/api/v1/products/catalog/barcode/${encodeURIComponent(normalizedQuery)}`,
        );
      }
      return apiRequest<{ candidates: ExternalProductCandidate[] }>(
        `/api/v1/products/catalog/search?q=${encodeURIComponent(normalizedQuery)}`,
      );
    },
    enabled: shouldSearchCatalog,
  });
  const catalogResults = catalog.data?.candidates ?? [];

  return (
    <details className="saved-product-picker">
      <summary>חיפוש מוצר — מהמוצרים שלי או מהמאגר</summary>
      <div className="saved-product-picker__body">
        <input
          value={searchText}
          onChange={(event) => setSearchText(event.target.value)}
          placeholder="חפש שם, מותג או ברקוד"
        />
        {normalizedQuery.length > 1 && products.isLoading && <small>מחפשים במוצרים שלך…</small>}
        {localResults.length > 0 && (
          <section className="saved-product-picker__section">
            <strong>נמצא במוצרים שלך</strong>
            <ul>
              {localResults.slice(0, 8).map((product) => (
                <li key={product.id}>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.preventDefault();
                      props.onChoose(product);
                    }}
                  >
                    <span>
                      <strong>{product.canonical_name_he}</strong>
                      <small>{product.brand ?? product.barcode ?? "מוצר שמור"}</small>
                    </span>
                    <span>
                      {formatNutrient(product.energy_kcal)} קל׳ /{" "}
                      {formatNutrient(product.base_quantity)}
                      {product.base_unit === "ml" ? " מ״ל" : " גרם"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        {shouldSearchCatalog && catalog.isLoading && (
          <div className="catalog-search-progress" role="status">
            <span aria-hidden="true">⌕</span>
            <span>לא נמצא אצלך. מחפשים במאגר הישראלי והבינלאומי…</span>
          </div>
        )}
        {catalogResults.length > 0 && (
          <section className="saved-product-picker__section saved-product-picker__section--catalog">
            <strong>תוצאות מישראל ומהעולם</strong>
            <small>הבחירה תוסיף את המוצר ישירות לארוחה.</small>
            <ul>
              {catalogResults.slice(0, 8).map((candidate) => (
                <li key={`${candidate.providerName}-${candidate.externalId}`}>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.preventDefault();
                      props.onChooseExternal(candidate);
                    }}
                  >
                    <span>
                      <strong>{candidate.nameHe}</strong>
                      <small>
                        {candidate.brand ?? candidate.barcode ?? "מוצר מהמאגר"} ·{" "}
                        {candidate.sourceLabelHe}
                      </small>
                    </span>
                    <span>
                      הוסף · {formatNutrient(candidate.nutrients.energyKcal)} קל׳ /{" "}
                      {formatNutrient(candidate.baseQuantity)}
                      {candidate.baseUnit === "ml" ? " מ״ל" : " גרם"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        {shouldSearchCatalog && catalog.isSuccess && catalogResults.length === 0 && (
          <small>לא נמצאה התאמה גם במאגרים. אפשר להקליד את שם המוצר והערכים ידנית.</small>
        )}
        {normalizedQuery.length <= 1 && <small>הקלד לפחות שתי אותיות כדי להתחיל חיפוש.</small>}
      </div>
    </details>
  );
}

function scaledNutrients(product: ProductBasis, amountText: string): Partial<EditableItem> {
  const amount = Number(amountText);
  if (!Number.isFinite(amount) || amount < 0 || product.base_quantity <= 0) {
    return { calories: "", protein: "", carbs: "", fat: "", fiber: "" };
  }
  const factor = amount / product.base_quantity;
  return {
    calories: scaleValue(product.energy_kcal, factor),
    protein: scaleValue(product.protein, factor),
    carbs: scaleValue(product.carbohydrate, factor),
    fat: scaleValue(product.fat, factor),
    fiber: scaleValue(product.fiber, factor),
  };
}

function scaleValue(value: number | null, factor: number): string {
  if (value === null) return "";
  return String(Math.round(value * factor * 10) / 10);
}

function normalizeProductSource(source: MealSourceType): MealSourceType {
  return source === "database" || source === "label" ? source : "manual";
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

function formatNutrient(value: number | null): string {
  return value === null
    ? "—"
    : new Intl.NumberFormat("he-IL", { maximumFractionDigits: 1 }).format(value);
}
