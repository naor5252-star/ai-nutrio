import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { apiRequest } from "../../app/api";

type QueueItem = {
  id: string;
  status: string;
  source: "photo" | "text";
  titleHe: string;
  errorMessageHe: string | null;
  createdAt: string;
  savedMealId: string | null;
  expiresAt: string;
};

type QueueResponse = { items: QueueItem[] };

const ACTIVE = new Set(["uploading", "queued", "processing"]);

export function AnalysisQueue(): React.JSX.Element | null {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["analysis-queue"],
    queryFn: () => apiRequest<QueueResponse>("/api/v1/analysis/jobs/recent"),
    refetchInterval: (state) =>
      (state.state.data?.items ?? []).some((item) => ACTIVE.has(item.status)) ? 2_500 : false,
    refetchOnMount: "always",
  });

  const remove = useMutation({
    mutationFn: (jobId: string) =>
      apiRequest<{ ok: true }>(`/api/v1/analysis/jobs/${jobId}`, {
        method: "DELETE",
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["analysis-queue"] });
    },
  });

  const items = query.data?.items ?? [];
  if (!query.isLoading && items.length === 0) return null;

  return (
    <section className="analysis-queue">
      <div className="analysis-queue__header">
        <div>
          <p className="eyebrow">תור AI</p>
          <h2>הניתוחים האחרונים</h2>
          <p>כל ניתוח נשמר ל־24 שעות.</p>
        </div>
        <span>{query.isLoading ? "…" : items.length}</span>
      </div>

      <div className="analysis-queue__list">
        {items.map((item) => (
          <article className="analysis-queue-card" key={item.id}>
            <div className="analysis-queue-card__top">
              <span>{item.source === "photo" ? "▧" : "✦"}</span>
              <div>
                <strong>{item.titleHe}</strong>
                <small>
                  {new Intl.DateTimeFormat("he-IL", {
                    hour: "2-digit",
                    minute: "2-digit",
                  }).format(new Date(item.createdAt))}
                </small>
              </div>
            </div>

            <div className={`analysis-queue-status analysis-queue-status--${statusTone(item)}`}>
              {ACTIVE.has(item.status) && <i aria-hidden="true" />}
              {statusLabel(item)}
            </div>

            {item.errorMessageHe && item.status === "failed" && <p>{item.errorMessageHe}</p>}

            <div className="analysis-queue-card__actions">
              <button
                type="button"
                onClick={() => {
                  void navigate(`/analysis/${item.id}?source=${item.source}`);
                }}
              >
                {openLabel(item)}
              </button>
              <button
                type="button"
                className="analysis-queue-card__delete"
                disabled={remove.isPending}
                onClick={() => {
                  if (window.confirm("למחוק את הניתוח הזה?")) remove.mutate(item.id);
                }}
              >
                מחיקה
              </button>
            </div>

            <small>יוסר מהתור {expiryLabel(item.expiresAt)}</small>
          </article>
        ))}
      </div>
    </section>
  );
}

function statusLabel(item: QueueItem): string {
  if (item.status === "uploading") return "מעלה תמונות…";
  if (item.status === "queued") return "ממתין ל־AI…";
  if (item.status === "processing") return "ה־AI מנתח…";
  if (item.status === "failed") return "הניתוח נכשל";
  if (item.savedMealId) return "אושר ונשמר";
  return "מוכן לבדיקה";
}

function statusTone(item: QueueItem): string {
  if (ACTIVE.has(item.status)) return "working";
  if (item.status === "failed") return "failed";
  if (item.savedMealId) return "saved";
  return "ready";
}

function openLabel(item: QueueItem): string {
  if (ACTIVE.has(item.status)) return "פתיחת סטטוס";
  if (item.status === "failed") return "פתיחה וניסיון חוזר";
  if (item.savedMealId) return "פתיחת התוצאה";
  return "בדיקה, עריכה ואישור";
}

function expiryLabel(expiresAt: string): string {
  const hours = Math.max(1, Math.ceil((Date.parse(expiresAt) - Date.now()) / (60 * 60 * 1_000)));
  return hours === 1 ? "בעוד כשעה" : `בעוד כ־${hours} שעות`;
}
