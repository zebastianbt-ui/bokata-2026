import CalendarConnections from "../components/CalendarConnections";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "../supabaseClient";
import bokataFork from "../assets/bokata-fork.png";
import forkTransparent from "../assets/fork-transparent.png";

// NOTE: Tu as collé un bloc très long avec plein de caractères cassés (×, retours, underscores, etc.).
// Cette version est une *reconstruction fidèle* du dashboard que tu décris (calendrier + timeline + modals + settings + preview IA),
// mais en code propre et exécutable pour que tu puisses le *voir en preview*.

const installDashboardErrorOverlay = () => {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if ((window as any).__bokataDashboardErrorOverlayInstalled) return;
  (window as any).__bokataDashboardErrorOverlayInstalled = true;

  const show = (message: string, stack?: string) => {
    let el = document.getElementById("bokata-dashboard-error");
    if (!el) {
      el = document.createElement("div");
      el.id = "bokata-dashboard-error";
      el.style.position = "fixed";
      el.style.inset = "16px";
      el.style.zIndex = "99999";
      el.style.background = "#fff5f5";
      el.style.border = "1px solid #fecaca";
      el.style.borderRadius = "16px";
      el.style.padding = "16px";
      el.style.fontFamily = "system-ui, -apple-system, Segoe UI, sans-serif";
      el.style.color = "#9f1239";
      el.style.overflow = "auto";
      document.body.appendChild(el);
    }
    el.innerHTML = `
      <div style="font-weight:700;font-size:18px;margin-bottom:8px;">Dashboard crash</div>
      <div style="font-size:13px;white-space:pre-wrap;">${message || "Unknown error"}</div>
      ${stack ? `<div style="margin-top:12px;font-size:11px;white-space:pre-wrap;color:#6b7280;">${stack}</div>` : ""}
      <div style="margin-top:12px;font-size:12px;color:#6b7280;">Refresh the page after sending this message.</div>
    `;
  };

  window.addEventListener("error", (event) => {
    const err = (event as ErrorEvent).error as Error | undefined;
    const message = err?.message || (event as ErrorEvent).message || "Unknown error";
    const stack = err?.stack;
    (window as any).__bokata_dashboard_error = { message, stack, time: new Date().toISOString() };
    show(message, stack);
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = (event as PromiseRejectionEvent).reason as Error | string | undefined;
    const message = typeof reason === "string" ? reason : reason?.message || "Unhandled rejection";
    const stack = typeof reason === "string" ? undefined : reason?.stack;
    (window as any).__bokata_dashboard_error = { message, stack, time: new Date().toISOString() };
    show(message, stack);
  });
};

installDashboardErrorOverlay();

type Meal = "Alla" | "Frukost" | "Lunch" | "Fika" | "Middag";
type MealKey = "Frukost" | "Lunch" | "Fika" | "Middag";
type MealRangeMap = Record<MealKey, [string, string]>;

const MEAL_KEYS: MealKey[] = ["Frukost", "Lunch", "Fika", "Middag"];
const MEAL_FILTERS: Meal[] = ["Alla", ...MEAL_KEYS];

const MEAL_THEME_CLASSES: Record<Meal, { active: string; inactive: string; swatch: string; booking: string }> = {
  Alla: {
    active: "bg-gray-900 border-gray-900 text-white font-bold",
    inactive: "bg-white border-gray-300 text-gray-700 hover:bg-gray-50",
    swatch: "bg-gray-700",
    booking: "bg-gray-100 border-gray-300 text-gray-700",
  },
  Frukost: {
    active: "bg-orange-100 border-orange-500 text-orange-800 font-bold",
    inactive: "bg-white border-orange-300 text-orange-700 hover:bg-orange-50",
    swatch: "bg-orange-500",
    booking: "bg-orange-100 border-orange-300 text-orange-900",
  },
  Lunch: {
    active: "bg-[#e6007a]/10 border-[#e6007a] text-[#b80062] font-bold",
    inactive: "bg-white border-[#e6007a]/40 text-[#e6007a] hover:bg-[#e6007a]/5",
    swatch: "bg-[#e6007a]",
    booking: "bg-[#e6007a]/10 border-[#e6007a]/35 text-[#8f004c]",
  },
  Fika: {
    active: "bg-[#4b0c73]/10 border-[#4b0c73] text-[#4b0c73] font-bold",
    inactive: "bg-white border-[#4b0c73]/40 text-[#4b0c73] hover:bg-[#4b0c73]/5",
    swatch: "bg-[#4b0c73]",
    booking: "bg-[#4b0c73]/10 border-[#4b0c73]/35 text-[#4b0c73]",
  },
  Middag: {
    active: "bg-blue-100 border-blue-500 text-blue-800 font-bold",
    inactive: "bg-white border-blue-300 text-blue-700 hover:bg-blue-50",
    swatch: "bg-blue-500",
    booking: "bg-blue-100 border-blue-300 text-blue-900",
  },
};

type BookingStatus = "pending" | "confirmed" | "cancelled";

type Booking = {
  id: string;
  date: string; // YYYY-MM-DD
  time: string; // HH:MM
  name: string;
  guests: number;
  durationMin?: number;
  tableId?: number | null;
  tableIds?: number[] | null;
  status?: BookingStatus;
  source?: "web" | "phone" | "walkin";
  clientEmail?: string | null;
  note?: boolean;
  notes?: string;
  createdAt?: string;
};

const isCancelledBooking = (booking: Pick<Booking, "status">) => booking.status === "cancelled";

const TABLE_IDS_META_PREFIX = "__BOKATA_TABLE_IDS__:";

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

const buildBookingNotesWithMeta = (notes: string | undefined, tableIds: number[]) => {
  const cleaned = (notes ?? "").trim();
  const normalizedIds = normalizeTableIds(tableIds);
  if (normalizedIds.length <= 1) return cleaned || null;
  const metaLine = `${TABLE_IDS_META_PREFIX}${normalizedIds.join(",")}`;
  return cleaned ? `${cleaned}\n${metaLine}` : metaLine;
};

const bookingAssignedTableIds = (booking: Pick<Booking, "tableId" | "tableIds">) => {
  return normalizeTableIds([...(booking.tableIds ?? []), booking.tableId]);
};

const formatBookingTableLabel = (booking: Pick<Booking, "tableId" | "tableIds">) => {
  const ids = bookingAssignedTableIds(booking);
  if (!ids.length) return "";
  return `Bord ${ids.join(" + ")}`;
};

const normalizeCustomerEmail = (value?: string | null) => (value ?? "").trim().toLowerCase();

const sameTableSelection = (left: number[], right: number[]) => {
  const a = normalizeTableIds(left).sort((x, y) => x - y);
  const b = normalizeTableIds(right).sort((x, y) => x - y);
  if (a.length !== b.length) return false;
  return a.every((id, idx) => id === b[idx]);
};

type BookingRow = {
  id: string;
  restaurant_id: string;
  date: string;
  time: string;
  name: string;
  guests: number;
  notes: string | null;
  table_id: number | null;
  duration_min: number | null;
  status: string | null;
  source: string | null;
  client_email: string | null;
  created_at: string;
};

type PetsPolicy = "none" | "terrace" | "everywhere";

const DAYS_SV = ["söndag", "måndag", "tisdag", "onsdag", "torsdag", "fredag", "lördag"] as const;

type DayName = (typeof DAYS_SV)[number];

const DAYS_ORDER: DayName[] = ["måndag", "tisdag", "onsdag", "torsdag", "fredag", "lördag", "söndag"];

type HoursPeriod = {
  id: string;
  name?: string;
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
  days: Record<DayName, { closed: boolean; open: string; close: string }>;
};

type FloorplanTable = {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  seats: number;
  label?: string;
  orientation?: "h" | "v";
};

type FloorplanZone = {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  name: string;
};

type Floorplan = {
  width: number;
  height: number;
  tables: FloorplanTable[];
  zones: FloorplanZone[];
};

type TableCap = {
  id: number;
  cap: number;
  label?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
};

const KNOWLEDGE_LABELS = [
  "Namn",
  "Typ av restaurang",
  "Adress",
  "Avstånd",
  "Distance",
  "E-post",
  "Email",
  "Telefon",
  "Webbplats",
  "Hemsida",
  "Website",
  "Beskrivning",
  "Stämning",
  "Mat",
  "Mat & meny",
  "Grupp & event",
  "Betalning",
  "Allergier",
  "Barn",
  "Barnstol",
  "Barnmeny",
  "Uteservering",
  "Hundvänligt",
  "Rullstolsanpassad",
  "Alkoholtillstånd",
  "Köket stänger",
  "Max gäster per bokning",
  "Djurpolicy",
  "Parkering",
  "Kollektivtrafik",
  "Google Maps",
  "Facebook",
  "Instagram",
  "Bokningsmeddelande",
  "Bekräftelsemail (automatisk)",
  "Bekräftelsemail (manuell)",
];

const BOOKING_MESSAGE_LABEL = "Bokningsmeddelande";
const BOOKING_CONFIRMATION_EMAIL_AUTO_LABEL = "Bekräftelsemail (automatisk)";
const BOOKING_CONFIRMATION_EMAIL_MANUAL_LABEL = "Bekräftelsemail (manuell)";

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const normalizeKnowledgeLabels = (base: string) => {
  let text = (base ?? "").replace(/\r/g, "");
  for (const label of KNOWLEDGE_LABELS) {
    const pattern = new RegExp(`([^\\n])\\s*${escapeRegExp(label)}:`, "gi");
    text = text.replace(pattern, `$1\n${label}:`);
  }
  return text;
};

const extractMultilineLabelValue = (base: string, label: string) => {
  const normalized = normalizeKnowledgeLabels(base || "");
  const lines = normalized.split(/\r?\n/).map((l) => l.trimEnd());
  const labelLower = `${label.toLowerCase()}:`;
  const startIdx = lines.findIndex((l) => l.toLowerCase().startsWith(labelLower));
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
    const lower = line.toLowerCase();
    if (lower === "infos:" || lower.startsWith("fråga:") || lower.startsWith("svar:")) break;
    if (KNOWLEDGE_LABELS.some((l) => lower.startsWith(`${l.toLowerCase()}:`))) break;
    collected.push(line.trim());
  }
  return collected.join("\n").trim();
};

