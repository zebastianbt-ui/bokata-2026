import crypto from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { BOOKING_TIME_ZONE } from "./specialRestaurantRules";

export const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.app.created";
export type CalendarBooking = {
  id: string; restaurant_id: string; name: string; date: string; time: string;
  guests: number; duration_min: number | null; status: string; created_at: string;
  calendar_updated_at?: string;
};
export type CalendarConnection = {
  id: string; restaurant_id: string; provider: "google" | "apple"; created_by: string;
  calendar_id: string | null; refresh_token: string | null; feed_nonce: string;
  sync_revision: number;
  last_synced_at: string | null; last_error: string | null; sync_lock_until: string | null;
};
export const calendarSiteUrl = () => (process.env.SITE_URL || "https://www.bokata.se").replace(/\/$/, "");
export const calendarCallbackUrl = () => `${calendarSiteUrl()}/api/calendar?action=google-callback`;
export function calendarKey() {
  const key = Buffer.from(process.env.CALENDAR_ENCRYPTION_KEY || "", "base64");
  if (key.length !== 32) throw new Error("Calendar encryption key is not configured");
  return key;
}
export function sealCalendarToken(value: string, context: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", calendarKey(), iv);
  cipher.setAAD(Buffer.from(context));
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map(b => b.toString("base64url")).join(".");
}
export function openCalendarToken(value: string, context: string) {
  const [iv, tag, encrypted] = value.split(".").map(p => Buffer.from(p, "base64url"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", calendarKey(), iv);
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}
export const digest = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
export const feedSignature = (connection: Pick<CalendarConnection, "id" | "feed_nonce">) =>
  crypto.createHmac("sha256", calendarKey()).update(`apple:${connection.id}:${connection.feed_nonce}`).digest("hex");
export function validFeedSignature(connection: Pick<CalendarConnection, "id" | "feed_nonce">, token: string) {
  return /^[a-f0-9]{64}$/.test(token) && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(feedSignature(connection)));
}
export const calendarFeedUrl = (connection: CalendarConnection) =>
  `${calendarSiteUrl()}/api/calendar?action=feed&id=${encodeURIComponent(connection.id)}&token=${feedSignature(connection)}`;

export function bookingStartUtc(date: string, time: string) {
  const wall = `${date}T${time.slice(0, 5)}:00`;
  let candidate = new Date(`${wall}Z`);
  if (!Number.isFinite(candidate.getTime())) throw new Error("Invalid booking date");
  const formatter = new Intl.DateTimeFormat("sv-SE", {
    timeZone: BOOKING_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  const formattedWall = (value: Date) => {
    const parts = formatter.formatToParts(value);
    const part = (type: string) => parts.find(p => p.type === type)?.value;
    return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:${part("second")}`;
  };
  for (let i = 0; i < 3; i++) {
    const actual = formattedWall(candidate);
    if (actual === wall) return candidate;
    candidate = new Date(candidate.getTime() + Date.parse(`${wall}Z`) - Date.parse(`${actual}Z`));
  }
  if (formattedWall(candidate) !== wall) throw new Error("Invalid booking time in Stockholm");
  return candidate;
}
export function calendarEvent(booking: CalendarBooking, origin = calendarSiteUrl()) {
  const start = bookingStartUtc(booking.date, booking.time);
  const duration = Number(booking.duration_min) > 0 ? Number(booking.duration_min) : 90;
  const end = new Date(start.getTime() + duration * 60000);
  const pending = booking.status === "pending";
  return {
    summary: `${pending ? "Väntar på bekräftelse · " : ""}${booking.guests} gäster · ${booking.name}`,
    description: `Bokning via Bokäta.\n${pending ? "Väntar på restaurangens bekräftelse." : "Bekräftad bokning."}\nÄndra bokningen i Bokäta: ${origin}/dashboard`,
    start: { dateTime: start.toISOString(), timeZone: BOOKING_TIME_ZONE },
    end: { dateTime: end.toISOString(), timeZone: BOOKING_TIME_ZONE },
    status: pending ? "tentative" : "confirmed",
    visibility: "private", transparency: "transparent",
    reminders: { useDefault: false },
  };
}
const escapeIcs = (value: string) => value.replace(/\\/g, "\\\\").replace(/\r\n|\r|\n/g, "\\n").replace(/;/g, "\\;").replace(/,/g, "\\,");
export function foldIcsLine(line: string) {
  const lines: string[] = []; let current = ""; let bytes = 0;
  for (const char of line) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > 75) { lines.push(current); current = " "; bytes = 1; }
    current += char; bytes += size;
  }
  lines.push(current);
  return lines.join("\r\n");
}
const icsTime = (value: string) => new Date(value).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
export function renderCalendarFeed(name: string, bookings: CalendarBooking[]) {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Bokata//Reservations//SV", "CALSCALE:GREGORIAN",
    `X-WR-CALNAME:${escapeIcs(`Bokäta · ${name}`)}`, `X-WR-TIMEZONE:${BOOKING_TIME_ZONE}`, "REFRESH-INTERVAL;VALUE=DURATION:PT15M", "X-PUBLISHED-TTL:PT15M"];
  for (const booking of bookings) {
    if (!["confirmed", "pending"].includes(booking.status)) continue;
    const event = calendarEvent(booking);
    const updated = booking.calendar_updated_at || booking.created_at;
    lines.push("BEGIN:VEVENT", `UID:${digest(`${booking.restaurant_id}:${booking.id}`)}@bokata.se`,
      `DTSTAMP:${icsTime(updated)}`, `LAST-MODIFIED:${icsTime(updated)}`,
      `DTSTART:${icsTime(event.start.dateTime)}`, `DTEND:${icsTime(event.end.dateTime)}`,
      `SUMMARY:${escapeIcs(event.summary)}`, `DESCRIPTION:${escapeIcs(event.description)}`,
      `STATUS:${event.status.toUpperCase()}`, "CLASS:PRIVATE", "TRANSP:TRANSPARENT", "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldIcsLine).join("\r\n") + "\r\n";
}
export async function readCalendarBookings(client: SupabaseClient, restaurantId: string, now = new Date()) {
  const from = new Date(now); from.setUTCDate(from.getUTCDate() - 30);
  const to = new Date(now); to.setUTCDate(to.getUTCDate() + 365);
  const bookings: CalendarBooking[] = [];
  for (let offset = 0; offset < 50000; offset += 500) {
    const { data, error } = await client.from("bookings")
      .select("id,restaurant_id,name,date,time,guests,duration_min,status,created_at,calendar_updated_at")
      .eq("restaurant_id", restaurantId).in("status", ["confirmed", "pending"])
      .gte("date", from.toISOString().slice(0, 10)).lte("date", to.toISOString().slice(0, 10))
      .order("id").range(offset, offset + 499);
    if (error) throw new Error("Could not read bookings");
    bookings.push(...(data || []));
    if (!data || data.length < 500) return bookings;
  }
  // Never reconcile an incomplete snapshot: that could remove valid events.
  throw new Error("Calendar booking limit exceeded");
}
