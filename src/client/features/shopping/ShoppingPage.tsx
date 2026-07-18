import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest, ClientApiError } from "../../app/api";

type ShoppingItem = {
  id: string;
  text: string;
  quantity: number;
  unit: string;
  purchased: number;
  updated_at: string;
  version: number;
  created_by_email: string;
  updated_by_email: string;
};

export function ShoppingPage(): React.JSX.Element {
  const [text, setText] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["shopping"],
    queryFn: () => apiRequest<{ items: ShoppingItem[] }>("/api/v1/shopping-list/"),
  });
  const add = useMutation({
    mutationFn: () =>
      apiRequest(
        "/api/v1/shopping-list/items",
        {
          method: "POST",
          body: JSON.stringify({
            text,
            quantity: 1,
            unit: "יחידה",
            clientMutationId: crypto.randomUUID(),
          }),
        },
        { queueOffline: true },
      ),
    onSuccess: async () => {
      setText("");
      setMessage("נוסף לרשימה");
      await queryClient.invalidateQueries({ queryKey: ["shopping"] });
    },
    onError: (error) =>
      setMessage(error instanceof ClientApiError ? error.messageHe : "לא הצלחנו להוסיף את הפריט"),
  });
  const toggle = useMutation({
    mutationFn: (item: ShoppingItem) =>
      apiRequest(
        `/api/v1/shopping-list/items/${item.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            purchased: !item.purchased,
            updatedAt: new Date().toISOString(),
            version: item.version,
          }),
        },
        { queueOffline: true },
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["shopping"] }),
  });
  const items = query.data?.items ?? [];
  return (
    <div className="page shopping-page">
      <section className="page-title">
        <p className="eyebrow">משותף לבית</p>
        <h1>רשימת קניות</h1>
        <p>שני בני הבית יכולים להוסיף, לעדכן ולסמן.</p>
      </section>
      <form
        className="shopping-add"
        onSubmit={(event) => {
          event.preventDefault();
          if (text.trim()) add.mutate();
        }}
      >
        <label className="visually-hidden" htmlFor="shopping-text">
          פריט חדש
        </label>
        <input
          id="shopping-text"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="מה חסר בבית?"
        />
        <button type="submit" disabled={!text.trim()}>
          +
        </button>
      </form>
      {message && (
        <p className="status-message" role="status">
          {message}
        </p>
      )}
      {items.length === 0 ? (
        <div className="large-empty">
          <span>□</span>
          <h2>הרשימה עדיין ריקה</h2>
          <p>אפשר להוסיף מוצר או טקסט חופשי.</p>
        </div>
      ) : (
        <ul className="shopping-list">
          {items.map((item) => (
            <li key={item.id} className={item.purchased ? "is-purchased" : ""}>
              <button
                className="shopping-check"
                aria-label={
                  item.purchased ? `החזרת ${item.text} לרשימה` : `סימון ${item.text} כנרכש`
                }
                onClick={() => toggle.mutate(item)}
              >
                {item.purchased ? "✓" : ""}
              </button>
              <div>
                <strong>{item.text}</strong>
                <small>
                  {item.quantity} {item.unit} · עודכן על ידי {item.updated_by_email.split("@")[0]}
                </small>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
