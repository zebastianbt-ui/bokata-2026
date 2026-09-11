import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { rateLimit } from "../lib/rateLimit";
import { resolveOwnerPrimaryRestaurant } from "../lib/ownerPrimary";
import {
  BOOKING_TIME_ZONE,
  getMadameBlaHoursOverride,
  isDropInOnlySlotForMadameBla,
  isMadameBlaClosedDate,
  isMadameBlaRestaurant,
  isManuallyFullBookedSlot,
  latestBookingTimeForDate,
} from "../lib/specialRestaurantRules";
import crypto from "crypto";

type BookingSettings = {
  seating?: {
    maxBookingDurationMin?: number;
    maxGuests?: number;
    maxTables?: number;
    maxGuestsPerReservation?: number;
  };
  notify_email?: string | null;
  notify_enabled?: boolean | null;
  require_manual_confirmation?: boolean | null;
  knowledge_public?: string | null;
};

const getEnv = (key: string) => process.env[key] ?? "";
const getSiteUrl = () => getEnv("SITE_URL") || "https://www.bokata.se";
const getBookingCancelSecret = (serviceKey: string) => getEnv("BOOKING_CANCEL_SECRET") || serviceKey;
const signBookingCancel = (secret: string, bookingId: string, email: string) =>
  crypto.createHmac("sha256", secret).update(`${bookingId}:${email.toLowerCase().trim()}`).digest("hex");
const buildBookingCancelUrl = (origin: string, secret: string, bookingId: string, email: string) => {
  const normalizedEmail = email.toLowerCase().trim();
  const sig = signBookingCancel(secret, bookingId, normalizedEmail);
  return `${origin}/api/bookings-cancel?bid=${encodeURIComponent(bookingId)}&email=${encodeURIComponent(normalizedEmail)}&sig=${encodeURIComponent(sig)}`;
};

const getToken = (req: VercelRequest) => {
  const authHeader = req.headers.authorization || "";
  return typeof authHeader === "string" && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
};

const firstQueryValue = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 20;
const EMAIL_SEND_TIMEOUT_MS = Math.max(1000, Number(getEnv("RESEND_TIMEOUT_MS") || 5000));
const BOOKING_MESSAGE_LABEL = "Bokningsmeddelande";
const BOOKING_CONFIRMATION_EMAIL_AUTO_LABEL = "Bekräftelsemail (automatisk)";
const BOOKING_CONFIRMATION_EMAIL_MANUAL_LABEL = "Bekräftelsemail (manuell)";
const KNOWLEDGE_MESSAGE_LABELS = [
  BOOKING_MESSAGE_LABEL,
  BOOKING_CONFIRMATION_EMAIL_AUTO_LABEL,
  BOOKING_CONFIRMATION_EMAIL_MANUAL_LABEL,
];

const getClientIp = (req: VercelRequest) => {
  const xfwd = req.headers["x-forwarded-for"];
  const ip = Array.isArray(xfwd) ? xfwd[0] : xfwd;
  return (ip || req.socket.remoteAddress || "unknown").split(",")[0].trim();
};

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");

const redactEmail = (value: string) => {
  const [local, domain] = value.split("@");
  if (!domain) return "***";
  return `${local.slice(0, 2) || "*"}***@${domain}`;
};

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


