import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest, ClientApiError } from "../../app/api";

type PushConfig = {
  vapidPublicKey: string | null;
  configured: boolean;
};

type PushPreferences = {
  pushEnabled: boolean;
  morningEnabled: boolean;
  morningTime: string;
  afternoonEnabled: boolean;
  afternoonTime: string;
  eveningEnabled: boolean;
  eveningTime: string;
  aiPersonalized: boolean;
  activeSubscriptions: number;
};

type Draft = Omit<PushPreferences, "activeSubscriptions">;

const defaults: Draft = {
  pushEnabled: false,
  morningEnabled: true,
  morningTime: "08:00",
  afternoonEnabled: true,
  afternoonTime: "15:00",
  eveningEnabled: true,
  eveningTime: "20:00",
  aiPersonalized: true,
};

export function PushNotificationSettings(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>(defaults);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const preferencesLoaded = useRef(false);

  const config = useQuery({
    queryKey: ["push", "config"],
    queryFn: () => apiRequest<PushConfig>("/api/v1/push/config"),
  });

  const preferences = useQuery({
    queryKey: ["push", "preferences"],
    queryFn: () => apiRequest<PushPreferences>("/api/v1/push/preferences"),
  });

  useEffect(() => {
    if (!preferences.data) return;
    setDraft({
      pushEnabled: preferences.data.pushEnabled,
      morningEnabled: preferences.data.morningEnabled,
      morningTime: preferences.data.morningTime,
      afternoonEnabled: preferences.data.afternoonEnabled,
      afternoonTime: preferences.data.afternoonTime,
      eveningEnabled: preferences.data.eveningEnabled,
      eveningTime: preferences.data.eveningTime,
      aiPersonalized: true,
    });
    preferencesLoaded.current = true;
  }, [preferences.data]);

  useEffect(() => {
    if (!preferencesLoaded.current) return;

    const timer = window.setTimeout(() => {
      void savePreferences(draft).catch((error: unknown) => {
        setMessage(
          error instanceof ClientApiError
            ? error.messageHe
            : "לא הצלחנו לשמור אוטומטית את הגדרות ההתראות.",
        );
      });
    }, 600);

    return () => window.clearTimeout(timer);
  }, [draft]);

  const supported =
    "serviceWorker" in navigator && "Notification" in window && "PushManager" in window;
  const standalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    Boolean((navigator as Navigator & { standalone?: boolean }).standalone);

  async function enablePush(): Promise<void> {
    setMessage(null);

    if (!supported) {
      setMessage("המכשיר או הדפדפן הזה לא תומך ב־Push Web.");
      return;
    }
    if (isIos() && !standalone) {
      setMessage("באייפון צריך קודם להוסיף את רגע טוב למסך הבית ואז לפתוח אותו מהסמל.");
      return;
    }
    if (!config.data?.configured || !config.data.vapidPublicKey) {
      setMessage("השרת עדיין מחכה למפתחות VAPID.");
      return;
    }

    setBusy(true);
    try {
      const permission =
        Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
      if (permission !== "granted") {
        setMessage("כדי לקבל עדכונים צריך לאשר התראות לאפליקציה.");
        return;
      }

      const registration = await navigator.serviceWorker.ready;
      let subscription = await registration.pushManager.getSubscription();

      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: base64UrlToArrayBuffer(config.data.vapidPublicKey),
        });
      }

      const json = subscription.toJSON();
      if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) {
        throw new Error("Push subscription is missing keys");
      }

      await apiRequest("/api/v1/push/subscriptions", {
        method: "POST",
        body: JSON.stringify({
          endpoint: json.endpoint,
          keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
        }),
      });

      const next = { ...draft, pushEnabled: true };
      await savePreferences(next);
      setDraft(next);
      setMessage("ההתראות הופעלו ✅ אפשר לשלוח עכשיו התראת ניסיון.");
      await queryClient.invalidateQueries({ queryKey: ["push"] });
    } catch (error) {
      setMessage(
        error instanceof ClientApiError
          ? error.messageHe
          : "לא הצלחנו להפעיל התראות. נסה שוב מתוך האפליקציה במסך הבית.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function disablePush(): Promise<void> {
    setBusy(true);
    setMessage(null);
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        await apiRequest("/api/v1/push/subscriptions", {
          method: "DELETE",
          body: JSON.stringify({ endpoint: subscription.endpoint }),
        });
        await subscription.unsubscribe();
      }

      const next = { ...draft, pushEnabled: false };
      await savePreferences(next);
      setDraft(next);
      setMessage("ההתראות כובו.");
      await queryClient.invalidateQueries({ queryKey: ["push"] });
    } catch (error) {
      setMessage(error instanceof ClientApiError ? error.messageHe : "לא הצלחנו לכבות את ההתראות.");
    } finally {
      setBusy(false);
    }
  }

  async function saveSchedule(): Promise<void> {
    setBusy(true);
    setMessage(null);
    try {
      await savePreferences(draft);
      setMessage("שעות ההתראות נשמרו.");
      await queryClient.invalidateQueries({ queryKey: ["push", "preferences"] });
    } catch (error) {
      setMessage(error instanceof ClientApiError ? error.messageHe : "לא הצלחנו לשמור את ההגדרות.");
    } finally {
      setBusy(false);
    }
  }

  async function sendTest(): Promise<void> {
    setBusy(true);
    setMessage(null);
    try {
      await apiRequest("/api/v1/push/test", { method: "POST" });
      setMessage("התראת ניסיון נשלחה 📲");
    } catch (error) {
      setMessage(
        error instanceof ClientApiError ? error.messageHe : "לא הצלחנו לשלוח התראת ניסיון.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-section push-settings">
      <div className="garmin-settings__heading">
        <h2>התראות חכמות במהלך היום</h2>
        <span className={`garmin-status-pill${draft.pushEnabled ? " is-active" : ""}`}>
          {draft.pushEnabled ? "פעיל" : "כבוי"}
        </span>
      </div>

      <p>AI מנתח את היום שלך מול אתמול ומכוון לצעד הבא. לקראת סוף השבוע הוא מסתכל גם על כל השבוע ומחפש את הדפוס שהכי כדאי לקחת איתך לסופ״ש.</p>

      {!config.data?.configured && (
        <p className="form-error">
          השרת עדיין לא מוגדר עם VAPID. נוסיף שני מפתחות ל־Cloudflare לפני ההפעלה.
        </p>
      )}

      {isIos() && !standalone && (
        <p className="form-error">
          באייפון: Safari → שיתוף → הוסף למסך הבית → פתח את רגע טוב מהסמל החדש.
        </p>
      )}

      <div className="shortcut-actions">
        {!draft.pushEnabled ? (
          <button
            type="button"
            className="primary-action"
            disabled={busy || !config.data?.configured}
            onClick={() => void enablePush()}
          >
            {busy ? "מפעילים…" : "הפעלת התראות"}
          </button>
        ) : (
          <>
            <button type="button" disabled={busy} onClick={() => void sendTest()}>
              שליחת התראת ניסיון
            </button>
            <button
              type="button"
              className="danger-action"
              disabled={busy}
              onClick={() => void disablePush()}
            >
              כיבוי התראות
            </button>
          </>
        )}
      </div>

      <div className="profile-form">
        <div className="form-pair">
          <ScheduleField
            label="הודעת בוקר"
            enabled={draft.morningEnabled}
            time={draft.morningTime}
            onEnabled={(value) => setDraft((current) => ({ ...current, morningEnabled: value }))}
            onTime={(value) => setDraft((current) => ({ ...current, morningTime: value }))}
          />
          <ScheduleField
            label="אמצע היום"
            enabled={draft.afternoonEnabled}
            time={draft.afternoonTime}
            onEnabled={(value) => setDraft((current) => ({ ...current, afternoonEnabled: value }))}
            onTime={(value) => setDraft((current) => ({ ...current, afternoonTime: value }))}
          />
        </div>

        <ScheduleField
          label="סיכום ערב"
          enabled={draft.eveningEnabled}
          time={draft.eveningTime}
          onEnabled={(value) => setDraft((current) => ({ ...current, eveningEnabled: value }))}
          onTime={(value) => setDraft((current) => ({ ...current, eveningTime: value }))}
        />

        <div className="status-message">
          <strong>ניתוח AI פעיל ✨</strong>
          <br />
          <small>
            כל התראה נוצרת ומנותחת באמצעות AI. אם ה־AI אינו זמין, לא תישלח הודעה כללית או
            אוטומטית במקומו.
          </small>
        </div>

        <button
          type="button"
          className="secondary-action"
          disabled={busy}
          onClick={() => void saveSchedule()}
        >
          שמירת שעות ההתראות
        </button>
      </div>

      {message && (
        <p className="status-message" role="status">
          {message}
        </p>
      )}

      <small>השינויים נשמרים אוטומטית. בדיקת ההתראות מתבצעת כל 5 דקות.</small>
    </section>
  );
}

function ScheduleField(props: {
  label: string;
  enabled: boolean;
  time: string;
  onEnabled: (value: boolean) => void;
  onTime: (value: string) => void;
}): React.JSX.Element {
  return (
    <label>
      <span>
        <input
          type="checkbox"
          checked={props.enabled}
          onChange={(event) => props.onEnabled(event.target.checked)}
        />{" "}
        {props.label}
      </span>
      <input
        type="time"
        value={props.time}
        onChange={(event) => props.onTime(event.target.value)}
      />
    </label>
  );
}

async function savePreferences(draft: Draft): Promise<void> {
  await apiRequest("/api/v1/push/preferences", {
    method: "PUT",
    body: JSON.stringify({
      ...draft,
      aiPersonalized: true,
      timezone: browserTimeZone(),
    }),
  });
}

function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Jerusalem";
}

function base64UrlToArrayBuffer(value: string): ArrayBuffer {
  const normalized = value.replace(/-/gu, "+").replace(/_/gu, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const buffer = new ArrayBuffer(binary.length);
  const output = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index += 1) {
    output[index] = binary.charCodeAt(index);
  }
  return buffer;
}

function isIos(): boolean {
  return /iphone|ipad|ipod/iu.test(navigator.userAgent);
}
