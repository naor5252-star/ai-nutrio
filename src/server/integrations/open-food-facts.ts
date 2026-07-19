import { logEvent } from "../services/logger";

const PRODUCT_FIELDS = [
  "code",
  "product_name",
  "product_name_he",
  "generic_name",
  "generic_name_he",
  "brands",
  "countries_tags",
  "categories_tags",
  "quantity",
  "product_quantity_unit",
  "serving_size",
  "image_front_small_url",
  "image_front_url",
  "nutriments",
].join(",");

const USER_AGENT = "RegaTovNutrition/0.1 (https://github.com/naor5252-star/ai-nutrio)";

type CatalogRegion = "israel" | "international";

export type ExternalProductCandidate = {
  externalId: string;
  barcode: string | null;
  nameHe: string;
  nameOriginal: string | null;
  brand: string | null;
  baseQuantity: number;
  baseUnit: "g" | "ml";
  servingDescriptionHe: string | null;
  servingWeight: number | null;
  nutrients: {
    energyKcal: number | null;
    protein: number | null;
    carbohydrate: number | null;
    fat: number | null;
    fiber: number | null;
  };
  providerName: "open_food_facts_israel" | "open_food_facts_world";
  sourceLabelHe: string;
  sourceRegion: CatalogRegion;
  imageUrl: string | null;
  countries: string[];
};

type LookupOptions = {
  correlationId: string;
};

export async function findOpenFoodFactsByBarcode(
  barcode: string,
  options: LookupOptions,
): Promise<ExternalProductCandidate[]> {
  const encodedBarcode = encodeURIComponent(barcode);
  const [israel, world] = await Promise.allSettled([
    fetchSingleProduct(
      `https://il.openfoodfacts.org/api/v2/product/${encodedBarcode}.json?fields=${encodeURIComponent(PRODUCT_FIELDS)}`,
      "open_food_facts_israel",
    ),
    fetchSingleProduct(
      `https://world.openfoodfacts.org/api/v2/product/${encodedBarcode}.json?fields=${encodeURIComponent(PRODUCT_FIELDS)}`,
      "open_food_facts_world",
    ),
  ]);

  return mergeCandidates(
    [
      ...settledCandidate(israel, options, "barcode_israel"),
      ...settledCandidate(world, options, "barcode_world"),
    ],
    barcode,
  );
}

export async function searchOpenFoodFacts(
  query: string,
  brand: string | null,
  options: LookupOptions,
): Promise<ExternalProductCandidate[]> {
  const searchTerms = [query, brand].filter(Boolean).join(" ").trim();
  if (searchTerms.length < 2) return [];

  const urls = [
    buildSearchUrl("https://il.openfoodfacts.org", searchTerms),
    buildSearchUrl("https://world.openfoodfacts.org", searchTerms),
  ];
  const [israel, world] = await Promise.allSettled([
    fetchSearchResults(urls[0]!, "open_food_facts_israel"),
    fetchSearchResults(urls[1]!, "open_food_facts_world"),
  ]);

  return mergeCandidates(
    [
      ...settledCandidate(israel, options, "search_israel"),
      ...settledCandidate(world, options, "search_world"),
    ],
    null,
  ).slice(0, 8);
}

function buildSearchUrl(baseUrl: string, searchTerms: string): string {
  const parameters = new URLSearchParams({
    search_terms: searchTerms,
    search_simple: "1",
    action: "process",
    json: "1",
    page_size: "6",
    fields: PRODUCT_FIELDS,
  });
  return `${baseUrl}/cgi/search.pl?${parameters.toString()}`;
}

async function fetchSingleProduct(
  url: string,
  providerName: ExternalProductCandidate["providerName"],
): Promise<ExternalProductCandidate[]> {
  const payload = await fetchJson(url);
  if (!isRecord(payload) || payload.status !== 1 || !isRecord(payload.product)) {
    return [];
  }
  const candidate = mapProduct(payload.product, providerName);
  return candidate ? [candidate] : [];
}

async function fetchSearchResults(
  url: string,
  providerName: ExternalProductCandidate["providerName"],
): Promise<ExternalProductCandidate[]> {
  const payload = await fetchJson(url);
  if (!isRecord(payload) || !isUnknownArray(payload.products)) return [];
  return payload.products
    .map((product) => (isRecord(product) ? mapProduct(product, providerName) : null))
    .filter((candidate): candidate is ExternalProductCandidate => candidate !== null);
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": USER_AGENT,
    },
  });
  if (!response.ok) throw new Error(`Open Food Facts returned ${response.status}`);
  return response.json() as Promise<unknown>;
}

