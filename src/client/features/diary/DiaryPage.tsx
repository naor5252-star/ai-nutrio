import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { apiRequest } from "../../app/api";
import type { MealSummary } from "../../app/types";

type MealSourceType = "label" | "database" | "manual" | "ai_estimate";
type MealCategory = "breakfast" | "lunch" | "dinner" | "snack" | "drink" | "custom";

type EditableMealItem = {
  foodId?: string | null;
  nameHe: string;
  quantity: number;
  unit: string;
  grams: number | null;
  calories: number | null;
  proteinGrams: number | null;
  carbohydrateGrams: number | null;
  fatGrams: number | null;
  fiberGrams: number | null;
  sourceType: MealSourceType;
};

type MealEditDraft = {
  id: string;
  title: string;
  occurredAt: string;
  category: MealCategory;
  customCategoryName: string | null;
  notes: string | null;
  items: EditableMealItem[];
};

type LoadedMeal = {
  id: string;
  title: string;
  occurred_at: string;
  category: string;
  custom_category_name: string | null;
  notes: string | null;
  items: Array<{ source_snapshot_json?: string | null }>;
};

function isoDate(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function toDateTimeLocal(value: string): string {
  const date = new Date(value);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

function nullableNumber(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseSnapshot(raw: string | null | undefined): EditableMealItem {
  const parsed = raw ? (JSON.parse(raw) as Partial<EditableMealItem>) : {};
  return {
    foodId: parsed.foodId ?? null,
    nameHe: parsed.nameHe ?? "רכיב",
    quantity: parsed.quantity ?? 1,
    unit: parsed.unit ?? "יחידה",
    grams: parsed.grams ?? null,
    calories: parsed.calories ?? null,
    proteinGrams: parsed.proteinGrams ?? null,
    carbohydrateGrams: parsed.carbohydrateGrams ?? null,
    fatGrams: parsed.fatGrams ?? null,
    fiberGrams: parsed.fiberGrams ?? null,
    sourceType: parsed.sourceType ?? "manual",
  };
}

export function DiaryPage(): React.JSX.Element {
  const [date, setDate] = useState(isoDate(new Date()));
  const [editDraft, setEditDraft] = useState<MealEditDraft | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [mergeMode, setMergeMode] = useState(false);
  const [selectedMealIds, setSelectedMealIds] = useState<string[]>([]);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["meals", date],
    queryFn: () => apiRequest<{ meals: MealSummary[] }>(`/api/v1/meals/?date=${date}`),
  });
  const favorite = useMutation({
    mutationFn: (id: string) => apiRequest(`/api/v1/meals/${id}/favorite`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["meals", date] }),
  });
  const mergeMeals = useMutation({
    mutationFn: (mealIds: string[]) =>
      apiRequest<{ id: string; localDate: string; mergedMeals: number }>("/api/v1/meals/merge", {
        method: "POST",
        body: JSON.stringify({ mealIds }),
      }),
    onSuccess: async (result) => {
      setMergeMode(false);
      setSelectedMealIds([]);
      setMergeError(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["meals"] }),
        queryClient.invalidateQueries({ queryKey: ["garmin", "trends"] }),
      ]);
      setDate(result.localDate);
    },
    onError: () => setMergeError("לא הצלחנו לאחד את הארוחות. נסה שוב."),
  });
  const saveEdit = useMutation({
    mutationFn: (draft: MealEditDraft) =>
      apiRequest<{ id: string; localDate: string }>(`/api/v1/meals/${draft.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          occurredAt: new Date(draft.occurredAt).toISOString(),
          category: draft.category,
          customCategoryName: draft.customCategoryName,
          title: draft.title.trim(),
          notes: draft.notes?.trim() || null,
          items: draft.items,
        }),
      }),
    onSuccess: async (result) => {
      setEditDraft(null);
      setEditError(null);
      await queryClient.invalidateQueries({ queryKey: ["meals"] });
      setDate(result.localDate);
    },
    onError: () => setEditError("לא הצלחנו לשמור את השינויים. נסה שוב."),
  });
  const meals = query.data?.meals ?? [];

  async function startEditing(id: string): Promise<void> {
    setEditError(null);
    const response = await apiRequest<{ meal: LoadedMeal }>(`/api/v1/meals/${id}`);
    const meal = response.meal;
    setEditDraft({
      id: meal.id,
      title: meal.title,
      occurredAt: toDateTimeLocal(meal.occurred_at),
      category: isMealCategory(meal.category) ? meal.category : "custom",
      customCategoryName: meal.custom_category_name,
      notes: meal.notes,
      items: meal.items.map((item) => parseSnapshot(item.source_snapshot_json)),
    });
  }

  function toggleMergeMeal(id: string): void {
    setMergeError(null);
    setSelectedMealIds((current) =>
      current.includes(id) ? current.filter((mealId) => mealId !== id) : [...current, id],
    );
  }

  function updateItem(index: number, patch: Partial<EditableMealItem>): void {
    setEditDraft((current) =>
      current
        ? {
            ...current,
            items: current.items.map((item, itemIndex) =>
              itemIndex === index ? { ...item, ...patch } : item,
            ),
          }
        : current,
    );
  }

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

      {editDraft && (
        <section className="meal-edit-panel" aria-labelledby="meal-edit-title">
          <div className="meal-edit-panel__heading">
            <div>
              <p className="eyebrow">עריכת ארוחה</p>
              <h2 id="meal-edit-title">{editDraft.title}</h2>
            </div>
            <button type="button" onClick={() => setEditDraft(null)}>
              סגירה
            </button>
          </div>
          <div className="meal-edit-grid">
            <label>
              <span>שם הארוחה</span>
              <input
                value={editDraft.title}
                onChange={(event) =>
                  setEditDraft((current) =>
                    current ? { ...current, title: event.target.value } : current,
                  )
                }
              />
            </label>
            <label>
              <span>תאריך ושעה</span>
              <input
                type="datetime-local"
                value={editDraft.occurredAt}
                onChange={(event) =>
                  setEditDraft((current) =>
                    current ? { ...current, occurredAt: event.target.value } : current,
                  )
                }
              />
            </label>
            <label>
              <span>סוג ארוחה</span>
              <select
                value={editDraft.category}
                onChange={(event) =>
                  setEditDraft((current) =>
                    current
                      ? { ...current, category: event.target.value as MealCategory }
                      : current,
                  )
                }
              >
                <option value="breakfast">ארוחת בוקר</option>
                <option value="lunch">ארוחת צהריים</option>
                <option value="dinner">ארוחת ערב</option>
                <option value="snack">נשנוש</option>
                <option value="drink">שתייה</option>
                <option value="custom">אחר</option>
              </select>
            </label>
          </div>
          <div className="meal-edit-items">
            {editDraft.items.map((item, index) => (
              <article className="meal-edit-item" key={`${editDraft.id}-${index}`}>
                <div className="meal-edit-item__heading">
                  <strong>רכיב {index + 1}</strong>
                  {editDraft.items.length > 1 && (
                    <button
                      type="button"
                      onClick={() =>
                        setEditDraft((current) =>
                          current
                            ? {
                                ...current,
                                items: current.items.filter((_, itemIndex) => itemIndex !== index),
                              }
                            : current,
                        )
                      }
                    >
                      הסרה
                    </button>
                  )}
                </div>
                <label>
                  <span>שם</span>
                  <input
                    value={item.nameHe}
                    onChange={(event) => updateItem(index, { nameHe: event.target.value })}
                  />
                </label>
                <div className="meal-edit-item__row">
                  <label>
                    <span>כמות</span>
                    <input
                      inputMode="decimal"
                      value={item.quantity}
                      onChange={(event) =>
                        updateItem(index, { quantity: Number(event.target.value) || 0 })
                      }
                    />
                  </label>
                  <label>
                    <span>יחידה</span>
                    <input
                      value={item.unit}
                      onChange={(event) => updateItem(index, { unit: event.target.value })}
                    />
                  </label>
                  <label>
                    <span>גרם / מ״ל</span>
                    <input
                      inputMode="decimal"
                      value={item.grams ?? ""}
                      onChange={(event) =>
                        updateItem(index, { grams: nullableNumber(event.target.value) })
                      }
                    />
                  </label>
                </div>
                <div className="meal-edit-item__nutrition">
                  <NutrientInput
                    label="קלוריות"
                    value={item.calories}
                    onChange={(value) => updateItem(index, { calories: value })}
                  />
                  <NutrientInput
                    label="חלבון"
                    value={item.proteinGrams}
                    onChange={(value) => updateItem(index, { proteinGrams: value })}
                  />
                  <NutrientInput
                    label="פחמימות"
                    value={item.carbohydrateGrams}
                    onChange={(value) => updateItem(index, { carbohydrateGrams: value })}
                  />
                  <NutrientInput
                    label="שומן"
                    value={item.fatGrams}
                    onChange={(value) => updateItem(index, { fatGrams: value })}
                  />
                  <NutrientInput
                    label="סיבים"
                    value={item.fiberGrams}
                    onChange={(value) => updateItem(index, { fiberGrams: value })}
                  />
                </div>
              </article>
            ))}
          </div>
          <button
            type="button"
            className="secondary-action meal-edit-add-item"
            onClick={() =>
              setEditDraft((current) =>
                current
                  ? {
                      ...current,
                      items: [
                        ...current.items,
                        {
                          nameHe: "רכיב חדש",
                          quantity: 1,
                          unit: "יחידה",
                          grams: null,
                          calories: null,
                          proteinGrams: null,
                          carbohydrateGrams: null,
                          fatGrams: null,
                          fiberGrams: null,
                          sourceType: "manual",
                        },
                      ],
                    }
                  : current,
              )
            }
          >
            הוספת רכיב
          </button>
          {editError && <p className="form-error">{editError}</p>}
          <button
            type="button"
            className="primary-action"
            disabled={
              saveEdit.isPending ||
              !editDraft.title.trim() ||
              editDraft.items.some((item) => !item.nameHe.trim())
            }
            onClick={() => saveEdit.mutate(editDraft)}
          >
            {saveEdit.isPending ? "שומרים…" : "שמירת שינויים"}
          </button>
        </section>
      )}

      {meals.length >= 2 && (
        <section className="meal-merge-toolbar">
          {!mergeMode ? (
            <button
              type="button"
              className="secondary-action"
              onClick={() => {
                setMergeMode(true);
                setSelectedMealIds([]);
                setMergeError(null);
              }}
            >
              איחוד ארוחות
            </button>
          ) : (
            <>
              <p>בחר לפחות שתי ארוחות שתרצה להפוך לארוחה אחת.</p>
              <div className="entry-actions">
                <button
                  type="button"
                  disabled={mergeMeals.isPending}
                  onClick={() => {
                    setMergeMode(false);
                    setSelectedMealIds([]);
                    setMergeError(null);
                  }}
                >
                  ביטול
                </button>
                <button
                  type="button"
                  disabled={selectedMealIds.length < 2 || mergeMeals.isPending}
                  onClick={() => {
                    if (
                      selectedMealIds.length >= 2 &&
                      window.confirm(
                        `לאחד ${selectedMealIds.length} ארוחות לארוחה אחת? הרכיבים והערכים יישמרו.`,
                      )
                    ) {
                      mergeMeals.mutate(selectedMealIds);
                    }
                  }}
                >
                  {mergeMeals.isPending ? "מאחדים…" : `אחד ${selectedMealIds.length} ארוחות`}
                </button>
              </div>
              {mergeError && <p className="form-error">{mergeError}</p>}
            </>
          )}
        </section>
      )}

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
                  {mergeMode && (
                    <label className="meal-merge-choice">
                      <input
                        type="checkbox"
                        checked={selectedMealIds.includes(meal.id)}
                        onChange={() => toggleMergeMeal(meal.id)}
                      />
                      <span>בחר לאיחוד</span>
                    </label>
                  )}
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
                  {!mergeMode && (
                    <div className="entry-actions">
                      <Link to={`/diary/${meal.id}`}>פרטים</Link>
                      <button type="button" onClick={() => void startEditing(meal.id)}>
                        עריכה
                      </button>
                      <button onClick={() => favorite.mutate(meal.id)}>
                        {meal.favorite ? "מועדף" : "שמירה כמועדף"}
                      </button>
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {mergeMode && (
        <>
          <div className="meal-merge-dock-spacer" aria-hidden="true" />
          <section className="meal-merge-dock" aria-label="אישור איחוד ארוחות">
            <div className="meal-merge-dock__summary">
              <strong>{selectedMealIds.length} ארוחות נבחרו</strong>
              <span>
                {selectedMealIds.length < 2 ? "בחר לפחות שתי ארוחות" : "מוכן לאיחוד לארוחה אחת"}
              </span>
            </div>
            <div className="meal-merge-dock__actions">
              <button
                type="button"
                className="secondary-action"
                disabled={mergeMeals.isPending}
                onClick={() => {
                  setMergeMode(false);
                  setSelectedMealIds([]);
                  setMergeError(null);
                }}
              >
                ביטול
              </button>
              <button
                type="button"
                className="primary-action"
                disabled={selectedMealIds.length < 2 || mergeMeals.isPending}
                onClick={() => {
                  if (
                    selectedMealIds.length >= 2 &&
                    window.confirm(
                      `לאחד ${selectedMealIds.length} ארוחות לארוחה אחת? הרכיבים והערכים יישמרו.`,
                    )
                  ) {
                    mergeMeals.mutate(selectedMealIds);
                  }
                }}
              >
                {mergeMeals.isPending
                  ? "מאחדים…"
                  : selectedMealIds.length < 2
                    ? "בחר עוד ארוחה"
                    : `אחד ${selectedMealIds.length} ארוחות`}
              </button>
            </div>
            {mergeError && <p className="form-error">{mergeError}</p>}
          </section>
        </>
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

function NutrientInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | null;
  onChange: (value: number | null) => void;
}): React.JSX.Element {
  return (
    <label>
      <span>{label}</span>
      <input
        inputMode="decimal"
        value={value ?? ""}
        onChange={(event) => onChange(nullableNumber(event.target.value))}
      />
    </label>
  );
}

function isMealCategory(value: string): value is MealCategory {
  return ["breakfast", "lunch", "dinner", "snack", "drink", "custom"].includes(value);
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
