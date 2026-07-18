/**
 * Time helpers (data-model.md Conventions).
 *
 * - All timestamps are UTC internally (`Date`, always an absolute instant).
 * - Rendering for humans/receipts uses the `Asia/Ho_Chi_Minh` zone (+07:00,
 *   no DST) via the Intl API so we never hand-roll offset math.
 */

export const HO_CHI_MINH_TZ = "Asia/Ho_Chi_Minh" as const;

/** Current instant as a UTC-based Date. */
export function nowUtc(): Date {
  return new Date();
}

/** Wall-clock parts of an instant in the Ho Chi Minh zone. */
export interface HoChiMinhParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number; // 0-59
  second: number; // 0-59
}

const PARTS_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: HO_CHI_MINH_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

/** Decompose an instant into Ho Chi Minh wall-clock parts. */
export function toHoChiMinh(instant: Date): HoChiMinhParts {
  const map: Record<string, string> = {};
  for (const part of PARTS_FORMATTER.formatToParts(instant)) {
    if (part.type !== "literal") map[part.type] = part.value;
  }
  const hour = Number(map.hour);
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    // Intl can emit "24" for midnight under hour12:false; normalize to 0.
    hour: hour === 24 ? 0 : hour,
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

const DISPLAY_FORMATTER = new Intl.DateTimeFormat("vi-VN", {
  timeZone: HO_CHI_MINH_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

/** Human-readable rendering of an instant in the Ho Chi Minh zone (vi-VN). */
export function formatHoChiMinh(instant: Date): string {
  return DISPLAY_FORMATTER.format(instant);
}
