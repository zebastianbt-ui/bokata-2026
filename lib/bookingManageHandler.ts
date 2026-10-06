import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { loadManagedBooking } from "../lib/bookingManagement";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  if (req.method !== "GET") return res.status(405).json({ error: "Method Not Allowed" });
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return res.status(500).json({ error: "Serverfel. Försök igen senare." });
  const client = createClient(url, key, { auth: { persistSession: false } });
  const result = await loadManagedBooking(client, process.env.BOOKING_CANCEL_SECRET || key, req.query);
  if (result.error) return res.status(result.status).json({ error: result.error });
  const { date, time, guests, name, status } = result.booking!;
  return res.status(200).json({ booking: { date, time: String(time).slice(0, 5), guests, name, status } });
}
