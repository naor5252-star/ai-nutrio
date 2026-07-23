import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest, ClientApiError } from "../../app/api";

type ProfileRow = {
  date_of_birth: string;
  sex_for_formula: "male" | "female";
  height_cm: number;
  current_weight_kg: number;
  target_weight_kg: number | null;
  activity_level: string;
  primary_goal: string;
  goal_intensity: string;
  manual_calorie_target: number | null;
  manual_protein_target: number | null;
};

type HouseholdResponse = {
  household: { id: string; name: string } | null;
  members: Array<{ id: string; email: string; role: string }>;
};

type GarminStatusResponse = {
  enabled: boolean;
  approvedProviderConfigured: boolean;
  messageHe: string;
  shortcutBridge: {
    configured: boolean;
    status: string;
    lastSuccessfulSyncAt: string | null;
    lastErrorCode: string | null;
    importUrl: string;
    latestDaily: {
      localDate: string;
      steps: number | null;
      activeEnergyKcal: number | null;
      restingEnergyKcal: number | null;
      walkingRunningDistanceKm: number | null;
      restingHeartRateBpm: number | null;
      sleepMinutes: number | null;
      weightKg: number | null;
      bodyFatPercentage: number | null;
      importedAt: string;
    } | null;
    recentWorkouts: Array<{
      workoutType: string;
      startAt: string;
      durationMinutes: number;
      activeEnergyKcal: number | null;
      distanceKm: number | null;
    }>;
  };
};

type ShortcutTokenResponse = {
  token: string;
  importUrl: string;
  messageHe: string;
};

