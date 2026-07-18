export type UnitConversion = {
  quantity: number;
  gramsPerUnit: number | null;
};

export function quantityToGrams(input: UnitConversion): number | null {
  if (!Number.isFinite(input.quantity) || input.quantity < 0)
    throw new Error("Quantity must be a non-negative finite number");
  if (input.gramsPerUnit === null) return null;
  if (!Number.isFinite(input.gramsPerUnit) || input.gramsPerUnit <= 0)
    throw new Error("gramsPerUnit must be positive");
  return input.quantity * input.gramsPerUnit;
}

export function scaleNutrient(
  baseValue: number | null,
  consumedQuantity: number,
  baseQuantity: number,
): number | null {
  if (baseValue === null) return null;
  if (!Number.isFinite(baseQuantity) || baseQuantity <= 0)
    throw new Error("Base quantity must be positive");
  if (!Number.isFinite(consumedQuantity) || consumedQuantity < 0)
    throw new Error("Consumed quantity must be non-negative");
  return (baseValue * consumedQuantity) / baseQuantity;
}
