import { describe, expect, it } from "vitest";
import { forecastInventory } from "../../src/modules/operations/forecast.js";

describe("inventory forecast", () => {
  it("turns recent demand and lead time into an advisory reorder amount", () => {
    expect(
      forecastInventory({
        dailyUnits: [2, 2, 2],
        availableUnits: 5,
        leadTimeDays: 3,
        safetyDays: 2,
      }),
    ).toEqual({ averageDailyUnits: 2, forecastUnits: 10, reorderUnits: 5 });
  });

  it("fails closed for negative inventory", () => {
    expect(() =>
      forecastInventory({ dailyUnits: [1], availableUnits: -1, leadTimeDays: 1 }),
    ).toThrow("available units");
  });
});
