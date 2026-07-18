import { useState } from "react";
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

export function CoachPage(): React.JSX.Element {
  const [text, setText] = useState("");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const next = useQuery({
    queryKey: ["coach-next", todayLocal()],
    queryFn: () =>
      apiRequest<{ headlineHe: string; messageHe: string; actionHe: string }>(
        `/api/v1/coach/next?date=${todayLocal()}`,
      ),
  });
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
        <p>המלצות קצרות לפי מה שבחרת לשמור, לא לפי ניחושים.</p>
      </section>
      {next.data && (
        <section className="coach-focus">
          <span>היום</span>
          <h2>{next.data.headlineHe}</h2>
          <p>{next.data.messageHe}</p>
        </section>
      )}
      <section className="prompt-starters" aria-label="שאלות מוצעות">
        {["מה כדאי לאכול בהמשך?", "איך להוסיף יותר חלבון?", "תן לי רעיון לארוחה מהירה"].map(
          (prompt) => (
            <button key={prompt} onClick={() => setText(prompt)}>
              {prompt}
            </button>
          ),
        )}
      </section>
      <section className="coach-conversation" aria-live="polite">
        {entries.length === 0 ? (
          <div className="coach-empty">
            <span>↗</span>
            <p>אפשר לשאול שאלה קצרה. התשובה תישען על היומן והיעדים שאישרת.</p>
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
      </section>
      <form
        className="coach-composer"
        onSubmit={(event) => {
          event.preventDefault();
          if (text.trim()) send.mutate(text.trim());
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
        />
        <button type="submit" disabled={!text.trim() || send.isPending}>
          שליחה
        </button>
      </form>
      <p className="fine-print">
        ההכוונה אינה אבחון או טיפול רפואי. במצב חירום יש לפנות לשירותי החירום המקומיים.
      </p>
    </div>
  );
}