const dedupeKnowledgeLines = (lines: string[]) => {
  const seen = new Set<string>();
  return lines.filter((line) => {
    const label = KNOWLEDGE_LABELS.find((l) => line.toLowerCase().startsWith(l.toLowerCase() + ":"));
    if (!label) return true;
    const key = label.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

type DashboardErrorBoundaryProps = { children: React.ReactNode };
type DashboardErrorBoundaryState = { error: Error | null };

class DashboardErrorBoundary extends React.Component<DashboardErrorBoundaryProps, DashboardErrorBoundaryState> {
  override state: DashboardErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("Dashboard crashed", error, info);
    if (typeof window !== "undefined") {
      (window as any).__bokata_dashboard_error = {
        message: error.message,
        stack: error.stack,
        componentStack: info.componentStack,
        time: new Date().toISOString(),
      };
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="min-h-screen bg-pink-50 p-6 flex items-center justify-center">
          <div className="w-full max-w-2xl rounded-2xl border border-rose-200 bg-white p-6 shadow-lg">
            <h1 className="text-2xl font-bold text-gray-900">Dashboarden kunde inte laddas</h1>
            <p className="mt-2 text-sm text-gray-700">
              Ett fel uppstod när sidan laddades. Säg gärna till oss vad som står här nedan.
            </p>
            <div className="mt-4 rounded-lg border border-rose-100 bg-rose-50 px-4 py-3 text-xs text-rose-700 whitespace-pre-wrap">
              {this.state.error.message}
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                className="rounded-full px-4 py-2 bg-pink-600 text-white font-semibold hover:bg-pink-700"
                onClick={() => window.location.reload()}
              >
                Ladda om
              </button>
              <a
                className="rounded-full px-4 py-2 border border-gray-300 text-gray-700 hover:bg-gray-50"
                href="/"
              >
                Till startsidan
              </a>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const makeDefaultDays = () => ({
  söndag: { closed: false, open: "11:00", close: "17:00" },
  måndag: { closed: false, open: "11:00", close: "17:00" },
  tisdag: { closed: false, open: "11:00", close: "17:00" },
  onsdag: { closed: false, open: "11:00", close: "17:00" },
  torsdag: { closed: false, open: "11:00", close: "17:00" },
  fredag: { closed: false, open: "11:00", close: "17:00" },
  lördag: { closed: false, open: "11:00", close: "17:00" },
});

const cloneDays = (days: Record<DayName, { closed: boolean; open: string; close: string }>) =>
  DAYS_ORDER.reduce(
    (acc, day) => {
      acc[day] = { ...days[day] };
      return acc;
    },
    {} as Record<DayName, { closed: boolean; open: string; close: string }>
  );

type Settings = {
  info: { email: string };
  publicMessage: string;
  confirmationEmailMessageAuto: string;
  confirmationEmailMessageManual: string;
  seating: {
    groupThreshold: number;
    highChairs: number;
    allowCombineTables: boolean;
    maxGuests: number;
    maxTables: number;
    maxBookingDurationMin: number;
    mealRanges: MealRangeMap;
    followUpEnabled: boolean;
    followUpDelayDays: number;
    followUpEmail: string;
  };
  policies: {
    vegan: boolean;
    glutenFree: boolean;
    lactoseFree: boolean;
    kidsMenu: boolean;
    strollerAllowed: boolean;
    pets: PetsPolicy;
    wheelchair: boolean;
  };
  hours: {
    normal: Record<DayName, { closed: boolean; open: string; close: string }>;
    special: { date: string; closed: boolean; open: string; close: string }[];
    periods: HoursPeriod[];
  };
  ai: {
    name: string;
    allowAutoConfirm: boolean;
    outOfScopeReply: string;
    languages: string[];
    knowledge: string;
    faq: string;
    webSearch: {
      enabled: boolean;
      siteUrl: string;
      googleMapsUrl: string;
      facebookUrl: string;
      instagramUrl: string;
    };
  };
  escalation: { maxGuestsPerReservation: number; manualReviewKeywords: string[] };
  notifications: {
    to: string;
    notifyOnNewBooking: boolean;
    requireManualConfirmation: boolean;
  };
};

type SpecialDay = Settings["hours"]["special"][number];

type OnboardingFaq = {
  id: string;
  q: string;
  a: string;
};

const DEFAULT_MEAL_RANGES: MealRangeMap = {
  Frukost: ["08:00", "10:59"],
  Lunch: ["11:00", "14:59"],
  Fika: ["15:00", "16:59"],
  Middag: ["17:00", "21:00"],
};
const LEGACY_DEFAULT_MEAL_RANGES: Partial<MealRangeMap> = {
  Lunch: ["11:00", "14:30"],
  Middag: ["17:00", "21:30"],
};
const ALL_DAY_RANGE: [string, string] = ["00:00", "23:59"];

const ENGINE = {
  slotStepMin: 30,
  durations: { Frukost: 60, Lunch: 90, Fika: 60, Middag: 120 } as const,
  tables: [2, 2, 2, 4, 4, 4, 6, 6],
};

const MONTHS = [
  "januari",
  "februari",
  "mars",
  "april",
  "maj",
  "juni",
  "juli",
  "augusti",
  "september",
  "oktober",
  "november",
  "december",
];

const WD_SHORT = ["Må", "Ti", "On", "To", "Fr", "Lö", "Sö"];
const WD_FULL = ["Söndag", "Måndag", "Tisdag", "Onsdag", "Torsdag", "Fredag", "Lördag"];

const HOLIDAYS_BY_YEAR: Record<number, { date: string; name: string }[]> = {
  2026: [
    { date: "2026-01-01", name: "Nyårsdagen" },
    { date: "2026-01-06", name: "Trettondedag" },
    { date: "2026-04-03", name: "Långfredagen" },
    { date: "2026-04-05", name: "Påskdagen" },
    { date: "2026-04-06", name: "Annandag påsk" },
    { date: "2026-05-01", name: "Första maj" },
    { date: "2026-05-14", name: "Kristi himmelsfärdsdag" },
    { date: "2026-05-24", name: "Pingstdagen" },
    { date: "2026-06-06", name: "Nationaldagen" },
    { date: "2026-06-20", name: "Midsommardagen" },
    { date: "2026-10-31", name: "Alla helgons dag" },
    { date: "2026-12-25", name: "Juldagen" },
    { date: "2026-12-26", name: "Annandag jul" },
  ],
  2027: [
    { date: "2027-01-01", name: "Nyårsdagen" },
    { date: "2027-01-06", name: "Trettondedag" },
    { date: "2027-03-26", name: "Långfredagen" },
    { date: "2027-03-28", name: "Påskdagen" },
    { date: "2027-03-29", name: "Annandag påsk" },
    { date: "2027-05-01", name: "Första maj" },
    { date: "2027-05-06", name: "Kristi himmelsfärdsdag" },
    { date: "2027-05-16", name: "Pingstdagen" },
    { date: "2027-06-06", name: "Nationaldagen" },
    { date: "2027-06-26", name: "Midsommardagen" },
    { date: "2027-11-06", name: "Alla helgons dag" },
    { date: "2027-12-25", name: "Juldagen" },
    { date: "2027-12-26", name: "Annandag jul" },
  ],
};

const pad2 = (n: number) => String(n).padStart(2, "0");
const timeToMin = (t: string) => {
  if (!t || typeof t !== "string") return 0;
  const parts = t.split(":");
  if (parts.length < 2) return 0;
  const [h, m] = parts.map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 0;
  return h * 60 + m;
};
const minToTime = (m: number) => `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;

const round30 = (t: string) => {
  if (!t || typeof t !== "string") return "00:00";
  const parts = t.split(":");
  if (parts.length < 2) return "00:00";
  const [hRaw, mRaw] = parts.map(Number);
  const h = Number.isFinite(hRaw) ? hRaw : 0;
  const m = Number.isFinite(mRaw) ? mRaw : 0;
  if (m < 15) return `${pad2(h)}:00`;
  if (m < 45) return `${pad2(h)}:30`;
  return `${pad2((h + 1) % 24)}:00`;
};

const overlap = (aS: number, aE: number, bS: number, bE: number) => aS < bE && bS < aE;

const uid = () => Math.random().toString(36).slice(2, 10);
const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

const tableSizeForSeats = (seats: number, orientation: "h" | "v" = "h") => {
  const base =
    seats <= 2 ? { w: 80, h: 60 } :
    seats <= 4 ? { w: 90, h: 60 } :
    seats <= 6 ? { w: 110, h: 70 } :
    seats <= 8 ? { w: 130, h: 80 } :
    { w: 150, h: 90 };
  return orientation === "v" ? { w: base.h, h: base.w } : base;
};

const normalizeTable = (t: FloorplanTable): FloorplanTable => {
  const orientation = t.orientation ?? "h";
  const size = tableSizeForSeats(t.seats || 0, orientation);
  return { ...t, ...size, orientation };
};

const toIsoDate = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const defaultPeriodRange = () => {
  const y = new Date().getFullYear();
  return { from: `${y}-01-01`, to: `${y}-12-31` };
};
const makeHoursPeriod = (
  days: Record<DayName, { closed: boolean; open: string; close: string }>,
  from?: string,
  to?: string,
  name?: string
): HoursPeriod => {
  const range = defaultPeriodRange();
  return {
    id: uid(),
    name,
    from: from ?? range.from,
    to: to ?? range.to,
    days: cloneDays(days),
  };
};
const normalizeHours = (hours?: Settings["hours"] | null) => {
  const baseDays = makeDefaultDays();
  if (!hours) {
    const normal = cloneDays(baseDays);
    return { normal, special: [], periods: [makeHoursPeriod(normal)] };
  }
  const normal = hours.normal ? cloneDays(hours.normal) : cloneDays(baseDays);
  const special = Array.isArray(hours.special) ? hours.special : [];
  const periodsRaw = Array.isArray(hours.periods) ? hours.periods : [];
  const periods =
    periodsRaw.length > 0
      ? periodsRaw.map((p) => ({
          ...p,
          name: p.name ?? "",
          days: p.days ? cloneDays(p.days as Record<DayName, { closed: boolean; open: string; close: string }>) : cloneDays(normal),
        }))
      : [makeHoursPeriod(normal)];
  return { normal, special, periods };
};

const isValidTime = (t: string) => {
  if (!t || typeof t !== "string") return false;
  const parts = t.split(":");
  if (parts.length < 2) return false;
  const [h, m] = parts.map(Number);
  return Number.isFinite(h) && Number.isFinite(m) && h >= 0 && h <= 23 && m >= 0 && m <= 59;
};

const normalizeMealRanges = (raw?: Partial<MealRangeMap> | null): MealRangeMap => {
  const out: MealRangeMap = { ...DEFAULT_MEAL_RANGES };
  MEAL_KEYS.forEach((key) => {
    const val = raw?.[key];
    if (Array.isArray(val) && val.length === 2 && isValidTime(val[0]) && isValidTime(val[1])) {
      out[key] = [val[0], val[1]];
    }
  });
  if (raw && !raw.Fika) {
    MEAL_KEYS.forEach((key) => {
      const val = raw[key];
      const legacy = LEGACY_DEFAULT_MEAL_RANGES[key];
      if (legacy && val?.[0] === legacy[0] && val?.[1] === legacy[1]) {
        out[key] = DEFAULT_MEAL_RANGES[key];
      }
    });
  }
  return out;
};

const mealForWithRanges = (t: string, ranges: MealRangeMap): Meal => {
  const x = timeToMin(t);
  for (const m of MEAL_KEYS) {
    const [a, b] = ranges[m];
    if (x >= timeToMin(a) && x <= timeToMin(b)) return m;
  }
  return "Alla";
};

const mealRangeFor = (meal: Meal, ranges: MealRangeMap): [string, string] => {
  if (meal === "Alla") return ALL_DAY_RANGE;
  return ranges[meal];
};

function assignTablesForDate(date: string, input: Booking[], mealRanges: MealRangeMap = DEFAULT_MEAL_RANGES): Booking[] {
  return assignTablesForDateWithTables(date, input, ENGINE.tables.map((cap, i) => ({ id: i + 1, cap })), mealRanges);
}

function parseTableNumber(label?: string | null) {
  if (!label) return null;
  const match = label.match(/\d+/);
  return match ? Number(match[0]) : null;
}

function buildTableCaps(plan?: Floorplan | null): TableCap[] {
  if (!plan?.tables?.length) return ENGINE.tables.map((cap, i) => ({ id: i + 1, cap }));
  const byId = new Map<number, TableCap>();
  plan.tables.forEach((t, idx) => {
    const id = parseTableNumber(t.label) ?? idx + 1;
    if (!byId.has(id)) {
      byId.set(id, {
        id,
        cap: Math.max(1, t.seats || 0),
        label: t.label?.trim() || `Bord ${id}`,
        x: t.x,
        y: t.y,
        w: t.w,
        h: t.h,
      });
    }
  });
  return Array.from(byId.values()).sort((a, b) => a.id - b.id);
}

type TableReservationBlock = {
  tableIds: number[];
  startMin: number;
  endMin: number;
};

const getTableCenter = (table: TableCap) => {
  const fallbackX = table.id * 140;
  const fallbackY = 0;
  const x = Number.isFinite(table.x as number) ? (table.x as number) : fallbackX;
  const y = Number.isFinite(table.y as number) ? (table.y as number) : fallbackY;
  const w = Number.isFinite(table.w as number) ? Math.max(40, table.w as number) : 100;
  const h = Number.isFinite(table.h as number) ? Math.max(40, table.h as number) : 70;
  return { x: x + w / 2, y: y + h / 2 };
};

const tableDistance = (a: TableCap, b: TableCap) => {
  const ac = getTableCenter(a);
  const bc = getTableCenter(b);
  return Math.hypot(ac.x - bc.x, ac.y - bc.y);
};

const buildTableNeighbors = (tables: TableCap[]) => {
  const links = new Map<number, Set<number>>();
  tables.forEach((table) => links.set(table.id, new Set<number>()));

  for (let i = 0; i < tables.length; i += 1) {
    for (let j = i + 1; j < tables.length; j += 1) {
      const a = tables[i];
      const b = tables[j];
      const ax = Number.isFinite(a.x as number) ? (a.x as number) : a.id * 140;
      const ay = Number.isFinite(a.y as number) ? (a.y as number) : 0;
      const aw = Number.isFinite(a.w as number) ? Math.max(40, a.w as number) : 100;
      const ah = Number.isFinite(a.h as number) ? Math.max(40, a.h as number) : 70;
      const bx = Number.isFinite(b.x as number) ? (b.x as number) : b.id * 140;
      const by = Number.isFinite(b.y as number) ? (b.y as number) : 0;
      const bw = Number.isFinite(b.w as number) ? Math.max(40, b.w as number) : 100;
      const bh = Number.isFinite(b.h as number) ? Math.max(40, b.h as number) : 70;
      const horizontalGap = Math.min(Math.abs(ax + aw - bx), Math.abs(bx + bw - ax));
      const verticalGap = Math.min(Math.abs(ay + ah - by), Math.abs(by + bh - ay));
      const horizontalOverlap = Math.min(ax + aw, bx + bw) - Math.max(ax, bx);
      const verticalOverlap = Math.min(ay + ah, by + bh) - Math.max(ay, by);
      const edgeGap = 42;
      const overlapTolerance = 14;
      const nearHorizontally = horizontalGap <= edgeGap && verticalOverlap >= -overlapTolerance;
      const nearVertically = verticalGap <= edgeGap && horizontalOverlap >= -overlapTolerance;
      const distanceLimit = Math.max(aw, ah, bw, bh) * 1.8;
      const nearCenter = tableDistance(a, b) <= distanceLimit;
      if (!nearHorizontally && !nearVertically && !nearCenter) continue;
      links.get(a.id)?.add(b.id);
      links.get(b.id)?.add(a.id);
    }
  }

  for (const table of tables) {
    const set = links.get(table.id);
    if (!set || set.size || tables.length <= 1) continue;
    let nearest: TableCap | null = null;
    let nearestDist = Number.POSITIVE_INFINITY;
    for (const other of tables) {
      if (other.id === table.id) continue;
      const d = tableDistance(table, other);
      if (d < nearestDist) {
        nearest = other;
        nearestDist = d;
      }
    }
    if (nearest) {
      set.add(nearest.id);
      links.get(nearest.id)?.add(table.id);
    }
  }

  return links;
};

function chooseTableGroup(args: {
  tables: TableCap[];
  guests: number;
  startMin: number;
  endMin: number;
  assignedBlocks: TableReservationBlock[];
  preferredTableId?: number | null;
}): number[] | null {
  if (!args.tables.length || args.guests < 1) return null;

  const unavailable = new Set<number>();
  for (const block of args.assignedBlocks) {
    if (!overlap(args.startMin, args.endMin, block.startMin, block.endMin)) continue;
    block.tableIds.forEach((id) => unavailable.add(id));
  }

  const available = args.tables.filter((table) => !unavailable.has(table.id));
  if (!available.length) return null;
  const availableById = new Map<number, TableCap>();
  available.forEach((table) => availableById.set(table.id, table));

  const sortedCaps = available.map((table) => table.cap).sort((a, b) => b - a);
  let maxCapacity = 0;
  let minNeeded = 0;
  for (const cap of sortedCaps) {
    maxCapacity += cap;
    minNeeded += 1;
    if (maxCapacity >= args.guests) break;
  }
  if (maxCapacity < args.guests) return null;

  const neighbors = buildTableNeighbors(available);
  const maxGroupSize = Math.min(8, available.length, Math.max(minNeeded + 1, 2));

  const tableSpread = (ids: number[]) => {
    if (ids.length <= 1) return 0;
    const points = ids
      .map((id) => availableById.get(id))
      .filter(Boolean)
      .map((table) => getTableCenter(table as TableCap));
    if (points.length <= 1) return 0;
    const minX = Math.min(...points.map((p) => p.x));
    const maxX = Math.max(...points.map((p) => p.x));
    const minY = Math.min(...points.map((p) => p.y));
    const maxY = Math.max(...points.map((p) => p.y));
    return (maxX - minX) + (maxY - minY);
  };

  const scoreGroup = (ids: number[]) => {
    const seats = ids.reduce((sum, id) => sum + (availableById.get(id)?.cap ?? 0), 0);
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

  const isBetter = (next: number[], current: number[] | null) => {
    if (!current) return true;
    const a = scoreGroup(next);
    const b = scoreGroup(current);
    if (a.missesPreferred !== b.missesPreferred) return a.missesPreferred < b.missesPreferred;
    if (a.overflow !== b.overflow) return a.overflow < b.overflow;
    if (a.size !== b.size) return a.size < b.size;
    if (a.spread !== b.spread) return a.spread < b.spread;
    return next.join(",") < current.join(",");
  };

  let best: number[] | null = null;
  const seen = new Set<string>();
  const explored = new Set<string>();

  const evaluate = (ids: number[], seats: number) => {
    if (seats < args.guests) return;
    const sorted = [...ids].sort((a, b) => a - b);
    const key = sorted.join(",");
    if (seen.has(key)) return;
    seen.add(key);
    if (isBetter(sorted, best)) best = sorted;
  };

  const starts = [...available].sort((a, b) => {
    const aPref = args.preferredTableId != null && a.id === args.preferredTableId ? 0 : 1;
    const bPref = args.preferredTableId != null && b.id === args.preferredTableId ? 0 : 1;
    if (aPref !== bPref) return aPref - bPref;
    if (a.cap !== b.cap) return b.cap - a.cap;
    return a.id - b.id;
  });

  const dfs = (group: number[], seats: number, frontier: Set<number>) => {
    const key = [...group].sort((a, b) => a - b).join(",");
    if (explored.has(key)) return;
    explored.add(key);

    evaluate(group, seats);
    if (group.length >= maxGroupSize) return;

    const nextCandidates = Array.from(frontier)
      .map((id) => availableById.get(id))
      .filter(Boolean)
      .sort((a, b) => {
        const aPref = args.preferredTableId != null && a!.id === args.preferredTableId ? 0 : 1;
        const bPref = args.preferredTableId != null && b!.id === args.preferredTableId ? 0 : 1;
        if (aPref !== bPref) return aPref - bPref;
        if (a!.cap !== b!.cap) return b!.cap - a!.cap;
        return a!.id - b!.id;
      }) as TableCap[];

    for (const next of nextCandidates) {
      if (group.includes(next.id)) continue;
      const nextGroup = [...group, next.id];
      const nextFrontier = new Set<number>(frontier);
      nextFrontier.delete(next.id);
      for (const neighborId of neighbors.get(next.id) ?? []) {
        if (!availableById.has(neighborId) || nextGroup.includes(neighborId)) continue;
        nextFrontier.add(neighborId);
      }
      dfs(nextGroup, seats + next.cap, nextFrontier);
    }
  };

  for (const start of starts) {
    const frontier = new Set<number>(
      Array.from(neighbors.get(start.id) ?? []).filter((id) => availableById.has(id))
    );
    dfs([start.id], start.cap, frontier);
  }

  return best;
}

function assignTablesForDateWithTables(
  date: string,
  input: Booking[],
  tables: TableCap[],
  mealRanges: MealRangeMap = DEFAULT_MEAL_RANGES
): Booking[] {
  const tableList = tables.length ? tables : ENGINE.tables.map((cap, i) => ({ id: i + 1, cap }));
  const day = input
    .filter((b) => b.date === date)
    .map((b) => ({ ...b, time: round30(b.time) }));
  const cancelled = day.filter((b) => isCancelledBooking(b));
  const active = day
    .filter((b) => !isCancelledBooking(b))
    .sort((a, b) => b.guests - a.guests || timeToMin(a.time) - timeToMin(b.time));

  const out: Booking[] = [...cancelled];
  const assignedBlocks: TableReservationBlock[] = [];
  const tableSet = new Set(tableList.map((table) => table.id));
  const tableCapById = new Map(tableList.map((table) => [table.id, table.cap] as const));

  for (const b of active) {
    const meal = mealForWithRanges(b.time, mealRanges);
    const dur = b.durationMin ?? (meal in ENGINE.durations ? ENGINE.durations[meal as keyof typeof ENGINE.durations] : 90);
    const s = timeToMin(round30(b.time));
    const e = s + dur;

    const forcedGroup = bookingAssignedTableIds(b).filter((id) => tableSet.has(id));
    const forcedSeats = forcedGroup.reduce((sum, id) => sum + (tableCapById.get(id) ?? 0), 0);
    const forcedOccupied = assignedBlocks.some(
      (block) => overlap(s, e, block.startMin, block.endMin) && block.tableIds.some((id) => forcedGroup.includes(id))
    );
    let group: number[] | null =
      forcedGroup.length && forcedSeats >= b.guests && !forcedOccupied ? forcedGroup : null;

    if (!group) {
      group = chooseTableGroup({
        tables: tableList,
        guests: b.guests,
        preferredTableId: forcedGroup[0] ?? b.tableId ?? null,
        startMin: s,
        endMin: e,
        assignedBlocks,
      });
    }
    const chosen = group?.length
      ? b.tableId != null && group.includes(b.tableId)
        ? b.tableId
        : group[0]
      : null;
    if (group?.length) {
      assignedBlocks.push({ tableIds: group, startMin: s, endMin: e });
    }

    out.push({ ...b, tableId: chosen, tableIds: group?.length ? group : null, durationMin: dur, time: round30(b.time) });
  }

  return [...input.filter((b) => b.date !== date), ...out];
}

function findAvailableTable(args: {
  date: string;
  time: string;
  guests: number;
  bookings: Booking[];
  durationMin: number;
  tables: TableCap[];
  mealRanges?: MealRangeMap;
}): number | null {
  const draftId = `draft-${uid()}`;
  const draft: Booking = {
    id: draftId,
    date: args.date,
    time: round30(args.time),
    name: "Availability check",
    guests: args.guests,
    notes: "",
    note: false,
    tableId: null,
    durationMin: args.durationMin,
    status: "confirmed",
    source: "walkin",
  };

  const simulated = assignTablesForDateWithTables(
    args.date,
    [...args.bookings, draft],
    args.tables,
    args.mealRanges ?? DEFAULT_MEAL_RANGES
  );
  return simulated.find((booking) => booking.id === draftId)?.tableId ?? null;
}

function isTableAvailable(args: {
  date: string;
  time: string;
  tableId: number;
  bookings: Booking[];
  durationMin: number;
  mealRanges?: MealRangeMap;
}) {
  const mealRanges = args.mealRanges ?? DEFAULT_MEAL_RANGES;
  const when = round30(args.time);
  const s = timeToMin(when);
  const e = s + args.durationMin;
  return !args.bookings.some((b) => {
    if (b.date !== args.date) return false;
    if (isCancelledBooking(b)) return false;
    const usedTables = bookingAssignedTableIds(b);
    if (!usedTables.includes(args.tableId)) return false;
    const bs = timeToMin(round30(b.time));
    const bd =
      b.durationMin ??
      (mealForWithRanges(b.time, mealRanges) in ENGINE.durations
        ? ENGINE.durations[mealForWithRanges(b.time, mealRanges) as keyof typeof ENGINE.durations]
        : 90);
    const be = bs + bd;
    return overlap(s, e, bs, be);
  });
}

function ReservationDashboardInner() {
  const [session, setSession] = useState<Session | null>(null);
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const location = useLocation();
  const [authMsg, setAuthMsg] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(false);
  const [passwordChangeValue, setPasswordChangeValue] = useState("");
  const [passwordConfirmValue, setPasswordConfirmValue] = useState("");
  const [passwordChangeLoading, setPasswordChangeLoading] = useState(false);
  const [passwordChangeMsg, setPasswordChangeMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [accessDenied, setAccessDenied] = useState<string | null>(null);
  const [settingsSaveError, setSettingsSaveError] = useState<string | null>(null);
  const [primaryMismatchNotice, setPrimaryMismatchNotice] = useState<string | null>(null);
  const [profileName, setProfileName] = useState("");
  const [profileEmail, setProfileEmail] = useState("");
  const [restaurantId, setRestaurantId] = useState<string | null>(null);
  const [restaurantName, setRestaurantName] = useState("");
  const [restaurantRole, setRestaurantRole] = useState<string | null>(null);
  const canEditFloorplan = restaurantRole !== null;
  const [bookingLinkStatus, setBookingLinkStatus] = useState("");
  const [settingsReady, setSettingsReady] = useState(false);
  const [aiSaveState, setAiSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [aiSaveMessage, setAiSaveMessage] = useState<string>("");
  const saveTimer = useRef<number | null>(null);
  const profileTimer = useRef<number | null>(null);
  const bookingSaveTimer = useRef<number | null>(null);
  const aiInitialSyncSkipRef = useRef(true);
  const bookingInitialSyncSkipRef = useRef(true);
  const aiLoadSucceededRef = useRef(false);
  const bookingLoadSucceededRef = useRef(false);
  const aiDirtyRef = useRef(false);
  const bookingDirtyRef = useRef(false);

  const markAiDirty = () => {
    aiDirtyRef.current = true;
  };

  const markBookingDirty = () => {
    bookingDirtyRef.current = true;
  };

  const markSettingsDirty = (_event?: unknown) => {
    markAiDirty();
    markBookingDirty();
  };

  const [activeMeal, setActiveMeal] = useState<Meal>("Alla");
  const [openBooking, setOpenBooking] = useState<Booking | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(() => new URLSearchParams(window.location.search).has("calendar"));
  const [activeTab, setActiveTab] = useState<"overview" | "tableplan">("overview");

  const today = useMemo(() => new Date(), []);

  const bookingPublicUrl = useMemo(() => {
    if (!restaurantId || typeof window === "undefined") return "";
    return `${window.location.origin}/booking?r=${restaurantId}`;
  }, [restaurantId]);

  const copyBookingPublicUrl = async () => {
    if (!bookingPublicUrl) return;
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(bookingPublicUrl);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = bookingPublicUrl;
        textarea.setAttribute("readonly", "true");
        textarea.style.position = "absolute";
        textarea.style.left = "-9999px";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }
      setBookingLinkStatus("Kopierad");
    } catch {
      setBookingLinkStatus("Kunde inte kopiera");
    } finally {
      window.setTimeout(() => setBookingLinkStatus(""), 2000);
    }
  };
  const [month, setMonth] = useState(today.getMonth());
  const [year, setYear] = useState(today.getFullYear());
  const [selectedDay, setSelectedDay] = useState(today.getDate());
  const dateSel = `${year}-${pad2(month + 1)}-${pad2(selectedDay)}`;

  const defaultSettings: Settings = useMemo(
    () => ({
      info: { email: "bookings@example.se" },
      publicMessage: "",
      confirmationEmailMessageAuto: "",
      confirmationEmailMessageManual: "",
      seating: {
        groupThreshold: 0,
        highChairs: 0,
        allowCombineTables: false,
        maxGuests: 0,
        maxTables: 0,
        maxBookingDurationMin: 0,
        mealRanges: DEFAULT_MEAL_RANGES,
        followUpEnabled: false,
        followUpDelayDays: 3,
        followUpEmail:
          "Tack för ert besök! Vi hoppas att ni hade en härlig stund.\nOm du vill får du gärna lämna en Google‑recension.",
      },
      policies: {
        vegan: true,
        glutenFree: true,
        lactoseFree: true,
        kidsMenu: true,
        strollerAllowed: true,
        pets: "terrace",
        wheelchair: true,
      },
      hours: {
        normal: makeDefaultDays(),
        special: [
          { date: "2025-05-29", closed: false, open: "09:00", close: "17:00" },
          { date: "2025-06-06", closed: false, open: "11:00", close: "17:00" },
          { date: "2025-06-20", closed: false, open: "11:00", close: "16:00" },
        ],
        periods: [makeHoursPeriod(makeDefaultDays())],
      },
      ai: {
        name: "Bokäta Assistant",
        allowAutoConfirm: true,
        outOfScopeReply:
          "Jag kan bara hjälpa till med bordsbokningar och relaterade frågor. Kontakta oss på {email}.",
        languages: ["sv", "en", "fr"],
        knowledge: "",
        faq: [
          "Tar ni emot kontanter?",
          "Tar ni kort (Visa/Mastercard/Amex)? Swish?",
          "Vilka är era öppettider per dag?",
          "Hur lång är bordsbokningstiden per sittning?",
          "Hur tar man sig till er med kollektivtrafik?",
          "Finns det parkering i närheten?",
          "Tillgänglig entré och toalett?",
          "Erbjuder ni vegan-, gluten- och laktosfria alternativ?",
          "Finns barnstolar? Barnvagn? Barnmeny?",
          "Hundpolicy (ej/terrass/överallt)?",
          "Max antal gäster per bokning?",
        ].join("\n"),
        webSearch: {
          enabled: false,
          siteUrl: "",
          googleMapsUrl: "",
          facebookUrl: "",
          instagramUrl: "",
        },
      },
      escalation: { maxGuestsPerReservation: 0, manualReviewKeywords: ["privat event", "bröllop", "afterwork"] },
      notifications: {
        to: "bookings@example.se",
        notifyOnNewBooking: true,
        requireManualConfirmation: false,
      },
    }),
    []
  );

  const [config, setConfig] = useState<Settings>(defaultSettings);
  const [openPeriods, setOpenPeriods] = useState<Record<string, boolean>>({});
  const [showHolidays, setShowHolidays] = useState(() => {
    if (typeof window === "undefined") return true;
    return window.innerWidth >= 768;
  });
  const mealRanges = useMemo(() => normalizeMealRanges(config.seating.mealRanges), [config.seating.mealRanges]);
  const bookingDurationMin = config.seating.maxBookingDurationMin || 90;

  useEffect(() => {
    aiInitialSyncSkipRef.current = true;
    bookingInitialSyncSkipRef.current = true;
    aiLoadSucceededRef.current = false;
    bookingLoadSucceededRef.current = false;
    aiDirtyRef.current = false;
    bookingDirtyRef.current = false;
  }, [session?.user?.id, restaurantId]);

  useEffect(() => {
    const ids = config.hours.periods?.map((p) => p.id) ?? [];
    setOpenPeriods((prev) => {
      const next: Record<string, boolean> = { ...prev };
      let changed = false;
      for (const id of ids) {
        if (next[id] === undefined) {
          next[id] = false;
          changed = true;
        }
      }
      for (const key of Object.keys(next)) {
        if (!ids.includes(key)) {
          delete next[key];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [config.hours.periods]);

  useEffect(() => {
    if (!settingsOpen) return;
    if (typeof window !== "undefined" && window.innerWidth < 768) {
      setShowHolidays(false);
    }
  }, [settingsOpen]);

  useEffect(() => {
    if (settingsOpen) {
      setShowDrafts(false);
    }
  }, [settingsOpen]);

  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [floorplan, setFloorplan] = useState<Floorplan>({
    width: 900,
    height: 520,
    tables: [
      { id: uid(), x: 80, y: 80, ...tableSizeForSeats(2), seats: 2, label: "T1", orientation: "h" },
      { id: uid(), x: 200, y: 80, ...tableSizeForSeats(2), seats: 2, label: "T2", orientation: "h" },
      { id: uid(), x: 320, y: 80, ...tableSizeForSeats(4), seats: 4, label: "T3", orientation: "h" },
      { id: uid(), x: 80, y: 180, ...tableSizeForSeats(6), seats: 6, label: "T4", orientation: "h" },
    ],
    zones: [
      { id: uid(), x: 520, y: 70, w: 280, h: 160, name: "Terrass" },
    ],
  });
  const [selectedItem, setSelectedItem] = useState<{ type: "table" | "zone"; id: string } | null>(null);
  const [dragging, setDragging] = useState<{ type: "table" | "zone"; id: string; offsetX: number; offsetY: number } | null>(
    null
  );
  const floorplanSaveTimer = useRef<number | null>(null);
  const tableCaps = useMemo(() => buildTableCaps(floorplan), [floorplan]);
  const tableOptions = useMemo(
    () => tableCaps.map((t) => ({ id: t.id, label: t.label ?? `Bord ${t.id}`, cap: t.cap })),
    [tableCaps]
  );

  useEffect(() => {
    let active = true;

    const init = async () => {
      const { data } = await supabase.auth.getSession();
      if (!active) return;
      setSession(data.session ?? null);
      if (data.session?.user?.email) setProfileEmail(data.session.user.email);
    };

    init();

    const { data: sub } = supabase.auth.onAuthStateChange((_event, sess) => {
      setSession(sess);
      setProfileEmail(sess?.user?.email ?? "");
      if (!sess) setSettingsReady(false);
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.removeItem("bokata_restaurant_id");
  }, []);

  useEffect(() => {
    const loadPlan = async () => {
      if (!restaurantId) return;
      const { data, error } = await supabase
        .from("floorplans")
        .select("layout")
        .eq("restaurant_id", restaurantId)
        .maybeSingle();
      if (error) return;
      const layout = (data as { layout?: Floorplan })?.layout;
      if (layout?.tables && layout?.zones) {
        setFloorplan({
          ...layout,
          tables: layout.tables.map((t) => normalizeTable(t)),
        });
      }
    };
    loadPlan();
  }, [restaurantId]);

  useEffect(() => {
    if (!restaurantId || !canEditFloorplan) return;
    if (floorplanSaveTimer.current) window.clearTimeout(floorplanSaveTimer.current);
    floorplanSaveTimer.current = window.setTimeout(async () => {
      await supabase.from("floorplans").upsert(
        {
          restaurant_id: restaurantId,
          layout: floorplan,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "restaurant_id" }
      );
    }, 800);
    return () => {
      if (floorplanSaveTimer.current) window.clearTimeout(floorplanSaveTimer.current);
    };
  }, [floorplan, restaurantId, canEditFloorplan]);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: PointerEvent) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const x = clamp(e.clientX - rect.left - dragging.offsetX, 0, rect.width - 40);
      const y = clamp(e.clientY - rect.top - dragging.offsetY, 0, rect.height - 40);
      if (dragging.type === "table") {
        setFloorplan((prev) => ({
          ...prev,
          tables: prev.tables.map((t) => (t.id === dragging.id ? { ...t, x, y } : t)),
        }));
      } else {
        setFloorplan((prev) => ({
          ...prev,
          zones: prev.zones.map((z) => (z.id === dragging.id ? { ...z, x, y } : z)),
        }));
      }
    };
    const onUp = () => setDragging(null);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [dragging]);

  useEffect(() => {
    const load = async () => {
      if (!session?.user?.id) return;
      const userId = session.user.id;
      const userEmail = (session.user.email ?? "").trim().toLowerCase();

      setAccessDenied(null);
      const { data: member, error: memberError } = await supabase
        .from("memberships")
        .select("restaurant_id")
        .eq("user_id", userId)
        .limit(1)
        .maybeSingle();
      if (memberError) {
        console.error("Membership lookup error", memberError);
      }

      const { data: sub, error: subError } = userEmail
        ? await supabase
            .from("stripe_subscriptions")
            .select("status")
            .or(`email.eq.${userEmail},supabase_user_id.eq.${userId}`)
            .in("status", ["active", "trialing"])
            .limit(1)
            .maybeSingle()
        : { data: null, error: null };
      if (subError) {
        console.error("Stripe subscription lookup error", subError);
      }

      const hasAccess = !!member || !!sub;
      const hadLookupError = !!memberError || !!subError;
      if (!hasAccess && !hadLookupError) {
        const baseMsg = "Du saknar aktivt abonnemang. Kontakta oss om du behöver åtkomst.";
        const emailMsg = userEmail ? ` (${userEmail})` : "";
        setAccessDenied(`${baseMsg}${emailMsg}`.trim());
        setSettingsReady(true);
        return;
      }
      if (!hasAccess && hadLookupError) {
        const baseMsg = "Kunde inte verifiera abonnemanget just nu. Försök igen om en stund.";
        const emailMsg = userEmail ? ` (${userEmail})` : "";
        const memberErrMsg = memberError ? ` | membership: ${memberError.message}` : "";
        const subErrMsg = subError ? ` | subscription: ${subError.message}` : "";
        setAccessDenied(`${baseMsg}${emailMsg}${memberErrMsg}${subErrMsg}`.trim());
      }

      let restaurant: { restaurantId: string | null; role?: string | null; name?: string | null } | null = null;
      try {
        const token = session?.access_token || "";
        restaurant = await fetchRestaurantFromApi(token);
        if (!restaurant?.restaurantId) {
          const baseName = profileName.trim() ? `${profileName.trim()} Restaurant` : "Bokäta Restaurant";
          restaurant = await createRestaurantFromApi(token, baseName);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Kunde inte hämta restaurang";
        console.error(msg);
      }

      if (restaurant?.restaurantId) {
        setRestaurantId(restaurant.restaurantId);
        setRestaurantName(restaurant.name ?? "");
        setRestaurantRole(restaurant.role ?? null);
        setPrimaryMismatchNotice(null);
      }

      const [{ data: profile }, { data: settings, error: settingsError }, { data: bookingSettings, error: bookingSettingsError }] =
        await Promise.all([
        supabase.from("profiles").select("full_name,email").eq("user_id", userId).maybeSingle(),
        restaurant?.restaurantId
          ? supabase
              .from("ai_settings")
              .select("knowledge,assistant_name,web_search_enabled,site_url,google_maps_url,facebook_url,instagram_url")
              .eq("restaurant_id", restaurant.restaurantId)
              .maybeSingle()
          : Promise.resolve({ data: null, error: null }),
        restaurant?.restaurantId
          ? supabase
              .from("booking_public_settings")
              .select("hours,seating,notify_email,notify_enabled,require_manual_confirmation,knowledge_public")
              .eq("public_id", restaurant.restaurantId)
              .maybeSingle()
          : Promise.resolve({ data: null, error: null }),
      ]);

      aiLoadSucceededRef.current = !settingsError;
      bookingLoadSucceededRef.current = !bookingSettingsError;

      if (settingsError) {
        console.error("ai_settings load failed", settingsError.message);
      }
      if (bookingSettingsError) {
        console.error("booking_public_settings load failed", bookingSettingsError.message);
      }

      if (profile) {
        if (profile.full_name) setProfileName(profile.full_name);
        if (profile.email) setProfileEmail(profile.email);
      } else if (session.user.email) {
        setProfileEmail(session.user.email);
      }

      if (settings) {
        setConfig((prev) => ({
          ...prev,
          ai: {
            ...prev.ai,
            knowledge: settings.knowledge != null ? normalizeKnowledgeLabels(settings.knowledge) : prev.ai.knowledge,
            name: settings.assistant_name ?? prev.ai.name,
            webSearch: {
              enabled: settings.web_search_enabled ?? prev.ai.webSearch.enabled,
              siteUrl: settings.site_url ?? prev.ai.webSearch.siteUrl,
              googleMapsUrl: settings.google_maps_url ?? prev.ai.webSearch.googleMapsUrl,
              facebookUrl: settings.facebook_url ?? prev.ai.webSearch.facebookUrl,
              instagramUrl: settings.instagram_url ?? prev.ai.webSearch.instagramUrl,
            },
          },
        }));
      }

      if (bookingSettings) {
        const knowledgePublic = bookingSettings.knowledge_public ?? "";
        setConfig((prev) => ({
          ...prev,
          hours: normalizeHours(bookingSettings.hours ?? prev.hours),
          seating: {
            ...prev.seating,
            maxGuests: bookingSettings.seating?.maxGuests ?? prev.seating.maxGuests,
            maxBookingDurationMin: bookingSettings.seating?.maxBookingDurationMin ?? prev.seating.maxBookingDurationMin,
            groupThreshold: bookingSettings.seating?.groupThreshold ?? prev.seating.groupThreshold,
            maxTables: bookingSettings.seating?.maxTables ?? prev.seating.maxTables,
            highChairs: bookingSettings.seating?.highChairs ?? prev.seating.highChairs,
            mealRanges: normalizeMealRanges(bookingSettings.seating?.mealRanges ?? prev.seating.mealRanges),
            followUpEnabled: bookingSettings.seating?.followUpEnabled ?? prev.seating.followUpEnabled,
            followUpDelayDays: bookingSettings.seating?.followUpDelayDays ?? prev.seating.followUpDelayDays,
            followUpEmail: bookingSettings.seating?.followUpEmail ?? prev.seating.followUpEmail,
          },
          escalation: {
            ...prev.escalation,
            maxGuestsPerReservation: bookingSettings.seating?.maxGuestsPerReservation ?? prev.escalation.maxGuestsPerReservation,
          },
          info: {
            ...prev.info,
            email: bookingSettings.notify_email ?? prev.info.email,
          },
          notifications: {
            ...prev.notifications,
            to: bookingSettings.notify_email ?? prev.notifications.to,
            notifyOnNewBooking: bookingSettings.notify_enabled ?? prev.notifications.notifyOnNewBooking,
            requireManualConfirmation: bookingSettings.require_manual_confirmation ?? prev.notifications.requireManualConfirmation,
          },
          publicMessage: extractMultilineLabelValue(knowledgePublic, BOOKING_MESSAGE_LABEL),
          confirmationEmailMessageAuto: extractMultilineLabelValue(
            knowledgePublic,
            BOOKING_CONFIRMATION_EMAIL_AUTO_LABEL
          ),
          confirmationEmailMessageManual: extractMultilineLabelValue(
            knowledgePublic,
            BOOKING_CONFIRMATION_EMAIL_MANUAL_LABEL
          ),
        }));
      }

      setSettingsReady(true);
    };

    load();
  }, [session?.user?.id]);

  const seed: Booking[] = useMemo(() => {
    const base: Booking[] = [
      {
        id: uid(),
        date: "2025-09-05",
        time: "11:00",
        name: "Emma Larsson",
        guests: 2,
        note: true,
        notes: "Allergi: nötter (inga spår).",
      },
      { id: uid(), date: "2025-09-05", time: "11:30", name: "Klara Nyman", guests: 2 },
      { id: uid(), date: "2025-09-05", time: "12:00", name: "Sara Lind", guests: 3, note: true, notes: "Vegan + glutenfritt." },
      { id: uid(), date: "2025-09-05", time: "12:30", name: "Henrik Holm", guests: 6 },
      { id: uid(), date: "2025-09-05", time: "13:00", name: "Familjen Sjögren", guests: 4, note: true, notes: "Barnstol. Hörnbord om möjligt." },
      { id: uid(), date: "2025-09-05", time: "18:00", name: "Familjen Karlsson", guests: 8, note: true, notes: "Jordnöt – inga spår." },
    ];
    const durationMin = defaultSettings.seating.maxBookingDurationMin || 90;
    return base.map((b) => ({ ...b, durationMin }));
  }, [defaultSettings.seating.maxBookingDurationMin]);

  const [bookings, setBookings] = useState<Booking[]>(() =>
    assignTablesForDateWithTables(dateSel, seed, tableCaps, mealRanges)
  );
  const [editBookingDraft, setEditBookingDraft] = useState<Booking | null>(null);
  const [bookingsReady, setBookingsReady] = useState(false);
  const [newBookingCount, setNewBookingCount] = useState(0);
  const [newBookingDetail, setNewBookingDetail] = useState<string | null>(null);
  const [newBookingItems, setNewBookingItems] = useState<Array<{ id: string; date: string; time: string; guests: number; name: string }>>([]);
  const [showNewBookings, setShowNewBookings] = useState(false);
  const lastBookingIdsRef = useRef<Set<string>>(new Set());
  const bookingNoticeTimer = useRef<number | null>(null);

  const formatTimeShort = (t?: string | null) => {
    if (!t) return "";
    const parts = t.split(":");
    if (parts.length < 2) return t;
    return `${parts[0]}:${parts[1]}`;
  };

  useEffect(() => {
    setBookings((prev) => assignTablesForDateWithTables(dateSel, prev, tableCaps, mealRanges));
  }, [dateSel, tableCaps, mealRanges]);

  useEffect(() => {
    setBookings((prev) => {
      const updated = prev.map((b) => ({ ...b, durationMin: bookingDurationMin }));
      const dates = Array.from(new Set<string>(updated.map((b) => b.date)));
      let out: Booking[] = updated;
      for (const d of dates) out = assignTablesForDateWithTables(d, out, tableCaps, mealRanges);
      return out;
    });
  }, [bookingDurationMin, tableCaps, mealRanges]);

  const fetchBookings = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!restaurantId || !settingsReady) return;
      const token = session?.access_token || "";
      if (!token) return;
      const resp = await fetch(`/api/bookings?restaurantId=${encodeURIComponent(restaurantId)}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      });
      const payload = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        console.error("bookings load failed", payload?.error || `HTTP ${resp.status}`);
        setBookingsReady(true);
        return;
      }
      const rows = ((payload?.bookings ?? []) as BookingRow[]);
      const mapped = rows.map((r) => {
        const parsedMeta = parseBookingNotesMeta(r.notes ?? "");
        const tableIds = normalizeTableIds([...(parsedMeta.tableIds ?? []), r.table_id]);
        return {
        id: r.id,
        date: r.date,
        time: r.time,
        name: r.name,
        guests: r.guests,
        notes: parsedMeta.notes,
        note: !!parsedMeta.notes,
        tableId: tableIds[0] ?? null,
        tableIds: tableIds.length ? tableIds : null,
        durationMin: r.duration_min ?? bookingDurationMin,
        status: (r.status as BookingStatus) ?? "confirmed",
        source: (r.source as Booking["source"]) ?? "walkin",
        clientEmail: r.client_email ?? null,
        createdAt: r.created_at ?? undefined,
        };
      });

      const incomingIds = new Set(mapped.map((b) => b.id));
      if (lastBookingIdsRef.current.size) {
        const newOnes = mapped.filter((b) => !lastBookingIdsRef.current.has(b.id));
        if (newOnes.length && !opts?.silent) {
          setNewBookingCount((prev) => prev + newOnes.length);
          const sortedNewBookings = newOnes
            .slice()
            .sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
          const latest = sortedNewBookings[sortedNewBookings.length - 1];
          if (latest) {
            setNewBookingDetail(`Ny bokning: ${latest.date} · ${formatTimeShort(latest.time)} · ${latest.guests} gäster`);
            if (bookingNoticeTimer.current) window.clearTimeout(bookingNoticeTimer.current);
            bookingNoticeTimer.current = window.setTimeout(() => {
              setNewBookingDetail(null);
            }, 5000);
          }
          const items = newOnes.map((b) => ({
            id: b.id,
            date: b.date,
            time: formatTimeShort(b.time),
            guests: b.guests,
            name: b.name,
          }));
          setNewBookingItems((prev) => [...items, ...prev].slice(0, 10));
        }
      }
      lastBookingIdsRef.current = incomingIds;

      setBookings(assignTablesForDateWithTables(dateSel, mapped, tableCaps, mealRanges));
      setBookingsReady(true);
    },
    [restaurantId, settingsReady, session?.access_token, bookingDurationMin, dateSel, tableCaps, mealRanges]
  );

  useEffect(() => {
    fetchBookings();
  }, [fetchBookings]);

  useEffect(() => {
    if (!restaurantId || !settingsReady) return;
    const id = window.setInterval(() => {
      fetchBookings();
    }, 30000);
    return () => window.clearInterval(id);
  }, [restaurantId, settingsReady, fetchBookings]);

  useEffect(() => {
    if (!session?.user?.id || !settingsReady || !restaurantId) return;
    if (!aiLoadSucceededRef.current) return;
    if (aiInitialSyncSkipRef.current) {
      aiInitialSyncSkipRef.current = false;
      return;
    }
    if (!aiDirtyRef.current) return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);

    saveTimer.current = window.setTimeout(async () => {
      try {
        setAiSaveState("saving");
        setAiSaveMessage("");
        const token = session?.access_token || "";
        const resp = await fetch("/api/booking-settings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            restaurantId,
            knowledge: config.ai.knowledge,
            assistant_name: config.ai.name,
            web_search_enabled: config.ai.webSearch.enabled,
            site_url: config.ai.webSearch.siteUrl || null,
            google_maps_url: config.ai.webSearch.googleMapsUrl || null,
            facebook_url: config.ai.webSearch.facebookUrl || null,
            instagram_url: config.ai.webSearch.instagramUrl || null,
          }),
        });
        if (!resp.ok) {
          const data = await resp.json().catch(() => ({}));
          if (resp.status === 409 && data?.code === "PRIMARY_RESTAURANT_MISMATCH") {
            setPrimaryMismatchNotice("Inställningarna är låsta till din primära restaurang. Ladda om sidan för att synka rätt restaurang.");
          }
          const msg = data?.error || `Save failed (${resp.status})`;
          throw new Error(msg);
        }
        aiDirtyRef.current = false;
        setAiSaveState("saved");
        setAiSaveMessage("Sparad");
        setPrimaryMismatchNotice(null);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Save failed";
        setAiSaveState("error");
        setAiSaveMessage(msg);
      }
    }, 600);

    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    };
  }, [
    config.ai.knowledge,
    config.ai.name,
    config.ai.webSearch.enabled,
    config.ai.webSearch.siteUrl,
    config.ai.webSearch.googleMapsUrl,
    config.ai.webSearch.facebookUrl,
    config.ai.webSearch.instagramUrl,
    session?.user?.id,
    session?.access_token,
    settingsReady,
    restaurantId,
  ]);


  useEffect(() => {
    if (!session?.user?.id || !settingsReady || !restaurantId) return;
    if (!bookingLoadSucceededRef.current) return;
    if (bookingInitialSyncSkipRef.current) {
      bookingInitialSyncSkipRef.current = false;
      return;
    }
    if (!bookingDirtyRef.current) return;
    if (bookingSaveTimer.current) window.clearTimeout(bookingSaveTimer.current);
    bookingSaveTimer.current = window.setTimeout(async () => {
      try {
        const token = session?.access_token || "";
        const resp = await fetch("/api/booking-settings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            restaurantId,
            hours: config.hours,
            seating: {
              maxGuests: config.seating.maxGuests,
              maxGuestsPerReservation: config.escalation.maxGuestsPerReservation,
              groupThreshold: config.seating.groupThreshold,
              maxBookingDurationMin: config.seating.maxBookingDurationMin,
              maxTables: config.seating.maxTables,
              highChairs: config.seating.highChairs,
              mealRanges: config.seating.mealRanges,
            },
            notify_email: config.info.email || config.notifications.to || null,
            notify_enabled: config.notifications.notifyOnNewBooking,
            require_manual_confirmation: config.notifications.requireManualConfirmation,
            knowledge_public: buildPublicKnowledge(
              config.ai.knowledge,
              config.ai.webSearch,
              config.publicMessage,
              config.confirmationEmailMessageAuto,
              config.confirmationEmailMessageManual
            ),
          }),
        });
        if (!resp.ok) {
          const data = await resp.json().catch(() => ({}));
          if (resp.status === 409 && data?.code === "PRIMARY_RESTAURANT_MISMATCH") {
            setPrimaryMismatchNotice("Inställningarna är låsta till din primära restaurang. Ladda om sidan för att synka rätt restaurang.");
          }
          const msg = data?.error || `Save failed (${resp.status})`;
          console.error("booking_public_settings save failed", msg);
          setSettingsSaveError(msg);
          return;
        }
        bookingDirtyRef.current = false;
        setSettingsSaveError(null);
        setPrimaryMismatchNotice(null);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Save failed";
        console.error("booking_public_settings save failed", msg);
        setSettingsSaveError(msg);
      }
    }, 700);
    return () => {
      if (bookingSaveTimer.current) window.clearTimeout(bookingSaveTimer.current);
    };
  }, [
    config.hours,
    config.seating,
    config.escalation.maxGuestsPerReservation,
    config.info.email,
    config.notifications.to,
    config.notifications.notifyOnNewBooking,
    config.notifications.requireManualConfirmation,
    config.ai.knowledge,
    config.ai.webSearch.enabled,
    config.ai.webSearch.siteUrl,
    config.ai.webSearch.googleMapsUrl,
    config.ai.webSearch.facebookUrl,
    config.ai.webSearch.instagramUrl,
    config.publicMessage,
    config.confirmationEmailMessageAuto,
    config.confirmationEmailMessageManual,
    session?.access_token,
    restaurantId,
    settingsReady,
  ]);

  useEffect(() => {
    if (!session?.user?.id) return;
    if (profileTimer.current) window.clearTimeout(profileTimer.current);

    profileTimer.current = window.setTimeout(async () => {
      await supabase.from("profiles").upsert(
        {
          user_id: session.user.id,
          full_name: profileName || null,
          email: profileEmail || session.user.email || null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" }
      );
    }, 600);

    return () => {
      if (profileTimer.current) window.clearTimeout(profileTimer.current);
    };
  }, [profileName, profileEmail, session?.user?.id]);

  const ALL_TIMES = useMemo(() => {
    const mins = MEAL_KEYS.map((meal) => mealRanges[meal][0]).map(timeToMin);
    const maxs = MEAL_KEYS.map((meal) => mealRanges[meal][1]).map(timeToMin);
    const out: string[] = [];
    for (let s = Math.min(...mins), e = Math.max(...maxs); s <= e; s += ENGINE.slotStepMin) out.push(minToTime(s));
    return out;
  }, [mealRanges]);

  const activeBookings = useMemo(() => bookings.filter((b) => !isCancelledBooking(b)), [bookings]);
  const dayBookings = useMemo(() => bookings.filter((b) => b.date === dateSel), [bookings, dateSel]);
  const dayActiveBookings = useMemo(() => dayBookings.filter((b) => !isCancelledBooking(b)), [dayBookings]);
  const floorplanSeatCount = useMemo(() => tableCaps.reduce((sum, table) => sum + table.cap, 0), [tableCaps]);
  const maxActiveBookingGuests = useMemo(
    () => activeBookings.reduce((max, booking) => Math.max(max, Number(booking.guests) || 0), 0),
    [activeBookings]
  );
  const floorplanCapacityAlert = useMemo(() => {
    if (!settingsReady || !restaurantId || floorplanSeatCount <= 0) return null;

    const reasons: string[] = [];
    if (config.seating.maxGuests > floorplanSeatCount) {
      reasons.push(
        `Max gäster samtidigt är ${config.seating.maxGuests}, men tableplanen har bara ${floorplanSeatCount} platser.`
      );
    }
    if (maxActiveBookingGuests > floorplanSeatCount) {
      reasons.push(
        `En befintlig bokning har ${maxActiveBookingGuests} gäster, vilket är mer än tableplanens ${floorplanSeatCount} platser.`
      );
    }
    if (!reasons.length) return null;

    return {
      summary: reasons.join(" "),
      totalSeats: floorplanSeatCount,
    };
  }, [settingsReady, restaurantId, floorplanSeatCount, config.seating.maxGuests, maxActiveBookingGuests]);

  const bookingDates = useMemo(() => {
    const set = new Set<string>();
    bookings.forEach((b) => set.add(b.date));
    return set;
  }, [bookings]);

  const isClosedDate = (iso: string) => {
    const special = config.hours.special.find((s) => s.date === iso);
    if (special) return special.closed;
    const dt = new Date(iso + "T00:00:00Z");
    if (Number.isNaN(dt.getTime())) return false;
    const dayName = DAYS_SV[dt.getUTCDay()];
    const periods = config.hours.periods ?? [];
    const matches = periods.filter((p) => iso >= p.from && iso <= p.to);
    const period =
      matches.length > 0
        ? matches.sort((a, b) => {
            const spanA = Math.max(0, Math.floor((new Date(a.to).getTime() - new Date(a.from).getTime()) / 86400000));
            const spanB = Math.max(0, Math.floor((new Date(b.to).getTime() - new Date(b.from).getTime()) / 86400000));
            return spanA - spanB;
          })[0]
        : periods[periods.length - 1];
    const day = (period?.days ?? config.hours.normal)[dayName];
    return day?.closed ?? false;
  };

  const weekStats = useMemo(() => {
    const toISO = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    const startOfWeek = (d: Date) => {
      const copy = new Date(d);
      const day = (copy.getDay() + 6) % 7;
      copy.setDate(copy.getDate() - day);
      copy.setHours(0, 0, 0, 0);
      return copy;
    };
    const addDays = (d: Date, n: number) => {
      const c = new Date(d);
      c.setDate(c.getDate() + n);
      return c;
    };
    const start = startOfWeek(today);
    const end = addDays(start, 7);
    const prevStart = addDays(start, -7);
    const prevEnd = start;
    const inRange = (iso: string, a: Date, b: Date) => iso >= toISO(a) && iso < toISO(b);
    const curGuests = activeBookings.filter((b) => inRange(b.date, start, end)).reduce((s, b) => s + b.guests, 0);
    const prevGuests = activeBookings.filter((b) => inRange(b.date, prevStart, prevEnd)).reduce((s, b) => s + b.guests, 0);
    const diff = curGuests - prevGuests;
    const pct = prevGuests > 0 ? Math.round((diff / prevGuests) * 100) : null;
    return { curGuests, prevGuests, diff, pct };
  }, [activeBookings, today]);

  const filteredForDisplay = useMemo(() => {
    const [a, b] = mealRangeFor(activeMeal, mealRanges);
    const s = timeToMin(a),
      e = timeToMin(b);
    return dayBookings
      .filter((bk) => {
        const t = timeToMin(bk.time);
        return t >= s && t <= e;
      })
      .sort((x, y) => timeToMin(x.time) - timeToMin(y.time));
  }, [activeMeal, dayBookings, mealRanges]);

  const filteredActive = useMemo(
    () => filteredForDisplay.filter((b) => !isCancelledBooking(b)),
    [filteredForDisplay]
  );

  const groupedByTime = useMemo(() => {
    const g: Record<string, Booking[]> = {};
    for (const b of filteredForDisplay.map((x) => ({ ...x, time: round30(x.time) }))) {
      (g[b.time] ??= []).push(b);
    }
    return g;
  }, [filteredForDisplay]);

  const totalGuestsDay = useMemo(() => dayActiveBookings.reduce((s, b) => s + b.guests, 0), [dayActiveBookings]);

  const totals = useMemo(
    () => filteredActive.reduce((a, b) => ({ count: a.count + 1, guests: a.guests + b.guests }), { count: 0, guests: 0 }),
    [filteredActive]
  );

  const busiestLeast = useMemo(() => {
    const map = new Map<number, number>();
    dayActiveBookings.forEach((b) => {
      const h = Math.floor(timeToMin(b.time) / 60);
      map.set(h, (map.get(h) || 0) + 1);
    });
    if (!map.size) return { max: "–", min: "–" };
    let maxH = -1,
      maxV = -1,
      minH = -1,
      minV = 1e9;
    map.forEach((v, h) => {
      if (v > maxV) {
        maxV = v;
        maxH = h;
      }
      if (v < minV) {
        minV = v;
        minH = h;
      }
    });
    const hr = (h: number) => `${pad2(h)}:00 – ${pad2((h + 1) % 24)}:00`;
    return { max: hr(maxH), min: hr(minH) };
  }, [dayActiveBookings]);

  const guestsByMeal = useMemo(() => {
    const m: Record<Meal, number> = { Alla: 0, Frukost: 0, Lunch: 0, Fika: 0, Middag: 0 };
    dayActiveBookings.forEach((b) => {
      const mf = mealForWithRanges(b.time, mealRanges);
      if (mf !== "Alla") m[mf] += b.guests;
      m.Alla += b.guests;
    });
    return m;
  }, [dayActiveBookings, mealRanges]);

  const regularCustomerEmails = useMemo(() => {
    const counts = new Map<string, number>();
    activeBookings.forEach((b) => {
      const email = normalizeCustomerEmail(b.clientEmail);
      if (!email) return;
      counts.set(email, (counts.get(email) ?? 0) + 1);
    });
    return new Set(Array.from(counts.entries()).filter(([, count]) => count >= 2).map(([email]) => email));
  }, [activeBookings]);

  const regularCustomersToday = useMemo(() => {
    const emails = new Set<string>();
    dayActiveBookings.forEach((b) => {
      const email = normalizeCustomerEmail(b.clientEmail);
      if (email && regularCustomerEmails.has(email)) emails.add(email);
    });
    return emails.size;
  }, [dayActiveBookings, regularCustomerEmails]);

  const updateMealRange = (meal: MealKey, idx: 0 | 1, value: string) => {
    markBookingDirty();
    setConfig((prev) => {
      const ranges = normalizeMealRanges(prev.seating.mealRanges);
      const nextRange: [string, string] = [...ranges[meal]] as [string, string];
      nextRange[idx] = value;
      return {
        ...prev,
        seating: {
          ...prev.seating,
          mealRanges: {
            ...ranges,
            [meal]: nextRange,
          },
        },
      };
    });
  };

  // --- AI preview (MVP, deterministic)
  const [aiMsg, setAiMsg] = useState("");
  const [aiPreview, setAiPreview] = useState("");
  const [aiHistory, setAiHistory] = useState<{ role: "user" | "assistant"; content: string }[]>([]);
  const [showDrafts, setShowDrafts] = useState(false);
  const [newFaq, setNewFaq] = useState<string>("");
  const [faqSuccess, setFaqSuccess] = useState(false);
  const faqTimeoutRef = useRef<number | null>(null);
  const [faqDraftAnswers, setFaqDraftAnswers] = useState<Record<string, string>>({});
  const [testRunning, setTestRunning] = useState(false);
  const [testResults, setTestResults] = useState<{ q: string; reply: string; ok: boolean }[]>([]);
  const currentYear = new Date().getFullYear();
  const [holidayYear, setHolidayYear] = useState<number>(currentYear);
  const [onboardingDirty, setOnboardingDirty] = useState(false);
  const [onboarding, setOnboarding] = useState({
    restaurantName: "",
    address: "",
    distance: "",
    phone: "",
    email: "",
    payment: "",
    allergies: "",
    kidsChair: false,
    kidsMenu: false,
    kidsNote: "",
    wheelchair: false,
    outdoorSeating: false,
    dogFriendly: false,
    alcoholLicense: false,
    kitchenCloseMinutes: "",
    restaurantType: "",
    restaurantDescription: "",
    foodType: "",
    groupEvents: "",
    pets: "",
    parking: "",
    transport: "",
  });
  const [onboardingFaqs, setOnboardingFaqs] = useState<OnboardingFaq[]>([]);
  const [showTemplate, setShowTemplate] = useState(false);
  const onboardInitRef = useRef(false);

  const fetchRestaurantFromApi = async (token: string) => {
    const resp = await fetch("/api/restaurant", {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      throw new Error(data?.error || `Kunde inte hämta restaurang (${resp.status})`);
    }
    return data as { restaurantId: string | null; role?: string | null; name?: string | null };
  };

  const createRestaurantFromApi = async (token: string, name: string) => {
    const resp = await fetch("/api/restaurant", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      throw new Error(data?.error || `Kunde inte skapa restaurang (${resp.status})`);
    }
    return data as { restaurantId: string | null; role?: string | null; name?: string | null };
  };

  const commonFaqs = [
    "Har ni öppet på måndagar?",
    "Vilka är era öppettider per dag?",
    "Tar ni emot kontanter?",
    "Tar ni kort (Visa/Mastercard/Amex)?",
    "Tar ni Swish?",
    "Har ni veganska alternativ?",
    "Har ni glutenfria alternativ?",
    "Har ni laktosfria alternativ?",
    "Kan ni hantera allergier?",
    "Finns barnstolar?",
    "Finns barnmeny?",
    "Får man ta med hund?",
    "Har ni uteservering?",
    "Är lokalen rullstolsanpassad?",
    "Finns parkering i närheten?",
    "Hur tar man sig till er med kollektivtrafik?",
    "Hur länge är en bordsbokning?",
    "Kan man boka större sällskap?",
    "Vad är max antal gäster per bokning?",
    "Har ni take away?",
    "Serverar ni alkohol?",
    "Har ni alkoholtillstånd?",
    "Har ni lunchmeny?",
    "Kan man boka bord online?",
    "Vilken adress har ni?",
    "Hur kontaktar man er?",
  ];
  const extendedFaqs = [
    "Har ni brunch på helgerna?",
    "Kan vi boka ett fönsterbord?",
    "Finns det tystare bord för möten?",
    "Har ni barnvänliga rätter?",
    "Har ni en fast meny?",
    "Kan man få kvitto via e‑post?",
    "Finns det laddning för elbil i närheten?",
    "Är ni öppna på helgdagar?",
    "Har ni presentkort?",
    "Tar ni emot företagsevent?",
    "Kan man ändra eller avboka en bokning?",
    "Hur långt i förväg kan man boka?",
    "Är köket öppet hela öppettiden?",
    "Finns det allergivänliga alternativ?",
    "Kan vi ta med egen tårta?",
    "Har ni privat rum?",
  ];

  const addCoreFaqs = () => {
    commonFaqs.forEach((q) => addOnboardingFaq(q));
  };

  const knowledgeTemplate = useMemo(() => {
    const lines = [
      "INFOS:",
      "Namn: ...",
      "Typ av restaurang: ...",
      "Adress: ...",
      "Avstånd: ... (ex: 12 km från Göteborg)",
      "E-post: ...",
      "Telefon: ...",
      "Webbplats: ...",
      "Beskrivning / stämning: ...",
      "Mat & meny: ...",
      "Grupp & event: ...",
      "Betalning: ...",
      "Allergier: ...",
      "Barnstol: Ja/Nej",
      "Barnmeny: ...",
      "Uteservering: Ja/Nej",
      "Hundvänligt: Ja/Nej",
      "Rullstolsanpassad: Ja/Nej",
      "Alkoholtillstånd: Ja/Nej",
      "Köket stänger: ... min före stängning",
      "Max gäster per bokning: ... (vid X gäster eller fler, kontakta oss på ...)",
      "Djurpolicy: ...",
      "Parkering: ...",
      "Kollektivtrafik: ...",
      "",
      ...commonFaqs.flatMap((q) => [`FRÅGA: ${q}`, "SVAR: ...", ""]),
    ];
    return lines.join("\n").trim();
  }, []);

  const createOnboardingFaq = (q: string, a = ""): OnboardingFaq => ({ id: uid(), q, a });

  const addOnboardingFaq = (q: string) => {
    const trimmed = q.trim();
    if (!trimmed) return;
    setOnboardingFaqs((prev) => {
      if (prev.some((x) => x.q.toLowerCase() === trimmed.toLowerCase())) return prev;
      return [...prev, createOnboardingFaq(trimmed)];
    });
    setOnboardingDirty(true);
  };

  const generateCommonQuestion = () => {
    const existing = new Set(onboardingFaqs.map((x) => x.q.toLowerCase()));
    const common = new Set(commonFaqs.map((x) => x.toLowerCase()));
    const available = extendedFaqs.filter((q) => !existing.has(q.toLowerCase()) && !common.has(q.toLowerCase()));
    const pool = available.length ? available : extendedFaqs.filter((q) => !existing.has(q.toLowerCase()));
    const pick = pool.length ? pool[Math.floor(Math.random() * pool.length)] : extendedFaqs[Math.floor(Math.random() * extendedFaqs.length)];
    addOnboardingFaq(pick);
  };

  const buildKnowledge = (data: typeof onboarding, faqs: { q: string; a: string }[], webSearch: Settings["ai"]["webSearch"]) => {
    const web = webSearch?.enabled ? webSearch : null;
    const kidsMenuText = data.kidsNote?.trim() || "";
    const kidsChairLine = `Barnstol: ${data.kidsChair ? "Ja" : "Nej"}`;
    const kidsMenuLine = kidsMenuText ? `Barnmeny: ${kidsMenuText}` : `Barnmeny: ${data.kidsMenu ? "Ja" : "Nej"}`;
    const kitchenCloseLine = data.kitchenCloseMinutes
      ? `Köket stänger: ${data.kitchenCloseMinutes} min före stängning`
      : "";
    const contactEmail = config.info.email || config.notifications.to || "";
    const maxPer = config.escalation.maxGuestsPerReservation;
    const groupLine =
      contactEmail && maxPer > 0
        ? `Max gäster per bokning: ${maxPer}. Vid ${maxPer} gäster eller fler, kontakta oss på ${contactEmail}.`
        : "";
    const lines = [
      "INFOS:",
      data.restaurantName ? `Namn: ${data.restaurantName}` : "",
      data.restaurantType ? `Typ av restaurang: ${data.restaurantType}` : "",
      data.address ? `Adress: ${data.address}` : "",
      data.distance ? `Avstånd: ${data.distance}` : "",
      data.email ? `E-post: ${data.email}` : "",
      data.phone ? `Telefon: ${data.phone}` : "",
      web?.siteUrl ? `Webbplats: ${web.siteUrl}` : "",
      web?.googleMapsUrl ? `Google Maps: ${web.googleMapsUrl}` : "",
      web?.facebookUrl ? `Facebook: ${web.facebookUrl}` : "",
      web?.instagramUrl ? `Instagram: ${web.instagramUrl}` : "",
      data.restaurantDescription ? `Beskrivning: ${data.restaurantDescription}` : "",
      data.foodType ? `Mat: ${data.foodType}` : "",
      data.groupEvents ? `Grupp & event: ${data.groupEvents}` : "",
      data.payment ? `Betalning: ${data.payment}` : "",
      data.allergies ? `Allergier: ${data.allergies}` : "",
      kidsChairLine,
      kidsMenuLine,
      data.outdoorSeating ? "Uteservering: Ja" : "Uteservering: Nej",
      data.dogFriendly ? "Hundvänligt: Ja" : "Hundvänligt: Nej",
      data.wheelchair ? "Rullstolsanpassad: Ja" : "Rullstolsanpassad: Nej",
      data.alcoholLicense ? "Alkoholtillstånd: Ja" : "Alkoholtillstånd: Nej",
      kitchenCloseLine,
      groupLine,
      data.pets ? `Djurpolicy: ${data.pets}` : "",
      data.parking ? `Parkering: ${data.parking}` : "",
      data.transport ? `Kollektivtrafik: ${data.transport}` : "",
      "",
    ].filter((x) => x !== "");
    const qa = faqs.flatMap((f) => [`FRÅGA: ${f.q}`, `SVAR: ${f.a || ""}`, ""]);
    return [...lines, ...qa].join("\n").trim();
  };

  const buildPublicKnowledge = (
    base: string,
    webSearch: Settings["ai"]["webSearch"],
    publicMessage?: string,
    confirmationEmailMessageAuto?: string,
    confirmationEmailMessageManual?: string
  ) => {
    const normalized = normalizeKnowledgeLabels(base || "");
    let lines = normalized.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    lines = dedupeKnowledgeLines(lines);
    const getLabelValue = (label: string) => {
      const line = lines.find((l) => l.toLowerCase().startsWith(label.toLowerCase() + ":"));
      if (!line) return "";
      return line.split(":").slice(1).join(":").trim();
    };
    const hasValue = (label: string) => Boolean(getLabelValue(label));
    const append = (label: string, value?: string) => {
      if (!value || hasValue(label)) return;
      lines.push(`${label}: ${value}`);
    };
    const appendMultiline = (label: string, value?: string) => {
      const trimmed = value?.trim();
      if (!trimmed) return;
      const parts = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (!parts.length) return;
      lines.push(`${label}: ${parts[0]}`);
      for (const part of parts.slice(1)) {
        lines.push(part);
      }
    };
    const stripLabelBlock = (input: string[], label: string) => {
      const labelLower = label.toLowerCase();
      const out: string[] = [];
      let skipping = false;
      for (const line of input) {
        const lower = line.toLowerCase();
        if (!skipping && lower.startsWith(labelLower + ":")) {
          skipping = true;
          continue;
        }
        if (skipping) {
          if (
            lower === "infos:" ||
            lower.startsWith("fråga:") ||
            lower.startsWith("svar:") ||
            KNOWLEDGE_LABELS.some((l) => lower.startsWith(`${l.toLowerCase()}:`))
          ) {
            skipping = false;
            out.push(line);
          }
          continue;
        }
        out.push(line);
      }
      return out;
    };
    if (webSearch?.enabled) {
      append("Webbplats", webSearch.siteUrl || "");
      append("Google Maps", webSearch.googleMapsUrl || "");
      append("Facebook", webSearch.facebookUrl || "");
      append("Instagram", webSearch.instagramUrl || "");
    }
    const contactEmail = config.info.email || config.notifications.to || "";
    const maxPer = config.escalation.maxGuestsPerReservation;
    if (contactEmail && maxPer > 0) {
      append(
        "Max gäster per bokning",
        `Vid ${maxPer} gäster eller fler, kontakta oss på ${contactEmail}.`
      );
    }
    const resolvedMessage = (publicMessage ?? "").trim();
    const resolvedAutoEmailMessage = (confirmationEmailMessageAuto ?? "").trim();
    const resolvedManualEmailMessage = (confirmationEmailMessageManual ?? "").trim();
    lines = stripLabelBlock(lines, BOOKING_MESSAGE_LABEL);
    lines = stripLabelBlock(lines, BOOKING_CONFIRMATION_EMAIL_AUTO_LABEL);
    lines = stripLabelBlock(lines, BOOKING_CONFIRMATION_EMAIL_MANUAL_LABEL);
    if (resolvedMessage) {
      appendMultiline(BOOKING_MESSAGE_LABEL, resolvedMessage);
    }
    if (resolvedAutoEmailMessage) {
      appendMultiline(BOOKING_CONFIRMATION_EMAIL_AUTO_LABEL, resolvedAutoEmailMessage);
    }
    if (resolvedManualEmailMessage) {
      appendMultiline(BOOKING_CONFIRMATION_EMAIL_MANUAL_LABEL, resolvedManualEmailMessage);
    }
    lines = dedupeKnowledgeLines(lines);
    return lines.filter(Boolean).join("\n").trim();
  };

  useEffect(() => {
    if (!onboardingDirty) return;
    markSettingsDirty();
    const next = buildKnowledge(onboarding, onboardingFaqs, config.ai.webSearch);
    setConfig((prev) => ({ ...prev, ai: { ...prev.ai, knowledge: next } }));
  }, [
    onboarding,
    onboardingFaqs,
    onboardingDirty,
    config.ai.webSearch.enabled,
    config.ai.webSearch.siteUrl,
    config.ai.webSearch.googleMapsUrl,
    config.ai.webSearch.facebookUrl,
    config.ai.webSearch.instagramUrl,
    config.escalation.maxGuestsPerReservation,
    config.info.email,
    config.notifications.to,
  ]);

  useEffect(() => {
    if (onboardingDirty) return;
    if (onboardInitRef.current) return;
    const k = normalizeKnowledgeLabels(config.ai.knowledge || "");
    if (!k.trim()) return;
    const lines = k.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const data = { ...onboarding };
    const labels = KNOWLEDGE_LABELS;
    const fieldMap: Record<string, string> = {};
    let current: string | null = null;
    for (const rawLine of k.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) {
        if (current && fieldMap[current]) fieldMap[current] += "\n";
        continue;
      }
      const lower = line.toLowerCase();
      if (lower === "infos:" || lower.startsWith("fråga:") || lower.startsWith("svar:")) {
        current = null;
        continue;
      }
      const match = labels.find((label) => lower.startsWith(label.toLowerCase() + ":"));
      if (match) {
        current = match;
        fieldMap[match] = line.split(":").slice(1).join(":").trim();
        continue;
      }
      if (current) {
        fieldMap[current] = fieldMap[current] ? `${fieldMap[current]}\n${line}` : line;
      }
    }
    const mapField = (label: string) => fieldMap[label] ?? "";
    data.restaurantName = mapField("Namn");
    data.address = mapField("Adress");
    data.distance = mapField("Avstånd") || mapField("Distance");
    data.phone = mapField("Telefon");
    data.email = mapField("E-post");
    data.restaurantType = mapField("Typ av restaurang");
    data.restaurantDescription = mapField("Beskrivning") || mapField("Stämning");
    data.foodType = mapField("Mat") || mapField("Mat & meny");
    data.groupEvents = mapField("Grupp & event");
    data.payment = mapField("Betalning");
    data.allergies = mapField("Allergier");
    data.kitchenCloseMinutes = mapField("Köket stänger").match(/\d+/)?.[0] || "";
    const barnLine = mapField("Barn");
    const barnstolField = mapField("Barnstol");
    const barnmenyField = mapField("Barnmeny");
    const barnTokens = barnLine
      .split(/[,;]+/)
      .map((t) => t.trim())
      .filter(Boolean);
    const hasBarnstol = /^(ja|yes|true)$/i.test(barnstolField) || /barnstol/i.test(barnLine);
    const barnmenyMatch = barnLine.match(/barnmeny\s*:\s*([^,;]+)/i);
    const barnmenyText = barnmenyField && !/^(ja|nej|yes|no|true|false)$/i.test(barnmenyField)
      ? barnmenyField
      : (barnmenyMatch ? barnmenyMatch[1].trim() : "");
    const hasBarnmeny = /^(ja|yes|true)$/i.test(barnmenyField) || /barnmeny/i.test(barnLine) || !!barnmenyText;
    data.kidsChair = hasBarnstol;
    data.kidsMenu = hasBarnmeny;
    data.kidsNote = barnmenyText || barnTokens.filter((t) => !/barnstol|barnmeny/i.test(t)).join(", ");
    data.outdoorSeating = /^(ja|yes|true)$/i.test(mapField("Uteservering"));
    data.dogFriendly = /^(ja|yes|true)$/i.test(mapField("Hundvänligt"));
    data.wheelchair = /^(ja|yes|true)$/i.test(mapField("Rullstolsanpassad"));
    data.alcoholLicense = /^(ja|yes|true)$/i.test(mapField("Alkoholtillstånd"));
    data.pets = mapField("Djurpolicy");
    data.parking = mapField("Parkering");
    data.transport = mapField("Kollektivtrafik");

    const faqs: OnboardingFaq[] = [];
    let curQ: string | null = null;
    for (const l of lines) {
      if (l.toLowerCase().startsWith("fråga:")) {
        curQ = l.slice(6).trim();
        continue;
      }
      if (l.toLowerCase().startsWith("svar:") && curQ) {
        const ans = l.slice(5).trim();
        faqs.push(createOnboardingFaq(curQ, ans));
        curQ = null;
      }
    }
    setOnboarding(data);
    setOnboardingFaqs(faqs);
    setFaqDraftAnswers({});
    onboardInitRef.current = true;
    if (!/barnstol:/i.test(k) || !/barnmeny:/i.test(k)) {
      setOnboardingDirty(true);
    }
  }, [config.ai.knowledge, onboardingDirty]);

  const knowledgeScore = useMemo(() => {
    const k = (config.ai.knowledge || "").toLowerCase();
    const anyOpenDay = (config.hours.periods?.length
      ? config.hours.periods.some((p) => DAYS_ORDER.some((d) => !p.days[d].closed))
      : DAYS_ORDER.some((d) => !config.hours.normal[d].closed));
    const checks = [
      { key: "Öppettider", ok: anyOpenDay },
      { key: "Adress", ok: /adress/.test(k) },
      { key: "Telefon", ok: /telefon|tel|phone/.test(k) },
      { key: "E-post", ok: /e-post|email|mail/.test(k) },
      { key: "Bordsbokningstid", ok: config.seating.maxBookingDurationMin > 0 },
      { key: "Max gäster", ok: config.seating.maxGuests > 0 },
      { key: "Betalning", ok: /betala|kort|kontant|swish|visa|mastercard|amex/.test(k) },
      { key: "Allergier", ok: /allergi|gluten|laktos|nöt/.test(k) },
      { key: "Barn", ok: /barnstol|barnvagn|barnmeny|barn/.test(k) },
      { key: "Djurpolicy", ok: /hund|djur|terrass/.test(k) },
      { key: "Uteservering", ok: /uteservering/.test(k) },
      { key: "Rullstol", ok: /rullstol/.test(k) },
      { key: "Alkohol", ok: /alkohol/.test(k) },
      { key: "Kök stänger", ok: /kök\s*stänger/.test(k) },
      { key: "Restaurangtyp", ok: /typ\s+av\s+restaurang/.test(k) },
      { key: "Mat", ok: /mat:|serverar/.test(k) },
      { key: "Stämning", ok: /beskrivning|stämning/.test(k) },
      { key: "Parkering", ok: /parkering/.test(k) },
      { key: "Kollektivtrafik", ok: /kollektivtrafik|buss|tunnelbana|tram|spårvagn/.test(k) },
    ];
    const ok = checks.filter((c) => c.ok).length;
    const score = Math.round((ok / checks.length) * 100);
    const missing = checks.filter((c) => !c.ok).map((c) => c.key);
    return { score, missing };
  }, [config.ai.knowledge, config.hours, config.seating]);

  const savedFaqs = useMemo(
    () => onboardingFaqs.filter((f) => f.a?.trim() && faqDraftAnswers[f.id] == null),
    [onboardingFaqs, faqDraftAnswers]
  );

  const draftFaqs = useMemo(
    () => onboardingFaqs.filter((f) => !f.a?.trim() || faqDraftAnswers[f.id] != null),
    [onboardingFaqs, faqDraftAnswers]
  );

  const callAi = async (text: string) => {
    const r = await fetch("/api/ai", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
      },
      body: JSON.stringify({
        message: text,
        knowledge: buildPublicKnowledge(config.ai?.knowledge ?? "", config.ai.webSearch, config.publicMessage),
        history: aiHistory,
        context: {
          baseDate: dateSel,
          nowTime: `${pad2(new Date().getHours())}:${pad2(new Date().getMinutes())}`,
          restaurant: {
            name: onboarding.restaurantName || restaurantName || "",
            address: onboarding.address || "",
            email: onboarding.email || config.info.email || config.notifications.to || "",
            website: config.ai.webSearch.siteUrl || "",
            facebook: config.ai.webSearch.facebookUrl || "",
            instagram: config.ai.webSearch.instagramUrl || "",
            googleMaps: config.ai.webSearch.googleMapsUrl || "",
          },
          seating: {
            maxGuests: config.seating.maxGuests,
            maxGuestsPerReservation: config.escalation.maxGuestsPerReservation,
            groupThreshold: config.seating.groupThreshold,
            maxBookingDurationMin: config.seating.maxBookingDurationMin,
          },
          hours: {
            normal: config.hours.normal,
            special: config.hours.special,
            periods: config.hours.periods,
          },
          tables: tableCaps.map((t) => t.cap),
          bookings: dayBookings.map((b) => ({
            date: b.date,
            time: b.time,
            guests: b.guests,
            durationMin: b.durationMin,
            tableId: b.tableId ?? null,
          })),
        },
      }),
    });
    const raw = await r.text();
    let data: { reply?: string; error?: string } = {};
    try {
      data = raw ? (JSON.parse(raw) as { reply?: string; error?: string }) : {};
    } catch {
      data = {};
    }
    if (!r.ok) {
      throw new Error(data?.error || raw || "AI error");
    }
    return data.reply || "Inget svar.";
  };

  const runAiTests = async () => {
    const prompts = [
      "öppet måndag?",
      "Har ni öppet på Måndag?",
      "Öppettider?",
      "Vegan?",
      "Har ni veganska alternativ?",
      "Glutenfritt?",
      "Laktosfritt?",
      "Parkering?",
      "Tar ni Swish?",
      "Tar ni kontanter?",
      "Tar ni kort?",
      "Finns barnstolar?",
      "Barnvagn?",
      "Hundar tillåtna?",
      "Hur länge är en bordsbokning?",
      "Boka bord för 4 imorgon kl 19",
      "Boka bord för 12 på fredag kl 18",
      "Var ligger ni?",
      "Vad heter ägaren till OpenAI?",
    ];
    setTestRunning(true);
    setTestResults([]);
    const out: { q: string; reply: string; ok: boolean }[] = [];
    for (const q of prompts) {
      try {
        const reply = await callAi(q);
        const ok =
          !/Jag kan tyvärr bara svara på frågor om restaurangen\./i.test(reply) &&
          !/Jag kan tyvärr inte svara säkert/i.test(reply) &&
          !/Fel vid AI-anrop\./i.test(reply);
        out.push({ q, reply, ok });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "AI error";
        out.push({ q, reply: `Fel vid AI-anrop. ${msg}`.trim(), ok: false });
      }
    }
    setTestResults(out);
    setTestRunning(false);
  };

  const addFaq = () => {
    const q = newFaq.trim();
    if (!q) return;
    markSettingsDirty();
    addOnboardingFaq(q);

    setNewFaq("");
    if (faqTimeoutRef.current) window.clearTimeout(faqTimeoutRef.current);
    setFaqSuccess(true);
    faqTimeoutRef.current = window.setTimeout(() => {
      setFaqSuccess(false);
    }, 1000);
  };

  const getFaqInputValue = (faqId: string, committedAnswer: string) => {
    return faqDraftAnswers[faqId] ?? committedAnswer;
  };

  const hasFaqPendingChanges = (faqId: string, committedAnswer: string) => {
    const draftAnswer = faqDraftAnswers[faqId];
    if (draftAnswer == null) return false;
    return draftAnswer.trim() !== committedAnswer;
  };

  const updateFaqDraftAnswer = (faqId: string, value: string) => {
    setFaqDraftAnswers((prev) => ({ ...prev, [faqId]: value }));
  };

  const clearFaqDraftAnswer = (faqId: string) => {
    setFaqDraftAnswers((prev) => {
      if (!(faqId in prev)) return prev;
      const { [faqId]: _removed, ...rest } = prev;
      return rest;
    });
  };

  const removeFaq = (faqId: string) => {
    markSettingsDirty();
    setOnboardingFaqs((prev) => prev.filter((x) => x.id !== faqId));
    clearFaqDraftAnswer(faqId);
    setOnboardingDirty(true);
  };

  const commitFaqAnswer = (faqId: string, committedAnswer: string) => {
    const nextAnswer = (faqDraftAnswers[faqId] ?? committedAnswer).trim();
    if (nextAnswer === committedAnswer) {
      clearFaqDraftAnswer(faqId);
      return;
    }
    markSettingsDirty();
    setOnboardingFaqs((prev) => prev.map((x) => (x.id === faqId ? { ...x, a: nextAnswer } : x)));
    clearFaqDraftAnswer(faqId);
    setOnboardingDirty(true);
  };

  function isBookingIntent(txt: string) {
    const t = txt.toLowerCase();
    return /(boka|booking|reservation|reservera|bord|table)/.test(t) || /\b\d{1,2}[:\.h]\d{2}\b/.test(t) || /\b\d{1,2}\s*(gäster|guests|personer|pers)\b/.test(t);
  }

  function extractGuests(txt: string) {
    const nums = (txt.match(/\d+/g) || []).map(Number).filter((n) => n > 0 && n < 500);
    return nums.length ? Math.max(...nums) : null;
  }

  function aiRespond(text: string) {
    if (!isBookingIntent(text)) return config.ai.outOfScopeReply.replace("{email}", config.notifications.to);
    const guests = extractGuests(text) ?? 2;
    if (config.escalation.maxGuestsPerReservation > 0 && guests >= config.escalation.maxGuestsPerReservation) {
      const contactEmail = config.info.email || config.notifications.to || "";
      return `För ${guests} gäster behöver ni kontakta oss direkt${contactEmail ? ` på ${contactEmail}` : ""}.`;
    }

    const tableId = findAvailableTable({
      date: dateSel,
      time: "12:00",
      guests,
      bookings,
      durationMin: bookingDurationMin,
      tables: tableCaps,
      mealRanges,
    });
    const can = tableId != null;
    return can
      ? `Ja, det finns plats. Jag kan boka för ${guests} gäster. (Förslag: ${dateSel} kl 12:00.)`
      : `Jag hittar tyvärr inget ledigt bord i den tidsperioden. Vill du ha väntelista eller annan tid?`;
  }

  // --- create booking modal
  const [formDate, setFormDate] = useState<string>(dateSel);
  const [formTime, setFormTime] = useState<string>("12:00");
  const [formName, setFormName] = useState<string>("");
  const [formGuestsInput, setFormGuestsInput] = useState<string>("2");
  const [formNotes, setFormNotes] = useState<string>("");
  const [formTableId, setFormTableId] = useState<number | null>(null);
  const [formTableIdSecondary, setFormTableIdSecondary] = useState<number | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (createOpen) {
      setFormDate(dateSel);
      setFormTime("12:00");
      setFormName("");
      setFormGuestsInput("2");
      setFormNotes("");
      setFormTableId(null);
      setFormTableIdSecondary(null);
      setFormError(null);
    }
  }, [createOpen, dateSel]);

  function createReservation(d: {
    date: string;
    time: string;
    name: string;
    guests: number;
    notes?: string;
    tableIds?: number[] | null;
  }) {
    if (!d.name.trim()) return { ok: false, error: "Namn krävs." };
    if (!d.date) return { ok: false, error: "Datum krävs." };
    if (!d.time) return { ok: false, error: "Tid krävs." };
    if (d.guests < 1) return { ok: false, error: "Ogiltigt antal gäster." };

    const when = round30(d.time);
    const durationMin = bookingDurationMin;
    const requestedTableIds = normalizeTableIds(d.tableIds ?? []);
    const draftId = `draft-${uid()}`;
    const draftBooking: Booking = {
      id: draftId,
      date: d.date,
      time: when,
      name: d.name.trim(),
      guests: d.guests,
      notes: d.notes,
      note: !!d.notes,
      tableId: requestedTableIds[0] ?? null,
      tableIds: requestedTableIds.length ? requestedTableIds : null,
      durationMin,
      status: "confirmed",
      source: "walkin",
    };

    const simulated = assignTablesForDateWithTables(d.date, [...bookings, draftBooking], tableCaps, mealRanges);
    const simulatedDraft = simulated.find((b) => b.id === draftId);
    const assignedTableIds = simulatedDraft ? bookingAssignedTableIds(simulatedDraft) : [];
    const tableId = assignedTableIds[0] ?? null;
    if (requestedTableIds.length && !sameTableSelection(assignedTableIds, requestedTableIds)) {
      return { ok: false, error: "Valda bord är upptagna eller saknar tillräcklig gruppkapacitet vid den tiden." };
    }

    const b: Booking = {
      id: uid(),
      date: d.date,
      time: when,
      name: d.name.trim(),
      guests: d.guests,
      notes: d.notes,
      note: !!d.notes,
      tableId,
      tableIds: assignedTableIds.length ? assignedTableIds : null,
      durationMin,
      status: "confirmed",
      source: "web",
    };
    if (restaurantId && settingsReady) {
      (async () => {
        const persistedNotes = buildBookingNotesWithMeta(b.notes, bookingAssignedTableIds(b));
        const { data } = await supabase
          .from("bookings")
          .insert({
            restaurant_id: restaurantId,
            date: b.date,
            time: b.time,
            name: b.name,
            guests: b.guests,
            notes: persistedNotes,
            table_id: b.tableId ?? null,
            duration_min: b.durationMin ?? bookingDurationMin,
            status: b.status ?? "confirmed",
            source: b.source ?? "walkin",
          })
          .select("id")
          .single();
        if (data?.id) {
          setBookings((prev) =>
            assignTablesForDateWithTables(
              d.date,
              prev.map((x) => (x.id === b.id ? { ...x, id: data.id } : x)),
              tableCaps,
              mealRanges
            )
          );
        }
      })().catch(() => {});
    }

    setBookings((prev) => assignTablesForDateWithTables(d.date, [...prev, b], tableCaps, mealRanges));
    return { ok: true };
  }

  const handleCreate = () => {
    const parsedGuests = formGuestsInput.trim() === "" ? 0 : Number(formGuestsInput);
    const guests = Number.isFinite(parsedGuests) ? Math.floor(parsedGuests) : 0;
    const res = createReservation({
      date: formDate,
      time: formTime,
      name: formName,
      guests,
      notes: formNotes,
      tableIds: normalizeTableIds([formTableId, formTableIdSecondary]),
    });
    if (!res.ok) {
      setFormError(res.error || "Kunde inte spara.");
      return;
    }
    setFormError(null);

    const d = new Date(formDate);
    if (!Number.isNaN(d.getTime())) {
      setYear(d.getFullYear());
      setMonth(d.getMonth());
      setSelectedDay(d.getDate());
    }

    setCreateOpen(false);
  };

  const upsertSpecialByDate = (date: string, patch: Partial<{ closed: boolean; open: string; close: string }>) => {
    markBookingDirty();
    setConfig((prev) => {
      const arr = prev.hours.special.slice();
      const idx = arr.findIndex((s) => s.date === date);
      if (idx === -1) arr.push({ date, closed: true, open: "11:00", close: "17:00", ...patch });
      else arr[idx] = { ...arr[idx], ...patch } as any;
      return { ...prev, hours: { ...prev.hours, special: arr } };
    });
  };

  const addHoursPeriod = () => {
    markBookingDirty();
    setConfig((prev) => {
      const baseDays = prev.hours.periods?.[0]?.days ?? prev.hours.normal;
      const next = [...(prev.hours.periods ?? []), makeHoursPeriod(baseDays, undefined, undefined, `Period ${prev.hours.periods.length + 1}`)];
      return { ...prev, hours: { ...prev.hours, periods: next } };
    });
  };

  const removeHoursPeriod = (id: string) => {
    markBookingDirty();
    setConfig((prev) => {
      const next = (prev.hours.periods ?? []).filter((p) => p.id !== id);
      if (!next.length) return prev;
      return { ...prev, hours: { ...prev.hours, periods: next } };
    });
  };
  // --- Custom closures (manual dates / periods)
  const [customClosureFrom, setCustomClosureFrom] = useState<string>("");
  const [customClosureTo, setCustomClosureTo] = useState<string>("");
  const [editingClosedRange, setEditingClosedRange] = useState<{ from: string; to: string } | null>(null);

  const addDaysISO = (iso: string, add: number) => {
    const d = new Date(iso + "T00:00:00");
    d.setDate(d.getDate() + add);
    const y = d.getFullYear();
    const m = pad2(d.getMonth() + 1);
    const day = pad2(d.getDate());
    return `${y}-${m}-${day}`;
  };

  const addCustomClosures = () => {
    if (!customClosureFrom || !customClosureTo) return;
    const start = new Date(customClosureFrom + "T00:00:00").getTime();
    const end = new Date(customClosureTo + "T00:00:00").getTime();
    if (Number.isNaN(start) || Number.isNaN(end) || start > end) return;

    markBookingDirty();
    setConfig((prev) => {
      const toDate = (iso: string) => new Date(iso + "T00:00:00");
      const rangeToReplace = editingClosedRange
        ? {
            start: toDate(editingClosedRange.from),
            end: toDate(editingClosedRange.to),
          }
        : null;

      const filtered = prev.hours.special.filter((specialDay) => {
        if (!specialDay.closed || !rangeToReplace) return true;
        const day = toDate(specialDay.date);
        return day < rangeToReplace.start || day > rangeToReplace.end;
      });

      const byDate = new Map<string, SpecialDay>(filtered.map((specialDay) => [specialDay.date, specialDay]));
      let cur = customClosureFrom;
      while (new Date(cur + "T00:00:00").getTime() <= end) {
        const existing = byDate.get(cur);
        if (existing) {
          byDate.set(cur, { ...existing, closed: true });
        } else {
          byDate.set(cur, { date: cur, closed: true, open: "11:00", close: "17:00" });
        }
        cur = addDaysISO(cur, 1);
      }

      const nextSpecial = Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
      return { ...prev, hours: { ...prev.hours, special: nextSpecial } };
    });

    setEditingClosedRange(null);
    setCustomClosureFrom("");
    setCustomClosureTo("");
  };

  // --- Calendar cells
  const monthDays = useMemo(() => new Date(year, month + 1, 0).getDate(), [year, month]);
  const selectedSafe = Math.min(selectedDay, monthDays);

  const calendarCells = useMemo(() => {
    const off = (new Date(year, month, 1).getDay() + 6) % 7; // Monday=0
    const blanks = Array.from({ length: off }, (_, i) => ({ key: `b-${i}`, day: null as number | null }));
    const days = Array.from({ length: monthDays }, (_, i) => ({ key: `d-${i + 1}`, day: i + 1 }));
    return [...blanks, ...days];
  }, [year, month, monthDays]);

  const closedRanges = useMemo(() => {
    const dates = config.hours.special
      .filter((s) => s.closed)
      .map((s) => s.date)
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
    if (!dates.length) return [] as { from: string; to: string; count: number }[];
    const out: { from: string; to: string; count: number }[] = [];
    let start = dates[0];
    let prev = dates[0];
    let count = 1;
    const toDate = (iso: string) => new Date(iso + "T00:00:00Z");
    const nextDay = (iso: string) => {
      const d = toDate(iso);
      d.setUTCDate(d.getUTCDate() + 1);
      return d.toISOString().slice(0, 10);
    };
    for (let i = 1; i < dates.length; i++) {
      const d = dates[i];
      if (d === nextDay(prev)) {
        prev = d;
        count += 1;
      } else {
        out.push({ from: start, to: prev, count });
        start = d;
        prev = d;
        count = 1;
      }
    }
    out.push({ from: start, to: prev, count });
    return out;
  }, [config.hours.special]);

  const removeClosedRange = (from: string, to: string) => {
    markBookingDirty();
    if (editingClosedRange?.from === from && editingClosedRange?.to === to) {
      setEditingClosedRange(null);
      setCustomClosureFrom("");
      setCustomClosureTo("");
    }
    setConfig((prev) => {
      const toDate = (iso: string) => new Date(iso + "T00:00:00");
      const start = toDate(from);
      const end = toDate(to);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return prev;
      const keep = prev.hours.special.filter((s) => {
        if (!s.closed) return true;
        const d = toDate(s.date);
        return d < start || d > end;
      });
      return { ...prev, hours: { ...prev.hours, special: keep } };
    });
  };

  const beginClosedRangeEdit = (from: string, to: string) => {
    setCustomClosureFrom(from);
    setCustomClosureTo(to);
    setEditingClosedRange({ from, to });
  };

  const cancelClosedRangeEdit = () => {
    setEditingClosedRange(null);
    setCustomClosureFrom("");
    setCustomClosureTo("");
  };

  const handleMagicLink = async () => {
    const email = authEmail.trim();
    if (!email) return;
    setAuthLoading(true);
    setAuthMsg(null);
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/dashboard` },
    });
    setAuthLoading(false);
    setAuthMsg(
      error
        ? `Inloggning misslyckades: ${error.message}`
        : "Länk skickad! Kolla din e‑post och klicka på länken för att logga in."
    );
  };

  const handlePasswordLogin = async () => {
    const email = authEmail.trim();
    const password = authPassword;
    if (!email || !password) return;
    setAuthLoading(true);
    setAuthMsg(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setAuthLoading(false);
    setAuthMsg(error ? `Inloggning misslyckades: ${error.message}` : null);
  };

  const handleGoogleLogin = async () => {
    setAuthLoading(true);
    setAuthMsg(null);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/dashboard`,
        queryParams: { prompt: "select_account" },
      },
    });
    if (error) {
      setAuthLoading(false);
      setAuthMsg(`Inloggning misslyckades: ${error.message}`);
    }
  };

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const email = params.get("email");
    if (email) setAuthEmail(email);
  }, [location.search]);

  const handleLogout = async () => {
    await supabase.auth.signOut({ scope: "global" });
  };

  const handleChangePassword = async () => {
    const nextPassword = passwordChangeValue;
    const confirmPassword = passwordConfirmValue;

    if (!nextPassword.trim() || !confirmPassword.trim()) {
      setPasswordChangeMsg({ type: "error", text: "Fyll i båda lösenordsfälten." });
      return;
    }

    if (nextPassword.length < 8) {
      setPasswordChangeMsg({ type: "error", text: "Lösenordet måste vara minst 8 tecken." });
      return;
    }

    if (nextPassword !== confirmPassword) {
      setPasswordChangeMsg({ type: "error", text: "Lösenorden matchar inte." });
      return;
    }

    setPasswordChangeLoading(true);
    setPasswordChangeMsg(null);
    const { error } = await supabase.auth.updateUser({ password: nextPassword });
    setPasswordChangeLoading(false);

    if (error) {
      setPasswordChangeMsg({ type: "error", text: `Kunde inte uppdatera lösenord: ${error.message}` });
      return;
    }

    setPasswordChangeValue("");
    setPasswordConfirmValue("");
    setPasswordChangeMsg({ type: "success", text: "Lösenordet är uppdaterat." });
  };

  const settingsDateInputClass =
    "bokata-date mt-1 w-full min-w-0 max-w-[140px] mx-auto rounded-lg border border-gray-300 px-2 py-1 text-center text-[11px] focus:outline-none focus:ring-2 focus:ring-pink-400 focus:border-pink-300 sm:mx-0 sm:max-w-none sm:text-base sm:px-3 sm:py-2";
  const settingsTimeInputClass =
    "w-full min-w-0 max-w-[104px] mx-auto rounded-md border border-gray-300 px-2 py-1 text-center text-[10px] disabled:opacity-60 sm:mx-0 sm:max-w-none sm:text-sm";
  const settingsTimeGridClass =
    "grid grid-cols-2 gap-1 justify-items-center sm:gap-2 sm:justify-items-stretch";

  if (!session) {
    return (
      <div className="min-h-screen bg-pink-50 p-6 flex items-center justify-center">
        <div className="w-full max-w-md rounded-2xl border border-pink-200 bg-white p-6 shadow-lg">
          <h1 className="text-2xl font-bold text-gray-900">Logga in</h1>
          <p className="mt-1 text-sm text-gray-600">Logga in med Google, lösenord eller magisk länk.</p>
          <label className="mt-4 block text-sm font-semibold text-gray-700">E‑post</label>
          <input
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-pink-400 focus:border-pink-300"
            value={authEmail}
            onChange={(e) => setAuthEmail(e.target.value)}
            placeholder="name@restaurant.se"
          />
          <label className="mt-4 block text-sm font-semibold text-gray-700">Lösenord</label>
          <input
            type="password"
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-pink-400 focus:border-pink-300"
            value={authPassword}
            onChange={(e) => setAuthPassword(e.target.value)}
            placeholder="••••••••"
            onKeyDown={(e) => {
              if (e.key === "Enter") handlePasswordLogin();
            }}
          />
          <button
            className="mt-4 w-full rounded-lg bg-pink-600 px-4 py-2 font-semibold text-white hover:bg-pink-700 disabled:opacity-60"
            onClick={handlePasswordLogin}
            disabled={authLoading || !authEmail || !authPassword}
          >
            Logga in
          </button>
          <button
            className="mt-3 w-full rounded-lg border border-pink-300 px-4 py-2 font-semibold text-pink-700 hover:bg-pink-50 disabled:opacity-60"
            onClick={handleGoogleLogin}
            disabled={authLoading}
          >
            Logga in med Google
          </button>
          <button
            className="mt-3 w-full rounded-lg border border-gray-300 px-4 py-2 font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-60"
            onClick={handleMagicLink}
            disabled={authLoading || !authEmail}
          >
            Skicka magisk länk
          </button>
          {authMsg ? <div className="mt-3 text-sm text-gray-700">{authMsg}</div> : null}
          {accessDenied ? <div className="mt-3 text-sm text-rose-700">{accessDenied}</div> : null}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-pink-50 p-6">
      <header className="-mx-1 mb-8 rounded-2xl bg-gradient-to-br from-[#2b0a4f] via-[#4b0c73] to-[#c0167a] px-6 py-10 text-white shadow-lg relative overflow-hidden">
        <img
          src={forkTransparent}
          alt=""
          aria-hidden="true"
          className="pointer-events-none absolute right-16 top-1/2 hidden md:block h-64 lg:h-72 w-auto -translate-y-1/2 opacity-95"
        />
        <div className="max-w-6xl mx-auto text-center relative">
          <div className="flex items-center justify-center gap-4">
            <h1 className="text-4xl md:text-6xl font-black tracking-tight">Dashboard</h1>
          </div>
          <p className="mt-3 text-lg md:text-xl text-white/85 max-w-2xl mx-auto">Övervaka bokningar, gäster och AI-svar i realtid.</p>
          <div className="mt-6 flex flex-wrap gap-3 justify-center">
            <button
              className="rounded-full px-6 py-3 font-semibold text-white bg-pink-500 hover:bg-pink-600 shadow-md ring-1 ring-pink-300"
              onClick={() => setCreateOpen(true)}
            >
              Ny bokning
            </button>
            <button
              className="rounded-full px-6 py-3 font-semibold text-white/90 bg-white/10 border border-white/20 hover:bg-white/15"
              onClick={() => setSettingsOpen(true)}
            >
              Inställningar
            </button>
            <button
              className="rounded-full px-6 py-3 font-semibold text-white/90 bg-white/10 border border-white/20 hover:bg-white/15"
              onClick={handleLogout}
            >
              Logga ut
            </button>
          </div>
        </div>
      </header>
      {accessDenied ? (
        <div className="mb-6 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {accessDenied}
        </div>
      ) : null}
      {floorplanCapacityAlert ? (
        <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <div className="font-semibold">Varning: tableplanens kapacitet matchar inte bokningarna.</div>
          <div className="mt-1">{floorplanCapacityAlert.summary}</div>
          <div className="mt-1">
            Lägg till fler bord i fliken <span className="font-semibold">Tableplan</span> eller sänk maxkapacitet i inställningarna.
          </div>
        </div>
      ) : null}

      {newBookingCount > 0 ? (
        <div className="mb-4">
          <div
            className="flex cursor-pointer items-center justify-between gap-3 rounded-xl border border-[#e6007a] bg-[#e6007a] px-4 py-3 text-sm text-white shadow-sm"
            onClick={() => setShowNewBookings((prev) => !prev)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") setShowNewBookings((prev) => !prev);
            }}
          >
            <span>
              {newBookingDetail ??
                (newBookingCount === 1
                  ? "1 ny bokning mottagen."
                  : `${newBookingCount} nya bokningar mottagna.`)}
            </span>
            <button
              className="ml-auto inline-flex h-7 w-7 items-center justify-center rounded-full text-white/90 hover:bg-white/15"
              onClick={(e) => {
                e.stopPropagation();
                setNewBookingCount(0);
                setNewBookingDetail(null);
                setNewBookingItems([]);
                setShowNewBookings(false);
              }}
              aria-label="Stäng"
              type="button"
            >
              ×
            </button>
          </div>
          {showNewBookings && newBookingItems.length ? (
            <div className="mt-2 rounded-xl border border-pink-200 bg-white/90 px-4 py-3 text-sm text-gray-700">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-pink-700">Nya bokningar</div>
              <div className="space-y-1">
                {newBookingItems.map((b) => (
                  <div key={b.id} className="flex flex-wrap items-center justify-between gap-2">
                    <div className="font-medium text-gray-900">
                      {b.date} · {b.time}
                    </div>
                    <div className="text-gray-600">
                      {b.guests} gäster{b.name ? ` · ${b.name}` : ""}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="mb-6 flex flex-wrap gap-2">
        <button
          className={`px-4 py-2 rounded-full text-sm font-semibold border ${
            activeTab === "overview" ? "bg-white text-pink-700 border-pink-300" : "bg-pink-100 text-pink-700 border-pink-200"
          }`}
          onClick={() => setActiveTab("overview")}
        >
          Översikt
        </button>
        <button
          className={`px-4 py-2 rounded-full text-sm font-semibold border ${
            activeTab === "tableplan" ? "bg-white text-pink-700 border-pink-300" : "bg-pink-100 text-pink-700 border-pink-200"
          }`}
          onClick={() => setActiveTab("tableplan")}
        >
          Tableplan
        </button>
      </div>

      {activeTab === "overview" ? (
        <>
          {/* Top stats */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
            <Stat
              icon="📅"
              label="Bokningar idag"
              value={String(dayActiveBookings.length)}
              secondaryLabel="Vs förra veckan"
              secondaryValue={`${weekStats.diff >= 0 ? "+" : ""}${weekStats.diff} gäster`}
              secondarySub={weekStats.pct != null ? `${weekStats.pct >= 0 ? "+" : ""}${weekStats.pct}%` : "—"}
            />
            <Stat
              icon="👥"
              label="Antal gäster idag"
              value={String(totalGuestsDay)}
              secondaryLabel="Totalt denna vecka"
              secondaryValue={String(weekStats.curGuests)}
              secondarySub="gäster"
            />
            <Stat
              icon="🕒"
              label="Mest bokade tid"
              value={busiestLeast.max}
              secondaryLabel="Minst bokade tid"
              secondaryValue={busiestLeast.min}
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
            <Stat icon="💗" label="Stammiskunder" value={String(regularCustomersToday)} />
            <Stat
              icon={<img src={forkTransparent} alt="Bokata" className="h-4 w-4" />}
              label="Svar skickade av AI"
              value="0"
              sub="denna vecka"
            />
          </div>

          {/* Calendar + Day view */}
          <div className="bg-white shadow rounded-lg p-4">
        <h3 className="text-lg font-bold text-gray-700 mb-4">
          {(() => {
            const dd = new Date(year, month, selectedSafe);
            return `${WD_FULL[dd.getDay()]} ${selectedSafe} ${MONTHS[month]} ${year}`;
          })()}
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {/* Month */}
          <div className="border border-gray-300 rounded-lg p-4">
            <div className="grid grid-cols-3 items-center mb-2">
              <button
                className="justify-self-start h-8 w-8 rounded-full border border-pink-300 text-pink-700 hover:bg-pink-50"
                onClick={() =>
                  setMonth((m) => {
                    if (m === 0) {
                      setYear((y) => y - 1);
                      return 11;
                    }
                    return m - 1;
                  })
                }
                aria-label="Föregående månad"
              >
                ‹
              </button>
              <p className="justify-self-center text-sm font-bold text-gray-700 text-center">
                {MONTHS[month]} {year}
              </p>
              <button
                className="justify-self-end h-8 w-8 rounded-full border border-pink-300 text-pink-700 hover:bg-pink-50"
                onClick={() =>
                  setMonth((m) => {
                    if (m === 11) {
                      setYear((y) => y + 1);
                      return 0;
                    }
                    return m + 1;
                  })
                }
                aria-label="Nästa månad"
              >
                ›
              </button>
            </div>

            <div className="grid grid-cols-7 text-center text-sm text-gray-700 gap-1">
              {WD_SHORT.map((d) => (
                <div key={d} className="font-semibold text-gray-500">
                  {d}
                </div>
              ))}

              {calendarCells.map((c) => {
                if (!c.day) return <div key={c.key} />;
                const sel = c.day === selectedSafe;
                const dateStr = `${year}-${pad2(month + 1)}-${pad2(c.day)}`;
                const isClosed = isClosedDate(dateStr);
                const hasBooking = bookingDates.has(dateStr);
                return (
                  <div
                    key={c.key}
                    onClick={() => setSelectedDay(c.day!)}
                    className={`rounded-lg w-9 h-11 flex flex-col items-center justify-center leading-none ${
                      sel
                        ? "bg-pink-500 text-white font-bold ring-2 ring-pink-700"
                        : isClosed
                        ? "bg-gray-100 text-gray-400 hover:bg-gray-100 cursor-pointer"
                        : "text-gray-800 hover:bg-gray-100 cursor-pointer"
                    }`}
                    role="button"
                    tabIndex={0}
                  >
                    <div className="text-sm font-semibold flex items-center gap-1">
                      {c.day}
                      {hasBooking ? <span className="text-[9px] leading-none">🔴</span> : null}
                    </div>
                    {isClosed && <div className="text-[10px] text-gray-500">Stängt</div>}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Day schedule */}
          <div className="md:col-span-3 border border-gray-300 rounded-lg p-4">
            <div className="flex flex-wrap items-center gap-2 mb-4">
              {MEAL_FILTERS.map((m) => {
                const on = activeMeal === m;
                const theme = MEAL_THEME_CLASSES[m];
                return (
                  <button
                    key={m}
                    className={`px-3 py-1 text-sm rounded transition border focus:outline-none focus:ring-2 focus:ring-pink-400 ${
                      on ? theme.active : theme.inactive
                    }`}
                    onClick={() => setActiveMeal(m)}
                    aria-pressed={on}
                  >
                    {m} ({guestsByMeal[m]})
                  </button>
                );
              })}

              <span className="ml-auto text-xs text-gray-500">
                {totals.count} bokningar • {totals.guests} gäster
              </span>
            </div>

            {activeMeal !== "Alla" && (
              <div className="mb-4 flex flex-wrap items-center gap-2 text-xs text-gray-600">
                <span className="font-semibold text-gray-600">Tider för {activeMeal}:</span>
                <input
                  type="time"
                  className="rounded-md border border-gray-300 px-2 py-1 text-xs text-gray-700"
                  value={mealRanges[activeMeal as MealKey][0]}
                  onChange={(e) => updateMealRange(activeMeal as MealKey, 0, e.target.value)}
                />
                <span className="text-gray-400">–</span>
                <input
                  type="time"
                  className="rounded-md border border-gray-300 px-2 py-1 text-xs text-gray-700"
                  value={mealRanges[activeMeal as MealKey][1]}
                  onChange={(e) => updateMealRange(activeMeal as MealKey, 1, e.target.value)}
                />
              </div>
            )}

            {Object.keys(groupedByTime).length === 0 ? (
              <div className="text-sm text-gray-500 italic p-3 bg-gray-50 rounded border border-dashed border-gray-300">
                Inga bokningar i denna tidsperiod.
              </div>
            ) : (
              <div className="space-y-2">
                {Object.keys(groupedByTime)
                  .sort((a, b) => timeToMin(a) - timeToMin(b))
                  .map((time) => (
                    <div key={time} className="bg-gray-50 rounded-md p-2 border border-gray-200">
                      <div className="flex items-start gap-3">
                        <div className="w-14 shrink-0 text-sm font-semibold text-gray-700 pt-1">{time}</div>
                        <div className="flex flex-wrap gap-2">
                          {groupedByTime[time].map((b) => {
                            const bookingMeal = mealForWithRanges(b.time, mealRanges);
                            const bookingTheme = MEAL_THEME_CLASSES[bookingMeal];
                            const cancelled = isCancelledBooking(b);
                            return (
                              <div
                                key={b.id}
                                className={`px-2 py-1 rounded shadow border text-sm ${
                                  cancelled
                                    ? "bg-gray-100 border-gray-300 text-gray-500 cursor-pointer"
                                    : `${bookingTheme.booking} cursor-pointer hover:brightness-95`
                                }`}
                                onClick={() => setOpenBooking(b)}
                                title={b.note ? "Visa anteckning" : "Redigera bokning"}
                              >
                                <div className="flex items-center gap-2 font-medium">
                                  <span className={cancelled ? "line-through" : ""}>{b.name}</span>
                                  {cancelled ? (
                                    <span className="inline-flex items-center rounded-full bg-gray-200 text-gray-700 text-[10px] px-2 py-0.5 font-semibold">
                                      Avbokad
                                    </span>
                                  ) : null}
                                  {b.note && (
                                    <span
                                      className="inline-flex items-center rounded-full bg-pink-200 text-pink-800 text-[10px] px-2 py-0.5 font-semibold"
                                      title={b.notes || "Särskilt önskemål"}
                                    >
                                      📎
                                    </span>
                                  )}
                                </div>
                                <div className={`text-xs ${cancelled ? "text-gray-500 line-through" : "opacity-80"}`}>
                                  {b.guests} gäster{formatBookingTableLabel(b) ? ` • ${formatBookingTableLabel(b)}` : ""}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  ))}
              </div>
            )}
          </div>
        </div>
      </div>
        </>
      ) : (
        <div className="bg-white shadow rounded-lg p-4">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-lg font-bold text-gray-700">Tableplan</h3>
              <p className="text-sm text-gray-500">Dra och släpp bord samt zoner. Totalt: {floorplanSeatCount} platser.</p>
            </div>
            <div className="flex gap-2">
              <button
                className="px-3 py-2 rounded-lg border border-pink-200 text-pink-700 bg-pink-50 hover:bg-pink-100 text-sm disabled:opacity-60"
                disabled={!canEditFloorplan}
                onClick={() =>
                  setFloorplan((prev) => ({
                    ...prev,
                    tables: [
                      ...prev.tables,
                      {
                        id: uid(),
                        x: 80,
                        y: 80,
                        ...tableSizeForSeats(4),
                        seats: 4,
                        label: `T${prev.tables.length + 1}`,
                        orientation: "h",
                      },
                    ],
                  }))
                }
              >
                + Bord
              </button>
              <button
                className="px-3 py-2 rounded-lg border border-pink-200 text-pink-700 bg-pink-50 hover:bg-pink-100 text-sm disabled:opacity-60"
                disabled={!canEditFloorplan}
                onClick={() =>
                  setFloorplan((prev) => ({
                    ...prev,
                    zones: [
                      ...prev.zones,
                      { id: uid(), x: 460, y: 90, w: 260, h: 140, name: `Zon ${prev.zones.length + 1}` },
                    ],
                  }))
                }
              >
                + Zon
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
            <div className="lg:col-span-3">
              <div className="w-full overflow-x-auto">
                <div
                  ref={canvasRef}
                  className="relative rounded-2xl border border-pink-200 bg-gradient-to-br from-pink-50 to-purple-50 overflow-hidden"
                  style={{ width: floorplan.width, height: floorplan.height }}
                >
                  {floorplan.zones.map((z) => (
                    <div
                      key={z.id}
                      onPointerDown={(e) => {
                        if (!canEditFloorplan) return;
                        const rect = canvasRef.current?.getBoundingClientRect();
                        if (!rect) return;
                        setSelectedItem({ type: "zone", id: z.id });
                        setDragging({
                          type: "zone",
                          id: z.id,
                          offsetX: e.clientX - rect.left - z.x,
                          offsetY: e.clientY - rect.top - z.y,
                        });
                      }}
                      className={`absolute rounded-xl border-2 border-dashed ${
                        selectedItem?.type === "zone" && selectedItem.id === z.id ? "border-pink-400" : "border-pink-200"
                      } bg-white/60`}
                      style={{ left: z.x, top: z.y, width: z.w, height: z.h }}
                    >
                      <div className="text-xs font-semibold text-pink-700 px-2 py-1">{z.name}</div>
                    </div>
                  ))}
                  {floorplan.tables.map((t) => (
                    (() => {
                      const size = tableSizeForSeats(t.seats || 0, t.orientation ?? "h");
                      return (
                    <div
                      key={t.id}
                      onPointerDown={(e) => {
                        if (!canEditFloorplan) return;
                        const rect = canvasRef.current?.getBoundingClientRect();
                        if (!rect) return;
                        setSelectedItem({ type: "table", id: t.id });
                        setDragging({
                          type: "table",
                          id: t.id,
                          offsetX: e.clientX - rect.left - t.x,
                          offsetY: e.clientY - rect.top - t.y,
                        });
                      }}
                      className={`absolute rounded-xl border ${
                        selectedItem?.type === "table" && selectedItem.id === t.id ? "border-pink-500" : "border-pink-300"
                      } bg-white shadow-sm flex items-center justify-center`}
                      style={{ left: t.x, top: t.y, width: size.w, height: size.h }}
                    >
                      <div className="text-center">
                        <div className="text-xs font-semibold text-gray-700">{t.label || "Bord"}</div>
                        <div className="text-[11px] text-gray-500">{t.seats} platser</div>
                      </div>
                    </div>
                      );
                    })()
                  ))}
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-pink-200 bg-white p-4">
              <div className="text-sm font-semibold text-gray-700 mb-3">Egenskaper</div>
              {floorplanCapacityAlert ? (
                <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  {floorplanCapacityAlert.summary}
                </div>
              ) : null}
              {!canEditFloorplan ? (
                <div className="text-xs text-gray-500 mb-3">Du saknar behörighet att redigera tableplan.</div>
              ) : null}
              {selectedItem ? (
                selectedItem.type === "table" ? (
                  (() => {
                    const t = floorplan.tables.find((x) => x.id === selectedItem.id);
                    if (!t) return null;
                    return (
                      <div className="space-y-3 text-sm">
                        <Field label="Label">
                          <input
                            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2"
                            value={t.label ?? ""}
                            disabled={!canEditFloorplan}
                            onChange={(e) =>
                              setFloorplan((prev) => ({
                                ...prev,
                                tables: prev.tables.map((x) => (x.id === t.id ? { ...x, label: e.target.value } : x)),
                              }))
                            }
                          />
                        </Field>
                        <Field label="Platser">
                          <input
                            type="number"
                            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2"
                            value={t.seats}
                            disabled={!canEditFloorplan}
                            onChange={(e) =>
                              setFloorplan((prev) => ({
                                ...prev,
                                tables: prev.tables.map((x) =>
                                  x.id === t.id
                                    ? {
                                        ...x,
                                        seats: Number(e.target.value) || 0,
                                        ...tableSizeForSeats(Number(e.target.value) || 0, x.orientation ?? "h"),
                                      }
                                    : x
                                ),
                              }))
                            }
                          />
                        </Field>
                        <Field label="Orientering">
                          <div className="mt-1 flex gap-2">
                            <button
                              type="button"
                              className={`px-3 py-2 rounded-lg border text-sm ${
                                (t.orientation ?? "h") === "h"
                                  ? "border-pink-400 bg-pink-50 text-pink-700"
                                  : "border-gray-300 text-gray-600"
                              }`}
                              disabled={!canEditFloorplan}
                              onClick={() =>
                                setFloorplan((prev) => ({
                                  ...prev,
                                  tables: prev.tables.map((x) =>
                                    x.id === t.id
                                      ? {
                                          ...x,
                                          orientation: "h",
                                          ...tableSizeForSeats(x.seats || 0, "h"),
                                        }
                                      : x
                                  ),
                                }))
                              }
                            >
                              Horisontell
                            </button>
                            <button
                              type="button"
                              className={`px-3 py-2 rounded-lg border text-sm ${
                                (t.orientation ?? "h") === "v"
                                  ? "border-pink-400 bg-pink-50 text-pink-700"
                                  : "border-gray-300 text-gray-600"
                              }`}
                              disabled={!canEditFloorplan}
                              onClick={() =>
                                setFloorplan((prev) => ({
                                  ...prev,
                                  tables: prev.tables.map((x) =>
                                    x.id === t.id
                                      ? {
                                          ...x,
                                          orientation: "v",
                                          ...tableSizeForSeats(x.seats || 0, "v"),
                                        }
                                      : x
                                  ),
                                }))
                              }
                            >
                              Vertikal
                            </button>
                          </div>
                        </Field>
                        <button
                          className="w-full rounded-lg border border-rose-200 bg-rose-50 text-rose-700 px-3 py-2 disabled:opacity-60"
                          disabled={!canEditFloorplan}
                          onClick={() =>
                            setFloorplan((prev) => ({
                              ...prev,
                              tables: prev.tables.filter((x) => x.id !== t.id),
                            }))
                          }
                        >
                          Ta bort bord
                        </button>
                      </div>
                    );
                  })()
                ) : (
                  (() => {
                    const z = floorplan.zones.find((x) => x.id === selectedItem.id);
                    if (!z) return null;
                    return (
                      <div className="space-y-3 text-sm">
                        <Field label="Namn">
                          <input
                            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2"
                            value={z.name}
                            disabled={!canEditFloorplan}
                            onChange={(e) =>
                              setFloorplan((prev) => ({
                                ...prev,
                                zones: prev.zones.map((x) => (x.id === z.id ? { ...x, name: e.target.value } : x)),
                              }))
                            }
                          />
                        </Field>
                        <div className="grid grid-cols-2 gap-2">
                          <Field label="Bredd">
                            <input
                              type="number"
                              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2"
                              value={z.w}
                              disabled={!canEditFloorplan}
                              onChange={(e) =>
                                setFloorplan((prev) => ({
                                  ...prev,
                                  zones: prev.zones.map((x) =>
                                    x.id === z.id ? { ...x, w: Number(e.target.value) || 80 } : x
                                  ),
                                }))
                              }
                            />
                          </Field>
                          <Field label="Höjd">
                            <input
                              type="number"
                              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2"
                              value={z.h}
                              disabled={!canEditFloorplan}
                              onChange={(e) =>
                                setFloorplan((prev) => ({
                                  ...prev,
                                  zones: prev.zones.map((x) =>
                                    x.id === z.id ? { ...x, h: Number(e.target.value) || 80 } : x
                                  ),
                                }))
                              }
                            />
                          </Field>
                        </div>
                        <button
                          className="w-full rounded-lg border border-rose-200 bg-rose-50 text-rose-700 px-3 py-2 disabled:opacity-60"
                          disabled={!canEditFloorplan}
                          onClick={() =>
                            setFloorplan((prev) => ({
                              ...prev,
                              zones: prev.zones.filter((x) => x.id !== z.id),
                            }))
                          }
                        >
                          Ta bort zon
                        </button>
                      </div>
                    );
                  })()
                )
              ) : (
                <div className="text-xs text-gray-500">Klicka på ett bord eller en zon.</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Note modal */}
  {openBooking && (
        <Modal onClose={() => setOpenBooking(null)}>
          <h4 className={`text-lg font-bold ${isCancelledBooking(openBooking) ? "text-gray-500 line-through" : "text-gray-800"}`}>
            {openBooking.name} – {openBooking.time}
          </h4>
          <p className="text-sm text-gray-500 mb-4">
            {openBooking.guests} gäster{formatBookingTableLabel(openBooking) ? ` • ${formatBookingTableLabel(openBooking)}` : ""}
            {isCancelledBooking(openBooking) ? " • Avbokad" : ""}
          </p>
          <div className="bg-pink-50 border border-pink-200 rounded-lg p-3 text-gray-800 whitespace-pre-wrap">
            {openBooking.notes || "(Ingen anteckning)"}
          </div>

          <div className="mt-5 grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field label="Datum">
              <input
                type="date"
                lang="sv-SE"
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-pink-400 focus:border-pink-300"
                value={editBookingDraft?.date ?? openBooking.date}
                onChange={(e) =>
                  setEditBookingDraft((prev) => ({ ...(prev ?? openBooking), date: e.target.value }))
                }
              />
            </Field>
            <Field label="Tid">
              <select
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-pink-400 focus:border-pink-300"
                value={editBookingDraft?.time ?? openBooking.time}
                onChange={(e) =>
                  setEditBookingDraft((prev) => ({ ...(prev ?? openBooking), time: e.target.value }))
                }
              >
                {ALL_TIMES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Namn">
              <input
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-pink-400 focus:border-pink-300"
                value={editBookingDraft?.name ?? openBooking.name}
                onChange={(e) =>
                  setEditBookingDraft((prev) => ({ ...(prev ?? openBooking), name: e.target.value }))
                }
              />
            </Field>
            <Field label="Gäster">
              <input
                type="number"
                min={1}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-pink-400 focus:border-pink-300"
                value={editBookingDraft?.guests ?? openBooking.guests}
                onChange={(e) =>
                  setEditBookingDraft((prev) => ({
                    ...(prev ?? openBooking),
                    guests: Number(e.target.value || 1),
                  }))
                }
              />
            </Field>
            {(() => {
              const selectedTables = bookingAssignedTableIds(editBookingDraft ?? openBooking);
              const primaryTableId = selectedTables[0] ?? null;
              const secondaryTableId = selectedTables[1] ?? null;
              return (
                <>
                  <Field label="Bord 1 (valfritt)">
                    <select
                      className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-pink-400 focus:border-pink-300"
                      value={primaryTableId == null ? "" : String(primaryTableId)}
                      onChange={(e) => {
                        const raw = e.target.value;
                        const parsed = raw ? Number(raw) : null;
                        setEditBookingDraft((prev) => {
                          const current = prev ?? openBooking;
                          const currentTables = bookingAssignedTableIds(current);
                          const normalized = normalizeTableIds([
                            raw && Number.isFinite(parsed) ? parsed : null,
                            currentTables[1] ?? null,
                          ]);
                          return {
                            ...current,
                            tableId: normalized[0] ?? null,
                            tableIds: normalized.length ? normalized : null,
                          };
                        });
                      }}
                    >
                      <option value="">Auto (välj bord automatiskt)</option>
                      {tableOptions.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.label} · {t.cap} platser
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Bord 2 (valfritt)">
                    <select
                      className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-pink-400 focus:border-pink-300 disabled:opacity-60"
                      value={secondaryTableId == null ? "" : String(secondaryTableId)}
                      disabled={primaryTableId == null}
                      onChange={(e) => {
                        const raw = e.target.value;
                        const parsed = raw ? Number(raw) : null;
                        setEditBookingDraft((prev) => {
                          const current = prev ?? openBooking;
                          const currentTables = bookingAssignedTableIds(current);
                          const normalized = normalizeTableIds([
                            currentTables[0] ?? null,
                            raw && Number.isFinite(parsed) ? parsed : null,
                          ]);
                          return {
                            ...current,
                            tableId: normalized[0] ?? null,
                            tableIds: normalized.length ? normalized : null,
                          };
                        });
                      }}
                    >
                      <option value="">Ingen</option>
                      {tableOptions
                        .filter((t) => t.id !== primaryTableId)
                        .map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.label} · {t.cap} platser
                          </option>
                        ))}
                    </select>
                  </Field>
                </>
              );
            })()}
            <Field label="Kommentar / önskemål">
              <textarea
                rows={3}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-pink-400 focus:border-pink-300"
                value={editBookingDraft?.notes ?? openBooking.notes ?? ""}
                onChange={(e) =>
                  setEditBookingDraft((prev) => ({ ...(prev ?? openBooking), notes: e.target.value }))
                }
              />
            </Field>
          </div>

          <div className="mt-5 flex flex-wrap justify-between gap-2">
            <button
              className="px-4 py-2 rounded-lg border border-red-200 text-red-600 hover:bg-red-50"
              onClick={async () => {
                if (!openBooking) return;
                if (!window.confirm("Ta bort bokningen?")) return;
                const target = openBooking;
                if (restaurantId && settingsReady) {
                  const { error } = await supabase
                    .from("bookings")
                    .delete()
                    .eq("id", target.id)
                    .eq("restaurant_id", restaurantId);
                  if (error) {
                    window.alert(`Kunde inte ta bort bokningen. ${error.message}`);
                    return;
                  }
                }
                setBookings((prev) => prev.filter((b) => String(b.id) !== String(target.id)));
                setEditBookingDraft(null);
                setOpenBooking(null);
                if (restaurantId && settingsReady) {
                  void fetchBookings({ silent: true });
                }
              }}
            >
              Ta bort
            </button>
            <div className="flex gap-2">
              <button
                className="px-4 py-2 rounded-lg border"
                onClick={() => {
                  setEditBookingDraft(null);
                  setOpenBooking(null);
                }}
              >
                Stäng
              </button>
              <button
                className="px-4 py-2 rounded-lg bg-pink-500 text-white hover:bg-pink-600 shadow"
                onClick={async () => {
                  if (!openBooking) return;
                  const target = openBooking;
                  const next = editBookingDraft ?? target;
                  const nextTableIds = bookingAssignedTableIds(next);

                  if (nextTableIds.length) {
                    const draftId = `draft-${uid()}`;
                    const draftBooking: Booking = {
                      ...next,
                      id: draftId,
                      date: next.date,
                      time: round30(next.time),
                      tableId: nextTableIds[0] ?? null,
                      tableIds: nextTableIds,
                      durationMin: next.durationMin ?? bookingDurationMin,
                      note: !!next.notes,
                    };
                    const simulated = assignTablesForDateWithTables(
                      next.date,
                      [...bookings.filter((b) => String(b.id) !== String(target.id)), draftBooking],
                      tableCaps,
                      mealRanges
                    );
                    const simulatedDraft = simulated.find((b) => String(b.id) === draftId);
                    const simulatedTableIds = simulatedDraft ? bookingAssignedTableIds(simulatedDraft) : [];
                    if (!sameTableSelection(simulatedTableIds, nextTableIds)) {
                      window.alert("Valda bord är upptagna eller saknar tillräcklig gruppkapacitet vid den tiden.");
                      return;
                    }
                  }

                  const persistedNotes = buildBookingNotesWithMeta(next.notes, nextTableIds);

                  if (restaurantId && settingsReady) {
                    const { error } = await supabase
                      .from("bookings")
                      .update({
                        date: next.date,
                        time: next.time,
                        name: next.name,
                        guests: next.guests,
                        notes: persistedNotes,
                        table_id: nextTableIds[0] ?? null,
                        duration_min: next.durationMin ?? bookingDurationMin,
                      })
                      .eq("id", target.id)
                      .eq("restaurant_id", restaurantId);
                    if (error) {
                      window.alert(`Kunde inte spara ändring. ${error.message}`);
                      return;
                    }
                  }
                  setBookings((prev) => {
                    const updated = prev.map((b) =>
                      String(b.id) === String(target.id)
                        ? {
                            ...b,
                            ...next,
                            tableId: nextTableIds[0] ?? null,
                            tableIds: nextTableIds.length ? nextTableIds : null,
                            note: !!next.notes?.trim(),
                          }
                        : b
                    );
                    const dates = Array.from(new Set<string>(updated.map((b) => b.date)));
                    let out = updated;
                    for (const d of dates) out = assignTablesForDateWithTables(d, out, tableCaps, mealRanges);
                    return out;
                  });
                  setEditBookingDraft(null);
                  setOpenBooking(null);
                  if (restaurantId && settingsReady) {
                    void fetchBookings({ silent: true });
                  }
                }}
              >
                Spara ändring
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Create booking */}
      {createOpen && (
        <Modal onClose={() => setCreateOpen(false)}>
          <h4 className="text-lg font-bold text-gray-800">Ny bokning</h4>
          <div className="mt-4 space-y-3">
            <Field label="Datum">
              <input
                type="date"
                lang="sv-SE"
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-pink-400 focus:border-pink-300"
                value={formDate}
                onChange={(e) => setFormDate(e.target.value)}
              />
            </Field>

            <Field label="Tid">
              <select
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-pink-400 focus:border-pink-300"
                value={formTime}
                onChange={(e) => setFormTime(e.target.value)}
              >
                {ALL_TIMES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Namn">
              <input
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-pink-400 focus:border-pink-300"
                placeholder="För- och efternamn"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
              />
            </Field>

            <Field label="Gäster">
              <input
                type="number"
                min={1}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-pink-400 focus:border-pink-300"
                value={formGuestsInput}
                onChange={(e) => {
                  const digits = e.target.value.replace(/[^\d]/g, "");
                  if (!digits) {
                    setFormGuestsInput("");
                    return;
                  }
                  const parsed = Number(digits);
                  if (!Number.isFinite(parsed)) return;
                  const normalized = Math.max(0, Math.min(999, Math.floor(parsed)));
                  setFormGuestsInput(String(normalized));
                }}
                onBlur={() => {
                  if (!formGuestsInput.trim()) return;
                  const parsed = Number(formGuestsInput);
                  if (!Number.isFinite(parsed)) {
                    setFormGuestsInput("");
                    return;
                  }
                  const normalized = Math.max(1, Math.min(999, Math.floor(parsed)));
                  setFormGuestsInput(String(normalized));
                }}
              />
            </Field>

            <Field label="Bord 1 (valfritt)">
              <select
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-pink-400 focus:border-pink-300"
                value={formTableId == null ? "" : String(formTableId)}
                onChange={(e) => {
                  const raw = e.target.value;
                  const parsed = raw ? Number(raw) : null;
                  const normalized = normalizeTableIds([raw && Number.isFinite(parsed) ? parsed : null, formTableIdSecondary]);
                  setFormTableId(normalized[0] ?? null);
                  setFormTableIdSecondary(normalized[1] ?? null);
                }}
              >
                <option value="">Auto (välj bord automatiskt)</option>
                {tableOptions.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label} · {t.cap} platser
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Bord 2 (valfritt)">
              <select
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-pink-400 focus:border-pink-300 disabled:opacity-60"
                value={formTableIdSecondary == null ? "" : String(formTableIdSecondary)}
                disabled={formTableId == null}
                onChange={(e) => {
                  const raw = e.target.value;
                  const parsed = raw ? Number(raw) : null;
                  const normalized = normalizeTableIds([formTableId, raw && Number.isFinite(parsed) ? parsed : null]);
                  setFormTableId(normalized[0] ?? null);
                  setFormTableIdSecondary(normalized[1] ?? null);
                }}
              >
                <option value="">Ingen</option>
                {tableOptions
                  .filter((t) => t.id !== formTableId)
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label} · {t.cap} platser
                    </option>
                  ))}
              </select>
            </Field>

            <Field label="Anteckning">
              <textarea
                rows={3}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-pink-400 focus:border-pink-300"
                placeholder="Allergier, barnstol, hund, vegan…"
                value={formNotes}
                onChange={(e) => setFormNotes(e.target.value)}
              />
            </Field>
          </div>

          {formError && <div className="pt-2 text-sm text-red-600">{formError}</div>}

          <div className="pt-4 flex justify-end gap-2">
            <button className="px-4 py-2 rounded-lg border border-gray-300" onClick={() => setCreateOpen(false)}>
              Avbryt
            </button>
            <button className="px-4 py-2 rounded-lg bg-pink-500 text-white hover:bg-pink-600 shadow" onClick={handleCreate}>
              Skapa
            </button>
          </div>
        </Modal>
      )}

      {/* Settings drawer */}
      {settingsOpen && (
        <Drawer onClose={() => setSettingsOpen(false)}>
          <div className="space-y-6" onInputCapture={markSettingsDirty} onChangeCapture={markSettingsDirty}>
            {restaurantId && session?.access_token && (
              <Section title="Kalenderanslutningar">
                <CalendarConnections key={restaurantId} restaurantId={restaurantId} accessToken={session.access_token} isOwner={restaurantRole === "owner"} />
              </Section>
            )}
            <Section title="Restauranginfo">
              {primaryMismatchNotice ? (
                <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 flex items-center justify-between gap-2">
                  <span>{primaryMismatchNotice}</span>
                  <button
                    type="button"
                    className="rounded-md border border-amber-300 px-2 py-1 text-xs font-semibold hover:bg-amber-100"
                    onClick={() => window.location.reload()}
                  >
                    Ladda om
                  </button>
                </div>
              ) : null}
              {settingsSaveError ? (
                <div className="mb-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
                  Kunde inte spara inställningar: {settingsSaveError}
                </div>
              ) : null}
              <Field label="Bokningslänk">
                <div className="mt-1 flex flex-col gap-2 sm:flex-row sm:items-center">
                  <input
                    className="w-full flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700"
                    value={bookingPublicUrl || "Laddar..."}
                    readOnly
                  />
                  <button
                    type="button"
                    onClick={copyBookingPublicUrl}
                    disabled={!bookingPublicUrl}
                    className="rounded-lg bg-pink-500 px-3 py-2 text-sm font-semibold text-white hover:bg-pink-600 disabled:opacity-50"
                  >
                    Kopiera
                  </button>
                  {bookingLinkStatus ? <span className="text-xs text-gray-500">{bookingLinkStatus}</span> : null}
                </div>
                <div className="mt-2 text-xs text-gray-500 leading-relaxed">
                  Klistra in på din webbplats eller Facebook för att leda gäster till Bokätas bokningssida.
                </div>
              </Field>
              <div className="mt-4">
                <Field label="E-post för bokningar & aviseringar">
                  <input
                    className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-pink-400 focus:border-pink-300"
                    value={config.info.email || config.notifications.to}
                    onChange={(e) =>
                      setConfig({
                        ...config,
                        info: { ...config.info, email: e.target.value },
                        notifications: { ...config.notifications, to: e.target.value },
                      })
                    }
                  />
                </Field>
              </div>
              <div className="mt-4">
                <Field label="Bokningsmeddelande (valfritt)">
                  <textarea
                    rows={4}
                    className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-pink-400 focus:border-pink-300"
                    placeholder="Skriv en kort hälsning eller info till gästerna som visas på bokningssidan."
                    value={config.publicMessage}
                    onChange={(e) => setConfig({ ...config, publicMessage: e.target.value })}
                  />
                  <div className="mt-2 text-xs text-gray-500">
                    Visas under kommentarsfältet på bokningssidan.
                  </div>
                </Field>
              </div>
              <div className="mt-4">
                <Field label="Bekräftelsemail till kund – automatisk (valfritt)">
                  <textarea
                    rows={4}
                    className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-pink-400 focus:border-pink-300"
                    placeholder="Text som visas i kundens bekräftelsemail när bokningen bekräftas automatiskt."
                    value={config.confirmationEmailMessageAuto}
                    onChange={(e) => setConfig({ ...config, confirmationEmailMessageAuto: e.target.value })}
                  />
                </Field>
              </div>
              <div className="mt-4">
                <Field label="Bekräftelsemail till kund – manuell (valfritt)">
                  <textarea
                    rows={4}
                    className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-pink-400 focus:border-pink-300"
                    placeholder="Text som visas i kundens bekräftelsemail efter manuell bekräftelse."
                    value={config.confirmationEmailMessageManual}
                    onChange={(e) => setConfig({ ...config, confirmationEmailMessageManual: e.target.value })}
                  />
                </Field>
              </div>
              <div className="mt-3 grid grid-cols-1 gap-2 text-sm">
                <label className="inline-flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={config.notifications.notifyOnNewBooking}
                    onChange={(e) =>
                      setConfig({
                        ...config,
                        notifications: { ...config.notifications, notifyOnNewBooking: e.target.checked },
                      })
                    }
                  />
                  Email till restaurang vid ny bokning
                </label>
                <label className="inline-flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={config.notifications.requireManualConfirmation}
                    onChange={(e) =>
                      setConfig({
                        ...config,
                        notifications: { ...config.notifications, requireManualConfirmation: e.target.checked },
                      })
                    }
                  />
                  Manuell bekräftelse krävs innan kundens bekräftelsemail
                </label>
              </div>
            </Section>

            <Section title="Följa upp gäster, erbjudanden & omdömen">
              <div className="grid grid-cols-1 gap-3 text-sm">
                <label className="inline-flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={config.seating.followUpEnabled}
                    onChange={(e) =>
                      setConfig({
                        ...config,
                        seating: { ...config.seating, followUpEnabled: e.target.checked },
                      })
                    }
                  />
                  Skicka uppföljningsmail efter besök
                </label>
                <Field label="Skicka efter (dagar)">
                  <input
                    type="number"
                    min={1}
                    className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-pink-400 focus:border-pink-300"
                    value={config.seating.followUpDelayDays}
                    onChange={(e) =>
                      setConfig({
                        ...config,
                        seating: {
                          ...config.seating,
                          followUpDelayDays: Math.max(1, Number(e.target.value) || 1),
                        },
                      })
                    }
                    disabled={!config.seating.followUpEnabled}
                  />
                </Field>
                <Field label="Follow up">
                  <textarea
                    rows={3}
                    className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-pink-400 focus:border-pink-300"
                    placeholder="Tack för ert besök! Vi hoppas att ni hade en härlig stund. Om du vill får du gärna lämna en Google‑recension."
                    value={config.seating.followUpEmail}
                    onChange={(e) =>
                      setConfig({
                        ...config,
                        seating: { ...config.seating, followUpEmail: e.target.value },
                      })
                    }
                    disabled={!config.seating.followUpEnabled}
                  />
                </Field>
                <div className="text-xs text-gray-500">
                  Det här sparar texten och inställningen. Utskick aktiveras när funktionen kopplas på.
                </div>
              </div>
            </Section>

            <Section title="Kapacitet & tider">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Max gäster i restaurangen">
                  <input
                    type="number"
                    className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-pink-400 focus:border-pink-300"
                    value={config.seating.maxGuests || ""}
                    onChange={(e) =>
                      setConfig({
                        ...config,
                        seating: { ...config.seating, maxGuests: Math.max(0, Number(e.target.value) || 0) },
                      })
                    }
                  />
                </Field>

                <Field label="Max antal bord">
                  <input
                    type="number"
                    className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-pink-400 focus:border-pink-300"
                    value={config.seating.maxTables || ""}
                    onChange={(e) =>
                      setConfig({
                        ...config,
                        seating: { ...config.seating, maxTables: Math.max(0, Number(e.target.value) || 0) },
                      })
                    }
                  />
                </Field>

                <Field label="Max gäster per bokning">
                  <input
                    type="number"
                    className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-pink-400 focus:border-pink-300"
                    value={config.escalation.maxGuestsPerReservation || ""}
                    onChange={(e) =>
                      setConfig({
                        ...config,
                        escalation: {
                          ...config.escalation,
                          maxGuestsPerReservation: Math.max(0, Number(e.target.value) || 0),
                        },
                      })
                    }
                  />
                  {config.escalation.maxGuestsPerReservation > 0 ? (
                    <div className="mt-1 text-xs text-gray-500">
                      Vid {config.escalation.maxGuestsPerReservation} gäster eller fler ska gästen kontakta er via e‑post.
                    </div>
                  ) : null}
                </Field>

                <Field label="Max tid per bokning (minuter)">
                  <select
                    className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-pink-400 focus:border-pink-300"
                    value={config.seating.maxBookingDurationMin || ""}
                    onChange={(e) =>
                      setConfig({
                        ...config,
                        seating: { ...config.seating, maxBookingDurationMin: Number(e.target.value) || 0 },
                      })
                    }
                  >
                    <option value="">—</option>
                    <option value={60}>60</option>
                    <option value={90}>90</option>
                    <option value={120}>120</option>
                  </select>
                </Field>

                <Field label="Barnstolar">
                  <input
                    type="number"
                    className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-pink-400 focus:border-pink-300"
                    value={config.seating.highChairs || ""}
                    onChange={(e) =>
                      setConfig({
                        ...config,
                        seating: { ...config.seating, highChairs: Math.max(0, Number(e.target.value) || 0) },
                      })
                    }
                  />
                </Field>
              </div>

              <div className="mt-6 rounded-lg border border-gray-200 bg-gray-50 p-3">
                <div className="mb-3 text-base font-bold text-gray-800">Måltidskategorier</div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {MEAL_KEYS.map((meal) => (
                    <div key={meal} className="rounded-lg border border-gray-200 bg-white p-3">
                      <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-gray-800">
                        <span className={`h-2.5 w-2.5 rounded-full ${MEAL_THEME_CLASSES[meal].swatch}`} />
                        <span>{meal}</span>
                      </div>
                      <div className={settingsTimeGridClass}>
                        <input
                          type="time"
                          className={settingsTimeInputClass}
                          value={mealRanges[meal][0]}
                          onChange={(e) => updateMealRange(meal, 0, e.target.value)}
                        />
                        <input
                          type="time"
                          className={settingsTimeInputClass}
                          value={mealRanges[meal][1]}
                          onChange={(e) => updateMealRange(meal, 1, e.target.value)}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="mt-6">
                <div className="flex items-center justify-between mb-2">
                  <div className="text-base font-bold text-gray-800">Öppettider</div>
                  <button
                    type="button"
                    className="px-3 py-1.5 rounded-lg text-sm bg-pink-500 text-white hover:bg-pink-600 shadow"
                    onClick={addHoursPeriod}
                  >
                    Lägg till period
                  </button>
                </div>
                <div className="space-y-4">
                  {config.hours.periods.map((period, idx) => (
                    <div key={period.id} className="rounded-lg border border-pink-200 bg-pink-50/40 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                        <input
                          type="text"
                          className="text-sm font-semibold text-violet-700 bg-violet-100/60 border border-transparent focus:border-violet-300 focus:outline-none w-full max-w-[220px] rounded-md px-2 py-1"
                          value={period.name ?? `Period ${idx + 1}`}
                          onFocus={() => {
                            if (!period.name) {
                              setConfig((prev) => ({
                                ...prev,
                                hours: {
                                  ...prev.hours,
                                  periods: prev.hours.periods.map((p) =>
                                    p.id === period.id ? { ...p, name: `Period ${idx + 1}` } : p
                                  ),
                                },
                              }));
                            }
                          }}
                          onChange={(e) =>
                            setConfig((prev) => ({
                              ...prev,
                              hours: {
                                ...prev.hours,
                                periods: prev.hours.periods.map((p) =>
                                  p.id === period.id ? { ...p, name: e.target.value } : p
                                ),
                              },
                            }))
                          }
                        />
                        <div className="flex items-center gap-3">
                          <button
                            type="button"
                            className="text-xs text-gray-600 hover:text-gray-900"
                            onClick={() =>
                              setOpenPeriods((prev) => ({ ...prev, [period.id]: !prev[period.id] }))
                            }
                          >
                            {openPeriods[period.id] ? "Dölj" : "Visa"}
                          </button>
                          {config.hours.periods.length > 1 && (
                            <button
                              type="button"
                              className="text-xs text-pink-700 hover:text-pink-800"
                              onClick={() => removeHoursPeriod(period.id)}
                            >
                              Ta bort period
                            </button>
                          )}
                        </div>
                      </div>
                      {openPeriods[period.id] ? (
                        <>
                          <div className="grid grid-cols-1 sm:grid-cols-2 items-end gap-2">
                            <div>
                              <Field label="Från">
                                <SwedishDateInput
                                  className={settingsDateInputClass}
                                  value={period.from}
                                  onChange={(value) =>
                                    setConfig((prev) => ({
                                      ...prev,
                                      hours: {
                                        ...prev.hours,
                                        periods: prev.hours.periods.map((p) =>
                                          p.id === period.id ? { ...p, from: value } : p
                                        ),
                                      },
                                    }))
                                  }
                                />
                              </Field>
                            </div>
                            <div>
                              <Field label="Till">
                                <SwedishDateInput
                                  className={settingsDateInputClass}
                                  value={period.to}
                                  onChange={(value) =>
                                    setConfig((prev) => ({
                                      ...prev,
                                      hours: {
                                        ...prev.hours,
                                        periods: prev.hours.periods.map((p) =>
                                          p.id === period.id ? { ...p, to: value } : p
                                        ),
                                      },
                                    }))
                                  }
                                />
                              </Field>
                            </div>
                          </div>
                          <div className="mt-3 divide-y rounded-lg border border-pink-200 bg-white/70">
                            {DAYS_ORDER.map((day) => {
                              const d = period.days[day];
                              return (
                                <div key={day} className="grid grid-cols-1 sm:grid-cols-12 items-center gap-2 px-3 py-2">
                                  <div className="flex items-center justify-between sm:col-span-4">
                                    <div className="capitalize">{day}</div>
                                    <label className="inline-flex items-center gap-2 text-sm whitespace-nowrap">
                                      <input
                                        type="checkbox"
                                        checked={d.closed}
                                        onChange={(e) =>
                                          setConfig((prev) => ({
                                            ...prev,
                                            hours: {
                                              ...prev.hours,
                                              periods: prev.hours.periods.map((p) =>
                                                p.id === period.id
                                                  ? {
                                                      ...p,
                                                      days: {
                                                        ...p.days,
                                                        [day]: { ...p.days[day], closed: e.target.checked },
                                                      },
                                                    }
                                                  : p
                                              ),
                                            },
                                          }))
                                        }
                                      />
                                      Stängt
                                    </label>
                                  </div>
                                  <div className={`${settingsTimeGridClass} sm:col-span-8`}>
                                    <input
                                      type="time"
                                      className={settingsTimeInputClass}
                                      value={d.open}
                                      onChange={(e) =>
                                        setConfig((prev) => ({
                                          ...prev,
                                          hours: {
                                            ...prev.hours,
                                            periods: prev.hours.periods.map((p) =>
                                              p.id === period.id
                                                ? {
                                                    ...p,
                                                    days: {
                                                      ...p.days,
                                                      [day]: { ...p.days[day], open: e.target.value },
                                                    },
                                                  }
                                                : p
                                            ),
                                          },
                                        }))
                                      }
                                      disabled={d.closed}
                                    />
                                    <input
                                      type="time"
                                      className={settingsTimeInputClass}
                                      value={d.close}
                                      onChange={(e) =>
                                        setConfig((prev) => ({
                                          ...prev,
                                          hours: {
                                            ...prev.hours,
                                            periods: prev.hours.periods.map((p) =>
                                              p.id === period.id
                                                ? {
                                                    ...p,
                                                    days: {
                                                      ...p.days,
                                                      [day]: { ...p.days[day], close: e.target.value },
                                                    },
                                                  }
                                                : p
                                            ),
                                          },
                                        }))
                                      }
                                      disabled={d.closed}
                                    />
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>

              <div className="mt-6">
                <div className="flex items-center justify-between mb-2">
                  <div className="text-base font-bold text-gray-800">Röda dagar (helgdagar)</div>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      className="text-xs text-gray-600 hover:text-gray-900"
                      onClick={() => setShowHolidays((prev) => !prev)}
                    >
                      {showHolidays ? "Dölj" : "Visa"}
                    </button>
                    <select
                      className="h-9 rounded-lg border border-gray-300 bg-white px-3 text-sm"
                      value={holidayYear}
                      onChange={(e) => setHolidayYear(Number(e.target.value))}
                    >
                      {[currentYear, currentYear + 1].map((y) => (
                        <option key={y} value={y}>
                          {y}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {showHolidays ? (
                  <div className="space-y-2">
                    {(HOLIDAYS_BY_YEAR[holidayYear] ?? []).map((h) => {
                      const sp =
                        config.hours.special.find((s) => s.date === h.date) ||
                        ({ date: h.date, closed: true, open: "11:00", close: "17:00" } as const);

                      return (
                        <div key={h.date} className="grid grid-cols-1 sm:grid-cols-12 items-center gap-2">
                          <div className="sm:col-span-4">
                            {h.name}
                            <div className="text-xs text-gray-500">{h.date}</div>
                          </div>
                          <div className="flex items-center justify-between sm:col-span-4">
                            <label className="inline-flex items-center gap-2 text-sm whitespace-nowrap">
                              <input
                                type="checkbox"
                                checked={sp.closed}
                                onChange={(e) => upsertSpecialByDate(h.date, { closed: e.target.checked })}
                              />
                              Stängt
                            </label>
                          </div>
                          <div className={`${settingsTimeGridClass} sm:col-span-4`}>
                            <input
                              type="time"
                              className={settingsTimeInputClass}
                              value={sp.open}
                              onChange={(e) => upsertSpecialByDate(h.date, { open: e.target.value })}
                              disabled={sp.closed}
                            />
                            <input
                              type="time"
                              className={settingsTimeInputClass}
                              value={sp.close}
                              onChange={(e) => upsertSpecialByDate(h.date, { close: e.target.value })}
                              disabled={sp.closed}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : null}

                <div className="mt-6 rounded-lg border border-pink-200 bg-pink-50/40 p-3">
                  <div className="text-base font-bold text-gray-800 mb-2">Stängda perioder</div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 items-end gap-2 justify-items-center sm:justify-items-stretch">
                    <div className="w-full sm:w-auto">
                      <Field label="Från" className="text-center sm:text-left">
                        <SwedishDateInput
                          className={settingsDateInputClass}
                          value={customClosureFrom}
                          onChange={setCustomClosureFrom}
                        />
                      </Field>
                    </div>
                    <div className="w-full sm:w-auto">
                      <Field label="Till" className="text-center sm:text-left">
                        <SwedishDateInput
                          className={settingsDateInputClass}
                          value={customClosureTo}
                          onChange={setCustomClosureTo}
                        />
                      </Field>
                    </div>
                    <div>
                      <div className="w-full flex flex-col gap-2">
                        <button
                          type="button"
                          className="w-full px-4 py-2 rounded-lg bg-pink-500 text-white hover:bg-pink-600 shadow"
                          onClick={addCustomClosures}
                        >
                          {editingClosedRange ? "Uppdatera period" : "Lägg till period"}
                        </button>
                        {editingClosedRange ? (
                          <button
                            type="button"
                            className="w-full px-4 py-2 rounded-lg border border-pink-200 text-pink-700 hover:bg-pink-50"
                            onClick={cancelClosedRangeEdit}
                          >
                            Avbryt
                          </button>
                        ) : null}
                      </div>
                    </div>
                  </div>
                  <div className="mt-2 text-xs text-gray-500">Ex: semester 15–31 juli. Klicka på en sparad period för att redigera.</div>

                  <div className="mt-3 space-y-2">
                    {closedRanges.length ? (
                      closedRanges.map((r) => (
                        <div
                          key={`${r.from}-${r.to}`}
                          className={`flex items-center justify-between text-sm bg-white/70 border rounded-lg px-3 py-2 cursor-pointer ${
                            editingClosedRange?.from === r.from && editingClosedRange?.to === r.to
                              ? "border-pink-400 ring-2 ring-pink-200"
                              : "border-pink-200 hover:bg-pink-50/60"
                          }`}
                          onClick={() => beginClosedRangeEdit(r.from, r.to)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              beginClosedRangeEdit(r.from, r.to);
                            }
                          }}
                          role="button"
                          tabIndex={0}
                        >
                          <div className="text-gray-800">
                            {r.from === r.to ? r.from : `${r.from} → ${r.to}`} <span className="text-xs text-gray-500">({r.count} dagar)</span>
                          </div>
                          <button
                            type="button"
                            className="text-xs text-pink-700 hover:text-pink-800"
                            onClick={(event) => {
                              event.stopPropagation();
                              removeClosedRange(r.from, r.to);
                            }}
                          >
                            Ta bort
                          </button>
                        </div>
                      ))
                    ) : (
                      <div className="text-xs text-gray-500">Inga stängda perioder sparade.</div>
                    )}
                  </div>
                </div>
              </div>

            </Section>

            <Section title="Konto & säkerhet">
              <div
                className="space-y-3"
                onInputCapture={(event) => event.stopPropagation()}
                onChangeCapture={(event) => event.stopPropagation()}
              >
                <div className="text-sm text-gray-600">Byt lösenord för kontot: {profileEmail || "—"}</div>

                <Field label="Nytt lösenord">
                  <input
                    type="password"
                    className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-pink-400 focus:border-pink-300"
                    value={passwordChangeValue}
                    onChange={(event) => {
                      setPasswordChangeValue(event.target.value);
                      setPasswordChangeMsg(null);
                    }}
                    placeholder="Minst 8 tecken"
                    autoComplete="new-password"
                  />
                </Field>

                <Field label="Bekräfta nytt lösenord">
                  <input
                    type="password"
                    className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-pink-400 focus:border-pink-300"
                    value={passwordConfirmValue}
                    onChange={(event) => {
                      setPasswordConfirmValue(event.target.value);
                      setPasswordChangeMsg(null);
                    }}
                    placeholder="Skriv samma lösenord igen"
                    autoComplete="new-password"
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        handleChangePassword();
                      }
                    }}
                  />
                </Field>

                <button
                  type="button"
                  className="w-full rounded-lg bg-pink-600 px-4 py-2 font-semibold text-white hover:bg-pink-700 disabled:opacity-60"
                  disabled={passwordChangeLoading || !passwordChangeValue || !passwordConfirmValue}
                  onClick={handleChangePassword}
                >
                  {passwordChangeLoading ? "Sparar..." : "Byt lösenord"}
                </button>

                {passwordChangeMsg ? (
                  <div
                    className={`rounded-lg px-3 py-2 text-sm ${
                      passwordChangeMsg.type === "error"
                        ? "border border-rose-200 bg-rose-50 text-rose-700"
                        : "border border-emerald-200 bg-emerald-50 text-emerald-700"
                    }`}
                  >
                    {passwordChangeMsg.text}
                  </div>
                ) : null}
              </div>
            </Section>

            <Section title="AI-profil & kunskapsbas">
              <div className="mb-3 text-sm text-gray-600">Inloggad: {profileEmail || "—"}</div>

              <Field label="Namn (kundprofil)" labelClassName="text-base font-bold text-gray-800">
                <input
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-pink-400 focus:border-pink-300"
                  value={profileName}
                  onChange={(e) => setProfileName(e.target.value)}
                  placeholder="Förnamn Efternamn"
                />
              </Field>

              <Field label="Namn på assistent" labelClassName="text-base font-bold text-gray-800">
                <input
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-pink-400 focus:border-pink-300"
                  value={config.ai.name}
                  onChange={(e) => setConfig({ ...config, ai: { ...config.ai, name: e.target.value } })}
                />
              </Field>

              <div className="mt-3 text-sm font-semibold text-violet-700 whitespace-nowrap">
                Ju mer info du lägger in, desto bättre svarar assistenten.
              </div>

              <div className="mt-2 rounded-lg border border-pink-200 bg-pink-50/30 p-3">
              <div className="text-sm font-semibold text-gray-700 mb-2">Kunskapsbas</div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-sm">
                <input
                  className="w-full rounded-lg border border-gray-300 px-3 py-2"
                  placeholder="Namn på restaurang"
                  value={onboarding.restaurantName}
                  onChange={(e) => {
                    setOnboarding({ ...onboarding, restaurantName: e.target.value });
                    setOnboardingDirty(true);
                  }}
                />
                <input
                  className="w-full rounded-lg border border-gray-300 px-3 py-2"
                  placeholder="Typ av restaurang (ex: Café & bistro, vinbar...)"
                  value={onboarding.restaurantType}
                  onChange={(e) => {
                    setOnboarding({ ...onboarding, restaurantType: e.target.value });
                    setOnboardingDirty(true);
                  }}
                />
                <input
                  className="w-full rounded-lg border border-gray-300 px-3 py-2"
                  placeholder="Adress"
                  value={onboarding.address}
                  onChange={(e) => {
                    setOnboarding({ ...onboarding, address: e.target.value });
                    setOnboardingDirty(true);
                  }}
                />
                <input
                  className="w-full rounded-lg border border-gray-300 px-3 py-2"
                  placeholder="Avstånd (ex: 12 km från Göteborg)"
                  value={onboarding.distance}
                  onChange={(e) => {
                    setOnboarding({ ...onboarding, distance: e.target.value });
                    setOnboardingDirty(true);
                  }}
                />
                <input
                  className="w-full rounded-lg border border-gray-300 px-3 py-2"
                  placeholder="E‑post"
                  value={onboarding.email}
                  onChange={(e) => {
                    setOnboarding({ ...onboarding, email: e.target.value });
                    setOnboardingDirty(true);
                  }}
                />
                <input
                  className="w-full rounded-lg border border-gray-300 px-3 py-2"
                  placeholder="Telefon"
                  value={onboarding.phone}
                  onChange={(e) => {
                    setOnboarding({ ...onboarding, phone: e.target.value });
                    setOnboardingDirty(true);
                  }}
                />
                  <textarea
                    rows={3}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 md:col-span-2"
                    placeholder="Hur skulle du beskriva din restaurang? (stämning, målgrupp...)"
                    value={onboarding.restaurantDescription}
                    onChange={(e) => {
                      setOnboarding({ ...onboarding, restaurantDescription: e.target.value });
                      setOnboardingDirty(true);
                    }}
                  />
                  <textarea
                    rows={3}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 md:col-span-2"
                    placeholder="Vilken typ av mat serverar ni? (ex: husmanskost, vegetarisk...)"
                    value={onboarding.foodType}
                    onChange={(e) => {
                      setOnboarding({ ...onboarding, foodType: e.target.value });
                      setOnboardingDirty(true);
                    }}
                  />
                  <textarea
                    rows={3}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 md:col-span-2"
                    placeholder="Grupp & event (ex: födelsedag, större sällskap, företagsevent...)"
                    value={onboarding.groupEvents}
                    onChange={(e) => {
                      setOnboarding({ ...onboarding, groupEvents: e.target.value });
                      setOnboardingDirty(true);
                    }}
                  />
                  <input
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 md:col-span-2"
                    placeholder="Betalning (ex: kort, kontant, Swish)"
                    value={onboarding.payment}
                    onChange={(e) => {
                      setOnboarding({ ...onboarding, payment: e.target.value });
                      setOnboardingDirty(true);
                    }}
                  />
                  <input
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 md:col-span-2"
                    placeholder="Allergier (ex: gluten/laktos/nötter)"
                    value={onboarding.allergies}
                    onChange={(e) => {
                      setOnboarding({ ...onboarding, allergies: e.target.value });
                      setOnboardingDirty(true);
                    }}
                  />
                  <label className="flex items-center gap-2 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700">
                    <input
                      type="checkbox"
                      checked={onboarding.kidsChair}
                      onChange={(e) => {
                        setOnboarding({ ...onboarding, kidsChair: e.target.checked });
                        setOnboardingDirty(true);
                      }}
                    />
                    Barnstol
                  </label>
                  <label className="flex items-center gap-2 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700">
                    <input
                      type="checkbox"
                      checked={onboarding.outdoorSeating}
                      onChange={(e) => {
                        setOnboarding({ ...onboarding, outdoorSeating: e.target.checked });
                        setOnboardingDirty(true);
                      }}
                    />
                    Uteservering
                  </label>
                  <input
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 md:col-span-2"
                    placeholder="Barnmeny (ex: pannkakor, köttbullar, mindre portioner)"
                    value={onboarding.kidsNote}
                    onChange={(e) => {
                      setOnboarding({ ...onboarding, kidsNote: e.target.value });
                      setOnboardingDirty(true);
                    }}
                  />
                  <label className="flex items-center gap-2 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700">
                    <input
                      type="checkbox"
                      checked={onboarding.dogFriendly}
                      onChange={(e) => {
                        setOnboarding({ ...onboarding, dogFriendly: e.target.checked });
                        setOnboardingDirty(true);
                      }}
                    />
                    Hundvänligt
                  </label>
                  <label className="flex items-center gap-2 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700">
                    <input
                      type="checkbox"
                      checked={onboarding.wheelchair}
                      onChange={(e) => {
                        setOnboarding({ ...onboarding, wheelchair: e.target.checked });
                        setOnboardingDirty(true);
                      }}
                    />
                    Rullstolsanpassad
                  </label>
                  <label className="flex items-center gap-2 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700">
                    <input
                      type="checkbox"
                      checked={onboarding.alcoholLicense}
                      onChange={(e) => {
                        setOnboarding({ ...onboarding, alcoholLicense: e.target.checked });
                        setOnboardingDirty(true);
                      }}
                    />
                    Alkoholtillstånd
                  </label>
                  <input
                    type="number"
                    min={0}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2"
                    placeholder="Köket stänger (min före stängning)"
                    value={onboarding.kitchenCloseMinutes}
                    onChange={(e) => {
                      setOnboarding({ ...onboarding, kitchenCloseMinutes: e.target.value });
                      setOnboardingDirty(true);
                    }}
                  />
                  <input
                    className="w-full rounded-lg border border-gray-300 px-3 py-2"
                    placeholder="Djurpolicy"
                    value={onboarding.pets}
                    onChange={(e) => {
                      setOnboarding({ ...onboarding, pets: e.target.value });
                      setOnboardingDirty(true);
                    }}
                  />
                  <input
                    className="w-full rounded-lg border border-gray-300 px-3 py-2"
                    placeholder="Parkering"
                    value={onboarding.parking}
                    onChange={(e) => {
                      setOnboarding({ ...onboarding, parking: e.target.value });
                      setOnboardingDirty(true);
                    }}
                  />
                  <input
                    className="w-full rounded-lg border border-gray-300 px-3 py-2"
                    placeholder="Kollektivtrafik"
                    value={onboarding.transport}
                    onChange={(e) => {
                      setOnboarding({ ...onboarding, transport: e.target.value });
                      setOnboardingDirty(true);
                    }}
                  />
                </div>

                <div className="mt-4 rounded-lg border border-gray-200 bg-white/70 p-3">
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-semibold text-gray-700">Webbsökning (beta)</div>
                    <label className="inline-flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={config.ai.webSearch.enabled}
                        onChange={(e) =>
                          setConfig((prev) => ({
                            ...prev,
                            ai: { ...prev.ai, webSearch: { ...prev.ai.webSearch, enabled: e.target.checked } },
                          }))
                        }
                      />
                      Tillåt webbsökning
                    </label>
                  </div>
                  <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-2 text-sm">
                    <input
                      className="w-full rounded-lg border border-gray-300 px-3 py-2"
                      placeholder="Site officiel (https://...)"
                      value={config.ai.webSearch.siteUrl}
                      onChange={(e) =>
                        setConfig((prev) => ({
                          ...prev,
                          ai: { ...prev.ai, webSearch: { ...prev.ai.webSearch, siteUrl: e.target.value } },
                        }))
                      }
                    />
                    <input
                      className="w-full rounded-lg border border-gray-300 px-3 py-2"
                      placeholder="Google Maps (lien)"
                      value={config.ai.webSearch.googleMapsUrl}
                      onChange={(e) =>
                        setConfig((prev) => ({
                          ...prev,
                          ai: { ...prev.ai, webSearch: { ...prev.ai.webSearch, googleMapsUrl: e.target.value } },
                        }))
                      }
                    />
                    <input
                      className="w-full rounded-lg border border-gray-300 px-3 py-2"
                      placeholder="Facebook (lien page)"
                      value={config.ai.webSearch.facebookUrl}
                      onChange={(e) =>
                        setConfig((prev) => ({
                          ...prev,
                          ai: { ...prev.ai, webSearch: { ...prev.ai.webSearch, facebookUrl: e.target.value } },
                        }))
                      }
                    />
                    <input
                      className="w-full rounded-lg border border-gray-300 px-3 py-2"
                      placeholder="Instagram (lien profil)"
                      value={config.ai.webSearch.instagramUrl}
                      onChange={(e) =>
                        setConfig((prev) => ({
                          ...prev,
                          ai: { ...prev.ai, webSearch: { ...prev.ai.webSearch, instagramUrl: e.target.value } },
                        }))
                      }
                    />
                  </div>
                  <div className="mt-2 text-xs text-gray-500">
                    Vi hämtar endast info från de länkar du anger här.
                  </div>
                </div>

                <div className="mt-3">
                  <div className="text-sm font-semibold text-gray-700 mb-2">Sparade frågor (kunskapsbas)</div>
                  {savedFaqs.length ? (
                    <div className="space-y-2">
                      {savedFaqs.map((f) => (
                        <div key={f.id} className="rounded-lg border border-gray-200 bg-white p-2">
                          <div className="flex items-center justify-between gap-2">
                            <div className="text-sm font-semibold text-gray-800">{f.q}</div>
                            <button
                              type="button"
                              className="text-xs text-pink-700 hover:text-pink-800"
                              onClick={() => removeFaq(f.id)}
                            >
                              Ta bort fråga
                            </button>
                          </div>
                          <div className="mt-1 flex items-center gap-2">
                            <input
                              className="w-full rounded-md border border-gray-300 px-2 py-1 text-sm"
                              placeholder="Skriv svar..."
                              value={getFaqInputValue(f.id, f.a)}
                              onChange={(e) => updateFaqDraftAnswer(f.id, e.target.value)}
                            />
                            <button
                              type="button"
                              className="h-8 w-8 rounded-md border border-emerald-300 bg-emerald-50 text-sm text-emerald-700 hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-50"
                              onClick={() => commitFaqAnswer(f.id, f.a)}
                              disabled={!hasFaqPendingChanges(f.id, f.a)}
                              aria-label="Validera svar"
                              title="Validera svar"
                            >
                              ✅
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-xs text-gray-500">Inga sparade frågor ännu.</div>
                  )}
                </div>
              </div>

              <div className="mt-2 text-xs text-gray-500">
                {aiSaveState === "saving" && "Autosparar…"}
                {aiSaveState === "saved" && "Autosparat"}
                {aiSaveState === "error" && `Kunde inte spara: ${aiSaveMessage}`}
              </div>

              <div className="text-sm mt-2">
                <div className="flex items-center gap-2 w-full">
                  <input
                    className="h-9 flex-1 rounded-lg border border-gray-300 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-pink-400 focus:border-pink-300"
                    placeholder="Lägg till fråga…"
                    value={newFaq}
                    onChange={(e) => setNewFaq(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") addFaq();
                    }}
                  />
                  <button
                    type="button"
                    className="h-9 w-9 rounded-lg border border-pink-300 bg-pink-50 text-pink-700 hover:bg-pink-100 hover:border-pink-400 transition"
                    onClick={addFaq}
                    aria-label="Lägg till fråga"
                    title="Lägg till"
                  >
                    +
                  </button>
                  <button
                    type="button"
                    className="h-9 px-3 rounded-lg border border-gray-300 text-xs"
                    onClick={generateCommonQuestion}
                  >
                    Generera fråga
                  </button>
                </div>
                {faqSuccess && <div className="mt-2 text-center text-xs text-green-700">Fråga tillagd</div>}
              </div>

              {draftFaqs.length ? (
                <div className="mt-3 rounded-lg border border-gray-200 bg-white p-2">
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-sm font-semibold text-gray-700">
                      Utkast (lägg till svar och spara) ({draftFaqs.length})
                    </div>
                    <button
                      type="button"
                      className="text-xs text-gray-600 hover:text-gray-900"
                      onClick={() => setShowDrafts((prev) => !prev)}
                    >
                      {showDrafts ? "Dölj" : "Visa"}
                    </button>
                  </div>
                  {showDrafts ? (
                    <div className="space-y-2">
                      {draftFaqs.map((f) => (
                        <div key={f.id} className="rounded-lg border border-gray-200 bg-white p-2">
                          <div className="flex items-center justify-between gap-2">
                            <div className="text-sm font-semibold text-gray-800">{f.q}</div>
                            <button
                              type="button"
                              className="text-xs text-pink-700 hover:text-pink-800"
                              onClick={() => removeFaq(f.id)}
                            >
                              Ta bort fråga
                            </button>
                          </div>
                          <div className="mt-1 flex items-center gap-2">
                            <input
                              className="w-full rounded-md border border-gray-300 px-2 py-1 text-sm"
                              placeholder="Skriv svar..."
                              value={getFaqInputValue(f.id, f.a)}
                              onChange={(e) => updateFaqDraftAnswer(f.id, e.target.value)}
                            />
                            <button
                              type="button"
                              className="h-8 w-8 rounded-md border border-emerald-300 bg-emerald-50 text-sm text-emerald-700 hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-50"
                              onClick={() => commitFaqAnswer(f.id, f.a)}
                              disabled={!hasFaqPendingChanges(f.id, f.a)}
                              aria-label="Validera svar"
                              title="Validera svar"
                            >
                              ✅
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}

              <div className="mt-4">
                <textarea
                  rows={2}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2"
                  placeholder="Skriv en fråga för att förhandsvisa svaret"
                  value={aiMsg}
                  onChange={(e) => setAiMsg(e.target.value)}
                />
                <div className="mt-2 flex gap-2">
                  <button
  className="px-4 py-2 rounded-lg bg-pink-500 text-white hover:bg-pink-600 shadow"
  onClick={async () => {
    setAiPreview("Tänker…");
    try {
      const reply = await callAi(aiMsg);
      setAiPreview(reply);
      setAiHistory((prev) =>
        [...prev, { role: "user" as const, content: aiMsg }, { role: "assistant" as const, content: reply }].slice(-12)
      );
    } catch (err) {
      setAiPreview(`Fel vid AI-anrop. ${err instanceof Error ? err.message : ""}`.trim());
    }
  }}
>
  Förhandsvisa
</button>

                  <button
                    className="px-4 py-2 rounded-lg border"
                    onClick={() => {
                      setAiPreview("");
                      setAiMsg("");
                      setAiHistory([]);
                    }}
                  >
                    Rensa
                  </button>
                </div>

                {aiPreview && (
                  <div className="mt-3 p-3 rounded-lg border border-pink-200 bg-gray-50 text-sm text-gray-800 whitespace-pre-wrap">
                    <div className="text-xs text-gray-500">Contexte : {dateSel} • 12:00</div>
                    <div className="mb-1 font-semibold text-pink-700">Svar från {config.ai.name}</div>
                    <div>{linkify(aiPreview)}</div>
                  </div>
                )}
              </div>

              <div className="mt-4 rounded-lg border border-gray-200 bg-gray-50 p-3">
                <div className="text-sm font-semibold text-gray-700 mb-2">Snabbtest (AI)</div>
                <button
                  className="px-3 py-1.5 rounded-lg bg-gray-800 text-white text-sm"
                  onClick={runAiTests}
                  disabled={testRunning}
                >
                  {testRunning ? "Testar..." : "Kör test"}
                </button>
                {testResults.length ? (
                  <div className="mt-3 space-y-2 text-sm">
                    {testResults.map((t, i) => (
                      <div key={`${t.q}-${i}`} className="rounded-md border border-gray-200 bg-white p-2">
                        <div className="flex items-center justify-between text-gray-700">
                          <div><strong>Q:</strong> {t.q}</div>
                          <span className={`text-xs font-semibold ${t.ok ? "text-green-600" : "text-amber-600"}`}>
                            {t.ok ? "OK" : "À améliorer"}
                          </span>
                        </div>
                        <div className="text-gray-800"><strong>A:</strong> {t.reply}</div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            </Section>

            <div className="flex justify-end gap-2">
              <button className="px-4 py-2 rounded-lg border" onClick={() => setSettingsOpen(false)}>
                Stäng
              </button>
            </div>
          </div>
        </Drawer>
      )}

      <footer className="mt-12 text-center text-sm text-gray-400">© 2026 Bokäta. Stockholm, Sweden. All rights reserved.</footer>
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
  sub,
  secondaryLabel,
  secondaryValue,
  secondarySub,
}: {
  icon?: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  secondaryLabel?: string;
  secondaryValue?: string;
  secondarySub?: string;
}) {
  return (
    <div className="bg-white p-4 shadow-lg rounded-lg border-2 border-[#4b0c73]">
      <p className="text-sm text-gray-500 flex items-center gap-2">
        {icon ? <span className="text-base">{icon}</span> : null}
        <span>{label}</span>
      </p>
      <h2 className="text-xl font-bold text-gray-800">{value}</h2>
      {sub ? <p className="text-xs text-gray-500 mt-1">{sub}</p> : null}
      {secondaryLabel ? (
        <div className="mt-3 border-t border-[#4b0c73]/15 pt-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-[#4b0c73]">{secondaryLabel}</p>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-lg font-bold text-gray-800">{secondaryValue}</span>
            {secondarySub ? <span className="text-xs text-gray-500">{secondarySub}</span> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function linkify(text: string) {
  const nodes: React.ReactNode[] = [];
  const mdLink = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null = null;
  let key = 0;

  const pushPlain = (segment: string) => {
    const parts = segment.split(/(https?:\/\/[^\s)]+)\b/);
    parts.forEach((part) => {
      if (!part) return;
      if (/^https?:\/\//i.test(part)) {
        nodes.push(
          <a key={`url-${key++}`} href={part} target="_blank" rel="noreferrer" className="text-pink-700 underline">
            {part}
          </a>
        );
        return;
      }
      nodes.push(<React.Fragment key={`txt-${key++}`}>{part}</React.Fragment>);
    });
  };

  while ((match = mdLink.exec(text))) {
    if (match.index > lastIndex) {
      pushPlain(text.slice(lastIndex, match.index));
    }
    const label = match[1];
    const url = match[2];
    nodes.push(
      <a key={`md-${key++}`} href={url} target="_blank" rel="noreferrer" className="text-pink-700 underline">
        {label}
      </a>
    );
    lastIndex = mdLink.lastIndex;
  }

  if (lastIndex < text.length) {
    pushPlain(text.slice(lastIndex));
  }

  return nodes;
}

function Modal({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden="true" />
      <div role="dialog" aria-modal="true" className="relative bg-white rounded-2xl shadow-xl w-[92vw] max-w-md p-6 border border-pink-200">
        <button className="absolute top-3 right-3 text-gray-500 hover:text-gray-700" onClick={onClose} aria-label="Stäng">
          ✕
        </button>
        {children}
      </div>
    </div>
  );
}

function Drawer({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden="true" />
      <div className="absolute right-0 top-0 h-full w-full max-w-2xl bg-gradient-to-b from-pink-50 via-white to-purple-50 shadow-xl border-l border-pink-200 p-6 overflow-y-auto">
        <div className="sticky top-0 z-10 flex items-center justify-between mb-4 bg-white/80 backdrop-blur border-b border-pink-200 rounded-t-xl px-1 py-3">
          <h4 className="text-xl font-bold text-gray-800">Inställningar</h4>
          <button className="text-gray-500 hover:text-gray-700" onClick={onClose} aria-label="Stäng">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

const SWEDISH_MONTHS = [
  "januari", "februari", "mars", "april", "maj", "juni",
  "juli", "augusti", "september", "oktober", "november", "december",
];
const SWEDISH_WEEKDAYS = ["Må", "Ti", "On", "To", "Fr", "Lö", "Sö"];

function SwedishDateInput({
  value,
  onChange,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  const selected = value ? new Date(`${value}T12:00:00`) : null;
  const initial = selected && !Number.isNaN(selected.getTime()) ? selected : new Date();
  const [open, setOpen] = useState(false);
  const [viewYear, setViewYear] = useState(initial.getFullYear());
  const [viewMonth, setViewMonth] = useState(initial.getMonth());
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const moveMonth = (delta: number) => {
    const next = new Date(viewYear, viewMonth + delta, 1);
    setViewYear(next.getFullYear());
    setViewMonth(next.getMonth());
  };

  const firstDay = new Date(viewYear, viewMonth, 1);
  const mondayOffset = (firstDay.getDay() + 6) % 7;
  const gridStart = new Date(viewYear, viewMonth, 1 - mondayOffset);
  const days = Array.from({ length: 42 }, (_, index) => {
    const date = new Date(gridStart);
    date.setDate(gridStart.getDate() + index);
    return date;
  });
  const todayIso = toIsoDate(new Date());

  const chooseDate = (date: Date) => {
    onChange(`${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`);
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="relative">
      <div className="relative">
        <input
          type="text"
          inputMode="none"
          readOnly
          value={value}
          placeholder="ÅÅÅÅ-MM-DD"
          aria-label="Välj datum"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
          className={`${className ?? ""} cursor-pointer pr-9`}
        />
        <button
          type="button"
          aria-label="Öppna kalender"
          onClick={() => setOpen((current) => !current)}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-600 hover:text-pink-700"
        >
          ▣
        </button>
      </div>
      {open ? (
        <div className="absolute left-1/2 z-[70] mt-2 w-[292px] -translate-x-1/2 rounded-xl border border-pink-200 bg-white p-3 text-left shadow-xl sm:left-0 sm:translate-x-0">
          <div className="mb-3 flex items-center justify-between">
            <button type="button" onClick={() => moveMonth(-1)} className="rounded-lg px-2 py-1 text-lg hover:bg-pink-50" aria-label="Föregående månad">‹</button>
            <div className="font-semibold text-gray-800">{SWEDISH_MONTHS[viewMonth]} {viewYear}</div>
            <button type="button" onClick={() => moveMonth(1)} className="rounded-lg px-2 py-1 text-lg hover:bg-pink-50" aria-label="Nästa månad">›</button>
          </div>
          <div className="grid grid-cols-7 text-center text-xs font-semibold text-gray-500">
            {SWEDISH_WEEKDAYS.map((day) => <div key={day} className="py-1">{day}</div>)}
          </div>
          <div className="grid grid-cols-7 gap-0.5">
            {days.map((date) => {
              const iso = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
              const isSelected = iso === value;
              const isToday = iso === todayIso;
              const inMonth = date.getMonth() === viewMonth;
              return (
                <button
                  key={iso}
                  type="button"
                  onClick={() => chooseDate(date)}
                  className={`h-9 rounded-lg text-sm ${
                    isSelected
                      ? "bg-pink-600 font-semibold text-white"
                      : inMonth
                      ? "text-gray-800 hover:bg-pink-50"
                      : "text-gray-400 hover:bg-gray-50"
                  } ${isToday && !isSelected ? "ring-1 ring-pink-400" : ""}`}
                >
                  {date.getDate()}
                </button>
              );
            })}
          </div>
          <div className="mt-2 flex justify-between border-t border-gray-100 pt-2 text-sm">
            <button type="button" onClick={() => onChange("")} className="px-2 py-1 text-gray-500 hover:text-gray-800">Rensa</button>
            <button type="button" onClick={() => chooseDate(new Date())} className="px-2 py-1 font-medium text-pink-700 hover:text-pink-800">Idag</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border border-pink-200 rounded-xl p-4 bg-white shadow-sm">
      <h5 className="font-semibold mb-3 text-pink-700">{title}</h5>
      {children}
    </section>
  );
}

function Field({
  label,
  children,
  className,
  labelClassName,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
  labelClassName?: string;
}) {
  return (
    <label className={`block text-sm ${className ?? ""}`}>
      <span className={`text-gray-600 ${labelClassName ?? ""}`}>{label}</span>
      {children}
    </label>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="inline-flex items-center gap-2">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

export default function ReservationDashboard() {
  return (
    <DashboardErrorBoundary>
      <ReservationDashboardInner />
    </DashboardErrorBoundary>
  );
}
