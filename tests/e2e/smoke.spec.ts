import { expect, test } from "@playwright/test";

test("Hebrew unauthenticated shell is RTL and accessible", async ({ page }) => {
  await page.route("**/api/v1/auth/session", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        authenticated: false,
        user: null,
        csrfToken: null,
        features: {
          demoAuth: false,
          googleAuth: false,
          appleAuth: false,
          garmin: false,
          ai: true,
          email: false,
        },
      }),
    });
  });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", "he");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page).toHaveTitle(/רגע טוב/u);
  await expect(page.getByRole("heading", { name: "כניסה פשוטה" })).toBeVisible();
  await expect(page.getByLabel("כתובת אימייל")).toBeVisible();
});

test("authenticated iPhone view exposes the thumb-reachable meal capture action", async ({
  page,
}) => {
  await page.route("**/api/v1/auth/session", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        authenticated: true,
        user: { id: "user-1", email: "user@example.com", householdId: null },
        csrfToken: "csrf-test",
        features: {
          demoAuth: false,
          googleAuth: false,
          appleAuth: false,
          garmin: false,
          ai: true,
          email: false,
        },
      }),
    });
  });
  await page.route("**/api/v1/profile/", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ profile: null, targets: null }),
    });
  });
  await page.route("**/api/v1/meals/**", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ meals: [] }) });
  });
  await page.route("**/api/v1/coach/next**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        headlineHe: "הארוחה הבאה שלך",
        messageHe: "אפשר לבחור משהו פשוט שמתאים להמשך היום.",
        actionHe: "לקבלת הצעה",
        actionPath: "/coach",
      }),
    });
  });

  await page.goto("/");
  await expect(page.getByRole("link", { name: /מה אכלתי/u })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "ניווט ראשי" })).toBeVisible();
  await expect(page.getByRole("link", { name: /הוספה/u })).toBeVisible();
});
