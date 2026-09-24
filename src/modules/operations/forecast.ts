export interface InventoryForecastInput {
  dailyUnits: readonly number[];
  availableUnits: number;
  leadTimeDays: number;
  safetyDays?: number;
}

export interface InventoryForecast {
  averageDailyUnits: number;
  forecastUnits: number;
  reorderUnits: number;
}

export function forecastInventory(input: InventoryForecastInput): InventoryForecast {
  if (!Number.isInteger(input.availableUnits) || input.availableUnits < 0)
    throw new Error("available units must be non-negative");
  if (!Number.isFinite(input.leadTimeDays) || input.leadTimeDays < 0)
    throw new Error("lead time must be non-negative");
  const recent = input.dailyUnits
    .filter((units) => Number.isFinite(units) && units >= 0)
    .slice(-14);
  const averageDailyUnits = recent.length
    ? recent.reduce((total, units) => total + units, 0) / recent.length
    : 0;
  const coverDays = input.leadTimeDays + Math.max(0, input.safetyDays ?? 2);
  const forecastUnits = Math.ceil(averageDailyUnits * coverDays);
  return {
    averageDailyUnits,
    forecastUnits,
    reorderUnits: Math.max(0, forecastUnits - input.availableUnits),
  };
}
