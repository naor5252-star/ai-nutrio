// Rega Tov iPhone Home Screen widget (Scriptable)
// Keep your token private. Do not commit a real token to GitHub.

const API_BASE = "https://ai-nutrition-advisor.naor-5252.workers.dev";
const TOKEN = "PASTE_YOUR_NEW_REGA_TOV_TOKEN_HERE";

function localDate() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function fmt(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
  return Math.round(Number(value)).toLocaleString("he-IL");
}

function cameraActionUrl() {
  const base = URLScheme.forRunningScript();
  return `${base}${base.includes("?") ? "&" : "?"}action=camera`;
}

function resizeForUpload(image, maxDimension = 1600) {
  const width = image.size.width;
  const height = image.size.height;
  const largest = Math.max(width, height);
  if (largest <= maxDimension) return image;

  const scale = maxDimension / largest;
  const resizedWidth = Math.max(1, Math.round(width * scale));
  const resizedHeight = Math.max(1, Math.round(height * scale));
  const canvas = new DrawContext();
  canvas.size = new Size(resizedWidth, resizedHeight);
  canvas.opaque = true;
  canvas.respectScreenScale = false;
  canvas.drawImageInRect(image, new Rect(0, 0, resizedWidth, resizedHeight));
  return canvas.getImage();
}

async function loadBalance() {
  const request = new Request(
    `${API_BASE}/api/v1/garmin/widget/balance?date=${encodeURIComponent(localDate())}`,
  );
  request.method = "GET";
  request.headers = {
    Authorization: `Bearer ${TOKEN}`,
    Accept: "application/json",
  };
  request.timeoutInterval = 15;

  const data = await request.loadJSON();
  const status = request.response?.statusCode ?? 200;
  if (status < 200 || status >= 300 || data?.error) {
    throw new Error(data?.error?.messageHe ?? `HTTP ${status}`);
  }
  return data;
}

async function captureMealFromCamera() {
  if (!TOKEN || TOKEN.includes("PASTE_YOUR_NEW_REGA_TOV_TOKEN_HERE")) {
    throw new Error("צריך להגדיר TOKEN בסקריפט לפני השימוש במצלמה");
  }

  const image = await Photos.fromCamera();
  const resized = resizeForUpload(image);
  const jpeg = Data.fromJPEG(resized);

  const request = new Request(`${API_BASE}/api/v1/garmin/widget/photo`);
  request.method = "POST";
  request.headers = {
    Authorization: `Bearer ${TOKEN}`,
    "Content-Type": "image/jpeg",
    Accept: "application/json",
  };
  request.body = jpeg;
  request.timeoutInterval = 45;

  const data = await request.loadJSON();
  const status = request.response?.statusCode ?? 200;
  if (status < 200 || status >= 300 || data?.error) {
    throw new Error(data?.error?.messageHe ?? `HTTP ${status}`);
  }

  if (data.analysisUrl) {
    Safari.open(data.analysisUrl);
  }
}

async function runCameraAction() {
  try {
    await captureMealFromCamera();
  } catch (error) {
    const alert = new Alert();
    alert.title = "רגע טוב";
    alert.message = String(error?.message ?? error);
    alert.addAction("סגור");
    await alert.presentAlert();
  }
}

function addMetric(stack, label, value) {
  const item = stack.addStack();
  item.layoutVertically();
  const labelText = item.addText(label);
  labelText.font = Font.systemFont(10);
  labelText.textColor = new Color("#746D63");
  const valueText = item.addText(value);
  valueText.font = Font.semiboldSystemFont(13);
  valueText.textColor = new Color("#243229");
}

async function makeWidget() {
  const widget = new ListWidget();
  widget.setPadding(14, 14, 14, 14);
  widget.backgroundColor = new Color("#FFF9F0");
  widget.refreshAfterDate = new Date(Date.now() + 15 * 60 * 1000);

  let data;
  try {
    data = await loadBalance();
  } catch (error) {
    const title = widget.addText("רגע טוב");
    title.font = Font.boldSystemFont(16);
    title.textColor = new Color("#2D4937");
    widget.addSpacer(8);
    const message = widget.addText("לא הצלחנו לעדכן את המאזן");
    message.font = Font.semiboldSystemFont(13);
    message.textColor = new Color("#C2533E");
    widget.addSpacer(4);
    const detail = widget.addText(String(error?.message ?? error));
    detail.font = Font.systemFont(9);
    detail.textColor = new Color("#746D63");
    detail.lineLimit = 3;
    return widget;
  }

  const top = widget.addStack();
  top.layoutHorizontally();
  const summary = top.addStack();
  summary.layoutVertically();
  summary.url = API_BASE;

  const brand = summary.addText("רגע טוב · היום");
  brand.font = Font.semiboldSystemFont(11);
  brand.textColor = new Color("#6C766D");
  summary.addSpacer(4);

  const balance = data.balanceCalories;
  const balanceKnown = balance !== null && balance !== undefined;
  const isDeficit = balanceKnown && balance >= 0;
  const headline = summary.addText(
    balanceKnown
      ? `${isDeficit ? "גירעון" : "עודף"} ${fmt(Math.abs(balance))}`
      : "מאזן עדיין לא זמין",
  );
  headline.font = Font.boldSystemFont(22);
  headline.textColor = balanceKnown
    ? new Color(isDeficit ? "#507852" : "#C2533E")
    : new Color("#746D63");

  if (balanceKnown) {
    const units = summary.addText("קלוריות");
    units.font = Font.systemFont(10);
    units.textColor = new Color("#746D63");
  }

  widget.addSpacer(8);
  const metrics = widget.addStack();
  metrics.layoutHorizontally();
  metrics.spacing = 18;
  addMetric(metrics, "נאכלו", `${fmt(data.intakeCalories)} קל׳`);
  addMetric(metrics, "נשרפו", `${fmt(data.burnedCalories)} קל׳`);

  if (data.calorieTarget !== null) {
    const remaining = data.remainingToTarget;
    addMetric(
      metrics,
      "מול יעד",
      remaining >= 0 ? `נותרו ${fmt(remaining)}` : `חריגה ${fmt(Math.abs(remaining))}`,
    );
  }

  widget.addSpacer();
  const action = widget.addStack();
  action.layoutHorizontally();
  action.centerAlignContent();
  action.backgroundColor = new Color("#2D4937");
  action.cornerRadius = 12;
  action.setPadding(9, 12, 9, 12);
  action.url = `${API_BASE}/quick-photo`;

  const camera = action.addText("📷  צילום מהיר");
  camera.font = Font.semiboldSystemFont(13);
  camera.textColor = Color.white();
  return widget;
}

if (!config.runsInWidget && args.queryParameters?.action === "camera") {
  await runCameraAction();
} else {
  const widget = await makeWidget();
  if (config.runsInWidget) {
    Script.setWidget(widget);
  } else {
    await widget.presentMedium();
  }
}

Script.complete();
