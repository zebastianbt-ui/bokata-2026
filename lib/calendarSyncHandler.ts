import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";
import { syncGoogleCalendar } from "../lib/googleCalendarSync";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return res.status(405).end();
  const expected = `Bearer ${process.env.CRON_SECRET || ""}`;
  const actual = String(req.headers.authorization || "");
  if (!process.env.CRON_SECRET || Buffer.byteLength(actual) !== Buffer.byteLength(expected) ||
    !crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) return res.status(401).end();
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return res.status(503).end();
  const client = createClient(url, key, { auth: { persistSession: false } });
  // Least recently attempted first; errors do not starve other restaurants.
  const dailyRefresh = new Date(Date.now() - 86400000).toISOString();
  const { data: connections, error } = await client.from("calendar_connections").select("*").eq("provider", "google")
    .not("refresh_token", "is", null).or(`needs_sync.eq.true,last_synced_at.lt.${dailyRefresh}`)
    .order("last_attempt_at", { ascending: true, nullsFirst: true }).limit(30);
  if (error) return res.status(503).json({ error: "Calendar setup is incomplete" });
  let processed = 0; let failed = 0; let cursor = 0;
  const deadline = Date.now() + 50000;
  const worker = async () => {
    while (cursor < (connections || []).length && Date.now() < deadline - 15000) {
      const connection = connections![cursor++];
      try {
        const { data: owner, error: ownerError } = await client.from("restaurants").select("owner_id").eq("id", connection.restaurant_id).single();
        if (ownerError) throw new Error("Could not verify owner");
        if (owner?.owner_id !== connection.created_by) {
          await client.from("calendar_connections").update({ refresh_token: null, last_error: "Restaurangens ägare har ändrats. Anslut kalendern igen." }).eq("id", connection.id);
        } else {
          await syncGoogleCalendar(client, connection, deadline);
        }
      } catch { failed++; }
      processed++;
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return res.status(failed ? 502 : 200).json({ processed, failed });
}
