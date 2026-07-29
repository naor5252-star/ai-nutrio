import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { apiRequest } from "../../app/api";
import type { MealSummary, TargetRow } from "../../app/types";
import "./HomeHealth.css";

type GarminStatusResponse = {
  shortcutBridge: {
    configured: boolean;
    lastSuccessfulSyncAt: string | null;
    latestDaily: {
      localDate: string;
      steps: number | null;
      activeEnergyKcal: number | null;
      restingEnergyKcal: number | null;
      walkingRunningDistanceKm: number | null;
      importedAt: string;
    } | null;
  };
};

const STEP_GOAL = 10_000;
const HEALTH_SHORTCUT_NAME = "update app";

function todayLocal(): string {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function formatNumber(value: number): string {
  return Math.round(value).toLocaleString("he-IL");
}

function buildHealthShortcutUrl(): string {
  return `shortcuts://run-shortcut?name=${encodeURIComponent(HEALTH_SHORTCUT_NAME)}`;
}

function formatSyncTime(value: string | null): string {
  if (!value) return "עדיין לא בוצע סנכרון";

  const syncedAt = new Date(value);
  if (Number.isNaN(syncedAt.getTime())) return "זמן הסנכרון אינו זמין";

  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - syncedAt.getTime()) / 60_000));
  if (elapsedMinutes < 1) return "עודכן עכשיו";
  if (elapsedMinutes === 1) return "עודכן לפני דקה";
  if (elapsedMinutes < 60) return `עודכן לפני ${elapsedMinutes} דקות`;

  return `עודכן ב־${new Intl.DateTimeFormat("he-IL", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(syncedAt)}`;
}

export function HomePage(): React.JSX.Element {
  const date = todayLocal();
  const profile = useQuery({
    queryKey: ["profile"],
    queryFn: () =>
      apiRequest<{ profile: Record<string, unknown> | null; targets: TargetRow | null }>(
        "/api/v1/profile",
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
  const health = useQuery({
    queryKey: ["garmin", "home"],
    queryFn: () => apiRequest<GarminStatusResponse>("/api/v1/garmin/status"),
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
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

  const latestDaily = health.data?.shortcutBridge.latestDaily;
  const todayHealth = latestDaily?.localDate === date ? latestDaily : null;
  const steps = todayHealth?.steps ?? 0;
  const stepProgress = Math.min(100, (steps / STEP_GOAL) * 100);
  const stepsRemaining = Math.max(0, STEP_GOAL - steps);
  const activeEnergy = todayHealth?.activeEnergyKcal ?? 0;
  const restingEnergy = todayHealth?.restingEnergyKcal ?? 0;
  const totalBurned = activeEnergy + restingEnergy;
  const calorieBalance = totalBurned - totals.calories;
  const balanceProgress =
    totalBurned > 0 ? Math.min(100, (totals.calories / totalBurned) * 100) : 0;
  const syncTime =
    todayHealth?.importedAt ?? health.data?.shortcutBridge.lastSuccessfulSyncAt ?? null;

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

      <section className="health-dashboard" aria-labelledby="activity-title">
        <div className="health-dashboard__heading">
          <div>
            <p className="eyebrow">פעילות</p>
            <h2 id="activity-title">התנועה שלך היום</h2>
          </div>
          <div className="health-dashboard__sync">
            <small>{health.isFetching ? "מסנכרנים…" : formatSyncTime(syncTime)}</small>
            <a className="health-sync-button" href={buildHealthShortcutUrl()}>
              <span aria-hidden="true">↻</span>
              סנכרן Apple Health
            </a>
          </div>
        </div>

        {health.isLoading ? (
          <p className="health-dashboard__state">טוענים נתוני פעילות…</p>
        ) : health.isError ? (
          <p className="health-dashboard__state">לא הצלחנו לטעון את נתוני הפעילות כרגע.</p>
        ) : !todayHealth ? (
          <div className="health-dashboard__empty">
            <strong>אין עדיין נתוני Apple Health להיום</strong>
            <span>לחץ על „סנכרן Apple Health”, והנתונים יופיעו כאן לאחר שהקיצור יסתיים.</span>
            <Link to="/settings">להגדרות החיבור ←</Link>
          </div>
        ) : (
          <div className="health-dashboard__grid">
            <article className="steps-card">
              <div
                className={`steps-card__dial${steps >= STEP_GOAL ? " is-complete" : ""}`}
                style={{ "--step-progress": `${stepProgress * 3.6}deg` } as React.CSSProperties}
                aria-label={`${formatNumber(steps)} צעדים מתוך ${formatNumber(STEP_GOAL)}`}
              >
                <div className="steps-card__center">
                  <strong>{formatNumber(steps)}</strong>
                  <span>צעדים היום</span>
                </div>
              </div>
              <div className="steps-card__details">
                <div>
                  <span>יעד</span>
                  <b>{formatNumber(STEP_GOAL)}</b>
                </div>
                <div>
                  <span>{steps >= STEP_GOAL ? "מצב" : "נותרו"}</span>
                  <b>{steps >= STEP_GOAL ? "🎉 הושג" : formatNumber(stepsRemaining)}</b>
                </div>
                {todayHealth.walkingRunningDistanceKm !== null && (
                  <div>
                    <span>מרחק</span>
                    <b>
                      {todayHealth.walkingRunningDistanceKm.toLocaleString("he-IL", {
                        maximumFractionDigits: 1,
                      })}{" "}
                      ק״מ
                    </b>
                  </div>
                )}
              </div>
            </article>

            <article className="energy-card">
              <div className="energy-card__header">
                <div>
                  <span>סה״כ נשרפו</span>
                  <strong>{formatNumber(totalBurned)}</strong>
                  <small>קלוריות</small>
                </div>
                <span aria-hidden="true">🔥</span>
              </div>
              <div className="energy-card__rows">
                <EnergyRow className="is-active" label="קלוריות פעילות" value={activeEnergy} />
                <EnergyRow className="is-resting" label="קלוריות מנוחה" value={restingEnergy} />
                <EnergyRow
                  className="is-goal"
                  label="יעד קלוריות יומי"
                  value={calorieTarget > 0 ? calorieTarget : null}
                />
              </div>
            </article>
            <article className={`calorie-balance-card${calorieBalance < 0 ? " is-surplus" : ""}`}>
              <div
                className="calorie-balance-card__dial"
                style={
                  {
                    "--balance-progress": `${balanceProgress * 3.6}deg`,
                  } as React.CSSProperties
                }
              >
                <div className="calorie-balance-card__center">
                  <span>{calorieBalance >= 0 ? "גירעון עד כה" : "עודף עד כה"}</span>
                  <strong>{formatNumber(Math.abs(calorieBalance))}</strong>
                  <small>קלוריות</small>
                </div>
              </div>
              <div className="calorie-balance-card__details">
                <div>
                  <span>נשרפו</span>
                  <b>{formatNumber(totalBurned)} קל׳</b>
                </div>
                <div>
                  <span>נאכלו</span>
                  <b>{formatNumber(totals.calories)} קל׳</b>
                </div>
                <p>מאזן עדכני לפי Apple Health והארוחות שתועדו. הוא משתנה במהלך היום.</p>
              </div>
            </article>
          </div>
        )}
      </section>

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

function EnergyRow({
  className,
  label,
  value,
}: {
  className: string;
  label: string;
  value: number | null;
}): React.JSX.Element {
  return (
    <div className={`energy-card__row ${className}`}>
      <span className="energy-card__dot" aria-hidden="true" />
      <span>{label}</span>
      <b>{value === null ? "—" : formatNumber(value)}</b>
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
