export type NullableNutrients = {
  calories: number | null;
  proteinGrams: number | null;
  carbohydrateGrams: number | null;
  fatGrams: number | null;
  fiberGrams: number | null;
  sugarGrams: number | null;
  sodiumMilligrams: number | null;
};

export type NutritionTotal = NullableNutrients & {
  partialNutrients: Array<keyof NullableNutrients>;
};

const nutrientKeys: Array<keyof NullableNutrients> = [
  "calories",
  "proteinGrams",
  "carbohydrateGrams",
  "fatGrams",
  "fiberGrams",
  "sugarGrams",
  "sodiumMilligrams",
];

export function sumNutrients(items: NullableNutrients[]): NutritionTotal {
  const partialNutrients: Array<keyof NullableNutrients> =
    items.length === 0 ? [...nutrientKeys] : [];
  const result: NullableNutrients = {
    calories: 0,
    proteinGrams: 0,
    carbohydrateGrams: 0,
    fatGrams: 0,
    fiberGrams: 0,
    sugarGrams: 0,
    sodiumMilligrams: 0,
  };

  for (const key of nutrientKeys) {
    let total = 0;
    let knownCount = 0;
    for (const item of items) {
      const value = item[key];
      if (value === null) continue;
      total += value;
      knownCount += 1;
    }
    if (knownCount === 0) result[key] = null;
    else result[key] = total;
    if (knownCount !== items.length) partialNutrients.push(key);
  }

  return { ...result, partialNutrients };
}
