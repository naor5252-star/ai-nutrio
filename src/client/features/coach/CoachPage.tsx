import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, ClientApiError } from "../../app/api";

function todayLocal(): string {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

type ChatEntry = { role: "user" | "assistant"; text: string };

type TodayChat = {
  localDate: string;
  conversationId: string | null;
  messages: Array<{
    id: string;
    role: "user" | "assistant";
    text: string;
    createdAt: string;
  }>;
};

export function CoachPage(): React.JSX.Element {
  const [text, setText] = useState("");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [historyApplied, setHistoryApplied] = useState(false);

  const next = useQuery({
    queryKey: ["coach-next", todayLocal()],
    queryFn: () =>
      apiRequest<{ headlineHe: string; messageHe: string; actionHe: string }>(
        `/api/v1/coach/next?date=${todayLocal()}`,
      ),
  });

  const history = useQuery({
    queryKey: ["coach-today", todayLocal()],
    queryFn: () => apiRequest<TodayChat>("/api/v1/coach/today"),
    staleTime: 15_000,
  });

  useEffect(() => {
    if (!history.data || historyApplied) return;
    setConversationId(history.data.conversationId);
    setEntries(
      history.data.messages.map((message) => ({
        role: message.role,
        text: message.text,
      })),
    );
    setHistoryApplied(true);
  }, [history.data, historyApplied]);

  const send = useMutation({
    mutationFn: (message: string) =>
      apiRequest<{ conversationId: string; response: string }>("/api/v1/coach/messages", {
        method: "POST",
        body: JSON.stringify({ conversationId, message }),
      }),
    onMutate: (message) => {
      setEntries((current) => [...current, { role: "user", text: message }]);
      setText("");
    },
    onSuccess: (result) => {
      setConversationId(result.conversationId);
      setEntries((current) => [...current, { role: "assistant", text: result.response }]);
    },
    onError: (error) =>
      setEntries((current) => [
        ...current,
        {
          role: "assistant",
          text: error instanceof ClientApiError ? error.messageHe : "לא הצלחתי לענות כרגע",
        },
      ]),
  });

  return (
    <div className="page coach-page">
      <section className="page-title">
        <p className="eyebrow">הכוונה אישית</p>
        <h1>מה הצעד הבא?</h1>
        <p>השיחה נשמרת לאורך היום ומתחילה מחדש ביום חדש.</p>
      </section>

      {next.data && (
        <section className="coach-focus">
          <span>היום</span>
          <h2>{next.data.headlineHe}</h2>
          <p>{next.data.messageHe}</p>
        </section>
      )}

      <section className="prompt-starters" aria-label="שאלות מוצעות">
        {["מה כדאי לאכול בהמשך?", "איך נראה השבוע שלי?", "מה כדאי לשפר היום?"].map((prompt) => (
          <button key={prompt} onClick={() => setText(prompt)}>
            {prompt}
          </button>
        ))}
      </section>

      <section className="coach-conversation" aria-live="polite" aria-busy={send.isPending}>
        {history.isLoading && entries.length === 0 ? (
          <div className="coach-empty">
            <div className="coach-thinking-dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
            <p>טוען את השיחה של היום…</p>
          </div>
        ) : entries.length === 0 && !send.isPending ? (
          <div className="coach-empty">
            <span>↗</span>
            <p>אפשר לשאול שאלה. השיחה הזו תישמר עד סוף היום.</p>
          </div>
        ) : (
          entries.map((entry, index) => (
            <div
              key={`${entry.role}-${index}`}
              className={`coach-entry coach-entry--${entry.role}`}
            >
              <small>{entry.role === "user" ? "אתה" : "הכוונה"}</small>
              <p>{entry.text}</p>
            </div>
          ))
        )}

        {send.isPending && (
          <div className="coach-entry coach-entry--assistant coach-entry--thinking" role="status">
            <small>הכוונה</small>
            <div className="coach-thinking-row">
              <div className="coach-thinking-dots" aria-hidden="true">
                <span />
                <span />
                <span />
              </div>
              <p>חושב ומנתח את הנתונים שלך…</p>
            </div>
          </div>
        )}
      </section>

      <form
        className="coach-composer"
        onSubmit={(event) => {
          event.preventDefault();
          if (text.trim() && !send.isPending) send.mutate(text.trim());
        }}
      >
        <label className="visually-hidden" htmlFor="coach-question">
          שאלה להכוונה
        </label>
        <textarea
          id="coach-question"
          rows={2}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="מה יעזור לך עכשיו?"
          disabled={history.isLoading || send.isPending}
        />
        <button type="submit" disabled={!text.trim() || history.isLoading || send.isPending}>
          {send.isPending ? "חושב…" : "שליחה"}
        </button>
      </form>

      <p className="fine-print">
        ההכוונה אינה אבחון או טיפול רפואי. במצב חירום יש לפנות לשירותי החירום המקומיים.
      </p>
    </div>
  );
}
