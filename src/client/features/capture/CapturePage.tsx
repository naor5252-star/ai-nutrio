import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiRequest, ClientApiError } from "../../app/api";
import { compressImage } from "./image";
import { queueCapture } from "../../offline/db";

type EntryMode = "choose" | "photo" | "text";

export function CapturePage(): React.JSX.Element {
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const galleryInputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const [mode, setMode] = useState<EntryMode>("choose");
  const [files, setFiles] = useState<Blob[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [mealText, setMealText] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const chooseFiles = async (fileList: FileList | null): Promise<void> => {
    if (!fileList) return;
    setBusy(true);
    try {
      const selected = Array.from(fileList).slice(0, 4);
      const compressed = await Promise.all(selected.map((file) => compressImage(file)));
      previews.forEach((url) => URL.revokeObjectURL(url));
      setFiles(compressed);
      setPreviews(compressed.map((blob) => URL.createObjectURL(blob)));
      setStatus(
        compressed.length > 1 ? `${compressed.length} זוויות מוכנות לבדיקה` : "התמונה מוכנה לבדיקה",
      );
    } finally {
      setBusy(false);
    }
  };

  const startPhotoAnalysis = async (): Promise<void> => {
    if (files.length === 0) return;
    setBusy(true);
    const clientMutationId = crypto.randomUUID();
    if (!navigator.onLine) {
      await queueCapture({
        id: clientMutationId,
        files,
        occurredAt: new Date().toISOString(),
        category: suggestedCategory(),
        createdAt: new Date().toISOString(),
        status: "pending",
      });
      setStatus("התמונה נשמרה במכשיר. נעלה אותה כשהאינטרנט יחזור.");
      setBusy(false);
      return;
    }
    try {
      setStatus("מעלים את התמונות בצורה פרטית…");
      const job = await apiRequest<{ jobId: string }>("/api/v1/analysis/jobs", {
        method: "POST",
        body: JSON.stringify({ clientMutationId, jobType: "meal" }),
      });
      for (const [index, blob] of files.entries()) {
        await apiRequest(`/api/v1/analysis/jobs/${job.jobId}/images/${index}`, {
          method: "PUT",
          headers: { "content-type": blob.type || "image/jpeg" },
          body: blob,
        });
      }
      setStatus("הניתוח התחיל. אפשר לצאת מהמסך ולחזור אחר כך.");
      await apiRequest(`/api/v1/analysis/jobs/${job.jobId}/start`, {
        method: "POST",
      });
      void navigate(`/analysis/${job.jobId}`);
    } catch (error) {
      setStatus(
        error instanceof ClientApiError
          ? error.messageHe
          : "לא הצלחנו להתחיל את הניתוח. התמונות עדיין במכשיר.",
      );
    } finally {
      setBusy(false);
    }
  };

  const startTextAnalysis = async (): Promise<void> => {
    const text = mealText.trim();
    if (text.length < 2) return;
    if (!navigator.onLine) {
      setStatus("ניתוח ארוחה מטקסט דורש כרגע חיבור לאינטרנט.");
      return;
    }
    setBusy(true);
    setStatus("ה־AI מפרק את התיאור לרכיבי ארוחה…");
    try {
      const job = await apiRequest<{ jobId: string }>("/api/v1/analysis/jobs/text", {
        method: "POST",
        body: JSON.stringify({ clientMutationId: crypto.randomUUID(), text }),
      });
      setStatus("הבקשה התקבלה. עוברים למסך הניתוח…");
      void navigate(`/analysis/${job.jobId}?source=text`);
    } catch (error) {
      setStatus(
        error instanceof ClientApiError
          ? error.messageHe
          : "לא הצלחנו להתחיל את ניתוח הטקסט. אפשר לנסות שוב או להזין ידנית.",
      );
    } finally {
      setBusy(false);
    }
  };

  const startManualEntry = async (): Promise<void> => {
    if (!navigator.onLine) {
      setStatus("פתיחת טופס ידני דורשת כרגע חיבור לאינטרנט.");
      return;
    }
    setBusy(true);
    setStatus("פותחים טופס ארוחה ריק…");
    try {
      const job = await apiRequest<{ jobId: string }>("/api/v1/analysis/jobs/manual", {
        method: "POST",
        body: JSON.stringify({ clientMutationId: crypto.randomUUID() }),
      });
      void navigate(`/analysis/${job.jobId}?source=manual`);
    } catch (error) {
      setStatus(
        error instanceof ClientApiError ? error.messageHe : "לא הצלחנו לפתוח את הטופס הידני.",
      );
    } finally {
      setBusy(false);
    }
  };

  const selectMode = (nextMode: EntryMode): void => {
    setStatus(null);
    setMode(nextMode);
  };

  return (
    <div className="page capture-page">
      <section className="page-title">
        <p className="eyebrow">הוספת ארוחה</p>
        <h1>{pageTitle(mode)}</h1>
        <p>{pageDescription(mode)}</p>
      </section>

      {mode !== "choose" && (
        <button className="meal-entry-back" type="button" onClick={() => selectMode("choose")}>
          ‹ חזרה לכל דרכי ההוספה
        </button>
      )}

      {mode === "choose" && (
        <section className="meal-entry-methods" aria-label="בחירת דרך להוספת ארוחה">
          <button
            className="meal-entry-method meal-entry-method--photo"
            type="button"
            disabled={busy}
            aria-label="הוספת ארוחה מצילום או מהגלריה"
            onClick={() => selectMode("photo")}
          >
            <span className="meal-entry-method__icon" aria-hidden="true">
              ◎
            </span>
            <span>
              <strong>צילום או גלריה</strong>
              <small>ה־AI יזהה את הרכיבים מתוך תמונה</small>
            </span>
            <b aria-hidden="true">‹</b>
          </button>
          <button
            className="meal-entry-method meal-entry-method--text"
            type="button"
            disabled={busy}
            aria-label="הוספת ארוחה מתיאור טקסט באמצעות AI"
            onClick={() => selectMode("text")}
          >
            <span className="meal-entry-method__icon" aria-hidden="true">
              ✦
            </span>
            <span>
              <strong>תיאור בטקסט עם AI</strong>
              <small>כתוב מה אכלת וה־AI יפרק את הארוחה</small>
            </span>
            <b aria-hidden="true">‹</b>
          </button>
          <button
            className="meal-entry-method meal-entry-method--manual"
            type="button"
            disabled={busy}
            aria-label="הוספת ארוחה ידנית"
            onClick={() => void startManualEntry()}
          >
            <span className="meal-entry-method__icon" aria-hidden="true">
              ✎
            </span>
            <span>
              <strong>הזנה ידנית</strong>
              <small>הוסף בעצמך רכיבים, כמויות וערכים</small>
            </span>
            <b aria-hidden="true">‹</b>
          </button>
        </section>
      )}

      {mode === "photo" && (
        <>
          <input
            ref={cameraInputRef}
            className="visually-hidden"
            type="file"
            accept="image/*"
            capture="environment"
            multiple
            onChange={(event) => {
              const input = event.currentTarget;
              void chooseFiles(input.files).finally(() => {
                input.value = "";
              });
            }}
          />
          <input
            ref={galleryInputRef}
            className="visually-hidden"
            type="file"
            accept="image/*"
            multiple
            onChange={(event) => {
              const input = event.currentTarget;
              void chooseFiles(input.files).finally(() => {
                input.value = "";
              });
            }}
          />
          {previews.length === 0 ? (
            <div className="capture-source-choice">
              <button
                className="capture-stage"
                type="button"
                onClick={() => cameraInputRef.current?.click()}
                disabled={busy}
              >
                <span className="capture-stage__frame">
                  <i />
                  <i />
                  <i />
                  <i />
                  <b>◎</b>
                </span>
                <strong>צלם ארוחה</strong>
                <small>פתיחת המצלמה האחורית</small>
              </button>
              <button
                className="gallery-source-action"
                type="button"
                onClick={() => galleryInputRef.current?.click()}
                disabled={busy}
              >
                <span aria-hidden="true">▧</span>
                <span>
                  <strong>בחירה מהגלריה</strong>
                  <small>אפשר לבחור עד ארבע תמונות קיימות</small>
                </span>
              </button>
            </div>
          ) : (
            <section className="capture-review">
              <div className="capture-grid">
                {previews.map((preview, index) => (
                  <img key={preview} src={preview} alt={`זווית ${index + 1} של הארוחה`} />
                ))}
              </div>
              <div className="capture-source-actions">
                <button
                  type="button"
                  onClick={() => cameraInputRef.current?.click()}
                  disabled={busy}
                >
                  <span aria-hidden="true">◎</span>
                  צילום מחדש
                </button>
                <button
                  type="button"
                  onClick={() => galleryInputRef.current?.click()}
                  disabled={busy}
                >
                  <span aria-hidden="true">▧</span>
                  בחירה אחרת מהגלריה
                </button>
              </div>
            </section>
          )}
          <div className="capture-guidance">
            <h2>צילום שעוזר לזיהוי</h2>
            <p>
              צלם מלמעלה או בזווית קלה, או בחר תמונות ברורות מהגלריה. ודא שכל רכיבי הארוחה נראים;
              אפשר להשתמש בעד ארבע זוויות.
            </p>
          </div>
          <button
            className="sticky-primary"
            type="button"
            onClick={() => void startPhotoAnalysis()}
            disabled={files.length === 0 || busy}
          >
            {busy ? "רגע…" : "בדוק את הארוחה"}
          </button>
        </>
      )}

      {mode === "text" && (
        <section className="meal-text-entry">
          <label>
            <span>מה אכלת?</span>
            <textarea
              value={mealText}
              maxLength={2_000}
              rows={8}
              placeholder="לדוגמה: אכלתי פיתה עם חביתה משתי ביצים, כף טחינה, סלט קטן וקפה עם מעט חלב"
              onChange={(event) => setMealText(event.target.value)}
            />
          </label>
          <div className="meal-text-entry__meta">
            <small>כדאי לציין כמויות, גודל מנה, רטבים ושתייה.</small>
            <small>{mealText.length}/2000</small>
          </div>
          <div className="meal-text-example">
            <strong>טיפ לתוצאה טובה</strong>
            <p>כתוב כל רכיב וכמות שאתה זוכר. פרטים חסרים יסומנו לבדיקה לפני השמירה.</p>
          </div>
          <button
            className="sticky-primary"
            type="button"
            disabled={mealText.trim().length < 2 || busy}
            onClick={() => void startTextAnalysis()}
          >
            {busy ? "מנתחים…" : "נתח את התיאור עם AI"}
          </button>
        </section>
      )}

      {status && (
        <p className="status-message" role="status">
          {status}
        </p>
      )}
    </div>
  );
}

function pageTitle(mode: EntryMode): string {
  if (mode === "photo") return "צלם או בחר מהגלריה";
  if (mode === "text") return "ספר לנו במילים מה אכלת";
  return "איך להוסיף את הארוחה?";
}

function pageDescription(mode: EntryMode): string {
  if (mode === "photo") return "ה־AI יזהה את הרכיבים, ותמיד ניתן לתקן לפני השמירה.";
  if (mode === "text") return "ה־AI יהפוך את התיאור לרכיבים וכמויות שתוכל לבדוק ולערוך.";
  return "בחר צילום, תיאור חופשי בעזרת AI או הזנה ידנית מלאה.";
}

function suggestedCategory(): string {
  const hour = new Date().getHours();
  if (hour < 11) return "breakfast";
  if (hour < 16) return "lunch";
  if (hour < 21) return "dinner";
  return "snack";
}
