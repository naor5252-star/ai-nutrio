export function ageOnDate(dateOfBirth: string, onDate = new Date()): number {
  const birth = new Date(`${dateOfBirth}T00:00:00.000Z`);
  if (Number.isNaN(birth.getTime())) throw new Error("Invalid date of birth");
  let age = onDate.getUTCFullYear() - birth.getUTCFullYear();
  const monthDelta = onDate.getUTCMonth() - birth.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && onDate.getUTCDate() < birth.getUTCDate())) age -= 1;
  return age;
}

export function localDateFromIso(iso: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(iso));
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) throw new Error("Could not resolve local date");
  return `${year}-${month}-${day}`;
}
