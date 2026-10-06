import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

const getEnv = (key: string) => process.env[key] ?? "";
const getSiteUrl = () => getEnv("SITE_URL") || "https://www.bokata.se";
const BOOKING_MESSAGE_LABEL = "Bokningsmeddelande";
const BOOKING_CONFIRMATION_EMAIL_AUTO_LABEL = "Bekräftelsemail (automatisk)";
const BOOKING_CONFIRMATION_EMAIL_MANUAL_LABEL = "Bekräftelsemail (manuell)";
const KNOWLEDGE_MESSAGE_LABELS = [
  BOOKING_MESSAGE_LABEL,
  BOOKING_CONFIRMATION_EMAIL_AUTO_LABEL,
  BOOKING_CONFIRMATION_EMAIL_MANUAL_LABEL,
];
const getBookingLinkSecret = (serviceKey: string) => getEnv("BOOKING_CANCEL_SECRET") || serviceKey;
const signBookingLink = (secret: string, bookingId: string, email: string) =>
  crypto.createHmac("sha256", secret).update(`${bookingId}:${email.toLowerCase().trim()}`).digest("hex");
const buildBookingManageUrl = (origin: string, secret: string, bookingId: string, email: string) => {
  const normalizedEmail = email.toLowerCase().trim();
  const sig = signBookingLink(secret, bookingId, normalizedEmail);
  return `${origin}/booking/manage?bid=${encodeURIComponent(bookingId)}&email=${encodeURIComponent(normalizedEmail)}&sig=${encodeURIComponent(sig)}`;
};

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");

const extractMultilineLabelValue = (knowledge: string | null | undefined, label: string) => {
  if (!knowledge) return "";
  const lines = String(knowledge).replace(/\r/g, "").split("\n").map((line) => line.trimEnd());
  const labelLower = `${label.toLowerCase()}:`;
  const startIdx = lines.findIndex((line) => line.trimStart().toLowerCase().startsWith(labelLower));
  if (startIdx === -1) return "";
  const first = lines[startIdx].split(":").slice(1).join(":").trim();
  const collected: string[] = [];
  if (first) collected.push(first);
  for (let i = startIdx + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) {
      if (collected.length) collected.push("");
      continue;
    }
    const lower = line.trimStart().toLowerCase();
    if (lower === "infos:" || lower.startsWith("fråga:") || lower.startsWith("svar:")) break;
    if (KNOWLEDGE_MESSAGE_LABELS.some((item) => lower.startsWith(`${item.toLowerCase()}:`))) break;
    collected.push(line.trim());
  }
  return collected.join("\n").trim();
};

const bookingMessageToHtml = (message: string) => {
  const trimmed = message.trim();
  if (!trimmed) return "";
  return trimmed
    .split(/\r?\n/)
    .map((line) => escapeHtml(line))
    .join("<br/>");
};

const stripRepeatedConfirmationIntro = (message: string) => {
  const lines = message
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line, idx, arr) => !(idx === 0 && !line) && !(idx === arr.length - 1 && !line));
  const patterns = [
    /^tack för (din|er) bokning/i,
    /^här är (din|dina) bokningsdetaljer/i,
    /^\(?\d{4}-\d{2}-\d{2}\s+kl\s+\d{2}:\d{2}\s*•\s*\d+\s+gäster\)?$/i,
  ];
  while (lines.length && patterns.some((pattern) => pattern.test(lines[0]))) {
    lines.shift();
  }
  return lines.join("\n").trim();
};

const extractFirstName = (fullName: string | null | undefined) => {
  const normalized = (fullName ?? "").trim();
  if (!normalized) return "";
  return normalized.split(/\s+/)[0] ?? "";
};

const capitalizeWord = (value: string) => value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();

