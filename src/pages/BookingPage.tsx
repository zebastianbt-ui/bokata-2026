import { bookingFarewell } from "../../lib/bookingFarewell";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../supabaseClient";
import forkTransparent from "../assets/fork-transparent.png";
import {
  BOOKING_TIME_ZONE,
  FULLY_BOOKED_NOTICE_DATES,
  MADAME_BLA_CLOSED_DATES,
  getMadameBlaDropInRange,
  getMadameBlaHoursOverride,
  isIsoInRange,
  isMadameBlaKnowledge,
  isManuallyFullBookedSlot,
  latestBookingTimeForDate,
  normalizeSlotTime,
} from "../../lib/specialRestaurantRules";

/**
 * Bokäta – Bokningssida (v2, rosa+lila)
 * Komplett bokningsflöde på svenska.
 *
 */

type Reservation = {
  id: string;
  restaurantSlug: string;
  date: string;
  time: string;
  guests: number;
  name: string;
  email: string;
  phone?: string;
  notes?: string;
  status: "pending" | "confirmed" | "cancelled";
  createdAt: string;
};

type DayName = "måndag" | "tisdag" | "onsdag" | "torsdag" | "fredag" | "lördag" | "söndag";

type HoursPeriod = {
  id?: string;
  name?: string;
  from: string;
  to: string;
  days: Record<DayName, { closed: boolean; open: string; close: string }>;
};

type BookingPublicSettings = {
  public_id: string;
  hours: {
    normal: Record<DayName, { closed: boolean; open: string; close: string }>;
    special: { date: string; closed: boolean; open: string; close: string }[];
    periods?: HoursPeriod[];
  };
  seating: {
    maxGuests: number;
    maxGuestsPerReservation: number;
    groupThreshold: number;
    maxBookingDurationMin: number;
  };
  knowledge_public?: string | null;
  notify_email?: string | null;
  notify_enabled?: boolean | null;
  require_manual_confirmation?: boolean | null;
};

const DEFAULT_HOURS: BookingPublicSettings["hours"] = {
  normal: {
    måndag: { closed: false, open: "11:00", close: "21:00" },
    tisdag: { closed: false, open: "11:00", close: "21:00" },
    onsdag: { closed: false, open: "11:00", close: "21:00" },
    torsdag: { closed: false, open: "11:00", close: "21:00" },
    fredag: { closed: false, open: "11:00", close: "21:00" },
    lördag: { closed: false, open: "11:00", close: "21:00" },
    söndag: { closed: false, open: "11:00", close: "21:00" },
  },
  special: [],
  periods: [
    {
      id: "default",
      from: new Date().toISOString().slice(0, 10),
      to: new Date(new Date().setFullYear(new Date().getFullYear() + 1)).toISOString().slice(0, 10),
      days: {
        måndag: { closed: false, open: "11:00", close: "21:00" },
        tisdag: { closed: false, open: "11:00", close: "21:00" },
        onsdag: { closed: false, open: "11:00", close: "21:00" },
        torsdag: { closed: false, open: "11:00", close: "21:00" },
        fredag: { closed: false, open: "11:00", close: "21:00" },
        lördag: { closed: false, open: "11:00", close: "21:00" },
        söndag: { closed: false, open: "11:00", close: "21:00" },
      },
    },
  ],
};

const EMPTY_HOURS: BookingPublicSettings["hours"] = {
  normal: {
    måndag: { closed: true, open: "", close: "" },
    tisdag: { closed: true, open: "", close: "" },
    onsdag: { closed: true, open: "", close: "" },
    torsdag: { closed: true, open: "", close: "" },
    fredag: { closed: true, open: "", close: "" },
    lördag: { closed: true, open: "", close: "" },
    söndag: { closed: true, open: "", close: "" },
  },
  special: [],
  periods: [],
};

const DEFAULT_SEATING: BookingPublicSettings["seating"] = {
  maxGuests: 60,
  maxGuestsPerReservation: 8,
  groupThreshold: 6,
  maxBookingDurationMin: 90,
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

function loadReservations(): Reservation[] {
  try {
    const raw = typeof window !== "undefined" ? localStorage.getItem("bokata_reservations") : null;
    return raw ? (JSON.parse(raw) as Reservation[]) : [];
  } catch {
    return [];
  }
}

function saveReservation(r: Reservation) {
  const existing = loadReservations();
  const updated = [r, ...existing].slice(0, 2000);
  if (typeof window !== "undefined") {
    localStorage.setItem("bokata_reservations", JSON.stringify(updated));
    window.dispatchEvent(new CustomEvent("bokata:new-reservation", { detail: r }));
    localStorage.setItem("bokata_last_update", String(Date.now()));
  }
}

function toISODateInputValue(date = new Date()) {
  const tz = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return tz.toISOString().split("T")[0];
}

function cloneDays(days: Record<DayName, { closed: boolean; open: string; close: string }>) {
  return {
    måndag: { ...days.måndag },
    tisdag: { ...days.tisdag },
    onsdag: { ...days.onsdag },
    torsdag: { ...days.torsdag },
    fredag: { ...days.fredag },
    lördag: { ...days.lördag },
    söndag: { ...days.söndag },
  };
}

function defaultPeriodRange() {
  const start = new Date();
  const end = new Date();
  end.setFullYear(end.getFullYear() + 1);
  return { from: toISODateInputValue(start), to: toISODateInputValue(end) };
}

function normalizeHours(hours: BookingPublicSettings["hours"]) {
  const normal = hours.normal ? cloneDays(hours.normal) : cloneDays(DEFAULT_HOURS.normal);
  const special = Array.isArray(hours.special) ? [...hours.special] : [];
  const rawPeriods = Array.isArray(hours.periods) ? hours.periods : [];
  const { from, to } = defaultPeriodRange();
  const periods =
    rawPeriods.length > 0
      ? rawPeriods.map((p) => ({
          id: p.id,
          name: p.name,
          from: p.from || from,
          to: p.to || to,
          days: cloneDays(p.days ?? normal),
        }))
      : [
          {
            id: "default",
            from,
            to,
            days: cloneDays(normal),
          },
        ];
  return { normal, special, periods };
}

function periodSpanDays(from: string, to: string) {
  const a = new Date(from + "T00:00:00Z");
  const b = new Date(to + "T00:00:00Z");
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor((b.getTime() - a.getTime()) / 86400000));
}

