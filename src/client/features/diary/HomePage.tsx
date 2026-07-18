import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { apiRequest } from "../../app/api";
import type { MealSummary, TargetRow } from "../../app/types";

function todayLocal(): string {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function HomePage(): React.JSX.Element {
  const date = todayLocal();
  const profile = useQuery({
    queryKey: ["profile"],
    queryFn: () =>
      apiRequest<{ profile: Record<string, unknown> | null; targets: TargetRow | null }>(
        "/api/v1/profile/",
      ),
  });
  const diary = useQuery({
    queryKey: ["meals", date],
    queryFn: () => apiRequest<{ meals: MealSummary[] }>(`/api/v1/meals/?date=${date}`),
  });
  const coach = useQuery({
    queryKey: ["coach-next", date],
    queryFn: () =>
      apiRequest<{ headlineHe: string; messageHe: string; actionHe: string; actionPath?: string }>(
        `/api/v1/coach/next?date=${date}`,
      ),
  });

  const meals = diary.data?.meals ?? [];
  const totals = meals.reduce(
    (sum, meal) => ({
      calories: sum.calories + (meal.total_calories ?? 0),
      protein: sum.protein + (meal.total_protein_grams ?? 0),
      carbs: sum.carbs + (meal.total_carbohydrate_grams ?? 0),
      fat: sum.fat + (meal.total_fat_grams ?? 0),
    }),
    { calories: 0, protein: 0, carbs: 0, fat: 0 },
  );
  const targets = profile.data?.targets;
  const calorieTarget = targets?.effective_calories ?? 0;
  const remaining = Math.max(0, calorieTarget - totals.calories);
  const progress = calorieTarget > 0 ? Math.min(100, (totals.calories / calorieTarget) * 100) : 0;

  return (
    <div className="page home-page">
      <section className="day-intro">
        <p className="eyebrow">היום שלך</p>
        <h1>
          {new Intl.DateTimeFormat("he-IL", {
            weekday: "long",
            day: "numeric",
            month: "long",
          }).format(new Date())}
        </h1>
        <p>לא צריך יום מושלם. רק תמונה ברורה של מה שקורה.</p>
      </section>

      {!profile.isLoading && !profile.data?.profile && (
        <Link to="/settings" className="profile-nudge">
          <strong>נגדיר יעד אישי?</strong>
          <span>כמה פרטים קצרים, ואפשר יהיה לראות מה נשאר להיום.</span>
          <b>להשלמת הפרופיל ←</b>
        </Link>
      )}

      <section className="remaining-orbit" aria-labelledby="remaining-title">
        <div
          className="remaining-orbit__dial"
          style={{ "--progress": `${progress * 3.6}deg` } as React.CSSProperties}
        >
          <div className="remaining-orbit__center">
            <span id="remaining-title">נשאר להיום</span>
            <strong>
              {calorieTarget > 0 ? Math.round(remaining).toLocaleString("he-IL") : "—"}
            </strong>
            <small>קלוריות</small>
          </div>
        </div>
        <div className="remaining-orbit__macros">
          <MacroLine
            label="חלבון"
            value={totals.protein}
            target={targets?.effective_protein_grams ?? null}
          />
          <MacroLine
            label="פחמימות"
            value={totals.carbs}
            target={targets?.carbohydrate_grams ?? null}
          />
          <MacroLine label="שומן" value={totals.fat} target={targets?.fat_grams ?? null} />
        </div>
      </section>

      <Link to="/add" className="camera-entry">
        <span className="camera-entry__lens" aria-hidden="true">
          ◎
        </span>
        <span>
          <strong>מה אכלתי?</strong>
          <small>צלם ארוחה או בחר תמונה</small>
        </span>
        <b aria-hidden="true">←</b>
      </Link>

      <section className="meal-moments" aria-labelledby="moments-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">רגעי האוכל</p>
            <h2 id="moments-title">מה כבר תועד</h2>
          </div>
          <Link to="/diary">לכל היומן</Link>
        </div>
        {diary.isLoading ? (
          <p className="quiet-state">טוענים את היומן…</p>
        ) : meals.length === 0 ? (
          <div className="empty-timeline">
            <span aria-hidden="true">○</span>
            <p>עוד לא תועדה ארוחה היום.</p>
            <Link to="/add">נתחיל מהארוחה הבאה</Link>
          </div>
        ) : (
          <ol className="meal-timeline">
            {meals.map((meal) => (
              <li key={meal.id}>
                <time>
                  {new Intl.DateTimeFormat("he-IL", { hour: "2-digit", minute: "2-digit" }).format(
                    new Date(meal.occurred_at),
                  )}
                </time>
                <span className="meal-timeline__dot" aria-hidden="true" />
                <div>
                  <strong>{meal.title}</strong>
                  <small>
                    {meal.total_calories === null
                      ? "קלוריות: לא ידוע"
                      : `${Math.round(meal.total_calories)} קלוריות`}
                  </small>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      {coach.data && (
        <section className="coach-note">
          <div className="coach-note__tab">הצעד הבא</div>
          <h2>{coach.data.headlineHe}</h2>
          <p>{coach.data.messageHe}</p>
          <Link to={coach.data.actionPath ?? "/coach"}>{coach.data.actionHe} ←</Link>
        </section>
      )}

      <div className="home-links">
        <Link to="/shopping">רשימת קניות משותפת</Link>
        <Link to="/products">מוצרים וברקודים</Link>
      </div>
    </div>
  );
}

function MacroLine({
  label,
  value,
  target,
}: {
  label: string;
  value: number;
  target: number | null;
}): React.JSX.Element {
  const percentage = target && target > 0 ? Math.min(100, (value / target) * 100) : 0;
  return (
    <div className="macro-line">
      <div>
        <span>{label}</span>
        <b>
          {Math.round(value)}
          {target ? ` / ${Math.round(target)}` : ""} גרם
        </b>
      </div>
      <div className="macro-line__track">
        <span style={{ width: `${percentage}%` }} />
      </div>
    </div>
  );
}
