import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest, ClientApiError } from "../../app/api";
import { compressImage } from "../capture/image";

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
  source_type: "label" | "database" | "manual" | "ai_estimate";
};

type LabelScan = {
  suggestedNameHe: string | null;
  brand: string | null;
  barcode: string | null;
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
  confidence: "high" | "medium" | "low";
  warningsHe: string[];
};

type BarcodeDetectorLike = {
  detect(source: ImageBitmapSource): Promise<Array<{ rawValue: string }>>;
};

type BarcodeDetectorConstructor = new (options: { formats: string[] }) => BarcodeDetectorLike;

type ProductDraft = {
  nameHe: string;
  brand: string;
  barcode: string;
  baseQuantity: string;
  baseUnit: "g" | "ml";
  servingDescriptionHe: string;
  servingWeight: string;
  energyKcal: string;
  protein: string;
  carbohydrate: string;
  fat: string;
  fiber: string;
  sourceType: "label" | "manual";
};

const EMPTY_DRAFT: ProductDraft = {
  nameHe: "",
  brand: "",
  barcode: "",
  baseQuantity: "100",
  baseUnit: "g",
  servingDescriptionHe: "",
  servingWeight: "",
  energyKcal: "",
  protein: "",
  carbohydrate: "",
  fat: "",
  fiber: "",
  sourceType: "manual",
};

