import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiRequest, ClientApiError } from "../../app/api";
import { compressImage } from "./image";
import { queueCapture } from "../../offline/db";

export function CapturePage(): React.JSX.Element {
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const galleryInputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const [files, setFiles] = useState<Blob[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
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

  const start = async (): Promise<void> => {
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
      await apiRequest(`/api/v1/analysis/jobs/${job.jobId}/start`, { method: "POST" });
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

  return (
    <div className="page capture-page">
      <section className="page-title">
        <p className="eyebrow">הוספת ארוחה</p>
        <h1>צלם או בחר מהגלריה, בדוק ושמור.</h1>
        <p>אפשר להשתמש במצלמה או לבחור עד ארבע תמונות קיימות. תמיד ניתן לתקן לפני השמירה.</p>
      </section>
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
            <button type="button" onClick={() => cameraInputRef.current?.click()} disabled={busy}>
              <span aria-hidden="true">◎</span>
              צילום מחדש
            </button>
            <button type="button" onClick={() => galleryInputRef.current?.click()} disabled={busy}>
              <span aria-hidden="true">▧</span>
              בחירה אחרת מהגלריה
            </button>
          </div>
        </section>
      )}
      <div className="capture-guidance">
        <h2>צילום שעוזר לזיהוי</h2>
        <p>
          צלם מלמעלה או בזווית קלה, או בחר תמונות ברורות מהגלריה. ודא שכל רכיבי הארוחה נראים; אפשר
          להשתמש בעד ארבע זוויות.
        </p>
      </div>
      {status && (
        <p className="status-message" role="status">
          {status}
        </p>
      )}
      <button
        className="sticky-primary"
        onClick={() => void start()}
        disabled={files.length === 0 || busy}
      >
        {busy ? "רגע…" : "בדוק את הארוחה"}
      </button>
    </div>
  );
}

function suggestedCategory(): string {
  const hour = new Date().getHours();
  if (hour < 11) return "breakfast";
  if (hour < 16) return "lunch";
  if (hour < 21) return "dinner";
  return "snack";
}
