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

type HealthTrendDay = {
  localDate: string;
  steps: number | null;
  activeEnergyKcal: number | null;
  restingEnergyKcal: number | null;
  totalBurnedKcal: number | null;
  sleepMinutes: number | null;
  intakeCalories: number;
  proteinGrams: number;
  carbohydrateGrams: number;
  fatGrams: number;
  mealCount: number;
  balanceCalories: number | null;
  workoutCount: number;
  workoutMinutes: number;
  workoutActiveEnergyKcal: number;
};

type HealthTrendsResponse = {
  startDate: string;
  endDate: string;
  days: HealthTrendDay[];
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

function shiftIsoDate(localDate: string, offsetDays: number): string {
  const value = new Date(`${localDate}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + offsetDays);
  return value.toISOString().slice(0, 10);
}

function startOfIsraeliWeek(localDate: string): string {
  const value = new Date(`${localDate}T12:00:00Z`);
  return shiftIsoDate(localDate, -value.getUTCDay());
}

function shortWeekday(localDate: string): string {
  return new Intl.DateTimeFormat("he-IL", {
    weekday: "short",
    timeZone: "UTC",
  }).format(new Date(`${localDate}T12:00:00Z`));
}

function formatDuration(minutes: number): string {
  const rounded = Math.max(0, Math.round(minutes));
  const hours = Math.floor(rounded / 60);
  const rest = rounded % 60;
  if (hours === 0) return `${rest} דק׳`;
  if (rest === 0) return `${hours} ש׳`;
  return `${hours}:${String(rest).padStart(2, "0")} ש׳`;
}

function blankTrendDay(localDate: string): HealthTrendDay {
  return {
    localDate,
    steps: null,
    activeEnergyKcal: null,
    restingEnergyKcal: null,
    totalBurnedKcal: null,
    sleepMinutes: null,
    intakeCalories: 0,
    proteinGrams: 0,
    carbohydrateGrams: 0,
    fatGrams: 0,
    mealCount: 0,
    balanceCalories: null,
    workoutCount: 0,
    workoutMinutes: 0,
    workoutActiveEnergyKcal: 0,
  };
}

function average(values: Array<number | null>): number | null {
  const defined = values.filter((value): value is number => value !== null);
  if (defined.length === 0) return null;
  return defined.reduce((sum, value) => sum + value, 0) / defined.length;
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
  const trends = useQuery({
    queryKey: ["garmin", "trends", date],
    queryFn: () =>
      apiRequest<HealthTrendsResponse>(`/api/v1/garmin/trends?end=${date}&days=35`),
    refetchInterval: 5 * 60_000,
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

  const trendDays = trends.data?.days ?? [];
  const trendByDate = new Map(trendDays.map((day) => [day.localDate, day]));
  const weekStart = startOfIsraeliWeek(date);
  const weekDays = Array.from({ length: 7 }, (_, index) => {
    const localDate = shiftIsoDate(weekStart, index);
    return trendByDate.get(localDate) ?? blankTrendDay(localDate);
  });
  const weekToDate = weekDays.filter((day) => day.localDate <= date);
  const knownWeekBalances = weekToDate.filter(
    (day): day is HealthTrendDay & { balanceCalories: number } => day.balanceCalories !== null,
  );
  const weekBalance = knownWeekBalances.reduce((sum, day) => sum + day.balanceCalories, 0);
  const weekConsumed = weekToDate.reduce((sum, day) => sum + day.intakeCalories, 0);
  const weeklyFoodBudget = calorieTarget > 0 ? calorieTarget * 7 : null;
  const weeklyFoodBudgetDelta =
    weeklyFoodBudget === null ? null : weeklyFoodBudget - weekConsumed;
  const weekDeficitDays = knownWeekBalances.filter((day) => day.balanceCalories > 0).length;
  const weekWorkoutMinutes = weekToDate.reduce((sum, day) => sum + day.workoutMinutes, 0);
  const weekMealDays = weekToDate.filter((day) => day.mealCount > 0).length;

  const monthDays = trendDays.slice(-30);
  const knownMonthBalances = monthDays.filter(
    (day): day is HealthTrendDay & { balanceCalories: number } => day.balanceCalories !== null,
  );
  const monthBalance = knownMonthBalances.reduce((sum, day) => sum + day.balanceCalories, 0);
  const monthMealDays = monthDays.filter((day) => day.mealCount > 0);
  const monthAverageIntake =
    monthMealDays.length > 0
      ? monthMealDays.reduce((sum, day) => sum + day.intakeCalories, 0) / monthMealDays.length
      : null;
  const monthAverageProtein =
    monthMealDays.length > 0
      ? monthMealDays.reduce((sum, day) => sum + day.proteinGrams, 0) / monthMealDays.length
      : null;
  const monthActiveEnergy = monthDays.reduce(
    (sum, day) => sum + (day.activeEnergyKcal ?? 0),
    0,
  );
  const monthWorkoutMinutes = monthDays.reduce((sum, day) => sum + day.workoutMinutes, 0);
  const monthAverageSteps = average(monthDays.map((day) => day.steps));
  const monthAverageSleep = average(monthDays.map((day) => day.sleepMinutes));

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
          </div>
        )}

        <section className="trend-dashboard" aria-labelledby="trend-title">
          <div className="trend-dashboard__heading">
            <div>
              <p className="eyebrow">מגמות</p>
              <h2 id="trend-title">השבוע והחודש שלך</h2>
            </div>
            <small>המאזן מבוסס על Apple Health ועל ארוחות שתועדו באפליקציה.</small>
          </div>

          {trends.isLoading ? (
            <p className="health-dashboard__state">טוענים מגמות…</p>
          ) : trends.isError ? (
            <p className="health-dashboard__state">לא הצלחנו לטעון את המגמות כרגע.</p>
          ) : (
            <div className="trend-dashboard__panels">
              <article className="weekly-balance-panel">
                <div className="trend-panel__title">
                  <div>
                    <span>ראשון–שבת</span>
                    <h3>מאזן קלורי שבועי</h3>
                  </div>
                  <strong
                    className={
                      knownWeekBalances.length === 0
                        ? ""
                        : weekBalance >= 0
                          ? "is-deficit"
                          : "is-surplus"
                    }
                  >
                    {knownWeekBalances.length === 0
                      ? "—"
                      : `${weekBalance >= 0 ? "גירעון " : "עודף "}${formatNumber(Math.abs(weekBalance))} קל׳`}
                  </strong>
                </div>

                <WeeklyBalanceChart days={weekDays} today={date} />

                <div className="weekly-summary-grid">
                  <div>
                    <span>נותרו בתקציב האכילה השבועי</span>
                    <b
                      className={
                        weeklyFoodBudgetDelta !== null && weeklyFoodBudgetDelta < 0
                          ? "is-surplus"
                          : ""
                      }
                    >
                      {weeklyFoodBudgetDelta === null
                        ? "—"
                        : weeklyFoodBudgetDelta >= 0
                          ? `${formatNumber(weeklyFoodBudgetDelta)} קל׳`
                          : `חריגה ${formatNumber(Math.abs(weeklyFoodBudgetDelta))} קל׳`}
                    </b>
                  </div>
                  <div>
                    <span>ימי גירעון</span>
                    <b>
                      {knownWeekBalances.length === 0
                        ? "—"
                        : `${weekDeficitDays}/${knownWeekBalances.length}`}
                    </b>
                  </div>
                  <div>
                    <span>אימון השבוע</span>
                    <b>{formatDuration(weekWorkoutMinutes)}</b>
                  </div>
                  <div>
                    <span>ימי אכילה מתועדים</span>
                    <b>{weekMealDays}/{weekToDate.length}</b>
                  </div>
                </div>
                <p className="trend-note">
                  „תקציב האכילה” מחושב מהיעד היומי כפול 7. המאזן הקלורי עצמו הוא נשרפו פחות נאכלו;
                  היום הנוכחי הוא נתון חלקי עד לסיום היום.
                </p>
              </article>

              <article className="monthly-trend-panel">
                <div className="trend-panel__title">
                  <div>
                    <span>30 הימים האחרונים</span>
                    <h3>חודש במבט אחד</h3>
                  </div>
                  <strong
                    className={
                      knownMonthBalances.length === 0
                        ? ""
                        : monthBalance >= 0
                          ? "is-deficit"
                          : "is-surplus"
                    }
                  >
                    {knownMonthBalances.length === 0
                      ? "אין מספיק נתונים"
                      : `${monthBalance >= 0 ? "גירעון " : "עודף "}${formatNumber(Math.abs(monthBalance))} קל׳`}
                  </strong>
                </div>

                <MonthTrendGrid days={monthDays} today={date} />

                <div className="monthly-metrics-grid">
                  <TrendMetric
                    label="אכילה ממוצעת"
                    value={
                      monthAverageIntake === null
                        ? "—"
                        : `${formatNumber(monthAverageIntake)} קל׳`
                    }
                  />
                  <TrendMetric
                    label="חלבון ממוצע"
                    value={
                      monthAverageProtein === null
                        ? "—"
                        : `${formatNumber(monthAverageProtein)} ג׳`
                    }
                  />
                  <TrendMetric
                    label="קלוריות פעילות"
                    value={`${formatNumber(monthActiveEnergy)} קל׳`}
                  />
                  <TrendMetric label="זמן אימון" value={formatDuration(monthWorkoutMinutes)} />
                  <TrendMetric
                    label="צעדים ממוצעים"
                    value={monthAverageSteps === null ? "—" : formatNumber(monthAverageSteps)}
                  />
                  <TrendMetric
                    label="שינה ממוצעת"
                    value={monthAverageSleep === null ? "—" : formatDuration(monthAverageSleep)}
                  />
                </div>
                <div className="month-trend-legend">
                  <span><i className="is-deficit" /> גירעון</span>
                  <span><i className="is-surplus" /> עודף</span>
                  <span><i className="is-meal" /> אכילה תועדה</span>
                  <span><i className="is-workout" /> אימון</span>
                </div>
              </article>
            </div>
          )}
        </section>
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

function WeeklyBalanceChart({
  days,
  today,
}: {
  days: HealthTrendDay[];
  today: string;
}): React.JSX.Element {
  const maxMagnitude = Math.max(1, ...days.map((day) => Math.abs(day.balanceCalories ?? 0)));

  return (
    <div className="weekly-balance-chart" aria-label="גרף מאזן קלורי שבועי">
      {days.map((day) => {
        const balance = day.balanceCalories;
        const isFuture = day.localDate > today;
        const magnitude = balance === null ? 0 : Math.max(8, (Math.abs(balance) / maxMagnitude) * 46);

        return (
          <div
            className={`weekly-balance-day${day.localDate === today ? " is-today" : ""}`}
            key={day.localDate}
            title={
              balance === null
                ? `${shortWeekday(day.localDate)}: אין נתוני מאזן`
                : `${shortWeekday(day.localDate)}: ${balance >= 0 ? "גירעון" : "עודף"} ${formatNumber(Math.abs(balance))} קל׳ · נאכלו ${formatNumber(day.intakeCalories)} · נשרפו ${formatNumber(day.totalBurnedKcal ?? 0)}`
            }
          >
            <span className="weekly-balance-day__value">
              {isFuture || balance === null
                ? "—"
                : `${balance >= 0 ? "+" : "−"}${formatNumber(Math.abs(balance))}`}
            </span>
            <div className="weekly-balance-day__plot">
              <span className="weekly-balance-day__zero" />
              {!isFuture && balance !== null && (
                <span
                  className={`weekly-balance-day__bar ${balance >= 0 ? "is-deficit" : "is-surplus"}`}
                  style={{ "--balance-size": `${magnitude}%` } as React.CSSProperties}
                />
              )}
            </div>
            <b>{shortWeekday(day.localDate)}</b>
          </div>
        );
      })}
    </div>
  );
}

function MonthTrendGrid({
  days,
  today,
}: {
  days: HealthTrendDay[];
  today: string;
}): React.JSX.Element {
  return (
    <div className="month-trend-grid" aria-label="מגמות ב-30 הימים האחרונים">
      {days.map((day) => {
        const balanceClass =
          day.balanceCalories === null
            ? "is-missing"
            : day.balanceCalories >= 0
              ? "is-deficit"
              : "is-surplus";
        const dayNumber = Number(day.localDate.slice(-2));

        return (
          <div
            key={day.localDate}
            className={`month-trend-day ${balanceClass}${day.localDate === today ? " is-today" : ""}`}
            title={`${day.localDate} · ${
              day.balanceCalories === null
                ? "אין מאזן"
                : `${day.balanceCalories >= 0 ? "גירעון" : "עודף"} ${formatNumber(Math.abs(day.balanceCalories))} קל׳`
            } · ${day.mealCount} ארוחות · ${formatDuration(day.workoutMinutes)}`}
          >
            <span>{dayNumber}</span>
            <div className="month-trend-day__signals">
              {day.mealCount > 0 && <i className="is-meal" aria-label="אכילה תועדה" />}
              {day.workoutMinutes > 0 && <i className="is-workout" aria-label="אימון תועד" />}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TrendMetric({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="trend-metric">
      <span>{label}</span>
      <b>{value}</b>
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
