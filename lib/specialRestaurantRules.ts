export type SwedishDayName = "måndag" | "tisdag" | "onsdag" | "torsdag" | "fredag" | "lördag" | "söndag";

export const BOOKING_TIME_ZONE = "Europe/Stockholm";

const SUMMER_BOOKING_FROM = "2026-06-29";
const SUMMER_BOOKING_TO = "2026-08-16";
const SUMMER_LATEST_BOOKING_TIME = "19:30";
const POST_SUMMER_WEEKDAY_LATEST_BOOKING_TIME = "16:00";

const DATE_SPECIFIC_LATEST_BOOKING_TIMES: Record<string, string> = {
  "2026-07-31": "18:30",
};

export const FULLY_BOOKED_NOTICE_DATES = new Set(["2026-07-26"]);

const MANUAL_FULLY_BOOKED_SLOTS: Record<string, string[]> = {
  "2026-04-03": ["11:30", "12:00", "12:30", "13:00", "13:30", "14:00", "14:30", "15:00", "15:30"],
  "2026-04-05": ["13:00"],
  "2026-07-26": ["17:00", "17:30", "18:00", "18:30", "19:00", "19:30", "20:00", "20:30", "21:00", "21:30"],
};

const MADAME_BLA_RESTAURANT_IDS = new Set([
  "77832d94-da22-464c-aa60-1ceecea4b3f9",
  "70b7c285-2b34-48d5-b42c-e16dc883f5af",
  "8300e19c-6f0f-42fb-8a96-9eac38268a1d",
]);

export const MADAME_BLA_CLOSED_DATES = new Set(["2026-09-07", "2026-09-08"]);

export const isIsoInRange = (iso: string, from: string, to: string) => iso >= from && iso <= to;

export const normalizeSlotTime = (value: string) => (value?.length >= 5 ? value.slice(0, 5) : value);

export const toSwedishDayName = (iso: string): SwedishDayName | null => {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return ["söndag", "måndag", "tisdag", "onsdag", "torsdag", "fredag", "lördag"][d.getUTCDay()] as SwedishDayName;
};

const timeToMin = (value: string) => {
  const [h, m] = value.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return NaN;
  return h * 60 + m;
};

const isSummerBookingDate = (dateIso: string) => isIsoInRange(dateIso, SUMMER_BOOKING_FROM, SUMMER_BOOKING_TO);

export const latestBookingTimeForDate = (dateIso: string) => {
  if (DATE_SPECIFIC_LATEST_BOOKING_TIMES[dateIso]) return DATE_SPECIFIC_LATEST_BOOKING_TIMES[dateIso];
  if (isSummerBookingDate(dateIso)) return SUMMER_LATEST_BOOKING_TIME;
  if (dateIso <= SUMMER_BOOKING_TO) return null;
  return POST_SUMMER_WEEKDAY_LATEST_BOOKING_TIME;
};

export const isManuallyFullBookedSlot = (dateIso: string, timeValue: string) => {
  const slots = MANUAL_FULLY_BOOKED_SLOTS[dateIso] ?? [];
  return slots.includes(normalizeSlotTime(timeValue));
};

export const isMadameBlaKnowledge = (knowledge?: string | null) => /madame\s*bl[åa]/i.test(knowledge ?? "");

export const isMadameBlaRestaurant = (restaurantId?: string | null, knowledge?: string | null) =>
  !!restaurantId && (MADAME_BLA_RESTAURANT_IDS.has(restaurantId) || isMadameBlaKnowledge(knowledge));

export const isMadameBlaClosedDate = (restaurantId: string | null | undefined, dateIso: string, knowledge?: string | null) =>
  MADAME_BLA_CLOSED_DATES.has(dateIso) && isMadameBlaRestaurant(restaurantId, knowledge);

export const getMadameBlaHoursOverride = (dateIso: string, day: SwedishDayName | string | null) => {
  if (!day) return undefined;
  if (isIsoInRange(dateIso, "2026-08-23", "2026-09-06")) {
    return { closed: false, open: "11:00", close: "17:00" };
  }
  if (isIsoInRange(dateIso, "2026-09-07", "2026-10-11")) {
    if (day === "torsdag" || day === "fredag" || day === "lördag" || day === "söndag") {
      return { closed: false, open: "11:00", close: "17:00" };
    }
    return { closed: true, open: "11:00", close: "17:00" };
  }
  if (isIsoInRange(dateIso, "2026-10-12", "2026-12-31")) {
    return { closed: true, open: "11:00", close: "17:00" };
  }
  return undefined;
};

export const getMadameBlaDropInRange = (dateIso: string, day: SwedishDayName | string | null) => {
  if (!day) return null;
  if (isIsoInRange(dateIso, "2026-05-01", "2026-06-28")) {
    if (day === "lördag" || day === "söndag") return { fromMin: 11 * 60, toMinExclusive: 16 * 60 };
    return null;
  }
  if (isIsoInRange(dateIso, "2026-06-29", "2026-08-16")) {
    return { fromMin: 11 * 60, toMinExclusive: 16 * 60 };
  }
  if (isIsoInRange(dateIso, "2026-08-17", "2026-10-11")) {
    const isWeekend = day === "lördag" || day === "söndag";
    const isBookableOctoberWeekend = isIsoInRange(dateIso, "2026-10-01", "2026-10-11");
    if (isWeekend && !isBookableOctoberWeekend) return { fromMin: 0, toMinExclusive: 24 * 60 };
    return null;
  }
  return null;
};

export const isDropInOnlySlotForMadameBla = (
  dateIso: string,
  timeValue: string,
  restaurantId?: string | null,
  knowledge?: string | null,
  dayName?: SwedishDayName | string | null
) => {
  if (!isMadameBlaRestaurant(restaurantId, knowledge)) return false;
  const rule = getMadameBlaDropInRange(dateIso, dayName ?? toSwedishDayName(dateIso));
  if (!rule) return false;
  const mins = timeToMin(normalizeSlotTime(timeValue));
  if (!Number.isFinite(mins)) return false;
  return mins >= rule.fromMin && mins < rule.toMinExclusive;
};