const resolveGreetingAndMessageBody = (message: string, firstName: string) => {
  const defaultGreeting = firstName ? `Hej ${firstName}!` : "Hej!";
  const lines = message
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return { greeting: defaultGreeting, body: "" };

  const firstLine = lines[0];
  const greetingPrefixMatch = firstLine.match(/^(bonjour|hej|hello)\b/i);
  if (!greetingPrefixMatch) {
    return { greeting: defaultGreeting, body: lines.join("\n") };
  }

  const simpleGreetingMatch = firstLine.match(/^(bonjour|hej|hello)[!\.\s]*$/i);
  const greeting = simpleGreetingMatch
    ? `${capitalizeWord(simpleGreetingMatch[1])}${firstName ? ` ${firstName}` : ""}!`
    : firstLine;

  return { greeting, body: lines.slice(1).join("\n").trim() };
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const token = String(req.query.token || "");
  const action = String(req.query.action || "");
  if (!token || !["confirm", "decline"].includes(action)) {
    res.status(400).send("Ogiltig länk.");
    return;
  }

  const supabaseUrl = getEnv("SUPABASE_URL") || getEnv("VITE_SUPABASE_URL");
  const serviceKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  const resendKey = getEnv("RESEND_API_KEY");
  const resendFrom = getEnv("RESEND_FROM") || "Bokäta <no-reply@bokata.se>";

  if (!supabaseUrl || !serviceKey) {
    res.status(500).send("Serverfel.");
    return;
  }

  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const { data: booking } = await supabase
    .from("bookings")
    .select("id,restaurant_id,name,date,time,guests,client_email,confirm_token,status,confirm_expires_at")
    .eq("confirm_token", token)
    .maybeSingle();

  if (!booking) {
    res.status(404).send("Bokningen hittades inte.");
    return;
  }
  if (booking.confirm_expires_at) {
    const expiresAt = new Date(booking.confirm_expires_at).getTime();
    if (Number.isFinite(expiresAt) && Date.now() > expiresAt) {
      res.status(410).send("Länken har gått ut. Kontakta restaurangen för hjälp.");
      return;
    }
  }

  const nextStatus = action === "confirm" ? "confirmed" : "cancelled";
  const { data: updatedBooking, error: updateError } = await supabase
    .from("bookings")
    .update({ status: nextStatus, confirm_token: null })
    .eq("id", booking.id)
    .eq("confirm_token", token)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();
  if (updateError || !updatedBooking) {
    res.status(updateError ? 500 : 409).send("Bokningen kunde inte uppdateras. Länken kan ha ersatts av en ny bekräftelselänk.");
    return;
  }

  let bookingMessageRaw = "";
  if (booking.restaurant_id) {
    const { data: bookingSettings } = await supabase
      .from("booking_public_settings")
      .select("knowledge_public")
      .eq("public_id", booking.restaurant_id)
      .maybeSingle();
    bookingMessageRaw = extractMultilineLabelValue(
      (bookingSettings as { knowledge_public?: string | null } | null)?.knowledge_public,
      BOOKING_CONFIRMATION_EMAIL_MANUAL_LABEL
    );
  }

  const sendEmail = async (to: string, subject: string, html: string) => {
    if (!resendKey) return { ok: false, status: 0, text: "Missing RESEND_API_KEY" };
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${resendKey}`,
      },
      body: JSON.stringify({ from: resendFrom, to, subject, html }),
    });
    const text = await resp.text();
    if (!resp.ok) {
      console.error("Resend error", resp.status, text || resp.statusText, { to, from: resendFrom });
    }
    return { ok: resp.ok, status: resp.status, text };
  };

  if (booking.client_email && action === "confirm") {
    const manageUrl = buildBookingManageUrl(getSiteUrl(), getBookingLinkSecret(serviceKey), String(booking.id), booking.client_email);
    const firstName = extractFirstName(booking.name);
    const { greeting, body } = resolveGreetingAndMessageBody(bookingMessageRaw, firstName);
    const greetingHtml = escapeHtml(greeting);
    const bookingMessageHtml = bookingMessageToHtml(stripRepeatedConfirmationIntro(body));
    await sendEmail(
      booking.client_email,
      "Din bokning är bekräftad!",
      `
        <p>${greetingHtml}</p>
        <p>Tack för er bokning!</p>
        ${bookingMessageHtml ? `<p>${bookingMessageHtml}</p>` : "<p>Vi ser fram emot att välkomna er!</p>"}
        <p>(${booking.date} kl ${booking.time} • ${booking.guests} gäster)</p>
        <p>Du kan <a href="${manageUrl}">ändra din bokning här</a>.</p>
      `
    );
  }

  if (booking.client_email && action === "decline") {
    await sendEmail(
      booking.client_email,
      "Din bokning kunde inte bekräftas",
      `
        <h2>Bokning nekad</h2>
        <p>Hej ${booking.name}!</p>
        <p>Tyvärr kunde vi inte bekräfta din bokning.</p>
      `
    );
  }

  res.status(200).send(
    action === "confirm"
      ? "Bokningen är bekräftad. Kunden har informerats."
      : `Bokningen är avböjd.`
  );
}