function pickPeriodForDate(periods: HoursPeriod[], iso: string) {
  const matches = periods.filter((p) => isIsoInRange(iso, p.from, p.to));
  if (!matches.length) return null;
  return matches.sort((a, b) => periodSpanDays(a.from, a.to) - periodSpanDays(b.from, b.to))[0];
}

function makeId(prefix = "resv") {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;
}

function genTimeSlots(start = "11:00", end = "21:00", stepMin = 30, lastBookingBufferMin = 60) {
  const out: string[] = [];
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  const startMins = sh * 60 + sm;
  const endMins = eh * 60 + em;
  const lastStart = Math.max(startMins, endMins - lastBookingBufferMin);
  for (let m = startMins; m <= lastStart; m += stepMin) {
    const h = Math.floor(m / 60)
      .toString()
      .padStart(2, "0");
    const mm = (m % 60).toString().padStart(2, "0");
    out.push(`${h}:${mm}`);
  }
  return out;
}

function getNowInBookingTimeZone() {
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
}

function isPastBookingSlot(dateIso: string, timeValue: string | undefined, now: { date: string; time: string }) {
  if (dateIso < now.date) return true;
  if (!timeValue || dateIso > now.date) return false;
  return normalizeSlotTime(timeValue) < now.time;
}

function timeToMin(value: string) {
  const [h, m] = value.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return NaN;
  return h * 60 + m;
}

const weekdaySv: DayName[] = ["söndag", "måndag", "tisdag", "onsdag", "torsdag", "fredag", "lördag"];
const toDayName = (iso: string): DayName | null => {
  const d = new Date(iso + "T00:00:00");
  if (Number.isNaN(d.getTime())) return null;
  return weekdaySv[d.getDay()];
};

function mockAvailability(date: string, time: string, guests: number) {
  const d = new Date(date + "T" + (time || "12:00"));
  const dow = d.getDay();
  const busy = (dow === 5 || dow === 6) && ["18:00", "18:30", "19:00", "19:30", "20:00"].includes(time);
  const capacity = busy ? 24 : 40;
  const booked = Math.floor(((d.getTime() / 1000) % 7) + (busy ? 10 : 2));
  const available = Math.max(0, capacity - booked);
  return { capacity, booked, available, canFit: guests <= available };
}

function linkify(text: string) {
  const parts = text.split(/(https?:\/\/[^\s]+)/g);
  return parts.map((part, i) => {
    if (/^https?:\/\//.test(part)) {
      return (
        <a
          key={`link-${i}`}
          href={part}
          target="_blank"
          rel="noreferrer"
          className="text-pink-700 underline underline-offset-2"
        >
          {part}
        </a>
      );
    }
    return <span key={`text-${i}`}>{part}</span>;
  });
}

