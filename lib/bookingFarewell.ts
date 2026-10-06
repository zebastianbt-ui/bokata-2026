import { BOOKING_TIME_ZONE } from "./specialRestaurantRules";

export function bookingFarewell(date: string, now = new Date()): string {
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: BOOKING_TIME_ZONE }).format(now);
  const current = new Date(`${today}T12:00:00Z`);
  const booking = new Date(`${date}T12:00:00Z`);
  const monday = new Date(current);
  monday.setUTCDate(current.getUTCDate() - (current.getUTCDay() + 6) % 7);
  const daysFromMonday = Math.round((booking.getTime() - monday.getTime()) / 86400000);
  if (daysFromMonday >= 0 && daysFromMonday < 7) {
    return `Vi ses på ${new Intl.DateTimeFormat("sv-SE", { weekday: "long", timeZone: "UTC" }).format(booking)}!`;
  }
  if (daysFromMonday >= 7 && daysFromMonday < 14) return "Vi ses nästa vecka!";
  const formatted = new Intl.DateTimeFormat("sv-SE", {
    day: "numeric", month: "long", timeZone: "UTC",
    ...(booking.getUTCFullYear() !== current.getUTCFullYear() ? { year: "numeric" as const } : {}),
  }).format(booking);
  return `Vi ses den ${formatted}!`;
}
