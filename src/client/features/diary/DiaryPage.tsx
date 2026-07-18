import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { apiRequest } from "../../app/api";
import type { MealSummary } from "../../app/types";

function isoDate(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function DiaryPage(): React.JSX.Element {
  const [date, setDate] = useState(isoDate(new Date()));
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["meals", date],
    queryFn: () => apiRequest<{ meals: MealSummary[] }>(`/api/v1/meals/?date=${date}`),
  });
  const favorite = useMutation({
    mutationFn: (id: string) => apiRequest(`/api/v1/meals/${id}/favorite`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["meals", date] }),
  });
  const meals = query.data?.meals ?? [];
  return (
    <div className="page diary-page">
      <section className="page-title">
        <p className="eyebrow">היומן שלי</p>
        <h1>כל רגע במקום שלו</h1>
        <p>ערכים חסרים נשארים “לא ידוע” ולא נספרים כאפס.</p>
      </section>
      <div className="date-switcher">
        <button
          onClick={() => setDate(isoDate(new Date(new Date(date).getTime() - 86_400_000)))}
          aria-label="יום קודם"
        >
          →
        </button>
        <label>
          <span>תאריך</span>
          <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
        </label>
        <button
          onClick={() => setDate(isoDate(new Date(new Date(date).getTime() + 86_400_000)))}
          aria-label="יום הבא"
        >
          ←
        </button>
      </div>
      {meals.length === 0 ? (
        <div className="large-empty">
          <span>○</span>
          <h2>אין ארוחות ביום הזה</h2>
          <p>אפשר לצלם ארוחה או להוסיף אותה ידנית.</p>
          <Link className="primary-action" to="/add">
            הוספת ארוחה
          </Link>
        </div>
      ) : (
        <ol className="diary-stream">
          {meals.map((meal) => {
            const partial = JSON.parse(meal.partial_nutrients_json) as unknown[];
            return (
              <li key={meal.id} className="diary-entry">
                <div className="diary-entry__time">
                  <time>
                    {new Intl.DateTimeFormat("he-IL", {
                      hour: "2-digit",
                      minute: "2-digit",
                    }).format(new Date(meal.occurred_at))}
                  </time>
                  <span />
                </div>
                <div className="diary-entry__body">
                  <div>
                    <small>{categoryName(meal.category)}</small>
                    <h2>{meal.title}</h2>
                  </div>
                  <div className="nutrient-ribbon">
                    <Nutrient label="קל׳" value={meal.total_calories} />
                    <Nutrient label="חלבון" value={meal.total_protein_grams} />
                    <Nutrient label="פחמ׳" value={meal.total_carbohydrate_grams} />
                    <Nutrient label="שומן" value={meal.total_fat_grams} />
                  </div>
                  {partial.length > 0 && (
                    <p className="partial-note">◐ סה״כ חלקי — מידע לא ידוע לא נכלל</p>
                  )}
                  <div className="entry-actions">
                    <Link to={`/diary/${meal.id}`}>פרטים</Link>
                    <button onClick={() => favorite.mutate(meal.id)}>
                      {meal.favorite ? "מועדף" : "שמירה כמועדף"}
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

function Nutrient({ label, value }: { label: string; value: number | null }): React.JSX.Element {
  return (
    <span>
      <b>{value === null ? "?" : Math.round(value)}</b>
      <small>{label}</small>
    </span>
  );
}

function categoryName(category: string): string {
  return (
    (
      {
        breakfast: "ארוחת בוקר",
        lunch: "ארוחת צהריים",
        dinner: "ארוחת ערב",
        snack: "נשנוש",
        drink: "שתייה",
        custom: "ארוחה",
      } as Record<string, string>
    )[category] ?? "ארוחה"
  );
}
