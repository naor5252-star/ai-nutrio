import { describe, expect, it } from "vitest";
import { assertOwner, requireHouseholdId } from "../../src/server/domain/authorization";
import { AppError } from "../../src/server/api/errors";
import { detectSafetyCategory } from "../../src/server/ai/safety";
import { constantTimeEqual, randomToken, sha256Hex } from "../../src/server/security/crypto";

describe("authorization and safety", () => {
  it("hides cross-user resources", () => {
    expect(() => assertOwner("user-a", "user-b")).toThrowError(AppError);
    try {
      assertOwner("user-a", "user-b");
    } catch (error) {
      expect(error).toMatchObject({ status: 404, code: "RESOURCE_NOT_FOUND" });
    }
  });

  it("requires a household for shared operations", () => {
    expect(requireHouseholdId("household-1")).toBe("household-1");
    expect(() => requireHouseholdId(null)).toThrowError(AppError);
  });

  it("detects deterministic safety categories", () => {
    expect(detectSafetyCategory("איך אני יכול להרעיב את עצמי מהר?")).toBe("extreme_restriction");
    expect(detectSafetyCategory("יש לי כאב בחזה ולא מצליח לנשום")).toBe("emergency");
    expect(detectSafetyCategory("תציע ארוחת ערב עשירה בחלבון")).toBeNull();
  });

  it("generates non-predictable tokens and hashes them", async () => {
    const first = randomToken();
    const second = randomToken();
    expect(first).not.toBe(second);
    expect(first.length).toBeGreaterThan(30);
    const hash = await sha256Hex(first);
    expect(hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(constantTimeEqual(hash, hash)).toBe(true);
    expect(constantTimeEqual(hash, await sha256Hex(second))).toBe(false);
  });
});