const pad2 = (n: number) => String(n).padStart(2, "0");
const timeToMin = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return NaN;
  return h * 60 + m;
};
const minToTime = (m: number) => `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
const overlap = (aS: number, aE: number, bS: number, bE: number) => aS < bE && bS < aE;
const toDayNameSv = (iso: string) => {
  const d = new Date(iso + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return null;
  const names = ["söndag", "måndag", "tisdag", "onsdag", "torsdag", "fredag", "lördag"];
  return names[d.getUTCDay()];
};
const isIsoInRange = (iso: string, from: string, to: string) => iso >= from && iso <= to;
const periodSpanDays = (from: string, to: string) => {
  const a = new Date(from + "T00:00:00Z");
  const b = new Date(to + "T00:00:00Z");
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor((b.getTime() - a.getTime()) / 86400000));
};
const pickPeriodForDate = (periods: any[], iso: string) => {
  const matches = periods.filter((p) => isIsoInRange(iso, p.from, p.to));
  if (!matches.length) return null;
  return matches.sort((a, b) => periodSpanDays(a.from, a.to) - periodSpanDays(b.from, b.to))[0];
};
const normalizeTime = (t: string) => (t?.length >= 5 ? t.slice(0, 5) : t);

const TABLE_IDS_META_PREFIX = "__BOKATA_TABLE_IDS__:";

const getNowInBookingTimeZone = () => {
  const formatter = new Intl.DateTimeFormat("sv-SE", {
    timeZone: BOOKING_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = formatter.formatToParts(new Date());
  const lookup = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  const year = lookup("year");
  const month = lookup("month");
  const day = lookup("day");
  const hour = lookup("hour");
  const minute = lookup("minute");
  return {
    date: `${year}-${month}-${day}`,
    time: `${hour}:${minute}`,
  };
};

const isPastBookingSlot = (dateIso: string, timeValue: string) => {
  const now = getNowInBookingTimeZone();
  if (dateIso < now.date) return true;
  if (dateIso > now.date) return false;
  return normalizeTime(timeValue) < now.time;
};

const normalizeTableIds = (values: Array<number | null | undefined>) => {
  const unique = new Set<number>();
  for (const value of values) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) continue;
    unique.add(parsed);
  }
  return Array.from(unique);
};

const parseBookingNotesMeta = (raw: string | null | undefined) => {
  const text = raw ?? "";
  if (!text.trim()) return { notes: "", tableIds: [] as number[] };

  let metaIds: number[] = [];
  const keptLines: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith(TABLE_IDS_META_PREFIX)) {
      const rawIds = trimmed.slice(TABLE_IDS_META_PREFIX.length);
      metaIds = normalizeTableIds(rawIds.split(",").map((part) => Number(part.trim())));
      continue;
    }
    keptLines.push(line);
  }

  return { notes: keptLines.join("\n").trim(), tableIds: metaIds };
};

const buildBookingNotesWithMeta = (notes: string | null | undefined, tableIds: number[]) => {
  const cleaned = (notes ?? "").trim();
  const normalizedIds = normalizeTableIds(tableIds);
  if (normalizedIds.length <= 1) return cleaned || null;
  const metaLine = `${TABLE_IDS_META_PREFIX}${normalizedIds.join(",")}`;
  return cleaned ? `${cleaned}\n${metaLine}` : metaLine;
};

const isMissingGuardedBookingRpc = (error: unknown) => {
  const err = error as { code?: string; message?: string; details?: string };
  const text = `${err?.message ?? ""} ${err?.details ?? ""}`;
  return err?.code === "42883" || /create_booking_guarded|function .* does not exist/i.test(text);
};

const isGuardedBookingTimeTypeMismatch = (error: unknown) => {
  const err = error as { code?: string; message?: string; details?: string; hint?: string };
  const text = `${err?.message ?? ""} ${err?.details ?? ""} ${err?.hint ?? ""}`;
  return (
    err?.code === "42804" &&
    /column\s+"?time"?\s+is\s+of\s+type\s+time\s+without\s+time\s+zone/i.test(text) &&
    /expression\s+is\s+of\s+type\s+text/i.test(text)
  );
};

const guardedBookingError = (error: unknown) => {
  const message = ((error as { message?: string })?.message ?? "").toUpperCase();
  if (message.includes("BOKATA_SAME_EMAIL_LIMIT")) {
    return { status: 400, message: "Max 2 bokningar per dag för samma e-postadress." };
  }
  if (message.includes("BOKATA_GUEST_CAPACITY_EXCEEDED")) {
    return { status: 400, message: "Tyvärr är det fullt vid den tiden." };
  }
  if (message.includes("BOKATA_TABLE_CAPACITY_EXCEEDED")) {
    return { status: 400, message: "Tyvärr finns det inga lediga bord vid den tiden." };
  }
  return null;
};

type FloorplanTable = {
  id: number;
  seats: number;
  x: number;
  y: number;
  w: number;
  h: number;
  neighbors: number[];
};

type AssignedTableBlock = {
  tableIds: number[];
  startMin: number;
  endMin: number;
};

const parseTableNumber = (label?: string | null) => {
  if (!label) return null;
  const match = label.match(/\d+/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const defaultSizeForSeats = (seats: number) => {
  if (seats <= 2) return { w: 80, h: 60 };
  if (seats <= 4) return { w: 90, h: 60 };
  if (seats <= 6) return { w: 110, h: 70 };
  if (seats <= 8) return { w: 130, h: 80 };
  return { w: 150, h: 90 };
};

const asFiniteNumber = (value: unknown, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const tableCenter = (table: Pick<FloorplanTable, "x" | "y" | "w" | "h">) => ({
  x: table.x + table.w / 2,
  y: table.y + table.h / 2,
});

const centerDistance = (a: Pick<FloorplanTable, "x" | "y" | "w" | "h">, b: Pick<FloorplanTable, "x" | "y" | "w" | "h">) => {
  const ac = tableCenter(a);
  const bc = tableCenter(b);
  return Math.hypot(ac.x - bc.x, ac.y - bc.y);
};

const areTablesAdjacent = (a: FloorplanTable, b: FloorplanTable) => {
  const horizontalGap = Math.min(Math.abs(a.x + a.w - b.x), Math.abs(b.x + b.w - a.x));
  const verticalGap = Math.min(Math.abs(a.y + a.h - b.y), Math.abs(b.y + b.h - a.y));
  const horizontalOverlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const verticalOverlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  const edgeGap = 42;
  const overlapTolerance = 14;
  const nearHorizontally = horizontalGap <= edgeGap && verticalOverlap >= -overlapTolerance;
  const nearVertically = verticalGap <= edgeGap && horizontalOverlap >= -overlapTolerance;
  const distanceLimit = Math.max(a.w, a.h, b.w, b.h) * 1.8;
  const nearCenter = centerDistance(a, b) <= distanceLimit;
  return nearHorizontally || nearVertically || nearCenter;
};

const buildPlanTables = (planTables: Array<{ seats?: number; x?: number; y?: number; w?: number; h?: number; label?: string }> | undefined) => {
  if (!Array.isArray(planTables) || !planTables.length) return [] as FloorplanTable[];

  const byId = new Map<number, FloorplanTable>();
  planTables.forEach((table, idx) => {
    const id = parseTableNumber(table.label) ?? idx + 1;
    if (byId.has(id)) return;
    const seats = Math.max(0, Number(table.seats) || 0);
    if (!seats) return;
    const defaults = defaultSizeForSeats(seats);
    byId.set(id, {
      id,
      seats,
      x: asFiniteNumber(table.x, idx * (defaults.w + 20)),
      y: asFiniteNumber(table.y, 0),
      w: Math.max(40, asFiniteNumber(table.w, defaults.w)),
      h: Math.max(40, asFiniteNumber(table.h, defaults.h)),
      neighbors: [],
    });
  });

  const tables = Array.from(byId.values()).sort((a, b) => a.id - b.id);
  if (tables.length <= 1) return tables;

  const links = new Map<number, Set<number>>();
  tables.forEach((table) => links.set(table.id, new Set<number>()));

  for (let i = 0; i < tables.length; i += 1) {
    for (let j = i + 1; j < tables.length; j += 1) {
      const a = tables[i];
      const b = tables[j];
      if (!areTablesAdjacent(a, b)) continue;
      links.get(a.id)?.add(b.id);
      links.get(b.id)?.add(a.id);
    }
  }

  tables.forEach((table) => {
    const neighbors = links.get(table.id);
    if (!neighbors || neighbors.size || tables.length <= 1) return;
    let nearest: FloorplanTable | null = null;
    let nearestDist = Number.POSITIVE_INFINITY;
    for (const other of tables) {
      if (other.id === table.id) continue;
      const d = centerDistance(table, other);
      if (d < nearestDist) {
        nearest = other;
        nearestDist = d;
      }
    }
    if (nearest) {
      neighbors.add(nearest.id);
      links.get(nearest.id)?.add(table.id);
    }
  });

  return tables.map((table) => ({
    ...table,
    neighbors: Array.from(links.get(table.id) ?? []).sort((a, b) => a - b),
  }));
};

const chooseBestTableGroup = (args: {
  tables: FloorplanTable[];
  guests: number;
  preferredTableId?: number | null;
  startMin: number;
  endMin: number;
  assigned: AssignedTableBlock[];
}) => {
  if (!args.tables.length) return null;

  const conflictingTableIds = new Set<number>();
  for (const block of args.assigned) {
    if (!overlap(args.startMin, args.endMin, block.startMin, block.endMin)) continue;
    block.tableIds.forEach((id) => conflictingTableIds.add(id));
  }

  const available = args.tables.filter((table) => !conflictingTableIds.has(table.id));
  if (!available.length) return null;

  const availableById = new Map<number, FloorplanTable>();
  available.forEach((table) => availableById.set(table.id, table));

  const sortedCaps = available.map((table) => table.seats).sort((a, b) => b - a);
  let maxCapacity = 0;
  let minNeeded = 0;
  for (const cap of sortedCaps) {
    maxCapacity += cap;
    minNeeded += 1;
    if (maxCapacity >= args.guests) break;
  }
  if (maxCapacity < args.guests) return null;

  const maxGroupSize = Math.min(8, available.length, Math.max(minNeeded + 1, 2));

  const tableSpread = (ids: number[]) => {
    const points = ids.map((id) => availableById.get(id)).filter(Boolean) as FloorplanTable[];
    if (points.length <= 1) return 0;
    const minX = Math.min(...points.map((table) => table.x));
    const maxX = Math.max(...points.map((table) => table.x + table.w));
    const minY = Math.min(...points.map((table) => table.y));
    const maxY = Math.max(...points.map((table) => table.y + table.h));
    return (maxX - minX) + (maxY - minY);
  };

  const candidateScore = (ids: number[]) => {
    const seats = ids.reduce((sum, id) => sum + (availableById.get(id)?.seats ?? 0), 0);
    const overflow = seats - args.guests;
    const missesPreferred =
      args.preferredTableId == null ? 0 : ids.includes(args.preferredTableId) ? 0 : 1;
    return {
      missesPreferred,
      overflow,
      size: ids.length,
      spread: tableSpread(ids),
    };
  };

  const isBetter = (a: number[], b: number[] | null) => {
    if (!b) return true;
    const sa = candidateScore(a);
    const sb = candidateScore(b);
    if (sa.missesPreferred !== sb.missesPreferred) return sa.missesPreferred < sb.missesPreferred;
    if (sa.overflow !== sb.overflow) return sa.overflow < sb.overflow;
    if (sa.size !== sb.size) return sa.size < sb.size;
    if (sa.spread !== sb.spread) return sa.spread < sb.spread;
    return a.join(",") < b.join(",");
  };

  let bestGroup: number[] | null = null;
  const seen = new Set<string>();
  const explored = new Set<string>();

  const evaluateCandidate = (ids: number[], seats: number) => {
    if (seats < args.guests) return;
    const sorted = [...ids].sort((a, b) => a - b);
    const key = sorted.join(",");
    if (seen.has(key)) return;
    seen.add(key);
    if (isBetter(sorted, bestGroup)) bestGroup = sorted;
  };

  const sortedStarts = [...available].sort((a, b) => {
    const aPref = args.preferredTableId != null && a.id === args.preferredTableId ? 0 : 1;
    const bPref = args.preferredTableId != null && b.id === args.preferredTableId ? 0 : 1;
    if (aPref !== bPref) return aPref - bPref;
    if (a.seats !== b.seats) return b.seats - a.seats;
    return a.id - b.id;
  });

  const dfs = (group: number[], seats: number, frontier: Set<number>) => {
    const groupKey = [...group].sort((a, b) => a - b).join(",");
    if (explored.has(groupKey)) return;
    explored.add(groupKey);

    evaluateCandidate(group, seats);
    if (group.length >= maxGroupSize) return;

    const nextCandidates = Array.from(frontier)
      .map((id) => availableById.get(id))
      .filter((table): table is FloorplanTable => !!table)
      .sort((a, b) => {
        const aPref = args.preferredTableId != null && a.id === args.preferredTableId ? 0 : 1;
        const bPref = args.preferredTableId != null && b.id === args.preferredTableId ? 0 : 1;
        if (aPref !== bPref) return aPref - bPref;
        if (a.seats !== b.seats) return b.seats - a.seats;
        return a.id - b.id;
      });

    for (const next of nextCandidates) {
      if (group.includes(next.id)) continue;
      const nextGroup = [...group, next.id];
      const nextFrontier = new Set<number>(frontier);
      nextFrontier.delete(next.id);
      for (const neighborId of next.neighbors) {
        if (!availableById.has(neighborId) || nextGroup.includes(neighborId)) continue;
        nextFrontier.add(neighborId);
      }
      dfs(nextGroup, seats + next.seats, nextFrontier);
    }
  };

  for (const start of sortedStarts) {
    const frontier = new Set<number>(start.neighbors.filter((id) => availableById.has(id)));
    dfs([start.id], start.seats, frontier);
  }

  return bestGroup;
};

const chooseFallbackTableGroup = (args: {
  tables: FloorplanTable[];
  guests: number;
  preferredTableId?: number | null;
  startMin: number;
  endMin: number;
  assigned: AssignedTableBlock[];
}) => {
  if (!args.tables.length || args.guests < 1) return null;

  const conflictingTableIds = new Set<number>();
  for (const block of args.assigned) {
    if (!overlap(args.startMin, args.endMin, block.startMin, block.endMin)) continue;
    block.tableIds.forEach((id) => conflictingTableIds.add(id));
  }

  const available = args.tables.filter((table) => !conflictingTableIds.has(table.id));
  if (!available.length) return null;

  if (args.preferredTableId != null) {
    const preferred = available.find((table) => table.id === args.preferredTableId);
    if (preferred && preferred.seats >= args.guests) return [preferred.id];
  }

  const single = [...available]
    .filter((table) => table.seats >= args.guests)
    .sort((a, b) => a.seats - b.seats || a.id - b.id)[0];
  if (single) return [single.id];

  const ranked = [...available].sort((a, b) => {
    const aPref = args.preferredTableId != null && a.id === args.preferredTableId ? 0 : 1;
    const bPref = args.preferredTableId != null && b.id === args.preferredTableId ? 0 : 1;
    if (aPref !== bPref) return aPref - bPref;
    if (a.seats !== b.seats) return b.seats - a.seats;
    return a.id - b.id;
  });

  const picked: number[] = [];
  let seats = 0;
  for (const table of ranked) {
    picked.push(table.id);
    seats += table.seats;
    if (seats >= args.guests) return picked.sort((a, b) => a - b);
  }

  return null;
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "GET") {
    const supabaseUrl = getEnv("SUPABASE_URL") || getEnv("VITE_SUPABASE_URL");
    const anonKey = getEnv("SUPABASE_ANON_KEY") || getEnv("VITE_SUPABASE_ANON_KEY");
    const serviceKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !anonKey || !serviceKey) {
      res.status(500).json({ error: "Missing Supabase env vars" });
      return;
    }

    const token = getToken(req);
    if (!token) {
      res.status(401).json({ error: "Missing auth token" });
      return;
    }

    const requestedRestaurantId = firstQueryValue(req.query.restaurantId || req.query.restaurant_id);
    if (!requestedRestaurantId) {
      res.status(400).json({ error: "Missing restaurantId" });
      return;
    }

    const authClient = createClient(supabaseUrl, anonKey, { auth: { persistSession: false } });
    const { data: userData, error: userError } = await authClient.auth.getUser(token);
    if (userError || !userData?.user) {
      res.status(401).json({ error: "Invalid auth token" });
      return;
    }

    const serviceClient = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
    const userId = userData.user.id;
    const ownerPrimary = await resolveOwnerPrimaryRestaurant(serviceClient, userId);
    if (ownerPrimary.error) {
      res.status(500).json({ error: ownerPrimary.error });
      return;
    }

    let canAccess = ownerPrimary.restaurantId === requestedRestaurantId;
    if (!canAccess) {
      const { data: membership, error: membershipError } = await serviceClient
        .from("memberships")
        .select("restaurant_id")
        .eq("user_id", userId)
        .eq("restaurant_id", requestedRestaurantId)
        .maybeSingle();
      if (membershipError) {
        res.status(500).json({ error: membershipError.message });
        return;
      }
      canAccess = !!membership;
    }

    if (!canAccess) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const { data, error } = await serviceClient
      .from("bookings")
      .select("id,restaurant_id,date,time,name,guests,notes,table_id,duration_min,status,source,client_email,created_at")
      .eq("restaurant_id", requestedRestaurantId)
      .order("date", { ascending: true })
      .order("time", { ascending: true })
      .order("created_at", { ascending: true });

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    res.status(200).json({ bookings: data ?? [] });
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method Not Allowed" });
    return;
  }

  const ip = getClientIp(req);
  const limiter = await rateLimit(`bookings:${ip}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  if (!limiter.ok) {
    res.status(429).json({ error: "För många försök. Försök igen om en minut." });
    return;
  }

  const supabaseUrl = getEnv("SUPABASE_URL") || getEnv("VITE_SUPABASE_URL");
  const serviceKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  const resendKey = getEnv("RESEND_API_KEY");
  const resendFrom = getEnv("RESEND_FROM") || "Bokäta <no-reply@bokata.se>";

  if (!supabaseUrl || !serviceKey) {
    res.status(500).json({ error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" });
    return;
  }

  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const {
    restaurantId,
    date,
    time,
    guests,
    name,
    email,
    phone,
    notes,
  } = (req.body ?? {}) as {
    restaurantId?: string;
    date?: string;
    time?: string;
    guests?: number;
    name?: string;
    email?: string;
    phone?: string | null;
    notes?: string | null;
  };

  if (!restaurantId || !date || !time || !guests || !name || !email) {
    res.status(400).json({ error: "Missing booking fields" });
    return;
  }

  if (isPastBookingSlot(date, time)) {
    res.status(400).json({ error: "Det går inte att boka en passerad tid." });
    return;
  }

  if (isManuallyFullBookedSlot(date, time)) {
    res.status(400).json({ error: "Tyvärr är den tiden fullbokad." });
    return;
  }

  const normalizedEmail = email.trim().toLowerCase();

  const { data: settings } = await supabase
    .from("booking_public_settings")
    .select("seating,hours,notify_email,notify_enabled,require_manual_confirmation,knowledge_public")
    .eq("public_id", restaurantId)
    .maybeSingle();

  const s = (settings ?? {}) as BookingSettings & { hours?: any };
  const requireManual = !!s.require_manual_confirmation;
  const notifyEnabled = !!s.notify_enabled;
  const notifyEmail = s.notify_email || null;
  const madameBlaOverride = isMadameBlaRestaurant(restaurantId, s.knowledge_public)
    ? getMadameBlaHoursOverride(date, toDayNameSv(date))
    : undefined;
  if (madameBlaOverride?.closed || isMadameBlaClosedDate(restaurantId, date, s.knowledge_public)) {
    res.status(400).json({ error: "Restaurangen är stängd den dagen." });
    return;
  }
  if (isDropInOnlySlotForMadameBla(date, time, restaurantId, s.knowledge_public)) {
    res.status(400).json({ error: "Den tiden är endast drop-in." });
    return;
  }
  const bookingMessageRaw = extractMultilineLabelValue(
    s.knowledge_public,
    BOOKING_CONFIRMATION_EMAIL_AUTO_LABEL
  );
  const rawDuration = s.seating?.maxBookingDurationMin ?? 90;
  const durationMin = rawDuration && rawDuration > 0 ? rawDuration : 90;
  const maxGuests = s.seating?.maxGuests ?? 60;
  const maxTables = s.seating?.maxTables ?? 20;
  const maxGuestsPerReservation = s.seating?.maxGuestsPerReservation ?? 22;

  if (maxGuestsPerReservation > 0 && guests >= maxGuestsPerReservation) {
    const contactEmail = notifyEmail ? ` Kontakta oss på ${notifyEmail}.` : "";
    res
      .status(400)
      .json({ error: `För ${maxGuestsPerReservation} gäster eller fler behöver ni kontakta oss direkt.${contactEmail}` });
    return;
  }

  const { count: sameEmailCount } = await supabase
    .from("bookings")
    .select("id", { count: "exact", head: true })
    .eq("restaurant_id", restaurantId)
    .eq("date", date)
    .eq("client_email", normalizedEmail)
    .neq("status", "cancelled");
  if ((sameEmailCount ?? 0) >= 2) {
    res.status(400).json({ error: "Max 2 bokningar per dag för samma e‑postadress." });
    return;
  }

  const hours = s.hours ?? null;
  if (hours || madameBlaOverride) {
    const special = Array.isArray(hours.special) ? hours.special : [];
    const periods = Array.isArray(hours.periods) ? hours.periods : [];
    const normal = hours.normal ?? null;
    const dayName = toDayNameSv(date);
    if (!dayName) {
      res.status(400).json({ error: "Ogiltigt datum." });
      return;
    }
    const specialDay = special.find((d: any) => d.date === date);
    if (specialDay?.closed) {
      res.status(400).json({ error: "Restaurangen är stängd den dagen." });
      return;
    }
    let dayHours: { open: string; close: string } | null = null;
    if (madameBlaOverride && !madameBlaOverride.closed) {
      dayHours = { open: madameBlaOverride.open, close: madameBlaOverride.close };
    } else if (specialDay && !specialDay.closed) {
      dayHours = { open: specialDay.open, close: specialDay.close };
    } else {
      const period = periods.length ? pickPeriodForDate(periods, date) : null;
      const d = (period?.days ?? normal)?.[dayName];
      if (!d || d.closed) {
        res.status(400).json({ error: "Restaurangen är stängd den dagen." });
        return;
      }
      dayHours = { open: d.open, close: d.close };
    }
    const t = timeToMin(time);
    const openMin = timeToMin(dayHours.open);
    const closeMin = timeToMin(dayHours.close);
    const lastBookingBufferMin = 60;
    const defaultLatestStart = Math.max(openMin, closeMin - lastBookingBufferMin);
    const latestBookingTime = latestBookingTimeForDate(date);
    const bookingRuleLatestStart = latestBookingTime ? timeToMin(latestBookingTime) : null;
    const latestStart = bookingRuleLatestStart !== null
      ? Math.min(defaultLatestStart, bookingRuleLatestStart)
      : defaultLatestStart;
    if (!Number.isFinite(t) || t < openMin || t > latestStart) {
      res.status(400).json({
        error: `Ogiltig tid. Vi har öppet ${dayHours.open}–${dayHours.close}. Sista bokningsbara tiden är ${minToTime(latestStart)}.`,
      });
      return;
    }
  }

  const { data: sameDayBookings } = await supabase
    .from("bookings")
    .select("time,guests,duration_min,status,table_id,notes")
    .eq("restaurant_id", restaurantId)
    .eq("date", date)
    .neq("status", "cancelled");

  const startMin = timeToMin(normalizeTime(time));
  const endMin = startMin + durationMin;
  const overlapGuests =
    (sameDayBookings ?? []).reduce((sum, b: any) => {
      const bs = timeToMin(normalizeTime(b.time));
      const bd = b.duration_min ?? durationMin;
      const be = bs + bd;
      if (!Number.isFinite(bs)) return sum;
      if (!overlap(startMin, endMin, bs, be)) return sum;
      return sum + (b.guests ?? 0);
    }, 0) + guests;

  if (overlapGuests > maxGuests) {
    res.status(400).json({ error: "Tyvärr är det fullt vid den tiden." });
    return;
  }

  let assignedTableId: number | null = null;
  let assignedTableIds: number[] = [];
  const { data: floorplanRow } = await supabase
    .from("floorplans")
    .select("layout")
    .eq("restaurant_id", restaurantId)
    .maybeSingle();

  const planTables = (floorplanRow as any)?.layout?.tables as
    | Array<{ seats?: number; x?: number; y?: number; w?: number; h?: number; label?: string }>
    | undefined;
  const tables = buildPlanTables(planTables);
  const floorplanTotalSeats = tables.reduce((sum, table) => sum + table.seats, 0);
  const peakExistingGuests = (sameDayBookings ?? []).reduce((max, booking: any) => {
    const guestsCount = Number(booking?.guests) || 0;
    return guestsCount > max ? guestsCount : max;
  }, 0);
  const floorplanCapacityMismatch = tables.length > 0 && floorplanTotalSeats > 0 && peakExistingGuests > floorplanTotalSeats;

  if (floorplanCapacityMismatch) {
    console.warn("Floorplan capacity mismatch detected; falling back to maxTables mode for this request", {
      restaurantId,
      date,
      floorplanTotalSeats,
      peakExistingGuests,
    });
  }

  if (tables.length && !floorplanCapacityMismatch) {
    const existing = (sameDayBookings ?? []).map((b: any) => {
      const parsedMeta = parseBookingNotesMeta(b.notes ?? "");
      const tableIds = normalizeTableIds([...(parsedMeta.tableIds ?? []), b.table_id]);
      return {
        time: normalizeTime(b.time),
        guests: Number(b.guests) || 0,
        durationMin: b.duration_min ?? durationMin,
        tableId: b.table_id ?? null,
        tableIds,
        hasMetaTableIds: parsedMeta.tableIds.length > 0,
      };
    });

    const tableMap = new Map<number, FloorplanTable>();
    tables.forEach((table) => tableMap.set(table.id, table));

    const assigned: AssignedTableBlock[] = [];
    const needsAssign: Array<{
      time: string;
      guests: number;
      durationMin: number;
      tableId: number | null;
      tableIds: number[];
      hasMetaTableIds: boolean;
    }> = [];

    for (const booking of existing) {
      const bs = timeToMin(booking.time);
      if (!Number.isFinite(bs)) {
        console.warn("Skipping booking with invalid time during table assignment", {
          restaurantId,
          date,
          time: booking.time,
        });
        continue;
      }
      const be = bs + booking.durationMin;
      const fixedGroup = booking.tableIds.filter((id: number) => tableMap.has(id));
      const fixedSeats = fixedGroup.reduce((sum: number, id: number) => sum + (tableMap.get(id)?.seats ?? 0), 0);
      const fixedOccupied = assigned.some(
        (block) => overlap(bs, be, block.startMin, block.endMin) && block.tableIds.some((id) => fixedGroup.includes(id))
      );
      const legacySingleTableFallback =
        booking.tableId != null &&
        !booking.hasMetaTableIds &&
        fixedGroup.length === 1 &&
        fixedSeats > 0 &&
        fixedSeats < booking.guests;
      const canStayFixed = fixedGroup.length > 0 && !fixedOccupied && (fixedSeats >= booking.guests || legacySingleTableFallback);
      if (canStayFixed) {
        assigned.push({ tableIds: fixedGroup, startMin: bs, endMin: be });
        continue;
      }
      needsAssign.push(booking);
    }

    needsAssign.sort((a, b) => b.guests - a.guests || timeToMin(a.time) - timeToMin(b.time));

    for (const booking of needsAssign) {
      const bs = timeToMin(booking.time);
      if (!Number.isFinite(bs)) {
        res.status(400).json({ error: "Tyvärr finns det inga lediga bord vid den tiden." });
        return;
      }
      const be = bs + booking.durationMin;
      const group =
        chooseBestTableGroup({
          tables,
          guests: booking.guests,
          preferredTableId: booking.tableIds[0] ?? booking.tableId,
          startMin: bs,
          endMin: be,
          assigned,
        }) ??
        chooseFallbackTableGroup({
          tables,
          guests: booking.guests,
          preferredTableId: booking.tableIds[0] ?? booking.tableId,
          startMin: bs,
          endMin: be,
          assigned,
        });
      if (!group?.length) {
        const fallbackAll = tables.map((table) => table.id);
        if (fallbackAll.length) {
          console.warn("Could not assign existing booking with floorplan, locking all tables for interval", {
            restaurantId,
            date,
            time: booking.time,
            guests: booking.guests,
          });
          assigned.push({ tableIds: fallbackAll, startMin: bs, endMin: be });
          continue;
        }
        res.status(400).json({ error: "Tyvärr finns det inga lediga bord vid den tiden." });
        return;
      }
      assigned.push({ tableIds: group, startMin: bs, endMin: be });
    }

    const requestedGroup =
      chooseBestTableGroup({
        tables,
        guests,
        startMin,
        endMin,
        assigned,
      }) ??
      chooseFallbackTableGroup({
        tables,
        guests,
        startMin,
        endMin,
        assigned,
      });
    if (!requestedGroup?.length) {
      res.status(400).json({ error: "Tyvärr finns det inga lediga bord vid den tiden." });
      return;
    }
    assignedTableIds = requestedGroup;
    assignedTableId = requestedGroup[0] ?? null;
  } else {
    const overlapTables =
      (sameDayBookings ?? []).reduce((sum, b: any) => {
        const bs = timeToMin(normalizeTime(b.time));
        const bd = b.duration_min ?? durationMin;
        const be = bs + bd;
        if (!Number.isFinite(bs)) return sum;
        if (!overlap(startMin, endMin, bs, be)) return sum;
        return sum + 1;
      }, 0) + 1;

    if (overlapTables > maxTables) {
      res.status(400).json({ error: "Tyvärr finns det inga lediga bord vid den tiden." });
      return;
    }
  }

  const confirmToken = requireManual ? crypto.randomUUID() : null;
  const confirmTtlHours = Number(getEnv("BOOKING_CONFIRM_TTL_HOURS") || 48);
  const confirmExpiresAt =
    requireManual && confirmTtlHours > 0 ? new Date(Date.now() + confirmTtlHours * 3600_000).toISOString() : null;
  const status = requireManual ? "pending" : "confirmed";
  const persistedNotes = buildBookingNotesWithMeta(notes || null, assignedTableIds);

  type InsertedBooking = { id: string };
  type BookingInsertResult = {
    data: InsertedBooking | null;
    error: { message: string; status?: number } | null;
  };

  const insertBookingDirect = async (): Promise<BookingInsertResult> => {
    const { data, error } = await supabase
      .from("bookings")
      .insert({
        restaurant_id: restaurantId,
        date,
        time: normalizeTime(time),
        guests,
        name,
        notes: persistedNotes,
        status,
        source: "web",
        duration_min: durationMin,
        table_id: assignedTableId,
        client_email: normalizedEmail,
        client_phone: phone || null,
        confirm_token: confirmToken,
        confirm_expires_at: confirmExpiresAt,
      })
      .select("id")
      .single();

    return { data: data ? { id: String((data as { id: unknown }).id) } : null, error };
  };

  const insertBookingGuarded = async (): Promise<BookingInsertResult> => {
    if (getEnv("BOOKING_GUARDED_RPC") === "off") return insertBookingDirect();

    const { data, error } = await supabase.rpc("create_booking_guarded", {
      p_restaurant_id: restaurantId,
      p_date: date,
      p_time: normalizeTime(time),
      p_guests: guests,
      p_duration_min: durationMin,
      p_max_guests: maxGuests,
      p_max_tables: maxTables,
      p_same_email_limit: 2,
      p_name: name,
      p_notes: persistedNotes,
      p_status: status,
      p_source: "web",
      p_table_id: assignedTableId,
      p_client_email: normalizedEmail,
      p_client_phone: phone || null,
      p_confirm_token: confirmToken,
      p_confirm_expires_at: confirmExpiresAt,
    });

    if (!error) {
      const row = Array.isArray(data) ? data[0] : data;
      return { data: row?.id ? { id: String(row.id) } : null, error: null };
    }

    if (isMissingGuardedBookingRpc(error)) {
      console.warn("create_booking_guarded RPC missing; falling back to direct booking insert");
      return insertBookingDirect();
    }

    if (isGuardedBookingTimeTypeMismatch(error)) {
      console.warn("create_booking_guarded RPC time type mismatch; falling back to direct booking insert");
      return insertBookingDirect();
    }

    const mapped = guardedBookingError(error);
    if (mapped) return { data: null, error: mapped };
    return { data: null, error };
  };

  const { data: inserted, error } = await insertBookingGuarded();

  if (error) {
    res.status(error.status ?? 500).json({ error: error.message });
    return;
  }
  if (!inserted?.id) {
    res.status(500).json({ error: "Booking insert did not return an id" });
    return;
  }

  const origin = getSiteUrl();
  const summary = `${date} kl ${time} • ${guests} gäster`;
  const bookingId = String(inserted.id);
  const cancelUrl =
    bookingId && normalizedEmail
      ? buildBookingCancelUrl(origin, getBookingCancelSecret(serviceKey), bookingId, normalizedEmail)
      : null;

  type EmailDeliveryResult = { ok: boolean; status: number; text: string };
  type EmailDelivery = EmailDeliveryResult & { purpose: "restaurant-notification" | "guest-confirmation" };

  const sendEmail = async (to: string, subject: string, html: string): Promise<EmailDeliveryResult> => {
    if (!resendKey) return { ok: false, status: 0, text: "Missing RESEND_API_KEY" };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), EMAIL_SEND_TIMEOUT_MS);
    try {
      const resp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${resendKey}`,
        },
        body: JSON.stringify({ from: resendFrom, to, subject, html }),
        signal: controller.signal,
      });
      const text = await resp.text();
      if (!resp.ok) {
        console.error("Resend error", resp.status, text || resp.statusText, { to: redactEmail(to), from: resendFrom });
      }
      return { ok: resp.ok, status: resp.status, text };
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      console.error("Resend request failed", text, { to: redactEmail(to), from: resendFrom });
      return { ok: false, status: 0, text };
    } finally {
      clearTimeout(timeout);
    }
  };

  const emailJobs: Promise<EmailDelivery>[] = [];

  if (notifyEnabled && notifyEmail) {
    const actions = requireManual
      ? `
        <p><a href="${origin}/api/bookings-confirm?token=${confirmToken}&action=confirm">✅ Bekräfta</a></p>
        <p><a href="${origin}/api/bookings-confirm?token=${confirmToken}&action=decline">❌ Avböj</a></p>
      `
      : "";
    const safeName = escapeHtml(name);
    const safeClientEmail = escapeHtml(normalizedEmail);
    const safePhone = phone ? escapeHtml(phone) : "";
    const safeNotes = notes ? escapeHtml(notes) : "";
    emailJobs.push(
      sendEmail(
        notifyEmail,
        requireManual ? "Ny bokning (väntar på bekräftelse)" : "Ny bokning",
        `
        <h2>Ny bokning</h2>
        <p><strong>${safeName}</strong></p>
        <p>${summary}</p>
        <p>Email: ${safeClientEmail}${safePhone ? `<br/>Telefon: ${safePhone}` : ""}</p>
        ${safeNotes ? `<p>Önskemål: ${safeNotes}</p>` : ""}
        ${actions}
      `
      ).then((result) => ({ purpose: "restaurant-notification", ...result }))
    );
  }

  if (!requireManual && resendKey) {
    const firstName = extractFirstName(name);
    const { greeting, body } = resolveGreetingAndMessageBody(bookingMessageRaw, firstName);
    const greetingHtml = escapeHtml(greeting);
    const bookingMessageHtml = bookingMessageToHtml(stripRepeatedConfirmationIntro(body));
    emailJobs.push(
      sendEmail(
        normalizedEmail,
        "Din bokning är bekräftad!",
        `
        <p>${greetingHtml}</p>
        <p>Tack för er bokning!</p>
        ${bookingMessageHtml ? `<p>${bookingMessageHtml}</p>` : "<p>Vi ser fram emot att välkomna er!</p>"}
        <p>(${summary})</p>
        ${cancelUrl ? `<p>Kan du inte komma? <a href="${cancelUrl}">Avboka din reservation här</a>.</p>` : ""}
      `
      ).then((result) => ({ purpose: "guest-confirmation", ...result }))
    );
  }

  const emailSettled = await Promise.allSettled(emailJobs);
  const emailDelivery = emailSettled.map((item) => {
    if (item.status === "fulfilled") {
      return { purpose: item.value.purpose, ok: item.value.ok, status: item.value.status };
    }
    const text = item.reason instanceof Error ? item.reason.message : String(item.reason);
    console.error("Email job failed unexpectedly", text);
    return { purpose: "unknown", ok: false, status: 0 };
  });
  const failedEmailCount = emailDelivery.filter((item) => !item.ok).length;
  if (failedEmailCount) {
    console.warn("Booking created with failed email deliveries", { bookingId, failedEmailCount });
  }

  res.status(200).json({ status, id: inserted?.id, emailDelivery });
}