export function ProductsPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [queryText, setQueryText] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [draft, setDraft] = useState<ProductDraft>(EMPTY_DRAFT);
  const barcodeInput = useRef<HTMLInputElement>(null);
  const labelInput = useRef<HTMLInputElement>(null);

  const library = useQuery({
    queryKey: ["products"],
    queryFn: () => apiRequest<{ products: ProductSummary[] }>("/api/v1/products"),
  });
  const search = useQuery({
    queryKey: ["product-search", queryText],
    queryFn: () =>
      apiRequest<{ results: ProductSummary[] }>(
        `/api/v1/products/search?q=${encodeURIComponent(queryText)}`,
      ),
    enabled: queryText.trim().length > 1,
  });

  const create = useMutation({
    mutationFn: () =>
      apiRequest<{ id: string }>("/api/v1/products", {
        method: "POST",
        body: JSON.stringify({
          nameHe: draft.nameHe,
          brand: draft.brand || null,
          barcode: draft.barcode || null,
          baseQuantity: Number(draft.baseQuantity),
          baseUnit: draft.baseUnit,
          servingDescriptionHe: draft.servingDescriptionHe || null,
          servingWeight: draft.servingWeight ? Number(draft.servingWeight) : null,
          sourceType: draft.sourceType,
          nutrients: (
            [
              ["energy_kcal", "kcal", draft.energyKcal],
              ["protein", "g", draft.protein],
              ["carbohydrate", "g", draft.carbohydrate],
              ["fat", "g", draft.fat],
              ["fiber", "g", draft.fiber],
            ] as const
          ).map(([nutrientCode, normalizedUnit, value]) => ({
            nutrientCode,
            normalizedUnit,
            normalizedValue: value === "" ? null : Number(value),
            originalDisplayValue: value === "" ? null : value,
          })),
        }),
      }),
    onSuccess: () => {
      setMessage("המוצר נשמר ואפשר לבחור אותו בארוחה");
      setShowForm(false);
      setDraft(EMPTY_DRAFT);
      setQueryText("");
      void queryClient.invalidateQueries({ queryKey: ["products"] });
      void queryClient.invalidateQueries({ queryKey: ["product-search"] });
    },
    onError: (error) =>
      setMessage(error instanceof ClientApiError ? error.messageHe : "לא הצלחנו לשמור את המוצר"),
  });

  const remove = useMutation({
    mutationFn: (id: string) => apiRequest(`/api/v1/products/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      setMessage("המוצר הוסר");
      void queryClient.invalidateQueries({ queryKey: ["products"] });
      void queryClient.invalidateQueries({ queryKey: ["product-search"] });
    },
    onError: (error) =>
      setMessage(error instanceof ClientApiError ? error.messageHe : "לא הצלחנו להסיר את המוצר"),
  });

  const scanWithAi = async (file: File): Promise<LabelScan> => {
    const compressed = await compressImage(file);
    return apiRequest<{ scan: LabelScan }>("/api/v1/products/label/scan", {
      method: "POST",
      headers: { "content-type": compressed.type || "image/jpeg" },
      body: compressed,
    }).then((response) => response.scan);
  };

  const scanBarcode = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    setScanning(true);
    setMessage("קוראים את הברקוד…");
    try {
      const detectorConstructor = (
        window as unknown as { BarcodeDetector?: BarcodeDetectorConstructor }
      ).BarcodeDetector;
      let detectedBarcode: string | null = null;
      if (detectorConstructor) {
        const detector = new detectorConstructor({
          formats: ["ean_13", "ean_8", "upc_a", "upc_e"],
        });
        const bitmap = await createImageBitmap(file);
        const results = await detector.detect(bitmap);
        bitmap.close();
        detectedBarcode = results[0]?.rawValue ?? null;
      }

      if (!detectedBarcode) {
        const scan = await scanWithAi(file);
        detectedBarcode = scan.barcode;
        if (scan.suggestedNameHe || hasNutrition(scan)) applyLabelScan(scan);
      }

      if (detectedBarcode) {
        setDraft((current) => ({
          ...current,
          barcode: detectedBarcode ?? "",
        }));
        setQueryText(detectedBarcode);
        setShowForm(true);
        setMessage(`זוהה ברקוד ${detectedBarcode}. אפשר להשלים שם וערכים ולשמור.`);
      } else {
        setShowForm(true);
        setMessage("לא הצלחנו לקרוא את הברקוד. אפשר להקליד אותו ידנית.");
      }
    } catch (error) {
      setShowForm(true);
      setMessage(
        error instanceof ClientApiError
          ? error.messageHe
          : "לא הצלחנו לקרוא את הברקוד. אפשר להקליד אותו ידנית.",
      );
    } finally {
      setScanning(false);
      if (barcodeInput.current) barcodeInput.current.value = "";
    }
  };

  const scanLabel = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    setScanning(true);
    setMessage("קוראים את התווית התזונתית…");
    try {
      const scan = await scanWithAi(file);
      applyLabelScan(scan);
      const confidenceText =
        scan.confidence === "high" ? "הקריאה נראית ברורה" : "כדאי לבדוק את הערכים מול התווית";
      setMessage(`${confidenceText}. הוסף או תקן את שם המוצר לפני השמירה.`);
    } catch (error) {
      setShowForm(true);
      setMessage(
        error instanceof ClientApiError
          ? error.messageHe
          : "לא הצלחנו לקרוא את התווית. אפשר למלא את הערכים ידנית.",
      );
    } finally {
      setScanning(false);
      if (labelInput.current) labelInput.current.value = "";
    }
  };

  const visibleProducts =
    queryText.trim().length > 1 ? (search.data?.results ?? []) : (library.data?.products ?? []);

  return (
    <div className="page products-page">
      <section className="page-title">
        <p className="eyebrow">ספריית מוצרים</p>
        <h1>סרוק פעם אחת, השתמש בכל ארוחה.</h1>
        <p>אפשר לצלם ברקוד, לצלם תווית תזונתית או להזין את המוצר ידנית.</p>
      </section>

      <div className="product-scan-actions">
        <button type="button" onClick={() => barcodeInput.current?.click()} disabled={scanning}>
          <span aria-hidden="true">▥</span>
          <strong>סריקת ברקוד</strong>
          <small>צלם את הקווים והמספר</small>
        </button>
        <button type="button" onClick={() => labelInput.current?.click()} disabled={scanning}>
          <span aria-hidden="true">▤</span>
          <strong>צילום ערכים</strong>
          <small>צלם את טבלת הסימון התזונתי</small>
        </button>
      </div>
      <input
        ref={barcodeInput}
        className="visually-hidden"
        type="file"
        accept="image/*"
        capture="environment"
        onChange={(event) => void scanBarcode(event.target.files?.[0])}
      />
      <input
        ref={labelInput}
        className="visually-hidden"
        type="file"
        accept="image/*"
        capture="environment"
        onChange={(event) => void scanLabel(event.target.files?.[0])}
      />

      {message && (
        <p className="status-message" role="status">
          {message}
        </p>
      )}

      <div className="product-search-row">
        <label>
          <span>חיפוש במוצרים</span>
          <input
            value={queryText}
            onChange={(event) => setQueryText(event.target.value)}
            placeholder="שם, מותג או ברקוד"
          />
        </label>
        <button
          type="button"
          onClick={() => {
            setDraft(EMPTY_DRAFT);
            setShowForm(true);
          }}
          aria-label="יצירת מוצר"
        >
          +
        </button>
      </div>

      <section className="product-library">
        <div className="section-heading">
          <h2>{queryText.trim().length > 1 ? "תוצאות חיפוש" : "המוצרים שלי"}</h2>
          <small>{visibleProducts.length} מוצרים</small>
        </div>
        {visibleProducts.length === 0 ? (
          <p className="quiet-state">
            {queryText.trim().length > 1
              ? "לא נמצא מוצר מתאים"
              : "עדיין אין מוצרים שמורים. אפשר להתחיל מסריקת תווית."}
          </p>
        ) : (
          <ul className="product-card-list">
            {visibleProducts.map((product) => (
              <li key={product.id}>
                <div className="product-card__title">
                  <div>
                    <strong>{product.canonical_name_he}</strong>
                    <small>{product.brand ?? "ללא מותג"}</small>
                  </div>
                  <button
                    type="button"
                    onClick={() => remove.mutate(product.id)}
                    disabled={remove.isPending}
                    aria-label={`מחיקת ${product.canonical_name_he}`}
                  >
                    ×
                  </button>
                </div>
                <div className="product-card__meta">
                  <span>{product.barcode ?? "ללא ברקוד"}</span>
                  <span>
                    ל-{formatNumber(product.base_quantity)} {unitName(product.base_unit)}
                  </span>
                </div>
                <div className="product-card__nutrients">
                  <span>
                    <b>{formatNumber(product.energy_kcal)}</b>
                    <small>קל׳</small>
                  </span>
                  <span>
                    <b>{formatNumber(product.protein)}</b>
                    <small>חלבון</small>
                  </span>
                  <span>
                    <b>{formatNumber(product.carbohydrate)}</b>
                    <small>פחמ׳</small>
                  </span>
                  <span>
                    <b>{formatNumber(product.fat)}</b>
                    <small>שומן</small>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {showForm && (
        <form
          className="product-form"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate();
          }}
        >
          <div className="product-form__heading">
            <div>
              <p className="eyebrow">אישור לפני שמירה</p>
              <h2>תיוג המוצר והערכים</h2>
            </div>
            <button type="button" onClick={() => setShowForm(false)} aria-label="סגירת הטופס">
              ×
            </button>
          </div>
          <label>
            <span>שם המוצר שלך</span>
            <input
              value={draft.nameHe}
              onChange={(event) => updateDraft("nameHe", event.target.value)}
              placeholder="לדוגמה: יוגורט PRO וניל"
              required
            />
            <small>זה השם שיופיע אחר כך בבחירת מוצרים בארוחה.</small>
          </label>
          <div className="form-pair">
            <label>
              <span>מותג</span>
              <input
                value={draft.brand}
                onChange={(event) => updateDraft("brand", event.target.value)}
              />
            </label>
            <label>
              <span>ברקוד</span>
              <input
                value={draft.barcode}
                onChange={(event) => updateDraft("barcode", event.target.value.replace(/\D/gu, ""))}
                inputMode="numeric"
                pattern="[0-9]{8,14}"
              />
            </label>
          </div>
          <div className="form-pair">
            <label>
              <span>הערכים הם עבור</span>
              <input
                value={draft.baseQuantity}
                onChange={(event) => updateDraft("baseQuantity", event.target.value)}
                inputMode="decimal"
                required
              />
            </label>
            <label>
              <span>יחידה</span>
              <select
                value={draft.baseUnit}
                onChange={(event) =>
                  updateDraft("baseUnit", event.target.value === "ml" ? "ml" : "g")
                }
              >
                <option value="g">גרם</option>
                <option value="ml">מ״ל</option>
              </select>
            </label>
          </div>
          <div className="nutrient-form-grid">
            <label>
              קלוריות
              <input
                value={draft.energyKcal}
                onChange={(event) => updateDraft("energyKcal", event.target.value)}
                inputMode="decimal"
              />
            </label>
            <label>
              חלבון
              <input
                value={draft.protein}
                onChange={(event) => updateDraft("protein", event.target.value)}
                inputMode="decimal"
              />
            </label>
            <label>
              פחמימות
              <input
                value={draft.carbohydrate}
                onChange={(event) => updateDraft("carbohydrate", event.target.value)}
                inputMode="decimal"
              />
            </label>
            <label>
              שומן
              <input
                value={draft.fat}
                onChange={(event) => updateDraft("fat", event.target.value)}
                inputMode="decimal"
              />
            </label>
            <label>
              סיבים
              <input
                value={draft.fiber}
                onChange={(event) => updateDraft("fiber", event.target.value)}
                inputMode="decimal"
              />
            </label>
          </div>
          <details>
            <summary>מידת מנה אופציונלית</summary>
            <div className="form-pair">
              <label>
                <span>תיאור מנה</span>
                <input
                  value={draft.servingDescriptionHe}
                  onChange={(event) => updateDraft("servingDescriptionHe", event.target.value)}
                  placeholder="גביע אחד"
                />
              </label>
              <label>
                <span>משקל מנה</span>
                <input
                  value={draft.servingWeight}
                  onChange={(event) => updateDraft("servingWeight", event.target.value)}
                  inputMode="decimal"
                />
              </label>
            </div>
          </details>
          <p className="fine-print">
            תוצאת הצילום היא הצעה בלבד. בדוק את המספרים מול האריזה לפני השמירה.
          </p>
          <button className="primary-action" type="submit" disabled={create.isPending}>
            {create.isPending ? "שומרים…" : "אישור ושמירת מוצר"}
          </button>
        </form>
      )}
    </div>
  );

  function applyLabelScan(scan: LabelScan): void {
    setDraft({
      nameHe: scan.suggestedNameHe ?? "",
      brand: scan.brand ?? "",
      barcode: scan.barcode ?? "",
      baseQuantity: String(scan.baseQuantity),
      baseUnit: scan.baseUnit,
      servingDescriptionHe: scan.servingDescriptionHe ?? "",
      servingWeight: toDraftNumber(scan.servingWeight),
      energyKcal: toDraftNumber(scan.nutrients.energyKcal),
      protein: toDraftNumber(scan.nutrients.protein),
      carbohydrate: toDraftNumber(scan.nutrients.carbohydrate),
      fat: toDraftNumber(scan.nutrients.fat),
      fiber: toDraftNumber(scan.nutrients.fiber),
      sourceType: "label",
    });
    setShowForm(true);
  }

  function updateDraft<K extends keyof ProductDraft>(key: K, value: ProductDraft[K]): void {
    setDraft((current) => ({ ...current, [key]: value }));
  }
}

function hasNutrition(scan: LabelScan): boolean {
  return Object.values(scan.nutrients).some((value) => value !== null);
}

function toDraftNumber(value: number | null): string {
  return value === null ? "" : String(value);
}

function formatNumber(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("he-IL", { maximumFractionDigits: 1 }).format(value);
}

function unitName(unit: "g" | "ml"): string {
  return unit === "ml" ? "מ״ל" : "גרם";
}