function mapProduct(
  product: Record<string, unknown>,
  providerName: ExternalProductCandidate["providerName"],
): ExternalProductCandidate | null {
  const barcode = readString(product, "code");
  const nameHe =
    readString(product, "product_name_he") ??
    readString(product, "product_name") ??
    readString(product, "generic_name_he") ??
    readString(product, "generic_name");
  if (!nameHe) return null;

  const countries = readStringArray(product, "countries_tags");
  const categories = readStringArray(product, "categories_tags");
  const sourceRegion = isIsraeliProduct(product, countries) ? "israel" : "international";
  const actualProvider =
    sourceRegion === "israel"
      ? "open_food_facts_israel"
      : providerName === "open_food_facts_israel"
        ? "open_food_facts_world"
        : providerName;
  const baseUnit = inferBaseUnit(product, categories);
  const nutriments = isRecord(product.nutriments) ? product.nutriments : {};

  return {
    externalId: `${actualProvider}:${barcode ?? normalizeName(nameHe)}`,
    barcode,
    nameHe,
    nameOriginal: readString(product, "product_name"),
    brand: readString(product, "brands"),
    baseQuantity: 100,
    baseUnit,
    servingDescriptionHe: readString(product, "serving_size"),
    servingWeight: parseServingWeight(readString(product, "serving_size")),
    nutrients: {
      energyKcal: readNumber(nutriments, "energy-kcal_100g"),
      protein: readNumber(nutriments, "proteins_100g"),
      carbohydrate: readNumber(nutriments, "carbohydrates_100g"),
      fat: readNumber(nutriments, "fat_100g"),
      fiber: readNumber(nutriments, "fiber_100g"),
    },
    providerName: actualProvider,
    sourceLabelHe: sourceRegion === "israel" ? "Open Food Facts ישראל" : "Open Food Facts בינלאומי",
    sourceRegion,
    imageUrl:
      readString(product, "image_front_small_url") ?? readString(product, "image_front_url"),
    countries,
  };
}

function mergeCandidates(
  candidates: ExternalProductCandidate[],
  requestedBarcode: string | null,
): ExternalProductCandidate[] {
  const byIdentity = new Map<string, ExternalProductCandidate>();
  for (const candidate of candidates) {
    const identity =
      candidate.barcode ??
      `${normalizeName(candidate.nameHe)}:${normalizeName(candidate.brand ?? "")}`;
    const existing = byIdentity.get(identity);
    if (!existing || compareCandidate(candidate, existing, requestedBarcode) < 0) {
      byIdentity.set(identity, candidate);
    }
  }
  return [...byIdentity.values()].sort((left, right) =>
    compareCandidate(left, right, requestedBarcode),
  );
}

function compareCandidate(
  left: ExternalProductCandidate,
  right: ExternalProductCandidate,
  requestedBarcode: string | null,
): number {
  const leftExact = requestedBarcode !== null && left.barcode === requestedBarcode ? 0 : 1;
  const rightExact = requestedBarcode !== null && right.barcode === requestedBarcode ? 0 : 1;
  if (leftExact !== rightExact) return leftExact - rightExact;
  const leftRegion = left.sourceRegion === "israel" ? 0 : 1;
  const rightRegion = right.sourceRegion === "israel" ? 0 : 1;
  if (leftRegion !== rightRegion) return leftRegion - rightRegion;
  return nutritionCompleteness(right) - nutritionCompleteness(left);
}

function nutritionCompleteness(candidate: ExternalProductCandidate): number {
  return Object.values(candidate.nutrients).filter((value) => value !== null).length;
}

function settledCandidate(
  result: PromiseSettledResult<ExternalProductCandidate[]>,
  options: LookupOptions,
  stage: string,
): ExternalProductCandidate[] {
  if (result.status === "fulfilled") return result.value;
  const reason: unknown = result.reason;
  logEvent({
    severity: "warn",
    event: "external_product_catalog_failed",
    correlationId: options.correlationId,
    outcome: "external_catalog_unavailable",
    retryable: true,
    details: {
      stage,
      errorMessage:
        reason instanceof Error ? reason.message.slice(0, 300) : "Unknown external catalog error",
    },
  });
  return [];
}

function isIsraeliProduct(product: Record<string, unknown>, countries: string[]): boolean {
  if (readString(product, "product_name_he")) return true;
  return countries.some((country) => {
    const normalized = country.toLowerCase();
    return normalized.includes("israel") || normalized.includes("ישראל");
  });
}

function inferBaseUnit(product: Record<string, unknown>, categories: string[]): "g" | "ml" {
  const unit = readString(product, "product_quantity_unit")?.toLowerCase();
  if (unit && ["ml", "cl", "dl", "l"].includes(unit)) return "ml";
  const quantity = readString(product, "quantity")?.toLowerCase() ?? "";
  if (/\b(?:ml|cl|dl|l)\b/u.test(quantity)) return "ml";
  if (categories.some((category) => category.toLowerCase().includes("beverage"))) {
    return "ml";
  }
  return "g";
}

function parseServingWeight(value: string | null): number | null {
  if (!value) return null;
  const match = /(\d+(?:[.,]\d+)?)\s*(?:g|gr|גרם|ml|מ"ל|מ״ל)/iu.exec(value);
  if (!match?.[1]) return null;
  const parsed = Number(match[1].replace(",", "."));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readStringArray(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!isUnknownArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function readNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Number(value.replace(",", "."));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function normalizeName(value: string): string {
  return value.trim().toLocaleLowerCase("he-IL").replace(/\s+/gu, "-");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}
