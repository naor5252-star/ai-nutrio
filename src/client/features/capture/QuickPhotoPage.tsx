import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiRequest, ClientApiError } from "../../app/api";
import { compressImage } from "./image";

export function QuickPhotoPage(): React.JSX.Element {
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const galleryInputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const processPhoto = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    if (!navigator.onLine) {
      setStatus("צילום מהיר דורש כרגע חיבור לאינטרנט.");
      return;
    }

    setBusy(true);
    setStatus("מכינים את התמונה…");
    try {
      const blob = await compressImage(file);
      const clientMutationId = crypto.randomUUID();

      setStatus("מעלים ומתחילים ניתוח AI…");
      const job = await apiRequest<{ jobId: string }>("/api/v1/analysis/jobs", {
        method: "POST",
        body: JSON.stringify({ clientMutationId, jobType: "meal" }),
      });

      await apiRequest(`/api/v1/analysis/jobs/${job.jobId}/images/0`, {
        method: "PUT",
        headers: { "content-type": blob.type || "image/jpeg" },
        body: blob,
      });

      await apiRequest(`/api/v1/analysis/jobs/${job.jobId}/start`, {
        method: "POST",
      });

      setStatus("הניתוח התחיל…");
      void navigate(`/analysis/${job.jobId}`, { replace: true });
    } catch (error) {
      setStatus(
        error instanceof ClientApiError
          ? error.messageHe
          : "לא הצלחנו להתחיל את הניתוח. אפשר לנסות שוב.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="quick-photo-page" dir="rtl">
      <button
        className="quick-photo-page__close"
        type="button"
        aria-label="חזרה למסך הבית"
        onClick={() => void navigate("/")}
      >
        ×
      </button>

      <section className="quick-photo-card">
        <div className="quick-photo-card__mark" aria-hidden="true">
          ◎
        </div>
        <p className="eyebrow">רגע טוב · צילום מהיר</p>
        <h1>צלם ארוחה וה־AI יתחיל מיד</h1>
        <p className="quick-photo-card__description">
          אחרי הצילום התמונה תעלה אוטומטית ותועבר ישירות למסך הניתוח.
        </p>

        <input
          ref={cameraInputRef}
          className="visually-hidden"
          type="file"
          accept="image/*"
          capture="environment"
          onChange={(event) => {
            const input = event.currentTarget;
            const file = input.files?.[0];
            input.value = "";
            void processPhoto(file);
          }}
        />
        <input
          ref={galleryInputRef}
          className="visually-hidden"
          type="file"
          accept="image/*"
          onChange={(event) => {
            const input = event.currentTarget;
            const file = input.files?.[0];
            input.value = "";
            void processPhoto(file);
          }}
        />

        <button
          className="quick-photo-card__camera"
          type="button"
          disabled={busy}
          onClick={() => cameraInputRef.current?.click()}
        >
          <span aria-hidden="true">📷</span>
          <span>{busy ? "מעבדים…" : "פתח מצלמה"}</span>
        </button>

        <button
          className="quick-photo-card__gallery"
          type="button"
          disabled={busy}
          onClick={() => galleryInputRef.current?.click()}
        >
          בחירה מהגלריה
        </button>

        {status && (
          <div className="quick-photo-card__status" role="status" aria-live="polite">
            {busy && <span className="quick-photo-card__spinner" aria-hidden="true" />}
            <span>{status}</span>
          </div>
        )}
      </section>
    </main>
  );
}
