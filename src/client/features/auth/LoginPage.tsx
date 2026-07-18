import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { SessionResponse } from "../../../shared/contracts/api";
import { apiRequest, ClientApiError } from "../../app/api";

export function LoginPage({ session }: { session: SessionResponse }): React.JSX.Element {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [developmentUrl, setDevelopmentUrl] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const magic = useMutation({
    mutationFn: () =>
      apiRequest<{ messageHe: string; developmentMagicUrl?: string }>(
        "/api/v1/auth/magic-link/request",
        {
          method: "POST",
          body: JSON.stringify({ email }),
        },
      ),
    onSuccess: (result) => {
      setMessage(result.messageHe);
      setDevelopmentUrl(result.developmentMagicUrl ?? null);
    },
    onError: (error) =>
      setMessage(error instanceof ClientApiError ? error.messageHe : "לא הצלחנו לשלוח קישור"),
  });
  const demo = useMutation({
    mutationFn: () =>
      apiRequest("/api/v1/auth/demo", {
        method: "POST",
        body: JSON.stringify({ email: "demo@example.com" }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["session"] }),
  });

  return (
    <main className="login-screen">
      <section className="login-hero">
        <span className="login-hero__sun" aria-hidden="true">
          ◒
        </span>
        <p className="eyebrow">יומן תזונה אישי לשני בני הבית</p>
        <h1>
          יותר בהירות סביב האוכל,
          <br />
          בלי שיפוט ובלי עומס.
        </h1>
        <p>צלמו ארוחה, בדקו את הזיהוי ושמרו רק אחרי שהמידע נראה לכם נכון.</p>
      </section>
      <section className="login-form" aria-labelledby="login-title">
        <h2 id="login-title">כניסה פשוטה</h2>
        <label>
          <span>כתובת אימייל</span>
          <input
            type="email"
            inputMode="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="name@example.com"
          />
        </label>
        <button
          className="primary-action"
          disabled={!email || magic.isPending}
          onClick={() => magic.mutate()}
        >
          {magic.isPending ? "שולחים…" : "שלחו לי קישור כניסה"}
        </button>
        {session.features.googleAuth && (
          <a className="secondary-action" href="/api/v1/auth/google/start">
            כניסה עם Google
          </a>
        )}
        {session.features.appleAuth && (
          <a className="secondary-action" href="/api/v1/auth/apple/start">
            כניסה עם Apple
          </a>
        )}
        {session.features.demoAuth && (
          <button className="text-action" onClick={() => demo.mutate()}>
            כניסה למצב פיתוח
          </button>
        )}
        {message && (
          <p className="status-message" role="status">
            {message}
          </p>
        )}
        {developmentUrl && (
          <a className="development-link" href={developmentUrl}>
            פתיחת קישור הפיתוח
          </a>
        )}
        <p className="fine-print">
          זוהי אפליקציית תמיכה כללית באורח חיים. היא אינה מחליפה רופא או דיאטנית מוסמכת.
        </p>
      </section>
    </main>
  );
}
