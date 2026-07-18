export const he = {
  appName: "רגע טוב",
  home: "היום",
  diary: "יומן",
  add: "הוספה",
  coach: "הכוונה",
  progress: "התקדמות",
  settings: "הגדרות",
  captureMeal: "צלם ארוחה",
  reviewRecognition: "בדוק את הזיהוי",
  remainingToday: "כמה נשאר לי להיום?",
  unknown: "לא ידוע",
  partial: "סה״כ חלקי",
  savedWhenOnline: "נשמור כשהאינטרנט יחזור",
} as const;

export type TranslationKey = keyof typeof he;
export function t(key: TranslationKey): string {
  return he[key];
}
