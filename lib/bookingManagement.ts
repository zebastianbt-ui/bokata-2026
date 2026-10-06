import crypto from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

export async function loadManagedBooking(client: SupabaseClient, secret: string, credentials: any) {
  const bid = typeof credentials?.bid === "string" ? credentials.bid : "";
  const email = typeof credentials?.email === "string" ? credentials.email.trim().toLowerCase() : "";
  const sig = typeof credentials?.sig === "string" ? credentials.sig : "";
  const expected = crypto.createHmac("sha256", secret).update(`${bid}:${email}`).digest("hex");
  if (!bid || !email || !/^[a-f0-9]{64}$/.test(sig) || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) {
    return { error: "Länken är ogiltig eller har ändrats.", status: 403 } as const;
  }
  const { data: booking, error } = await client.from("bookings")
    .select("id,restaurant_id,date,time,guests,name,client_email,client_phone,notes,status,duration_min,confirm_token")
    .eq("id", bid).maybeSingle();
  if (error) return { error: "Bokningen kunde inte hämtas. Försök igen senare.", status: 500 } as const;
  if (!booking || String(booking.client_email || "").trim().toLowerCase() !== email) {
    return { error: "Bokningen kunde inte hittas.", status: 404 } as const;
  }
  return { booking };
}
