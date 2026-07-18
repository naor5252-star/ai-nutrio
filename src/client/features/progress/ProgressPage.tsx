import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest, ClientApiError } from "../../app/api";

type Weight = { id: string; measured_at: string; weight_kg: number; source: string };
type Body = {
  id: string;
  measured_at: string;
  body_fat_percentage: number | null;
  muscle_mass_kg: number | null;
  source: string;
};

export function ProgressPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [weight, setWeight] = useState("");
  const [bodyFat, setBodyFat] = useState("");
  const [muscle, setMuscle] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ["measurements"],
    queryFn: () =>
      apiRequest<{ weights: Weight[]; bodyComposition: Body[] }>("/api/v1/measurements/"),
  });
  const save = useMutation({
    mutationFn: () =>
      apiRequest(
        "/api/v1/measurements/",
        {
          method: "POST",
          body: JSON.stringify({
            measuredAt: new Date().toISOString(),
            ...(weight ? { weightKg: Number(weight) } : {}),
            ...(bodyFat ? { bodyFatPercentage: Number(bodyFat) } : {}),
            ...(muscle ? { muscleMassKg: Number(muscle) } : {}),
          }),
        },
        { queueOffline: true },
      ),
    onSuccess: async (result) => {
      const queued =
        typeof result === "object" &&
        result !== null &&
        Reflect.get(result, "queuedOffline") === true;
      setMessage(queued ? "המדידה נשמרה במכשיר ותסונכרן כשהאינטרנט יחזור" : "המדידה נשמרה");
      setWeight("");
      setBodyFat("");
      setMuscle("");
      await queryClient.invalidateQueries({ queryKey: ["measurements"] });
    },
    onError: (error) =>
      setMessage(error instanceof ClientApiError ? error.messageHe : "לא הצלחנו לשמור את המדידה"),
  });
  const weights = query.data?.weights ?? [];
  return (
    <div className="page progress-page">
      <section className="page-title">
        <p className="eyebrow">התקדמות</p>
        <h1>כל מדידה עומדת בפני עצמה</h1>
        <p>אין ממוצע נע ואין החלקה של הנתונים.</p>
      </section>
      <section className="weight-plot" aria-labelledby="weight-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">משקל</p>
            <h2 id="weight-title">המדידות שלך</h2>
          </div>
          <span>{weights.length} מדידות</span>
        </div>
        {weights.length < 2 ? (
          <div className="quiet-state">אחרי שתי מדידות יוצג כאן קו התקדמות.</div>
        ) : (
          <WeightChart weights={weights} />
        )}
        <ul className="measurement-list">
          {weights
            .slice(-6)
            .reverse()
            .map((entry) => (
              <li key={entry.id}>
                <time>
                  {new Intl.DateTimeFormat("he-IL", { dateStyle: "medium" }).format(
                    new Date(entry.measured_at),
                  )}
                </time>
                <strong>{entry.weight_kg.toFixed(1)} ק״ג</strong>
              </li>
            ))}
        </ul>
      </section>
      <section className="measurement-entry">
        <h2>הוספת מדידה</h2>
        <div className="measurement-fields">
          <label>
            <span>משקל, ק״ג</span>
            <input
              inputMode="decimal"
              value={weight}
              onChange={(event) => setWeight(event.target.value)}
            />
          </label>
          <label>
            <span>אחוז שומן</span>
            <input
              inputMode="decimal"
              value={bodyFat}
              onChange={(event) => setBodyFat(event.target.value)}
            />
          </label>
          <label>
            <span>מסת שריר, ק״ג</span>
            <input
              inputMode="decimal"
              value={muscle}
              onChange={(event) => setMuscle(event.target.value)}
            />
          </label>
        </div>
        <button
          className="primary-action"
          disabled={!weight && !bodyFat && !muscle}
          onClick={() => save.mutate()}
        >
          שמירת מדידה
        </button>
        {message && (
          <p className="status-message" role="status">
            {message}
          </p>
        )}
      </section>
    </div>
  );
}

function WeightChart({ weights }: { weights: Weight[] }): React.JSX.Element {
  const values = weights.map((item) => item.weight_kg);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(1, max - min);
  const points = weights
    .map((item, index) => {
      const x = weights.length === 1 ? 50 : (index / (weights.length - 1)) * 100;
      const y = 90 - ((item.weight_kg - min) / range) * 80;
      return `${x},${y}`;
    })
    .join(" ");
  return (
    <figure className="simple-chart">
      <svg viewBox="0 0 100 100" role="img" aria-labelledby="weight-chart-title weight-chart-desc">
        <title id="weight-chart-title">גרף מדידות משקל</title>
        <desc id="weight-chart-desc">
          המשקל נע בין {min.toFixed(1)} ל-{max.toFixed(1)} קילוגרם לאורך {weights.length} מדידות.
        </desc>
        <polyline
          points={points}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
        />
        {points.split(" ").map((point, index) => {
          const [cx, cy] = point.split(",");
          return <circle key={weights[index]?.id} cx={cx} cy={cy} r="2.5" />;
        })}
      </svg>
      <figcaption>
        {min.toFixed(1)}–{max.toFixed(1)} ק״ג
      </figcaption>
    </figure>
  );
}
