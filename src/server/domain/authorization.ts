import { AppError } from "../api/errors";

export function assertOwner(authenticatedUserId: string, ownerUserId: string): void {
  if (authenticatedUserId !== ownerUserId) {
    throw new AppError({ status: 404, code: "RESOURCE_NOT_FOUND", messageHe: "הפריט לא נמצא" });
  }
}

export function requireHouseholdId(householdId: string | null): string {
  if (!householdId) {
    throw new AppError({
      status: 409,
      code: "HOUSEHOLD_REQUIRED",
      messageHe: "צריך ליצור משק בית לפני הפעולה הזו",
    });
  }
  return householdId;
}
