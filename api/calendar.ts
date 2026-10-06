import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import crypto from "crypto";
import {
  GOOGLE_CALENDAR_SCOPE, CalendarConnection, calendarCallbackUrl, calendarSiteUrl,
  calendarKey, calendarFeedUrl, digest, readCalendarBookings, renderCalendarFeed,
  sealCalendarToken, validFeedSignature,
} from "../lib/restaurantCalendar";
import { googleRequest, GoogleCalendarError, syncGoogleCalendar } from "../lib/googleCalendarSync";
import { rateLimit } from "../lib/rateLimit";

export const config = { maxDuration: 60 };
const value = (input: unknown) => typeof input === "string" ? input : "";
const cookieName = "bokata_calendar_oauth";
const googleConfigured = () => !!(process.env.GOOGLE_CALENDAR_CLIENT_ID && process.env.GOOGLE_CALENDAR_CLIENT_SECRET && process.env.CRON_SECRET);
function cookie(value: string, age = 600) {
  return `${cookieName}=${value}; HttpOnly; SameSite=Lax; Path=/api/calendar; Max-Age=${age}${calendarSiteUrl().startsWith("https:") ? "; Secure" : ""}`;
}
async function ownedRestaurant(client: SupabaseClient, id: string, userId: string) {
  const { data, error } = await client.from("restaurants").select("id,name,owner_id").eq("id", id).eq("owner_id", userId).maybeSingle();
  if (error) throw new Error("Could not verify restaurant ownership");
  return data;
}
function redirectResult(res: VercelResponse, result: "connected" | "cancelled" | "error") {
  res.setHeader("Set-Cookie", cookie("", 0));
  res.redirect(303, `${calendarSiteUrl()}/dashboard?calendar=${result}`);
}
async function googleCallback(req: VercelRequest, res: VercelResponse, client: SupabaseClient) {
  const state = value(req.query.state);
  const browserToken = String(req.headers.cookie || "").split(";").map(part => part.trim()).find(part => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1) || "";
  if (!/^[a-f0-9]{64}$/.test(state) || !/^[a-f0-9]{64}$/.test(browserToken)) return redirectResult(res, "error");
  const { data: pending, error } = await client.from("calendar_oauth_states").delete()
    .eq("state_hash", digest(state)).eq("browser_hash", digest(browserToken))
    .gt("expires_at", new Date().toISOString()).select("user_id,restaurant_id").maybeSingle();
  if (error || !pending) return redirectResult(res, "error");
  if (req.query.error) return redirectResult(res, "cancelled");
  const restaurant = await ownedRestaurant(client, pending.restaurant_id, pending.user_id);
  if (!restaurant || !value(req.query.code)) return redirectResult(res, "error");
  let connectionLock: { id: string; token: string } | null = null;
  try {
    const tokens = await googleRequest("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code: value(req.query.code), client_id: process.env.GOOGLE_CALENDAR_CLIENT_ID || "",
        client_secret: process.env.GOOGLE_CALENDAR_CLIENT_SECRET || "", redirect_uri: calendarCallbackUrl(), grant_type: "authorization_code" }),
    });
    if (!tokens.access_token || !tokens.refresh_token || (tokens.scope && !tokens.scope.split(" ").includes(GOOGLE_CALENDAR_SCOPE))) {
      return redirectResult(res, "error");
    }
    const { data: existing, error: existingError } = await client.from("calendar_connections").select("*")
      .eq("restaurant_id", restaurant.id).eq("provider", "google").maybeSingle();
    if (existingError) throw new Error("Could not load existing connection");
    if (existing) {
      const lock = crypto.randomUUID();
      const { data: claimed, error: lockError } = await client.rpc("claim_calendar_sync", { p_id: existing.id, p_token: lock });
      if (lockError || !claimed) throw new Error("Sync in progress");
      connectionLock = { id: existing.id, token: lock };
    }
    const headers = { Authorization: `Bearer ${tokens.access_token}`, "Content-Type": "application/json" };
    let calendarId = existing?.calendar_id;
    if (calendarId) {
      try { await googleRequest(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}`, { headers }); }
      catch (error) {
        if (error instanceof GoogleCalendarError && [403, 404, 410].includes(error.status)) calendarId = null;
        else throw error;
      }
    }
    if (!calendarId) {
      const calendar = await googleRequest("https://www.googleapis.com/calendar/v3/calendars", {
        method: "POST", headers, body: JSON.stringify({ summary: `Bokäta · ${restaurant.name || "Bokningar"}`,
          timeZone: "Europe/Stockholm", description: "Restaurangens bokningar. Ändra och avboka i Bokäta." }),
      });
      calendarId = calendar.id;
    }
    if (!calendarId) throw new Error("Calendar missing");
    const { error: saveError } = await client.from("calendar_connections").upsert({
      restaurant_id: restaurant.id, provider: "google", created_by: pending.user_id, calendar_id: calendarId,
      refresh_token: sealCalendarToken(tokens.refresh_token, `${restaurant.id}:google`), last_error: null,
      last_synced_at: null, needs_sync: true,
    }, { onConflict: "restaurant_id,provider" });
    if (saveError) throw new Error("Could not save calendar connection");
    return redirectResult(res, "connected");
  } catch {
    return redirectResult(res, "error");
  } finally {
    if (connectionLock) await client.from("calendar_connections").update({ sync_lock_until: null, sync_lock_token: null })
      .eq("id", connectionLock.id).eq("sync_lock_token", connectionLock.token);
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("X-Content-Type-Options", "nosniff");
  const action = value(req.query.action) || "status";
  if (!["GET", "POST"].includes(req.method || "")) return res.status(405).json({ error: "Method Not Allowed" });
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return res.status(503).json({ error: "Kalenderanslutningen är inte tillgänglig ännu." });
  const client = createClient(url, serviceKey, { auth: { persistSession: false } });
  try {
    calendarKey();
    if (action === "google-callback") {
      if (req.method !== "GET") return res.status(405).end();
      return await googleCallback(req, res, client);
    }
    if (action === "feed") {
      if (req.method !== "GET") return res.status(405).end();
      const id = value(req.query.id); const token = value(req.query.token);
      if (!/^[a-f0-9-]{36}$/.test(id) || !/^[a-f0-9]{64}$/.test(token)) return res.status(404).send("Kalendern hittades inte.");
      const { data: connection, error } = await client.from("calendar_connections").select("*").eq("id", id).eq("provider", "apple").maybeSingle();
      if (error) return res.status(503).send("Kalendern kunde inte hämtas. Försök igen senare.");
      if (!connection || !validFeedSignature(connection, token)) return res.status(404).send("Kalendern hittades inte.");
      const restaurant = await ownedRestaurant(client, connection.restaurant_id, connection.created_by);
      if (!restaurant) return res.status(404).send("Kalendern hittades inte.");
      const bookings = await readCalendarBookings(client, connection.restaurant_id);
      const feed = renderCalendarFeed(restaurant.name || "Bokningar", bookings);
      res.setHeader("Content-Type", "text/calendar; charset=utf-8");
      res.setHeader("Content-Disposition", 'inline; filename="bokata.ics"');
      return res.status(200).send(feed);
    }
    const bearer = value(req.headers.authorization).replace(/^Bearer /, "");
    if (!bearer) return res.status(401).json({ error: "Logga in för att ansluta din kalender." });
    const { data: auth, error: authError } = await client.auth.getUser(bearer);
    if (authError || !auth.user) return res.status(401).json({ error: "Logga in igen för att fortsätta." });
    const restaurantId = value(req.method === "GET" ? req.query.restaurantId : req.body?.restaurantId);
    if (!/^[a-f0-9-]{36}$/.test(restaurantId)) return res.status(400).json({ error: "Välj en restaurang." });
    const restaurant = await ownedRestaurant(client, restaurantId, auth.user.id);
    if (!restaurant) return res.status(403).json({ error: "Endast restaurangens ägare kan ansluta en kalender." });
    if (action === "status" && req.method === "GET") {
      const { data, error } = await client.from("calendar_connections").select("*").eq("restaurant_id", restaurantId);
      if (error) throw new Error("Could not load calendar connections");
      return res.status(200).json({ googleAvailable: googleConfigured(), connections: (data || []).filter(c => c.created_by === auth.user.id).map((c: CalendarConnection) => ({
        provider: c.provider, connected: c.provider === "apple" || !!c.refresh_token,
        lastSyncedAt: c.last_synced_at, error: c.last_error,
        ...(c.provider === "apple" ? { feedUrl: calendarFeedUrl(c) } : {}),
      })) });
    }
    if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });
    const limiter = await rateLimit(`calendar:${auth.user.id}`, 15, 60000);
    if (!limiter.ok) return res.status(429).json({ error: "För många försök. Vänta en minut och försök igen." });
    if (action === "google-connect") {
      if (!googleConfigured()) return res.status(503).json({ error: "Google Calendar är inte aktiverat för Bokäta ännu." });
      const state = crypto.randomBytes(32).toString("hex");
      const browserToken = crypto.randomBytes(32).toString("hex");
      await client.from("calendar_oauth_states").delete().lt("expires_at", new Date().toISOString());
      const { error } = await client.from("calendar_oauth_states").insert({ state_hash: digest(state), browser_hash: digest(browserToken),
        user_id: auth.user.id, restaurant_id: restaurantId, expires_at: new Date(Date.now() + 600000).toISOString() });
      if (error) throw new Error("Could not start OAuth");
      res.setHeader("Set-Cookie", cookie(browserToken));
      const params = new URLSearchParams({ client_id: process.env.GOOGLE_CALENDAR_CLIENT_ID!, redirect_uri: calendarCallbackUrl(),
        response_type: "code", scope: GOOGLE_CALENDAR_SCOPE, access_type: "offline", prompt: "consent", state });
      return res.status(200).json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
    }
    if (action === "apple-connect") {
      // Repeated clicks preserve the existing subscription URL.
      const { error } = await client.from("calendar_connections").upsert({ restaurant_id: restaurantId, provider: "apple", created_by: auth.user.id },
        { onConflict: "restaurant_id,provider", ignoreDuplicates: true });
      if (error) throw new Error("Could not create feed");
      const { data: connection, error: readError } = await client.from("calendar_connections").select("*").eq("restaurant_id", restaurantId).eq("provider", "apple").single();
      if (readError || !connection || connection.created_by !== auth.user.id) throw new Error("Could not read feed");
      return res.status(200).json({ feedUrl: calendarFeedUrl(connection) });
    }
    if (action === "disconnect" || action === "sync") {
      const provider = value(req.body?.provider);
      if (!["google", "apple"].includes(provider) || (action === "sync" && provider !== "google")) return res.status(400).json({ error: "Ogiltig kalender." });
      const { data: connection, error } = await client.from("calendar_connections").select("*").eq("restaurant_id", restaurantId).eq("provider", provider).maybeSingle();
      if (error) throw new Error("Could not load calendar");
      if (!connection) return res.status(404).json({ error: "Kalendern är inte ansluten." });
      if (connection.created_by !== auth.user.id) return res.status(403).json({ error: "Anslutningen tillhör en tidigare ägare. Kontakta Bokäta." });
      if (action === "sync") {
        if (!connection.refresh_token) return res.status(409).json({ error: "Anslut Google Calendar igen." });
        return res.status(200).json(await syncGoogleCalendar(client, connection));
      }
      if (provider === "google") {
        // Claim the same lease as the sync worker before disabling it.
        const lock = crypto.randomUUID();
        const { data: claimed, error: lockError } = await client.rpc("claim_calendar_sync", { p_id: connection.id, p_token: lock });
        if (lockError) throw new Error("Could not lock calendar");
        if (!claimed) return res.status(409).json({ error: "En synkronisering pågår. Försök igen om en stund." });
        const { error: updateError } = await client.from("calendar_connections").update({ refresh_token: null, sync_lock_until: null,
          sync_lock_token: null, last_error: null }).eq("id", connection.id);
        if (updateError) throw new Error("Could not disconnect calendar");
      } else {
        const { error: deleteError } = await client.from("calendar_connections").delete().eq("id", connection.id);
        if (deleteError) throw new Error("Could not disconnect calendar");
      }
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: "Okänd kalenderåtgärd." });
  } catch {
    if (action === "google-callback") return redirectResult(res, "error");
    return res.status(503).json({ error: "Kalenderanslutningen kunde inte uppdateras. Försök igen senare eller kontakta Bokäta." });
  }
}
