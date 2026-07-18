import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiRequest, ClientApiError } from "../../app/api";
import { compressImage } from "./image";
import { queueCapture } from "../../offline/db";

export function CapturePage(): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
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
        <h1>צלם, בדוק, שמור.</h1>
        <p>הזיהוי הוא הערכה. תמיד אפשר לתקן לפני השמירה.</p>
      </section>
      <input
        ref={inputRef}
        className="visually-hidden"
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        onChange={(event) => void chooseFiles(event.target.files)}
      />
      {previews.length === 0 ? (
        <button className="capture-stage" onClick={() => inputRef.current?.click()} disabled={busy}>
          <span className="capture-stage__frame">
            <i />
            <i />
            <i />
            <i />
            <b>◎</b>
          </span>
          <strong>צלם ארוחה</strong>
          <small>או בחר תמונה מספריית התמונות</small>
        </button>
      ) : (
        <section className="capture-review">
          <div className="capture-grid">
            {previews.map((preview, index) => (
              <img key={preview} src={preview} alt={`זווית ${index + 1} של הארוחה`} />
            ))}
          </div>
          <button className="text-action" onClick={() => inputRef.current?.click()}>
            החלפת תמונות
          </button>
        </section>
      )}
      <div className="capture-guidance">
        <h2>צילום שעוזר לזיהוי</h2>
        <p>
          צלם מלמעלה או בזווית קלה, ודאג שכל רכיבי הארוחה יהיו בתמונה. אפשר להוסיף עד ארבע זוויות.
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
