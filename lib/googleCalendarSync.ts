import crypto from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CalendarConnection, CalendarBooking, calendarEvent, digest, openCalendarToken,
  readCalendarBookings,
} from "./restaurantCalendar";

export class GoogleCalendarError extends Error {
  constructor(public status: number, public reconnect = false) { super("Google Calendar request failed"); }
}
export async function googleRequest(url: string, init: RequestInit = {}) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10000) });
  const body = await response.text();
  let data: any = {};
  try { data = body ? JSON.parse(body) : {}; } catch { /* A provider may return an HTML error page. */ }
  if (!response.ok) throw new GoogleCalendarError(response.status, data.error === "invalid_grant" || response.status === 401);
  return data;
}
export async function googleAccessToken(connection: CalendarConnection) {
  if (!connection.refresh_token) throw new GoogleCalendarError(401, true);
  const token = openCalendarToken(connection.refresh_token, `${connection.restaurant_id}:google`);
  const data = await googleRequest("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CALENDAR_CLIENT_ID || "",
      client_secret: process.env.GOOGLE_CALENDAR_CLIENT_SECRET || "", refresh_token: token, grant_type: "refresh_token" }),
  });
  if (!data.access_token) throw new GoogleCalendarError(401, true);
  return data.access_token as string;
}
export type GoogleEvent = {
  id: string; summary?: string; description?: string; status?: string;
  start?: { dateTime?: string }; end?: { dateTime?: string };
  extendedProperties?: { private?: Record<string, string> };
};
export function planGoogleCalendarSync(connection: CalendarConnection, bookings: CalendarBooking[], existing: GoogleEvent[]) {
  const remaining = new Map(existing.map(event => [event.id, event]));
  const operations: Array<{ method: "POST" | "PATCH" | "DELETE"; id: string; body?: Record<string, unknown> }> = [];
  for (const booking of bookings) {
    const event = calendarEvent(booking);
    const current = existing.find(item => item.status !== "cancelled" && item.extendedProperties?.private?.bokataBooking === booking.id);
    const id = current?.id || digest(`${connection.id}:${booking.id}:${booking.calendar_updated_at || booking.created_at}`);
    const body = { ...event, extendedProperties: { private: {
      bokataRestaurant: connection.restaurant_id, bokataBooking: booking.id,
    } } };
    if (current) {
      remaining.delete(current.id);
      const same = current.summary === event.summary && current.description === event.description && current.status === event.status &&
        Date.parse(current.start?.dateTime || "") === Date.parse(event.start.dateTime) &&
        Date.parse(current.end?.dateTime || "") === Date.parse(event.end.dateTime);
      if (!same) operations.push({ method: "PATCH", id, body });
    } else {
      operations.push({ method: "POST", id, body: { ...body, id } });
    }
  }
  // Only app-tagged events are ever removed, after both snapshots have loaded completely.
  for (const event of remaining.values()) {
    if (event.status !== "cancelled" && event.extendedProperties?.private?.bokataRestaurant === connection.restaurant_id) {
      operations.push({ method: "DELETE", id: event.id });
    }
  }
  return operations;
}
export async function syncGoogleCalendar(client: SupabaseClient, connection: CalendarConnection, deadline = Date.now() + 50000) {
  const lock = crypto.randomUUID();
  const { data: claimed, error: claimError } = await client.rpc("claim_calendar_sync", { p_id: connection.id, p_token: lock });
  if (claimError) throw new Error("Could not claim calendar sync");
  if (!claimed) return { busy: true, changed: 0, remaining: 0 };
  const started = Date.now();
  let lastError: string | null = null;
  let completed = false;
  try {
    // The row may have been disconnected/reconnected since the worker selected it.
    const { data: latest, error: latestError } = await client.from("calendar_connections").select("*").eq("id", connection.id).single();
    if (latestError || !latest) throw new Error("Could not reload calendar connection");
    connection = latest;
    if (!connection.refresh_token) return { busy: false, changed: 0, remaining: 0 };
    const accessToken = await googleAccessToken(connection);
    const headers = { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" };
    const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(connection.calendar_id || "")}/events`;
    const bookings = await readCalendarBookings(client, connection.restaurant_id);
    const existing: GoogleEvent[] = [];
    let pageToken = "";
    for (let page = 0; ; page++) {
      if (page >= 100) throw new Error("Calendar event limit exceeded");
      const params = new URLSearchParams({ maxResults: "2500", privateExtendedProperty: `bokataRestaurant=${connection.restaurant_id}` });
      if (pageToken) params.set("pageToken", pageToken);
      const data = await googleRequest(`${base}?${params}`, { headers });
      existing.push(...(data.items || []));
      pageToken = data.nextPageToken || "";
      if (!pageToken) break;
    }
    const operations = planGoogleCalendarSync(connection, bookings, existing);
    let changed = 0;
    // Bound each execution; the next run reconciles the remainder from fresh snapshots.
    for (const operation of operations.slice(0, 30)) {
      if (Date.now() - started > 45000 || Date.now() > deadline - 10000) break;
      const url = operation.method === "POST" ? base : `${base}/${encodeURIComponent(operation.id)}`;
      try {
        await googleRequest(url, { method: operation.method, headers,
          ...(operation.body ? { body: JSON.stringify(operation.body) } : {}) });
      } catch (error) {
        if (error instanceof GoogleCalendarError && operation.method === "DELETE" && [404, 410].includes(error.status)) {
          // An earlier attempt or the calendar owner already removed this event.
        } else if (error instanceof GoogleCalendarError && operation.method === "POST" && error.status === 409) {
          await googleRequest(`${base}/${encodeURIComponent(operation.id)}`, { method: "PATCH", headers, body: JSON.stringify(operation.body) });
        } else { throw error; }
      }
      changed++;
    }
    completed = changed === operations.length;
    return { busy: false, changed, remaining: operations.length - changed };
  } catch (error) {
    lastError = error instanceof GoogleCalendarError && (error.reconnect || [403, 404].includes(error.status))
      ? "Anslut Google Calendar igen för att fortsätta synkronisera."
      : "Synkroniseringen kunde inte slutföras. Vi försöker igen automatiskt.";
    throw new Error(lastError);
  } finally {
    if (completed) {
      // Do not clear a booking change that arrived while snapshots were being read.
      await client.from("calendar_connections").update({ needs_sync: false })
        .eq("id", connection.id).eq("sync_revision", connection.sync_revision).eq("sync_lock_token", lock);
    }
    const { error } = await client.from("calendar_connections").update({
      sync_lock_until: null, sync_lock_token: null, last_error: lastError,
      ...(completed ? { last_synced_at: new Date().toISOString() } : {}),
    }).eq("id", connection.id).eq("sync_lock_token", lock);
    if (error) console.error("Calendar sync lease release failed");
  }
}
