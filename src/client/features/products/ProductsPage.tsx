import { useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, ClientApiError } from "../../app/api";

type SearchResult = {
  id: string;
  canonical_name_he: string;
  brand: string | null;
  barcode: string | null;
};

type BarcodeDetectorLike = {
  detect(source: ImageBitmapSource): Promise<Array<{ rawValue: string }>>;
};
type BarcodeDetectorConstructor = new (options: { formats: string[] }) => BarcodeDetectorLike;

export function ProductsPage(): React.JSX.Element {
  const [queryText, setQueryText] = useState("");
  const [barcode, setBarcode] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const cameraInput = useRef<HTMLInputElement>(null);
  const search = useQuery({
    queryKey: ["product-search", queryText],
    queryFn: () =>
      apiRequest<{ results: SearchResult[] }>(
        `/api/v1/products/search?q=${encodeURIComponent(queryText)}`,
      ),
    enabled: queryText.trim().length > 1,
  });
  const create = useMutation({
    mutationFn: (form: HTMLFormElement) => {
      const data = new FormData(form);
      return apiRequest("/api/v1/products/", {
        method: "POST",
        body: JSON.stringify({
          nameHe: data.get("nameHe"),
          brand: data.get("brand") || null,
          barcode: data.get("barcode") || null,
          baseQuantity: 100,
          baseUnit: data.get("baseUnit"),
          sourceType: "manual",
          nutrients: (
            [
              ["energy_kcal", "kcal"],
              ["protein", "g"],
              ["carbohydrate", "g"],
              ["fat", "g"],
              ["fiber", "g"],
            ] as const
          ).map(([nutrientCode, normalizedUnit]) => ({
            nutrientCode,
            normalizedUnit,
            normalizedValue: data.get(nutrientCode) === "" ? null : Number(data.get(nutrientCode)),
            originalDisplayValue:
              data.get(nutrientCode) === "" ? null : String(data.get(nutrientCode)),
          })),
        }),
      });
    },
    onSuccess: () => {
      setMessage("המוצר נשמר ואפשר להשתמש בו בבית");
      setShowForm(false);
    },
    onError: (error) =>
      setMessage(error instanceof ClientApiError ? error.messageHe : "לא הצלחנו לשמור את המוצר"),
  });

  const scanImage = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    const constructor = Reflect.get(window, "BarcodeDetector") as
      BarcodeDetectorConstructor | undefined;
    if (!constructor) {
      setMessage("סריקת ברקוד אוטומטית אינה זמינה בדפדפן הזה. אפשר להקליד את המספר.");
      return;
    }
    const detector = new constructor({ formats: ["ean_13", "ean_8", "upc_a", "upc_e"] });
    const bitmap = await createImageBitmap(file);
    const results = await detector.detect(bitmap);
    bitmap.close();
    const value = results[0]?.rawValue;
    if (value) {
      setBarcode(value);
      setQueryText(value);
      setMessage(`זוהה ברקוד ${value}`);
    } else setMessage("לא הצלחנו לקרוא את הברקוד. נסה צילום ישר ובאור טוב.");
  };

  return (
    <div className="page products-page">
      <section className="page-title">
        <p className="eyebrow">מוצרים ארוזים</p>
        <h1>חיפוש, ברקוד ותווית</h1>
        <p>המידע מהתווית קודם למאגר; ערך חסר נשאר לא ידוע.</p>
      </section>
      <div className="product-search-row">
        <label>
          <span>שם, מותג או ברקוד</span>
          <input
            value={queryText}
            onChange={(event) => setQueryText(event.target.value)}
            placeholder="לדוגמה: יוגורט"
          />
        </label>
        <button onClick={() => cameraInput.current?.click()} aria-label="צילום ברקוד">
          ▣
        </button>
      </div>
      <input
        ref={cameraInput}
        className="visually-hidden"
        type="file"
        accept="image/*"
        capture="environment"
        onChange={(event) => void scanImage(event.target.files?.[0])}
      />
      {message && (
        <p className="status-message" role="status">
          {message}
        </p>
      )}
      <ul className="product-results">
        {search.data?.results.map((result) => (
          <li key={result.id}>
            <div>
              <strong>{result.canonical_name_he}</strong>
              <small>{result.brand ?? "ללא מותג"}</small>
            </div>
            <span>{result.barcode ?? "ללא ברקוד"}</span>
          </li>
        ))}
      </ul>
      <button className="secondary-action" onClick={() => setShowForm((value) => !value)}>
        {showForm ? "סגירת הטופס" : "+ יצירת מוצר ידנית"}
      </button>
      {showForm && (
        <form
          className="product-form"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate(event.currentTarget);
          }}
        >
          <h2>סיכום מוצר לפני שמירה</h2>
          <label>
            שם המוצר
            <input name="nameHe" required />
          </label>
          <label>
            מותג
            <input name="brand" />
          </label>
          <label>
            ברקוד
            <input
              name="barcode"
              inputMode="numeric"
              defaultValue={barcode}
              pattern="[0-9]{8,14}"
            />
          </label>
          <label>
            הערכים הם ל-100
            <input type="hidden" name="baseUnit" value="g" />
            <span className="static-field">גרם</span>
          </label>
          <div className="nutrient-form-grid">
            <label>
              קלוריות
              <input name="energy_kcal" inputMode="decimal" />
            </label>
            <label>
              חלבון
              <input name="protein" inputMode="decimal" />
            </label>
            <label>
              פחמימות
              <input name="carbohydrate" inputMode="decimal" />
            </label>
            <label>
              שומן
              <input name="fat" inputMode="decimal" />
            </label>
            <label>
              סיבים
              <input name="fiber" inputMode="decimal" />
            </label>
          </div>
          <p className="fine-print">בדוק מול התווית. שדות ריקים יישמרו כ״לא ידוע״.</p>
          <button className="primary-action" type="submit">
            אישור ושמירת מוצר
          </button>
        </form>
      )}
    </div>
  );
}
