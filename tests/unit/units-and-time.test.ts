import { describe, expect, it } from "vitest";
import { quantityToGrams, scaleNutrient } from "../../src/shared/units/conversions";
import { ageOnDate, localDateFromIso } from "../../src/server/domain/time";

describe("units and time", () => {
  it("converts fractional household quantities", () => {
    expect(quantityToGrams({ quantity: 0.5, gramsPerUnit: 80 })).toBe(40);
    expect(quantityToGrams({ quantity: 1.5, gramsPerUnit: null })).toBeNull();
  });

  it("scales nutrients without losing precision", () => {
    expect(scaleNutrient(250, 37.5, 100)).toBe(93.75);
    expect(scaleNutrient(null, 37.5, 100)).toBeNull();
  });

  it("rejects invalid conversion inputs", () => {
    expect(() => quantityToGrams({ quantity: -1, gramsPerUnit: 20 })).toThrow();
    expect(() => scaleNutrient(100, 10, 0)).toThrow();
  });

  it("calculates age around a birthday", () => {
    expect(ageOnDate("1990-07-19", new Date("2026-07-18T12:00:00Z"))).toBe(35);
    expect(ageOnDate("1990-07-19", new Date("2026-07-19T12:00:00Z"))).toBe(36);
  });

  it("uses the phone timezone for diary dates", () => {
    expect(localDateFromIso("2026-07-18T21:30:00.000Z", "Asia/Jerusalem")).toBe("2026-07-19");
  });
});