export default function BookingPage() {
  const SECTION_PAD_Y = "py-3 md:py-8";
  const SECTION_PAD_X = "px-6 md:px-10";
  const SECTION_PAD_Y_BOTTOM = "pt-6 pb-4 md:pt-8 md:pb-8";
  const [restaurantSlug, setRestaurantSlug] = useState("demo");
  const [missingRestaurant, setMissingRestaurant] = useState(false);
  const [restaurantName, setRestaurantName] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const fromQuery = params.get("r");
    const next = fromQuery || "";
    if (!next) {
      setMissingRestaurant(true);
      return;
    }
    setRestaurantSlug(next);
  }, []);

  if (missingRestaurant) {
    return (
      <div className="min-h-screen bg-pink-50 px-6 py-10 flex items-center justify-center">
        <div className="w-full max-w-md rounded-2xl border border-pink-200 bg-white p-6 text-center shadow-lg">
          <h1 className="text-2xl font-extrabold text-gray-900">Bokningslänk saknas</h1>
          <p className="mt-2 text-sm text-gray-600">
            Den här sidan är inte kopplad till någon restaurang. Be din restaurang om rätt bokningslänk.
          </p>
          <a
            href="/"
            className="mt-4 inline-flex items-center justify-center rounded-full bg-pink-600 px-4 py-2 text-sm font-semibold text-white hover:bg-pink-700"
          >
            Till startsidan
          </a>
        </div>
      </div>
    );
  }

  const [date, setDate] = useState<string>(toISODateInputValue());
  const [time, setTime] = useState<string>("");
  const [guests, setGuests] = useState<number>(2);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [created, setCreated] = useState<Reservation | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const [publicSettings, setPublicSettings] = useState<BookingPublicSettings | null>(null);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [qaQuestion, setQaQuestion] = useState("");
  const [qaAnswer, setQaAnswer] = useState<string | null>(null);
  const [qaLoading, setQaLoading] = useState(false);
  const [qaHistory, setQaHistory] = useState<{ role: "user" | "assistant"; content: string }[]>([]);
  const [clockTick, setClockTick] = useState(0);

  useEffect(() => {
    const id = window.setInterval(() => setClockTick((prev) => prev + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    let active = true;
    const load = async () => {
      if (!restaurantSlug || restaurantSlug === "demo") {
        if (active) {
          setPublicSettings(null);
          setSettingsLoaded(true);
        }
        return;
      }
      if (active) setSettingsLoaded(false);
      const { data } = await supabase
        .from("booking_public_settings")
        .select("public_id,hours,seating,knowledge_public")
        .eq("public_id", restaurantSlug)
        .maybeSingle();
      if (!active) return;
      if (data) setPublicSettings(data as BookingPublicSettings);
      setSettingsLoaded(true);
    };
    load();
    return () => {
      active = false;
    };
  }, [restaurantSlug]);

  const parseRestaurantNameFromKnowledge = (knowledge?: string | null) => {
    if (!knowledge) return null;
    const normalized = normalizeKnowledgeLabels(knowledge);
    const lines = normalized.split(/\r?\n/).map((l) => l.trim());
    const nameLine = lines.find((l) => l.toLowerCase().startsWith("namn:"));
    if (!nameLine) return null;
    const value = nameLine.split(":").slice(1).join(":").trim();
    return value || null;
  };
  const parseWebsiteFromKnowledge = (knowledge?: string | null) => {
    if (!knowledge) return null;
    const normalized = normalizeKnowledgeLabels(knowledge);
    const lines = normalized.split(/\r?\n/).map((l) => l.trim());
    const siteLine = lines.find(
      (l) =>
        l.toLowerCase().startsWith("webbplats:") ||
        l.toLowerCase().startsWith("hemsida:") ||
        l.toLowerCase().startsWith("website:")
    );
    if (siteLine) {
      const value = siteLine.split(":").slice(1).join(":").trim();
      return value || null;
    }
    const match = knowledge.match(/https?:\/\/[^\s]+/i);
    return match ? match[0] : null;
  };

  useEffect(() => {
    const loadName = async () => {
      if (!restaurantSlug || restaurantSlug === "demo") return;
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(restaurantSlug);
      if (!isUuid) {
        setRestaurantName(restaurantSlug);
        return;
      }
      const { data } = await supabase.from("restaurants").select("name").eq("id", restaurantSlug).maybeSingle();
      setRestaurantName(data?.name ?? null);
    };
    loadName();
  }, [restaurantSlug]);

  useEffect(() => {
    if (!publicSettings?.knowledge_public) return;
    const parsed = parseRestaurantNameFromKnowledge(publicSettings.knowledge_public);
    if (parsed && parsed !== restaurantName) {
      setRestaurantName(parsed);
    }
  }, [publicSettings?.knowledge_public, restaurantName]);
  const restaurantWebsite = useMemo(
    () => parseWebsiteFromKnowledge(publicSettings?.knowledge_public ?? ""),
    [publicSettings?.knowledge_public]
  );
  const bookingMessage = useMemo(
    () => extractMultilineLabelValue(publicSettings?.knowledge_public ?? "", BOOKING_MESSAGE_LABEL),
    [publicSettings?.knowledge_public]
  );

  const settingsLoading = !settingsLoaded && restaurantSlug !== "demo";
  const effectiveSettings = publicSettings ?? { public_id: restaurantSlug, hours: DEFAULT_HOURS, seating: DEFAULT_SEATING };
  const normalizedHours = useMemo(() => normalizeHours(effectiveSettings.hours), [effectiveSettings.hours]);
  const settingsMissing = settingsLoaded && !publicSettings && restaurantSlug !== "demo";
  const bookingNow = useMemo(() => getNowInBookingTimeZone(), [clockTick]);
  const madameBlaMode = useMemo(
    () => isMadameBlaKnowledge(restaurantName) || isMadameBlaKnowledge(publicSettings?.knowledge_public ?? ""),
    [restaurantName, publicSettings?.knowledge_public]
  );

  const isDateInPast = (iso: string) => isPastBookingSlot(iso, undefined, bookingNow);
  const isTimeSlotInPast = (iso: string, value: string) => isPastBookingSlot(iso, value, bookingNow);
  const isDropInOnlySlot = (iso: string, value: string) => {
    if (!madameBlaMode) return false;
    const day = toDayName(iso);
    const rule = getMadameBlaDropInRange(iso, day);
    if (!rule) return false;
    const mins = timeToMin(value);
    if (!Number.isFinite(mins)) return false;
    return mins >= rule.fromMin && mins < rule.toMinExclusive;
  };

  const isClosedDate = (iso: string) => {
    const day = toDayName(iso);
    const madameBlaOverride = madameBlaMode ? getMadameBlaHoursOverride(iso, day) : undefined;
    if (madameBlaOverride) return madameBlaOverride.closed;
    if (madameBlaMode && MADAME_BLA_CLOSED_DATES.has(iso)) return true;
    const special = normalizedHours.special.find((s) => s.date === iso);
    if (special) return special.closed;
    if (!day) return false;
    const period = pickPeriodForDate(normalizedHours.periods, iso);
    const d = (period?.days ?? normalizedHours.normal)[day];
    return d?.closed ?? false;
  };

  const dayHours = (iso: string) => {
    const day = toDayName(iso);
    const madameBlaOverride = madameBlaMode ? getMadameBlaHoursOverride(iso, day) : undefined;
    if (madameBlaOverride) return madameBlaOverride.closed ? null : { open: madameBlaOverride.open, close: madameBlaOverride.close };
    if (madameBlaMode && MADAME_BLA_CLOSED_DATES.has(iso)) return null;
    const special = normalizedHours.special.find((s) => s.date === iso);
    if (special) return special.closed ? null : { open: special.open, close: special.close };
    if (!day) return null;
    const period = pickPeriodForDate(normalizedHours.periods, iso);
    const d = (period?.days ?? normalizedHours.normal)[day];
    return d && !d.closed ? { open: d.open, close: d.close } : null;
  };

  const times = useMemo(() => {
    const h = dayHours(date);
    if (!h) return [];
    const slots = genTimeSlots(h.open, h.close, 30);
    const latestBookingTime = latestBookingTimeForDate(date);
    if (!latestBookingTime) return slots;
    return slots.filter((slot) => timeToMin(slot) <= timeToMin(latestBookingTime));
  }, [date, normalizedHours]);

  const findNextOpenDate = (startIso: string) => {
    const baselineIso = startIso < bookingNow.date ? bookingNow.date : startIso;
    if (dayHours(baselineIso) && !isDateInPast(baselineIso)) return baselineIso;
    const start = new Date(baselineIso + "T00:00:00");
    if (Number.isNaN(start.getTime())) return startIso;
    for (let i = 1; i <= 366; i += 1) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const iso = toISODateInputValue(d);
      if (dayHours(iso) && !isDateInPast(iso)) return iso;
    }
    return baselineIso;
  };

  useEffect(() => {
    const next = findNextOpenDate(date);
    if (next !== date) {
      setDate(next);
      setViewMonth(Number(next.split("-")[1]) - 1);
      setViewYear(Number(next.split("-")[0]));
    }
  }, [normalizedHours, date, bookingNow.date]);

  const avail = useMemo(() => {
    const blockedByPast = time ? isTimeSlotInPast(date, time) : isDateInPast(date);
    const blockedByManualFull = time ? isManuallyFullBookedSlot(date, time) : false;
    const blockedByDropInOnly = time ? isDropInOnlySlot(date, time) : false;
    if (isClosedDate(date) || blockedByPast || blockedByManualFull || blockedByDropInOnly) {
      return { capacity: 0, booked: 0, available: 0, canFit: false };
    }
    return mockAvailability(date, time, guests);
  }, [date, time, guests, normalizedHours, bookingNow, madameBlaMode]);

  useEffect(() => {
    if (!time) return;
    if (!times.includes(time) || isTimeSlotInPast(date, time) || isManuallyFullBookedSlot(date, time) || isDropInOnlySlot(date, time)) {
      setTime("");
    }
  }, [date, time, times, bookingNow, madameBlaMode]);

  const hasName = name.trim().length > 0;
  const hasEmail = email.trim().length > 0;
  const formReady = Boolean(date && time && guests && hasName && hasEmail);
  const guestsLabel = guests > 0 ? `${guests} gäster` : "välj antal gäster";
  const mobileCtaDisabledReason = (() => {
    if (submitting) return "Skickar bokningen…";
    if (!date) return "Välj ett datum.";
    if (isDateInPast(date)) return "Det går inte att boka passerade datum.";
    if (!time) return "Välj en tid.";
    if (isTimeSlotInPast(date, time)) return "Det går inte att boka en passerad tid.";
    if (isManuallyFullBookedSlot(date, time)) return "Den tiden är fullbokad.";
    if (isDropInOnlySlot(date, time)) return "Den tiden är endast drop-in.";
    if (!guests || guests < 1) return "Ange antal gäster.";
    if (!hasName) return "Ange ditt namn.";
    if (!hasEmail) return "Ange din e‑post.";
    if (!avail.canFit) return "Tyvärr finns det inte plats för det antalet vid den tiden.";
    return null;
  })();
  const [viewMonth, setViewMonth] = useState(() => Number(date.split("-")[1]) - 1);
  const [viewYear, setViewYear] = useState(() => Number(date.split("-")[0]));

  const monthName = (m: number) =>
    ["januari", "februari", "mars", "april", "maj", "juni", "juli", "augusti", "september", "oktober", "november", "december"][m].toUpperCase();
  const daysInMonth = (y: number, m: number) => new Date(y, m + 1, 0).getDate();
  const startOffset = (y: number, m: number) => (new Date(y, m, 1).getDay() + 6) % 7; // Monday=0
  const calendarDays = useMemo(() => {
    const count = daysInMonth(viewYear, viewMonth);
    const offset = startOffset(viewYear, viewMonth);
    const blanks = Array.from({ length: offset }, (_, i) => ({ key: `b-${i}`, day: null as number | null }));
    const days = Array.from({ length: count }, (_, i) => ({ key: `d-${i + 1}`, day: i + 1 }));
    return [...blanks, ...days];
  }, [viewYear, viewMonth]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!date || !time || !guests || !name.trim() || !email.trim()) return;
    if (isTimeSlotInPast(date, time)) {
      setSubmitError("Det går inte att boka en passerad tid.");
      return;
    }
    if (isManuallyFullBookedSlot(date, time)) {
      setSubmitError("Den tiden är fullbokad.");
      return;
    }
    if (isDropInOnlySlot(date, time)) {
      setSubmitError("Den tiden är endast drop-in.");
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    const resv: Reservation = {
      id: makeId(),
      restaurantSlug,
      date,
      time,
      guests,
      name: name.trim(),
      email: email.trim(),
      phone: phone.trim() || undefined,
      notes: notes.trim() || undefined,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    if (!restaurantSlug || restaurantSlug === "demo") {
      setTimeout(() => {
        saveReservation(resv);
        setCreated(resv);
        setSubmitting(false);
      }, 350);
      return;
    }
    try {
      const r = await fetch("/api/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          restaurantId: restaurantSlug,
          date,
          time,
          guests,
          name: name.trim(),
          email: email.trim(),
          phone: phone.trim() || null,
          notes: notes.trim() || null,
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error || "Kunde inte skicka bokning.");
      setCreated({ ...resv, status: data.status ?? resv.status });
      setSubmitError(null);
      setSubmitting(false);
    } catch (err) {
      console.error(err);
      setSubmitting(false);
      setSubmitError(err instanceof Error ? err.message : "Kunde inte skicka bokning.");
    }
  }

  const askAi = async () => {
    const text = qaQuestion.trim();
    if (!text) return;
    setQaLoading(true);
    setQaAnswer(null);
    try {
      const nextHistory: { role: "user" | "assistant"; content: string }[] = [
        ...qaHistory,
        { role: "user", content: text },
      ];
      const r = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          knowledge: publicSettings?.knowledge_public ?? "",
          history: nextHistory,
          context: {
            baseDate: toISODateInputValue(),
            nowTime: `${new Date().getHours().toString().padStart(2, "0")}:${new Date().getMinutes().toString().padStart(2, "0")}`,
            hoursConfigured: !!publicSettings?.hours,
            requireManualConfirmation: !!publicSettings?.require_manual_confirmation,
            seating: effectiveSettings.seating,
            hours: normalizedHours,
            restaurant: restaurantWebsite ? { website: restaurantWebsite } : undefined,
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
      if (!r.ok) throw new Error(data?.error || raw || "Kunde inte hämta svar.");
      const reply = data.reply || "Inget svar.";
      setQaAnswer(reply);
      setQaHistory([...nextHistory, { role: "assistant", content: reply }]);
    } catch (err) {
      setQaAnswer(err instanceof Error ? err.message : "Kunde inte hämta svar.");
    } finally {
      setQaLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-white text-gray-900">
      <header className="sticky top-0 z-10 backdrop-blur bg-white/80 border-b border-pink-100">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
              <img
                src={forkTransparent}
                alt="Bokäta"
                className="h-10 w-auto object-contain"
              />
            <div>
              <div className="text-xs uppercase tracking-wider bg-clip-text text-transparent bg-gradient-to-r from-pink-600 to-violet-600 font-semibold">
                Bokäta – Boka bord
              </div>
              {restaurantName ? <div className="text-sm text-gray-500">{restaurantName}</div> : null}
            </div>
          </div>
        </div>
      </header>

      <main className={`max-w-6xl mx-auto px-4 pt-2 md:pt-8 ${created ? "pb-8" : "pb-12 md:pb-12"}`}>
        {!created ? (
          <section id="booking">
            <form ref={formRef} onSubmit={submit} className="space-y-4 md:space-y-8">
              <div className={`relative left-1/2 right-1/2 -ml-[50vw] -mr-[50vw] w-screen rounded-3xl bg-gradient-to-br from-[#3d015f] via-[#2a0044] to-pink-600 text-white ${SECTION_PAD_Y} ${SECTION_PAD_X} overflow-hidden shadow-lg`}>
                <div className="max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-2 gap-6 relative">
                  <div className="rounded-3xl border border-violet-200 bg-white p-6 h-full min-h-[440px] flex flex-col">
                    <div className="flex items-center justify-between mb-4">
                      <button
                        type="button"
                        className="h-10 w-10 rounded-full border border-violet-200 text-violet-700 hover:bg-violet-100"
                        onClick={() => {
                          const nm = viewMonth === 0 ? 11 : viewMonth - 1;
                          const ny = viewMonth === 0 ? viewYear - 1 : viewYear;
                          setViewMonth(nm);
                          setViewYear(ny);
                        }}
                      >
                        ‹
                      </button>
                      <div className="text-lg font-semibold text-violet-800">
                        {monthName(viewMonth)} {viewYear}
                      </div>
                      <button
                        type="button"
                        className="h-10 w-10 rounded-full border border-violet-200 text-violet-700 hover:bg-violet-100"
                        onClick={() => {
                          const nm = viewMonth === 11 ? 0 : viewMonth + 1;
                          const ny = viewMonth === 11 ? viewYear + 1 : viewYear;
                          setViewMonth(nm);
                          setViewYear(ny);
                        }}
                      >
                        ›
                      </button>
                    </div>
                    <div className="grid grid-cols-7 text-sm font-semibold text-violet-700/80 mb-3">
                      {["M", "T", "O", "T", "F", "L", "S"].map((d) => (
                        <div key={d} className="text-center">{d}</div>
                      ))}
                    </div>
                    <div className="grid grid-cols-7 gap-3">
                      {calendarDays.map((c) => {
                        if (!c.day) return <div key={c.key} className="h-10" />;
                        const iso = `${viewYear}-${String(viewMonth + 1).padStart(2, "0")}-${String(c.day).padStart(2, "0")}`;
                        const isSel = iso === date;
                        const closed = settingsLoading ? false : isClosedDate(iso);
                        const passed = isDateInPast(iso);
                        const blocked = settingsLoading || closed || passed;
                        return (
                          <button
                            key={c.key}
                            type="button"
                            onClick={() => !blocked && setDate(iso)}
                            disabled={blocked}
                            className={`h-12 rounded-2xl text-sm font-semibold flex flex-col items-center justify-center leading-tight ${
                              blocked
                                ? "bg-gray-100 text-gray-400 border border-gray-200"
                                : isSel
                                ? "bg-gradient-to-r from-violet-600 to-pink-600 text-white"
                                : "bg-white text-violet-700 border border-violet-200 hover:bg-violet-100"
                            }`}
                          >
                            <span>{c.day}</span>
                            {closed && !passed ? <span className="text-[10px] mt-0.5">Stängt</span> : null}
                          </button>
                        );
                      })}
                    </div>
                    <div className="mt-5 rounded-2xl border border-violet-100 bg-violet-50/70 p-4">
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <div>
                          <div className="text-sm font-semibold text-violet-800">Välj tid</div>
                        </div>
                        <div className="flex items-center gap-4">
                          <label htmlFor="guests-inline" className="text-sm font-semibold text-gray-600 whitespace-nowrap">
                            Gäster
                          </label>
                          <input
                            id="guests-inline"
                            type="number"
                            inputMode="numeric"
                            min={1}
                            max={16}
                            value={guests > 0 ? guests : ""}
                            onChange={(e) => {
                              const raw = e.target.value;
                              if (raw === "") {
                                setGuests(0);
                                return;
                              }
                              const parsed = Number(raw);
                              if (!Number.isFinite(parsed)) return;
                              const normalized = Math.max(1, Math.min(16, Math.floor(parsed)));
                              setGuests(normalized);
                            }}
                            className="w-24 rounded-xl border-gray-300 bg-white px-3 py-2 text-base font-semibold text-gray-900 focus:border-violet-400 focus:ring-violet-400"
                            placeholder="2"
                          />
                        </div>
                      </div>
                      <div className="grid grid-cols-3 gap-2 max-h-[280px] min-h-[180px] overflow-auto pr-1">
                        {times.map((t) => {
                          const passed = isTimeSlotInPast(date, t);
                          const manualFull = isManuallyFullBookedSlot(date, t);
                          const dropInOnly = isDropInOnlySlot(date, t);
                          const a = passed || manualFull
                            ? { capacity: 0, booked: 0, available: 0, canFit: false }
                            : mockAvailability(date, t, guests || 1);
                          const isSel = t === time;
                          const blocked = settingsLoading || passed || manualFull || dropInOnly || !a.canFit;
                          const tag = dropInOnly
                            ? "Endast Drop in"
                            : manualFull
                            ? "Fullbokat"
                            : passed
                            ? "Passerad"
                            : a.canFit
                            ? a.available <= 2
                              ? "Snart full"
                              : a.available <= 6
                              ? "Populär"
                              : ""
                            : "";
                          return (
                            <button
                              key={t}
                              type="button"
                              onClick={() => !blocked && setTime(t)}
                              disabled={blocked}
                              className={`text-sm font-semibold rounded-md px-1.5 py-1 border transition ${
                                !blocked
                                  ? isSel
                                    ? "bg-gradient-to-r from-violet-600 to-pink-600 text-white border-violet-600"
                                    : "bg-violet-50 text-violet-700 border-violet-200 hover:bg-violet-100"
                                  : dropInOnly
                                  ? "bg-amber-50 text-amber-700 border-amber-200 cursor-not-allowed"
                                  : "bg-gray-50 text-gray-400 border-gray-200 line-through cursor-not-allowed"
                              }`}
                            >
                              <div className="flex flex-col items-center leading-tight">
                                <span>{t}</span>
                                {tag && <span className="text-[9px] mt-0.5 opacity-80">{tag}</span>}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                      {FULLY_BOOKED_NOTICE_DATES.has(date) ? (
                        <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-700">
                          Fullbokat
                        </div>
                      ) : null}
                      <div className="mt-4 text-xs text-gray-500">
                        {settingsLoading
                          ? "Laddar öppettider…"
                          : settingsMissing
                          ? "Tiderna är inte konfigurerade än. Välj ändå en tid så uppdateras när restaurangen sparat sina tider."
                          : ""}
                      </div>
                    </div>
                    <button
                      type="submit"
                      disabled={!formReady || submitting || !avail.canFit}
                      className="mt-4 hidden md:block w-full px-5 py-3 rounded-2xl font-semibold text-white bg-gradient-to-r from-violet-700 via-purple-600 to-fuchsia-600 disabled:opacity-50 shadow-md hover:shadow-lg transition"
                    >
                      {submitting ? "Skickar…" : "BOKA"}
                    </button>
                    {submitError ? (
                      <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 text-center">
                        {submitError}
                      </div>
                    ) : null}
                  </div>

                  <div>
                    <div className="rounded-3xl bg-white border border-violet-100 p-6 md:p-8 flex flex-col">
                      <div className="rounded-2xl border border-violet-100 bg-violet-50/70 p-4 space-y-4">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          <label className="block">
                            <span className="text-lg md:text-xl font-semibold text-gray-700">
                              Namn <span className="ml-1 text-xs font-semibold text-rose-500 align-middle">(obligatoriskt)</span>
                            </span>
                            <input
                              value={name}
                              onChange={(e) => setName(e.target.value)}
                              placeholder="För- och efternamn"
                              className="mt-1.5 w-full rounded-xl border-gray-300 focus:border-violet-400 focus:ring-violet-400 px-4 py-2.5 text-base font-semibold text-gray-900 placeholder:text-gray-400"
                            />
                          </label>
                          <label className="block">
                            <span className="text-lg md:text-xl font-semibold text-gray-700">
                              E‑post <span className="ml-1 text-xs font-semibold text-rose-500 align-middle">(obligatoriskt)</span>
                            </span>
                            <input
                              type="email"
                              value={email}
                              onChange={(e) => setEmail(e.target.value)}
                              placeholder="namn@example.com"
                              className="mt-1.5 w-full rounded-xl border-gray-300 focus:border-violet-400 focus:ring-violet-400 px-4 py-2.5 text-base font-semibold text-gray-900 placeholder:text-gray-400"
                            />
                          </label>
                        </div>
                        <label className="block">
                          <span className="text-lg md:text-xl font-semibold text-gray-700">Kommentar</span>
                          <textarea
                            rows={3}
                            value={notes}
                            onChange={(e) => setNotes(e.target.value)}
                            placeholder="Allergier, barnvagn…"
                            className="mt-1.5 w-full rounded-xl border-gray-300 focus:border-violet-400 focus:ring-violet-400 px-4 py-2.5 text-base font-semibold text-gray-900 placeholder:text-gray-400"
                          />
                        </label>
                        {bookingMessage ? (
                          <div className="rounded-xl border border-violet-100 bg-white px-4 py-3 text-sm text-gray-600 whitespace-pre-wrap">
                            {bookingMessage}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </div>

                </div>
              </div>

              <div className="rounded-2xl border border-pink-100 bg-white px-6 py-5 text-center text-lg md:text-xl text-gray-700 max-w-5xl mx-auto">
                <span className="font-semibold text-gray-900">Snabböversikt</span>{" "}
                {new Date(date).toLocaleDateString()} • {guestsLabel}
                {name ? ` • ${name}` : ""}
                {email ? ` • ${email}` : ""}
                {notes ? ` • ${notes}` : ""}
              </div>

              <div className={`relative left-1/2 right-1/2 -ml-[50vw] -mr-[50vw] w-screen rounded-3xl bg-gradient-to-br from-[#3d015f] via-[#2a0044] to-pink-600 ${SECTION_PAD_Y_BOTTOM} ${SECTION_PAD_X} overflow-hidden`}>
                <div className="max-w-6xl mx-auto flex flex-col lg:flex-row items-start gap-6">
                  <div className="w-full lg:w-[70%] rounded-3xl border border-violet-100 bg-white p-4 md:p-6 flex flex-col">
                    <h3 className="text-xl font-bold text-gray-800">Har du frågor?</h3>
                    <div className="mt-4 space-y-3">
                      <textarea
                        value={qaQuestion}
                        onChange={(e) => setQaQuestion(e.target.value)}
                        placeholder="Ex: Har ni öppet imorgon? Finns parkering?"
                        className="w-full min-h-[120px] rounded-2xl border border-violet-200 bg-violet-50/60 px-4 py-3 focus:border-violet-400 focus:ring-violet-400"
                      />
                      <div className="flex flex-wrap items-center gap-3">
                        <button
                          type="button"
                          onClick={askAi}
                          disabled={qaLoading || !qaQuestion.trim()}
                          className="rounded-2xl bg-gradient-to-r from-violet-700 via-purple-600 to-fuchsia-600 text-white px-6 py-3 text-base md:text-lg font-semibold uppercase tracking-wide disabled:opacity-60"
                        >
                          {qaLoading ? "Svarar..." : "Fråga AI"}
                        </button>
                        {qaAnswer && <div className="text-sm text-gray-700">{linkify(qaAnswer)}</div>}
                      </div>
                    </div>
                  </div>
                  <div className="hidden lg:flex w-[30%] self-stretch items-center justify-center">
                    <img
                      src={forkTransparent}
                      alt=""
                      aria-hidden="true"
                      className="h-[80%] scale-150 w-auto pointer-events-none select-none"
                    />
                  </div>
                </div>
              </div>
            </form>
          </section>
        ) : (
          <section className="max-w-2xl mx-auto">
            <div className="rounded-3xl bg-white shadow-sm border border-violet-100 p-6 md:p-8 text-center">
              <h2 className="text-xl md:text-2xl font-extrabold text-gray-800">Tack! Din bokning är skickad</h2>
              <p className="text-gray-600 mt-2">
                En bekräftelse skickas till <span className="font-semibold">{created!.email}</span> inom kort.
              </p>
              <p className="text-gray-600 mt-2">
                Om du inte hittar mejlet, glöm inte att kontrollera din skräppost.
              </p>

              <div className="mt-6 text-sm bg-violet-50 border border-violet-100 rounded-2xl p-4 text-left">
                <div>
                  <span className="font-semibold">Datum:</span> {created!.date}
                </div>
                <div>
                  <span className="font-semibold">Tid:</span> {created!.time}
                </div>
                <div>
                  <span className="font-semibold">Gäster:</span> {created!.guests}
                </div>
                <div>
                  <span className="font-semibold">Namn:</span> {created!.name}
                </div>
                {created!.phone && (
                  <div>
                    <span className="font-semibold">Telefon:</span> {created!.phone}
                  </div>
                )}
                {created!.notes && (
                  <div>
                    <span className="font-semibold">Kommentar:</span> {created!.notes}
                  </div>
                )}
              </div>

              <p className="mt-6 text-xl font-bold text-violet-700">
                {bookingFarewell(created!.date)}
              </p>

              {null}
            </div>
          </section>
        )}

      </main>

      {!created && (
        <div className="fixed bottom-0 left-0 right-0 z-20 md:hidden">
          <div
            className="mx-auto max-w-5xl px-4"
            style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 0.75rem)" }}
          >
            <div className="rounded-2xl border border-white/10 bg-white/90 backdrop-blur shadow-lg p-3 flex items-center justify-between">
              <div className="text-sm">
                <div className="font-semibold text-gray-800">Din bokning</div>
                <div className="text-xs text-gray-600">{date} • {time || "välj tid"} • {guestsLabel}</div>
                {mobileCtaDisabledReason ? (
                  <div className="mt-1 text-[11px] text-rose-600">{mobileCtaDisabledReason}</div>
                ) : null}
              </div>
              <button
                type="button"
                disabled={!formReady || submitting || !avail.canFit}
                className="px-4 py-2 rounded-xl font-semibold text-white bg-gradient-to-r from-violet-600 via-pink-600 to-rose-600 disabled:opacity-50"
                onClick={() => formRef.current?.requestSubmit()}
              >
                {submitting ? "Skickar…" : "Boka"}
              </button>
            </div>
          </div>
        </div>
      )}

      <footer className="mt-0 pt-4 pb-24 md:pb-8 text-center">
        <div className="mx-auto max-w-5xl px-4">
          <div className="flex flex-col items-center gap-6 md:flex-row md:items-center md:justify-between">
            <div className="md:flex-1 md:text-center">
              <div className="text-2xl md:text-3xl font-extrabold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-violet-600 via-pink-500 to-rose-500">
                Bokäta
              </div>
              <div className="mt-1 text-lg md:text-xl font-semibold text-gray-700">
                Den lagar inte mat. Den lagar allt annat.
              </div>
              <a
                href="/"
                className="mt-3 inline-flex items-center justify-center rounded-full border border-pink-200 bg-pink-50 px-5 py-2 text-sm font-semibold text-pink-700 hover:bg-pink-100"
              >
                Driver du också restaurang? Upptäck Bokäta →
              </a>
            </div>
            {null}
          </div>
          <div className="mt-4 text-xs text-gray-400">© 2026 Bokäta. Stockholm, Sweden. All rights reserved.</div>
        </div>
      </footer>
    </div>
  );
}

// --- Testhelpers (manuella, kör i konsolen om du vill) ---
export function __test__idUniqueness(n = 200) {
  const s = new Set<string>();
  for (let i = 0; i < n; i++) s.add(makeId());
  if (s.size !== n) throw new Error("IDs ska vara unika");
  return true;
}

export function __test__availabilitySanity() {
  const a1 = mockAvailability("2025-08-26", "18:00", 2);
  const a2 = mockAvailability("2025-08-26", "12:00", 2);
  if (a1.capacity < a2.capacity) throw new Error("Busy-logik ska inte sänka kapacitet under normal");
  if (a1.available < 0 || a2.available < 0) throw new Error("Tillgänglighet får inte vara negativ");
  return true;
}