export function SettingsPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [shortcutToken, setShortcutToken] = useState<ShortcutTokenResponse | null>(null);
  const profile = useQuery({
    queryKey: ["profile"],
    queryFn: () =>
      apiRequest<{ profile: ProfileRow | null; targets: Record<string, unknown> | null }>(
        "/api/v1/profile",
      ),
  });
  const household = useQuery({
    queryKey: ["household"],
    queryFn: () => apiRequest<HouseholdResponse>("/api/v1/households/current"),
  });
  const garmin = useQuery({
    queryKey: ["garmin"],
    queryFn: () => apiRequest<GarminStatusResponse>("/api/v1/garmin/status"),
  });
  const createShortcutToken = useMutation({
    mutationFn: () =>
      apiRequest<ShortcutTokenResponse>("/api/v1/garmin/shortcut/token", {
        method: "POST",
      }),
    onSuccess: async (result) => {
      setShortcutToken(result);
      setMessage("מפתח החיבור נוצר. הוא מוצג פעם אחת בלבד.");
      await queryClient.invalidateQueries({ queryKey: ["garmin"] });
    },
    onError: (error) =>
      setMessage(
        error instanceof ClientApiError ? error.messageHe : "לא הצלחנו ליצור מפתח ל־Shortcut",
      ),
  });
  const disconnectShortcut = useMutation({
    mutationFn: () =>
      apiRequest("/api/v1/garmin/shortcut/token", {
        method: "DELETE",
      }),
    onSuccess: async () => {
      setShortcutToken(null);
      setMessage("הגשר נותק והמפתח הקודם בוטל");
      await queryClient.invalidateQueries({ queryKey: ["garmin"] });
    },
    onError: (error) =>
      setMessage(error instanceof ClientApiError ? error.messageHe : "לא הצלחנו לנתק את הגשר"),
  });

  const saveProfile = useMutation({
    mutationFn: (form: HTMLFormElement) => {
      const data = new FormData(form);
      return apiRequest<{ targets: { warningCodes: string[] } }>("/api/v1/profile", {
        method: "PUT",
        body: JSON.stringify({
          dateOfBirth: data.get("dateOfBirth"),
          sexForFormula: data.get("sexForFormula"),
          heightCm: Number(data.get("heightCm")),
          currentWeightKg: Number(data.get("currentWeightKg")),
          targetWeightKg: data.get("targetWeightKg") ? Number(data.get("targetWeightKg")) : null,
          activityLevel: data.get("activityLevel"),
          primaryGoal: data.get("primaryGoal"),
          goalIntensity: data.get("goalIntensity"),
          manualCalorieTarget: data.get("manualCalorieTarget")
            ? Number(data.get("manualCalorieTarget"))
            : null,
          manualProteinTarget: data.get("manualProteinTarget")
            ? Number(data.get("manualProteinTarget"))
            : null,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      });
    },
    onSuccess: async (result) => {
      setMessage(
        result.targets.warningCodes.length > 0
          ? "היעדים נשמרו. מוצגת אזהרה כי התוצאה חריגה; האפליקציה אינה תחליף לייעוץ מקצועי."
          : "הפרופיל והיעדים נשמרו",
      );
      await queryClient.invalidateQueries({ queryKey: ["profile"] });
    },
    onError: (error) =>
      setMessage(error instanceof ClientApiError ? error.messageHe : "לא הצלחנו לשמור את הפרופיל"),
  });
  const createHousehold = useMutation({
    mutationFn: () =>
      apiRequest("/api/v1/households/", {
        method: "POST",
        body: JSON.stringify({ name: "הבית שלנו" }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["household"] }),
  });
  const invite = useMutation({
    mutationFn: () =>
      apiRequest<{ developmentInvitationUrl?: string }>("/api/v1/households/invite", {
        method: "POST",
        body: JSON.stringify({ email: inviteEmail }),
      }),
    onSuccess: (result) => {
      setMessage(
        result.developmentInvitationUrl
          ? `הזמנה נוצרה לפיתוח: ${result.developmentInvitationUrl}`
          : "ההזמנה נשלחה",
      );
      setInviteEmail("");
    },
    onError: (error) =>
      setMessage(error instanceof ClientApiError ? error.messageHe : "לא הצלחנו לשלוח הזמנה"),
  });
  const logout = useMutation({
    mutationFn: () => apiRequest("/api/v1/auth/logout", { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["session"] }),
  });

  const row = profile.data?.profile;
  return (
    <div className="page settings-page">
      <section className="page-title">
        <p className="eyebrow">פרופיל והגדרות</p>
        <h1>המידע נשאר שלך</h1>
        <p>היומן, המדידות והשיחות פרטיים גם בתוך משק הבית.</p>
      </section>
      {message && (
        <p className="status-message" role="status">
          {message}
        </p>
      )}

      <section className="settings-section">
        <h2>היעדים האישיים שלי</h2>
        <form
          className="profile-form"
          key={row?.date_of_birth ?? "new"}
          onSubmit={(event) => {
            event.preventDefault();
            saveProfile.mutate(event.currentTarget);
          }}
        >
          <div className="form-pair">
            <label>
              תאריך לידה
              <input
                name="dateOfBirth"
                type="date"
                required
                defaultValue={row?.date_of_birth ?? "1990-01-01"}
              />
            </label>
            <label>
              ערך לנוסחת הקלוריות
              <select name="sexForFormula" defaultValue={row?.sex_for_formula ?? "male"}>
                <option value="male">זכר</option>
                <option value="female">נקבה</option>
              </select>
            </label>
          </div>
          <div className="form-pair">
            <label>
              גובה, ס״מ
              <input
                name="heightCm"
                inputMode="decimal"
                required
                defaultValue={row?.height_cm ?? 170}
              />
            </label>
            <label>
              משקל נוכחי, ק״ג
              <input
                name="currentWeightKg"
                inputMode="decimal"
                required
                defaultValue={row?.current_weight_kg ?? 65}
              />
            </label>
          </div>
          <label>
            משקל יעד, ק״ג — רשות
            <input
              name="targetWeightKg"
              inputMode="decimal"
              defaultValue={row?.target_weight_kg ?? ""}
            />
          </label>
          <label>
            רמת פעילות
            <select name="activityLevel" defaultValue={row?.activity_level ?? "moderate"}>
              <option value="sedentary">מעט פעילות</option>
              <option value="light">פעילות קלה</option>
              <option value="moderate">פעילות בינונית</option>
              <option value="very_active">פעילות גבוהה</option>
              <option value="extreme">פעילות גבוהה מאוד</option>
            </select>
            <small>Garmin לא משנה את הבחירה הזו אוטומטית.</small>
          </label>
          <label>
            המטרה הראשית
            <select name="primaryGoal" defaultValue={row?.primary_goal ?? "maintenance"}>
              <option value="weight_loss">ירידה במשקל</option>
              <option value="fat_reduction">הפחתת אחוז שומן</option>
              <option value="maintenance">שמירה על המשקל</option>
              <option value="performance">שיפור ביצועים</option>
              <option value="muscle_gain">עלייה במסת שריר</option>
              <option value="general_nutrition">שיפור תזונה כללי</option>
            </select>
          </label>
          <label>
            עוצמת התאמה
            <select name="goalIntensity" defaultValue={row?.goal_intensity ?? "medium"}>
              <option value="moderate">מתונה</option>
              <option value="medium">בינונית</option>
              <option value="increased">מוגברת</option>
            </select>
          </label>
          <details>
            <summary>עריכה ידנית של יעדים</summary>
            <div className="form-pair">
              <label>
                קלוריות
                <input
                  name="manualCalorieTarget"
                  inputMode="numeric"
                  defaultValue={row?.manual_calorie_target ?? ""}
                />
              </label>
              <label>
                חלבון, גרם
                <input
                  name="manualProteinTarget"
                  inputMode="numeric"
                  defaultValue={row?.manual_protein_target ?? ""}
                />
              </label>
            </div>
          </details>
          <button className="primary-action" type="submit">
            חישוב ושמירת יעדים
          </button>
        </form>
      </section>

      <section className="settings-section">
        <h2>משק הבית</h2>
        {!household.data?.household ? (
          <button className="secondary-action" onClick={() => createHousehold.mutate()}>
            יצירת משק בית
          </button>
        ) : (
          <>
            <p>
              <strong>{household.data.household.name}</strong> · {household.data.members.length}{" "}
              חברים
            </p>
            <ul className="member-list">
              {household.data.members.map((member) => (
                <li key={member.id}>
                  {member.email}
                  <small>{member.role === "owner" ? "יוצר הבית" : "חבר"}</small>
                </li>
              ))}
            </ul>
            {household.data.members.length < 2 && (
              <div className="invite-row">
                <input
                  type="email"
                  value={inviteEmail}
                  onChange={(event) => setInviteEmail(event.target.value)}
                  placeholder="אימייל של בן/בת הבית"
                />
                <button onClick={() => invite.mutate()} disabled={!inviteEmail}>
                  הזמנה
                </button>
              </div>
            )}
          </>
        )}
      </section>

      <section className="settings-section garmin-settings">
        <div className="garmin-settings__heading">
          <h2>Garmin ו־Apple Health</h2>
          <span
            className={`garmin-status-pill${
              garmin.data?.shortcutBridge.status === "active" ? " is-active" : ""
            }`}
          >
            {garmin.data?.shortcutBridge.status === "active"
              ? "מחובר"
              : garmin.data?.shortcutBridge.configured
                ? "ממתין לסנכרון"
                : "לא מחובר"}
          </span>
        </div>
        <p>{garmin.data?.messageHe ?? "בודקים את מצב החיבור…"}</p>

        <div className="garmin-bridge-card">
          <div className="garmin-bridge-card__title">
            <span aria-hidden="true">♥</span>
            <div>
              <strong>גשר חינמי דרך Apple Health</strong>
              <small>Garmin Connect → Apple Health → Shortcut → רגע טוב</small>
            </div>
          </div>

          {!garmin.data?.shortcutBridge.configured && (
            <button
              className="primary-action"
              type="button"
              disabled={createShortcutToken.isPending}
              onClick={() => createShortcutToken.mutate()}
            >
              {createShortcutToken.isPending ? "יוצרים מפתח…" : "יצירת מפתח אישי ל־Shortcut"}
            </button>
          )}

          {garmin.data?.shortcutBridge.configured && !shortcutToken && (
            <div className="shortcut-actions">
              <button
                type="button"
                onClick={() => createShortcutToken.mutate()}
                disabled={createShortcutToken.isPending}
              >
                החלפת המפתח
              </button>
              <button
                className="danger-action"
                type="button"
                onClick={() => disconnectShortcut.mutate()}
                disabled={disconnectShortcut.isPending}
              >
                {disconnectShortcut.isPending ? "מנתקים…" : "ניתוק הגשר"}
              </button>
            </div>
          )}

          {shortcutToken && (
            <div className="shortcut-secret" role="status">
              <strong>שמור עכשיו — המפתח לא יוצג שוב</strong>
              <small>{shortcutToken.messageHe}</small>
              <code>{shortcutToken.token}</code>
              <div className="shortcut-actions">
                <button
                  type="button"
                  onClick={() => {
                    void copyToClipboard(shortcutToken.token)
                      .then(() => setMessage("המפתח הועתק"))
                      .catch(() => setMessage("לא הצלחנו להעתיק. לחץ לחיצה ארוכה על המפתח."));
                  }}
                >
                  העתקת המפתח
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void copyToClipboard(shortcutToken.importUrl)
                      .then(() => setMessage("כתובת הייבוא הועתקה"))
                      .catch(() => setMessage("לא הצלחנו להעתיק את הכתובת"));
                  }}
                >
                  העתקת כתובת הייבוא
                </button>
              </div>
            </div>
          )}

          {garmin.data?.shortcutBridge.latestDaily && (
            <>
              <strong>
                סנכרון אחרון · {formatDateTime(garmin.data.shortcutBridge.lastSuccessfulSyncAt)}
              </strong>
              <div className="health-summary-grid">
                <div>
                  <strong>{formatMetric(garmin.data.shortcutBridge.latestDaily.steps)}</strong>
                  <small>צעדים</small>
                </div>
                <div>
                  <strong>
                    {formatMetric(garmin.data.shortcutBridge.latestDaily.activeEnergyKcal)}
                  </strong>
                  <small>קלוריות פעילות</small>
                </div>
                <div>
                  <strong>
                    {formatMetric(garmin.data.shortcutBridge.latestDaily.walkingRunningDistanceKm)}{" "}
                    ק״מ
                  </strong>
                  <small>הליכה וריצה</small>
                </div>
                <div>
                  <strong>
                    {formatSleep(garmin.data.shortcutBridge.latestDaily.sleepMinutes)}
                  </strong>
                  <small>שינה</small>
                </div>
              </div>
            </>
          )}

          <details className="shortcut-setup">
            <summary>הוראות הקמה באייפון</summary>
            <ol>
              <li>סנכרן את השעון כאשר Garmin Connect פתוח.</li>
              <li>אפשר ל־Garmin Connect לכתוב נתונים ל־Apple Health.</li>
              <li>צור Shortcut שקורא את נתוני Health של היום.</li>
              <li>שלח Dictionary כ־JSON לכתובת הייבוא בשיטת POST.</li>
              <li>הוסף Header בשם Authorization ובערך Bearer ולאחריו המפתח האישי.</li>
            </ol>
          </details>
        </div>

        <details>
          <summary>החיבור הרשמי של Garmin</summary>
          <p>
            {garmin.data?.approvedProviderConfigured
              ? "פרטי Garmin קיימים. החיבור הרשמי יופעל לאחר השלמת מסלול ההרשאה וה־Data Feed."
              : "החיבור הרשמי נשאר בהמתנה למפתחות ולאישור Garmin."}
          </p>
        </details>
      </section>
      <section className="settings-section">
        <h2>התקנה באייפון</h2>
        <ol className="install-steps">
          <li>פתח את האפליקציה ב-Safari.</li>
          <li>לחץ על כפתור השיתוף.</li>
          <li>בחר “הוסף למסך הבית”.</li>
          <li>פתח מהסמל החדש כדי לאפשר התראות Push נתמכות.</li>
        </ol>
      </section>
      <section className="settings-section">
        <h2>ייצוא המידע שלי</h2>
        <div className="export-links">
          <a href="/api/v1/export/csv">CSV</a>
          <a href="/api/v1/export/json">JSON</a>
          <a href="/api/v1/export/pdf">PDF</a>
        </div>
      </section>
      <section className="settings-section">
        <h2>חשבון</h2>
        <button className="secondary-action" onClick={() => logout.mutate()}>
          יציאה
        </button>
        <DeleteAccount
          onDeleted={() => {
            void queryClient.invalidateQueries({ queryKey: ["session"] });
          }}
        />
      </section>
    </div>
  );
}

