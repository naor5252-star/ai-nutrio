export type SafetyCategory =
  | "extreme_restriction"
  | "purging"
  | "dehydration"
  | "dangerous_supplements"
  | "diagnosis"
  | "emergency";

const PATTERNS: ReadonlyArray<{ category: SafetyCategory; pattern: RegExp }> = [
  {
    category: "emergency",
    pattern: /(כאב בחזה|לא מצליח לנשום|איבוד הכרה|medical emergency|chest pain)/iu,
  },
  { category: "purging", pattern: /(להקיא|הקאה מכוונת|משלשל|laxative|purge)/iu },
  { category: "dehydration", pattern: /(לא לשתות|ייבוש מכוון|dehydrat)/iu },
  {
    category: "extreme_restriction",
    pattern: /(להרעיב|צום ממושך|פחות מ.?500 קלור|starv|prolonged fast)/iu,
  },
  { category: "dangerous_supplements", pattern: /(מינון מסוכן|תוסף לא חוקי|קלנבוטרול|diuretic)/iu },
  { category: "diagnosis", pattern: /(תאבחן|יש לי סוכרת|יש לי הפרעת אכילה|diagnose me)/iu },
];

export function detectSafetyCategory(text: string): SafetyCategory | null {
  return PATTERNS.find((item) => item.pattern.test(text))?.category ?? null;
}

export function safetyResponseHe(category: SafetyCategory): string {
  if (category === "emergency") {
    return "אני לא יכול לספק טיפול חירום. אם יש קושי בנשימה, כאב בחזה, אובדן הכרה או סכנה מיידית—פנה עכשיו לשירותי החירום המקומיים. האפליקציה אינה שירות רפואי.";
  }
  if (category === "diagnosis") {
    return "אני לא יכול לאבחן מצב רפואי. כדאי לפנות לרופא או לדיאטנית מוסמכת שיוכלו לבדוק את התמונה המלאה. אפשר לעזור כאן בארגון יומן האכילה ובהכנת שאלות לפגישה.";
  }
  return "אני לא יכול לעזור בהרעבה, הקאה מכוונת, ייבוש או שימוש מסוכן בתוספים. מגיעה לך תמיכה בטוחה ולא שיפוטית. מומלץ לפנות לרופא או לדיאטנית מוסמכת; במקרה של סכנה מיידית יש לפנות לשירותי החירום המקומיים.";
}
