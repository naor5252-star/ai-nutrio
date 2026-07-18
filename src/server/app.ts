import { Hono } from "hono";
import type { AppEnv } from "./context";
import { apiErrorResponse } from "./api/errors";
import { correlationMiddleware, securityHeadersMiddleware } from "./security/http";
import { authRoutes } from "./auth/routes";
import { profileRoutes } from "./api/profile-routes";
import { householdRoutes } from "./api/household-routes";
import { mealRoutes } from "./api/meal-routes";
import { analysisRoutes } from "./api/analysis-routes";
import { productRoutes } from "./api/product-routes";
import { shoppingRoutes } from "./api/shopping-routes";
import { measurementRoutes } from "./api/measurement-routes";
import { coachRoutes } from "./api/coach-routes";
import { reportRoutes } from "./api/report-routes";
import { exportRoutes } from "./api/export-routes";
import { pushRoutes } from "./api/push-routes";
import { garminRoutes } from "./api/garmin-routes";
import { accountRoutes } from "./api/account-routes";

export const app = new Hono<AppEnv>({ strict: false });
app.use("*", correlationMiddleware);
app.use("*", securityHeadersMiddleware);

app.get("/api/health", (context) =>
  context.json({ ok: true, service: "ai-nutrition-advisor", version: "0.1.0" }),
);
app.route("/api/v1/auth", authRoutes);
app.route("/api/v1/profile", profileRoutes);
app.route("/api/v1/households", householdRoutes);
app.route("/api/v1/meals", mealRoutes);
app.route("/api/v1/analysis", analysisRoutes);
app.route("/api/v1/products", productRoutes);
app.route("/api/v1/shopping-list", shoppingRoutes);
app.route("/api/v1/measurements", measurementRoutes);
app.route("/api/v1/coach", coachRoutes);
app.route("/api/v1/reports", reportRoutes);
app.route("/api/v1/export", exportRoutes);
app.route("/api/v1/push", pushRoutes);
app.route("/api/v1/garmin", garminRoutes);
app.route("/api/v1/account", accountRoutes);

app.notFound((context) =>
  context.json(
    {
      error: {
        code: "NOT_FOUND",
        messageHe: "הכתובת המבוקשת לא נמצאה",
        correlationId: context.get("correlationId"),
        retryable: false,
      },
    },
    404,
  ),
);

app.onError((error, context) => apiErrorResponse(context, error));