async function copyToClipboard(value: string): Promise<void> {
  if (!navigator.clipboard) throw new Error("Clipboard API unavailable");
  await navigator.clipboard.writeText(value);
}

function formatDateTime(value: string | null): string {
  if (!value) return "עדיין לא בוצע";
  return new Intl.DateTimeFormat("he-IL", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}

function formatMetric(value: number | null): string {
  if (value === null) return "—";
  return new Intl.NumberFormat("he-IL", { maximumFractionDigits: 1 }).format(value);
}

function formatSleep(value: number | null): string {
  if (value === null) return "—";
  const hours = Math.floor(value / 60);
  const minutes = Math.round(value % 60);
  return `${hours}:${String(minutes).padStart(2, "0")}`;
}

function DeleteAccount({ onDeleted }: { onDeleted: () => void }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const deletion = useMutation({
    mutationFn: () => apiRequest("/api/v1/account/", { method: "DELETE" }),
    onSuccess: onDeleted,
  });
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open]);
  return (
    <>
      <button className="danger-action" onClick={() => setOpen(true)}>
        מחיקת החשבון
      </button>
      {open && (
        <div className="dialog-backdrop" role="presentation">
          <div
            className="confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-title"
          >
            <h2 id="delete-title">למחוק את החשבון לצמיתות?</h2>
            <p>
              המחיקה מיידית ואין אפשרות שחזור. יימחקו היומן הפרטי, המדידות, שיחות AI, חיבור Garmin,
              תמונות וסשנים.
            </p>
            <div>
              <button onClick={() => setOpen(false)}>ביטול</button>
              <button className="danger-action" onClick={() => deletion.mutate()}>
                {deletion.isPending ? "מוחקים…" : "מחיקה לצמיתות"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
