import type { VercelRequest, VercelResponse } from "@vercel/node";
import { rateLimit } from "../lib/rateLimit";
import {
  MADAME_BLA_CLOSED_DATES,
  getMadameBlaDropInRange,
  getMadameBlaHoursOverride as getSharedMadameBlaHoursOverride,
  isMadameBlaKnowledge,
  toSwedishDayName,
} from "../lib/specialRestaurantRules";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method Not Allowed" });
    return;
  }

  try {
  const getClientIp = () => {
    const xfwd = req.headers["x-forwarded-for"];
    const ip = Array.isArray(xfwd) ? xfwd[0] : xfwd;
    return (ip || req.socket.remoteAddress || "unknown").split(",")[0].trim();
  };
  const RATE_LIMIT_WINDOW_MS = 60_000;
  const RATE_LIMIT_MAX = 30;
  const limiter = await rateLimit(`ai:${getClientIp()}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  if (!limiter.ok) {
    res.status(429).json({ error: "För många AI-förfrågningar. Försök igen om en minut." });
    return;
  }

  const { message, knowledge, context, history } = (req.body ?? {}) as {
    message?: string;
    knowledge?: string;
    history?: { role: "user" | "assistant"; content: string }[];
      context?: {
        baseDate?: string;
        nowTime?: string;
        hoursConfigured?: boolean;
        requireManualConfirmation?: boolean;
        restaurant?: {
          name?: string;
          address?: string;
          email?: string;
          website?: string;
          facebook?: string;
          instagram?: string;
          googleMaps?: string;
        };
        seating?: {
          maxGuests?: number;
          maxGuestsPerReservation?: number;
        groupThreshold?: number;
        maxBookingDurationMin?: number;
      };
      hours?: {
        normal?: Record<string, { closed: boolean; open: string; close: string }>;
        special?: { date: string; closed: boolean; open: string; close: string }[];
        periods?: { id?: string; name?: string; from: string; to: string; days: Record<string, { closed: boolean; open: string; close: string }> }[];
      };
      tables?: number[];
      bookings?: { date: string; time: string; guests: number; durationMin?: number; tableId?: number | null }[];
    };
  };

  if (!message || typeof message !== "string") {
    res.status(400).json({ error: "Missing message" });
    return;
  }

  const FORCE_OPENAI = true;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "Missing OPENAI_API_KEY" });
    return;
  }

  const hoursOrder = ["måndag", "tisdag", "onsdag", "torsdag", "fredag", "lördag", "söndag"];
  const hoursSummary = (() => {
    const normal = context?.hours?.normal;
    const periods = context?.hours?.periods;
    const base = context?.baseDate;
    const period =
      base && Array.isArray(periods)
        ? periods.find((p) => base >= p.from && base <= p.to) ?? periods[0]
        : Array.isArray(periods) && periods.length
        ? periods[0]
        : null;
    const days = period?.days ?? normal;
    if (!days) return "";
    const lines = hoursOrder.map((d) => {
      const day = days[d];
      if (!day) return null;
      return day.closed ? `${d}: stängt` : `${d}: ${day.open}–${day.close}`;
    });
    const range = period ? ` (${period.from}–${period.to})` : "";
    return `${lines.filter(Boolean).join(", ")}${range}`;
  })();

  const describePeriodHours = (period?: { from: string; to: string; days: Record<string, { closed: boolean; open: string; close: string }> } | null) => {
    if (!period) return "";
    const days = period.days ?? context?.hours?.normal;
    if (!days) return "";
    const lines = hoursOrder
      .map((d) => {
        const day = days[d];
        if (!day) return null;
        return day.closed ? `${d}: stängt` : `${d}: ${day.open}–${day.close}`;
      })
      .filter(Boolean);
    return `${lines.join(", ")}`;
  };
  const periodsSummary = (() => {
    const periods = context?.hours?.periods ?? [];
    if (!periods.length) return "";
    const lines = periods
      .map((p, idx) => {
        const rawLabel = p?.name ? p.name : "";
        const label = rawLabel && !/^period\s*\d+/i.test(rawLabel) ? rawLabel : "";
        const summary = describePeriodHours(p as any);
        if (!summary) return "";
        const range = p?.from && p?.to ? ` (${p.from}–${p.to})` : "";
        return label ? `${label}: ${summary}${range}` : `${summary}${range}`;
      })
      .filter(Boolean);
    return lines.join("\n");
  })();

  const pad2Local = (n: number) => String(n).padStart(2, "0");
  const realToday = (() => {
    const now = new Date();
    return `${now.getFullYear()}-${pad2Local(now.getMonth() + 1)}-${pad2Local(now.getDate())}`;
  })();
  const isMadameBlaContext = isMadameBlaKnowledge([knowledge, context?.restaurant?.name].filter(Boolean).join("\n"));
  const getMadameBlaHoursOverride = (iso?: string | null) => {
    if (!iso || !isMadameBlaContext) return undefined;
    const dayName = toSwedishDayName(iso);
    const override = getSharedMadameBlaHoursOverride(iso, dayName);
    return override ? { dayName, ...override } : undefined;
  };
  const isMadameBlaWeekendDropInOnly = (iso?: string | null) => {
    const override = getMadameBlaHoursOverride(iso);
    return !!override && !override.closed && !!iso && getMadameBlaDropInRange(iso, override.dayName) !== null;
  };

  const closedRangesText = (() => {
    const special = context?.hours?.special ?? [];
    const dates = special
      .filter((s) => s?.closed && s.date)
      .map((s) => s.date)
      .concat(isMadameBlaContext ? Array.from(MADAME_BLA_CLOSED_DATES) : [])
      .sort();
    if (!dates.length) return "";
    const addDay = (iso: string) => {
      const [y, m, d] = iso.split("-").map(Number);
      if (!y || !m || !d) return null;
      const dt = new Date(Date.UTC(y, m - 1, d));
      dt.setUTCDate(dt.getUTCDate() + 1);
      return `${dt.getUTCFullYear()}-${pad2Local(dt.getUTCMonth() + 1)}-${pad2Local(dt.getUTCDate())}`;
    };
    const ranges: { start: string; end: string }[] = [];
    let start = dates[0];
    let prev = dates[0];
    for (let i = 1; i < dates.length; i++) {
      const cur = dates[i];
      const nextExpected = addDay(prev);
      if (nextExpected && cur === nextExpected) {
        prev = cur;
      } else {
        ranges.push({ start, end: prev });
        start = cur;
        prev = cur;
      }
    }
    ranges.push({ start, end: prev });
    return ranges.map((r) => (r.start === r.end ? r.start : `${r.start}–${r.end}`)).join(", ");
  })();

  const dashboardFacts = [
    hoursSummary ? `Öppettider (från dashboard): ${hoursSummary}` : "",
    periodsSummary ? `Säsongsperioder:\n${periodsSummary}` : "",
    context?.seating?.maxBookingDurationMin ? `Bordsbokningstid: ${context.seating.maxBookingDurationMin} min` : "",
    context?.seating?.maxGuests ? `Max gäster i restaurangen: ${context.seating.maxGuests}` : "",
    context?.seating?.maxGuestsPerReservation ? `Max gäster per bokning: ${context.seating.maxGuestsPerReservation}` : "",
    closedRangesText ? `Stängda perioder: ${closedRangesText}` : "",
  ].filter(Boolean).join("\n");

  const qualityChecks = (() => {
    const k = (knowledge ?? "").toLowerCase();
    const anyOpenDay = context?.hours?.periods?.length
      ? context.hours.periods.some((p) => Object.values(p.days ?? {}).some((d) => !d?.closed))
      : context?.hours?.normal
      ? Object.values(context.hours.normal).some((d) => !d?.closed)
      : false;
    return [
      { key: "Öppettider", ok: anyOpenDay },
      { key: "Adress", ok: /adress/.test(k) },
      { key: "Telefon", ok: /telefon|tel|phone/.test(k) },
      { key: "E-post", ok: /e-post|email|mail/.test(k) },
      { key: "Bordsbokningstid", ok: (context?.seating?.maxBookingDurationMin ?? 0) > 0 },
      { key: "Max gäster", ok: (context?.seating?.maxGuests ?? 0) > 0 },
      { key: "Betalning", ok: /betala|kort|kontant|swish|visa|mastercard|amex/.test(k) },
      { key: "Allergier", ok: /allergi|gluten|laktos|nöt/.test(k) },
      { key: "Barn", ok: /barnstol|barnvagn|barnmeny|barn/.test(k) },
      { key: "Djurpolicy", ok: /hund|djur|terrass/.test(k) },
      { key: "Parkering", ok: /parkering/.test(k) },
      { key: "Kollektivtrafik", ok: /kollektivtrafik|buss|tunnelbana|tram|spårvagn|bus|m[ée]tro|transport/.test(k) },
    ];
  })();
  const qualityScore = Math.round((qualityChecks.filter((c) => c.ok).length / qualityChecks.length) * 100);
  const qualityMissing = qualityChecks.filter((c) => !c.ok).map((c) => c.key);


  const pad2 = (n: number) => String(n).padStart(2, "0");
  const toUtcDate = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number);
    if (!y || !m || !d) return null;
    return new Date(Date.UTC(y, m - 1, d));
  };
  const fmtDate = (dt: Date) => `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
  const addDays = (iso: string, n: number) => {
    const dt = toUtcDate(iso);
    if (!dt) return null;
    dt.setUTCDate(dt.getUTCDate() + n);
    return fmtDate(dt);
  };
  const spanDays = (from: string, to: string) => {
    const a = toUtcDate(from);
    const b = toUtcDate(to);
    if (!a || !b) return Number.POSITIVE_INFINITY;
    return Math.max(0, Math.floor((b.getTime() - a.getTime()) / 86400000));
  };
  const timeToMin = (t: string) => {
    const [h, m] = t.split(":").map(Number);
    return h * 60 + m;
  };
  const minToTime = (m: number) => `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
  const round30 = (t: string) => {
    const [h, m] = t.split(":").map(Number);
    if (m < 15) return `${pad2(h)}:00`;
    if (m < 45) return `${pad2(h)}:30`;
    return `${pad2((h + 1) % 24)}:00`;
  };
  const overlap = (aS: number, aE: number, bS: number, bE: number) => aS < bE && bS < aE;
  const weekdaySv = ["söndag", "måndag", "tisdag", "onsdag", "torsdag", "fredag", "lördag"];
  const weekdayIndex: Record<string, number> = {
    söndag: 0,
    måndag: 1,
    tisdag: 2,
    onsdag: 3,
    torsdag: 4,
    fredag: 5,
    lördag: 6,
  };

  const msgLower = message.toLowerCase();
  const detectLang = () => {
    if (/(å|ä|ö|och|inte|är|har|ni|jag|vi|tack|bokning|boka|öppet|öppettider|stängt|gäster?|sällskap)/i.test(msgLower)) {
      return "sv";
    }
    if (/(bonjour|merci|svp|s['’]il|vous|nous|où|ou|horaires|réserv|adresse|aujourd|demain|ouvert|fermé|sans|avec|pour|che(z|s))/i.test(msgLower)) {
      return "fr";
    }
    if (/(hello|thanks|open|opening|hours|reservation|booking|address|menu|please)/i.test(msgLower)) return "en";
    return "sv";
  };
  const lang = detectLang();
  const t = (sv: string, fr: string, en: string) => (lang === "fr" ? fr : lang === "en" ? en : sv);
  const hasSmiley = (text: string) => /😊|🙂|😀|😁|😃|😄|😅|😍|😇|🥰/.test(text);
  const formatReply = (text: string) => {
    const cleaned = text.replace(/—/g, "-").trim();
    if (!cleaned) return cleaned;
    return hasSmiley(cleaned) ? cleaned : `${cleaned} 😊`;
  };
  const normalize = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  const asUrl = (url: string) => {
    if (!url) return url;
    if (/^https?:\/\//i.test(url)) return url;
    return `https://${url.replace(/^\/+/, "")}`;
  };
  const hasUrl = (text: string) => /https?:\/\/\S+/i.test(text);
  const appendWebsiteIfMissing = (text: string) => {
    if (!kbInfo.website) return text;
    if (hasUrl(text)) return text;
    if (/(hemsida|webbplats|website|site)/i.test(text)) return `${text} ${asUrl(kbInfo.website)}`;
    return text;
  };
  const sendReply = (text: string) => {
    res.status(200).json({ reply: formatReply(appendWebsiteIfMissing(text)) });
  };

  const knowledgeText = (knowledge ?? "").trim();
  const knowledgeRawLines = knowledgeText.split(/\r?\n/);
  const knowledgeLines = knowledgeRawLines.map((l) => l.trim()).filter(Boolean);
  const knowledgeFieldLabels = [
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
    "Google Maps",
    "Facebook",
    "Instagram",
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
  ];
  const knowledgeFieldMap = (() => {
    const map: Record<string, string> = {};
    let current: string | null = null;
    for (const rawLine of knowledgeRawLines) {
      const line = rawLine.trim();
      if (!line) {
        if (current && map[current]) map[current] += "\n";
        continue;
      }
      const lower = line.toLowerCase();
      if (lower === "infos:" || lower.startsWith("fråga:") || lower.startsWith("svar:")) {
        current = null;
        continue;
      }
      const match = knowledgeFieldLabels.find((label) => lower.startsWith(label.toLowerCase() + ":"));
      if (match) {
        current = match;
        map[match] = line.split(":").slice(1).join(":").trim();
        continue;
      }
      if (current) {
        map[current] = map[current] ? `${map[current]}\n${line}` : line;
      }
    }
    return map;
  })();
  const getField = (label: string) => knowledgeFieldMap[label] ?? "";
  const getFieldAny = (labels: string[]) => {
    for (const label of labels) {
      const val = getField(label);
      if (val) return val;
    }
    return "";
  };
  const findFirstUrl = (text: string) => {
    const match = text.match(/https?:\/\/[^\s]+/i);
    return match ? match[0] : "";
  };
  const kbInfo = {
    name: getField("Namn"),
    address: getField("Adress"),
    phone: getField("Telefon"),
    email: getField("E-post"),
    website: asUrl(getFieldAny(["Webbplats", "Hemsida", "Website", "Site"]) || context?.restaurant?.website || findFirstUrl(knowledgeText) || ""),
    payment: getField("Betalning"),
    allergies: getField("Allergier"),
    kids: getField("Barn"),
    kidsChair: getFieldAny(["Barnstol", "Barnstolar"]),
    kidsMenu: getField("Barnmeny"),
    pets: getField("Djurpolicy"),
    outdoorSeating: getField("Uteservering"),
    dogFriendly: getField("Hundvänligt"),
    wheelchair: getField("Rullstolsanpassad"),
    alcoholLicense: getField("Alkoholtillstånd"),
    kitchenClose: getField("Köket stänger"),
    restaurantType: getField("Typ av restaurang"),
    description: getFieldAny(["Beskrivning", "Stämning"]),
    food: getFieldAny(["Mat", "Mat & meny"]),
    groupEvents: getField("Grupp & event"),
    parking: getFieldAny(["Parkering", "Parking"]),
    transport: getField("Kollektivtrafik"),
    distance: getFieldAny(["Avstånd", "Avstand", "Distance"]),
    instagram: getFieldAny(["Instagram", "Insta"]) || context?.restaurant?.instagram || "",
    facebook: getField("Facebook") || context?.restaurant?.facebook || "",
    googleMaps: getFieldAny(["Google Maps", "Maps", "GoogleMaps"]) || context?.restaurant?.googleMaps || "",
  };
  const paymentInfo = (() => {
    const text = (kbInfo.payment || "").trim();
    const lower = text.toLowerCase();
    return {
      text,
      hasAny: !!text,
      swish: /swish/.test(lower),
      cash: /kontant|cash/.test(lower),
      card: /kort|card|visa|mastercard|amex|kredit|debit/.test(lower),
      bitcoin: /bitcoin|btc/.test(lower),
    };
  })();
  const kidsInfo = (() => {
    const combined = [kbInfo.kids, kbInfo.kidsChair, kbInfo.kidsMenu].filter(Boolean).join(" ");
    const menuFromKids = kbInfo.kids.match(/barnmeny\s*:\s*([^,;]+)/i)?.[1]?.trim() || "";
    const menuRaw = (kbInfo.kidsMenu || "").trim();
    const menuText =
      menuRaw && !/^(ja|nej|yes|no|true|false)$/i.test(menuRaw)
        ? menuRaw
        : menuFromKids;
    const chairRaw = (kbInfo.kidsChair || "").trim();
    return {
      hasAny: !!combined,
      chairYes: /barnstol/i.test(combined) || /^(ja|yes|true)$/i.test(chairRaw),
      chairNo: /^(nej|no|false)$/i.test(chairRaw) || /inga\s+barnstol/i.test(combined),
      menuYes: /barnmeny/i.test(combined) || /^(ja|yes|true)$/i.test(menuRaw) || !!menuText,
      menuNo: /^(nej|no|false)$/i.test(menuRaw),
      menuText,
    };
  })();
  const bookingDurationMin =
    context?.seating?.maxBookingDurationMin ??
    (() => {
      const raw = getFieldAny(["Bordsbokningstid", "Bokningstid", "Sittningstid"]);
      const match = raw.match(/(\d{1,3})/);
      return match ? Number(match[1]) : null;
    })();
  const hasMenuInfo = /meny|menu/i.test(knowledgeText);
  const identity = {
    name: context?.restaurant?.name || kbInfo.name || "",
    address: context?.restaurant?.address || kbInfo.address || "",
    email: context?.restaurant?.email || kbInfo.email || "",
    phone: kbInfo.phone || "",
    website: context?.restaurant?.website || kbInfo.website || "",
  };
  const identityForPrompt = {
    name: identity.name || "Inconnu",
    address: identity.address || "Inconnu",
    email: identity.email || "Inconnu",
    website: identity.website || "Inconnu",
  };
  const restaurantIdentity = [
    `Namn: ${identityForPrompt.name}`,
    `Adress: ${identityForPrompt.address}`,
    identity.phone ? `Telefon: ${identity.phone}` : "",
    `E-post: ${identityForPrompt.email}`,
    `Webbplats: ${identityForPrompt.website}`,
  ].filter(Boolean).join("\n");
  const isHoursQuestionLite = /(öppet|öppnar|öppning|öppettider|öppettid|stängt|stängda|opening|horaires|ouvert|open(?!ai))/i.test(msgLower);
  const isMapsQuestion = /(google maps|karta|maps|vägbeskrivning|hur långt|restid|avstånd|kör)/i.test(msgLower);
  const needsWebForHours =
    isHoursQuestionLite &&
    (context?.hoursConfigured === false ||
      !context?.hours ||
      (!context?.hours?.normal && !context?.hours?.periods?.length));
  const needsWebForMenu = /(meny|menu|à la carte|rätter|mat|vegetar|vegan|gluten|laktos|galett|crêpe|crepe)/i.test(msgLower) && !hasMenuInfo;
  const siteUrl = kbInfo.website;
  let externalHints = "";

  const closedRanges = (() => {
    const ranges: { start: string; end: string }[] = [];
    const closedDates =
      (context?.hours?.special
        ?.filter((s) => s.closed && s.date)
        .map((s) => s.date) ?? [])
        .concat(isMadameBlaContext ? Array.from(MADAME_BLA_CLOSED_DATES) : [])
        .sort();
    if (closedDates.length) {
      let start = closedDates[0];
      let prev = closedDates[0];
      for (let i = 1; i < closedDates.length; i++) {
        const cur = closedDates[i];
        const nextExpected = addDays(prev, 1);
        if (nextExpected && cur === nextExpected) {
          prev = cur;
        } else {
          ranges.push({ start, end: prev });
          start = cur;
          prev = cur;
        }
      }
      ranges.push({ start, end: prev });
    }
    const periods = context?.hours?.periods ?? [];
    for (const p of periods) {
      const days = p?.days ? Object.values(p.days) : [];
      if (days.length && days.every((d) => d?.closed)) {
        ranges.push({ start: p.from, end: p.to });
      }
    }
    if (!ranges.length) return ranges;
    const sorted = ranges.slice().sort((a, b) => a.start.localeCompare(b.start));
    const merged: { start: string; end: string }[] = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
      const cur = sorted[i];
      const last = merged[merged.length - 1];
      const nextExpected = addDays(last.end, 1);
      if (cur.start <= last.end || (nextExpected && cur.start === nextExpected)) {
        if (cur.end > last.end) last.end = cur.end;
      } else {
        merged.push({ ...cur });
      }
    }
    return merged;
  })();
  const closedRangeForDate = (iso?: string | null) => {
    if (!iso) return null;
    return closedRanges.find((r) => iso >= r.start && iso <= r.end) ?? null;
  };

  let systemPrompt = "";
  const guardrailPrompt = `Kom ihåg: du svarar alltid som ${identityForPrompt.name}. Fråga aldrig vilket ställe det gäller. Om en uppgift är "Inconnu", säg tydligt att den saknas och be restaurangen fylla i den i Bokäta.`;
  const languageDirective =
    lang === "fr"
      ? "SPRÅK: Svara på franska."
      : lang === "en"
      ? "SPRÅK: Svara på engelska."
      : "SPRÅK: Svara på svenska.";

  const sanitizeUrl = (input: string) => {
    try {
      const url = new URL(input);
      if (!["http:", "https:"].includes(url.protocol)) return null;
      const host = url.hostname.toLowerCase();
      if (
        host === "localhost" ||
        host === "127.0.0.1" ||
        host === "0.0.0.0" ||
        host.startsWith("127.") ||
        host.startsWith("10.") ||
        host.startsWith("192.168.") ||
        /^172\.(1[6-9]|2\d|3[0-1])\./.test(host) ||
        host.startsWith("::1") ||
        host.startsWith("fc") ||
        host.startsWith("fd")
      ) {
        return null;
      }
      return url;
    } catch {
      return null;
    }
  };

  const fetchWithTimeout = async (url: string, timeoutMs: number) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, {
        method: "GET",
        redirect: "follow",
        headers: {
          "User-Agent": "BokataBot/1.0 (+https://www.bokata.se)",
          "Accept": "text/html,application/xhtml+xml",
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  const htmlToText = (html: string) =>
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/\s+/g, " ")
      .trim();

  const extractMenuLink = (html: string, baseUrl: string) => {
    const base = sanitizeUrl(baseUrl);
    if (!base) return null;
    const hrefs: string[] = [];
    const re = /href\s*=\s*["']([^"']+)["']/gi;
    let m: RegExpExecArray | null = null;
    while ((m = re.exec(html))) {
      const href = m[1];
      if (!href || href.startsWith("#")) continue;
      hrefs.push(href);
    }
    for (const href of hrefs) {
      const lower = href.toLowerCase();
      if (!/menu|meny/.test(lower)) continue;
      try {
        const full = new URL(href, base.toString());
        const baseHost = base.hostname.toLowerCase();
        const fullHost = full.hostname.toLowerCase();
        if (fullHost === baseHost || fullHost.endsWith(`.${baseHost}`)) {
          return full.toString();
        }
      } catch {
        continue;
      }
    }
    return null;
  };

  const isPdfUrl = (url: string) => /\.pdf(\?|#|$)/i.test(url);

  const extractMenuText = (html: string) => {
    const raw = htmlToText(html);
    return raw.slice(0, 20_000);
  };

  const normalizeTime = (raw: string) => {
    const clean = raw.replace(".", ":");
    const parts = clean.split(":");
    if (parts.length === 1) {
      const h = Number(parts[0]);
      if (h >= 0 && h <= 23) return `${pad2(h)}:00`;
      return null;
    }
    const h = Number(parts[0]);
    const m = Number(parts[1]);
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) return `${pad2(h)}:${pad2(m)}`;
    return null;
  };

  const extractHoursSummary = (text: string) => {
    const dayRegex =
      /\b(måndag|tisdag|onsdag|torsdag|fredag|lördag|söndag|monday|tuesday|wednesday|thursday|friday|saturday|sunday|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\b\s*[:\-–]?\s*(\d{1,2}(?:[:\.]\d{2})?)\s*(?:-|–|to|till|à)\s*(\d{1,2}(?:[:\.]\d{2})?)/gi;
    const out: string[] = [];
    let match: RegExpExecArray | null = null;
    while ((match = dayRegex.exec(text))) {
      const day = match[1];
      const start = normalizeTime(match[2]);
      const end = normalizeTime(match[3]);
      if (!start || !end) continue;
      out.push(`${day} ${start}–${end}`);
      if (out.length >= 7) break;
    }
    return out.length ? out.join(", ") : "";
  };

  const getWebData = (() => {
    let cached: Promise<{ menuUrl: string | null; hoursSummary: string | null }> | null = null;
    return async (siteUrl: string) => {
      if (cached) return cached;
      cached = (async () => {
        const safe = sanitizeUrl(siteUrl);
        if (!safe) return { menuUrl: null, hoursSummary: null };
        try {
          const resp = await fetchWithTimeout(safe.toString(), 5000);
          if (!resp.ok) return { menuUrl: null, hoursSummary: null };
          const html = (await resp.text()).slice(0, 200_000);
          const text = htmlToText(html);
          return {
            menuUrl: extractMenuLink(html, safe.toString()),
            hoursSummary: extractHoursSummary(text),
          };
        } catch {
          return { menuUrl: null, hoursSummary: null };
        }
      })();
      return cached;
    };
  })();

  const getMenuContent = (() => {
    let cached: Promise<{ menuUrl: string | null; menuText: string | null; menuIsPdf: boolean }> | null = null;
    return async (siteUrl: string) => {
      if (cached) return cached;
      cached = (async () => {
        const base = sanitizeUrl(siteUrl);
        if (!base) return { menuUrl: null, menuText: null, menuIsPdf: false };
        const webData = await getWebData(siteUrl);
        if (!webData.menuUrl) return { menuUrl: null, menuText: null, menuIsPdf: false };
        const menuUrl = webData.menuUrl;
        if (isPdfUrl(menuUrl)) {
          return { menuUrl, menuText: null, menuIsPdf: true };
        }
        const menuSafe = sanitizeUrl(menuUrl);
        if (!menuSafe) return { menuUrl, menuText: null, menuIsPdf: false };
        try {
          const resp = await fetchWithTimeout(menuSafe.toString(), 5000);
          if (!resp.ok) return { menuUrl, menuText: null, menuIsPdf: false };
          const html = (await resp.text()).slice(0, 200_000);
          const menuText = extractMenuText(html);
          return { menuUrl, menuText, menuIsPdf: false };
        } catch {
          return { menuUrl, menuText: null, menuIsPdf: false };
        }
      })();
      return cached;
    };
  })();

  if (siteUrl && (needsWebForHours || needsWebForMenu)) {
    if (needsWebForHours) {
      const webData = await getWebData(siteUrl);
      if (webData.hoursSummary) {
        externalHints += `Webbhours (officiell hemsida, ej verifierad): ${webData.hoursSummary}\n`;
      }
    }
    if (needsWebForMenu) {
      const menuData = await getMenuContent(siteUrl);
      if (menuData.menuText) {
        externalHints += `Menu (officiell hemsida, ej verifierad): ${menuData.menuText.slice(0, 4000)}\n`;
      } else if (menuData.menuUrl) {
        externalHints += `Menu URL (officiell hemsida): ${menuData.menuUrl}\n`;
      }
    }
  }

  const kbFaqs = (() => {
    const out: { q: string; a: string }[] = [];
    let q: string | null = null;
    for (const l of knowledgeLines) {
      if (l.toLowerCase().startsWith("fråga:")) {
        q = l.slice(6).trim();
        continue;
      }
      if (l.toLowerCase().startsWith("svar:") && q) {
        out.push({ q, a: l.slice(5).trim() });
        q = null;
      }
    }
    return out;
  })();
  const getPeriodForDate = (iso?: string | null) => {
    if (!iso) return null;
    const periods = context?.hours?.periods;
    if (!Array.isArray(periods) || !periods.length) return null;
    const matches = periods.filter((p) => iso >= p.from && iso <= p.to);
    if (!matches.length) return null;
    return matches.sort((a, b) => spanDays(a.from, a.to) - spanDays(b.from, b.to))[0];
  };

  const isPeriodAllClosed = (period?: { days: Record<string, { closed: boolean }> } | null, normal?: Record<string, { closed: boolean }>) => {
    const days = period?.days ?? normal;
    if (!days) return false;
    return Object.values(days).every((d) => d?.closed);
  };

  const isClosedDate = (iso?: string | null) => {
    if (!iso) return false;
    const madameBlaOverride = getMadameBlaHoursOverride(iso);
    if (madameBlaOverride) return madameBlaOverride.closed;
    if (isMadameBlaContext && MADAME_BLA_CLOSED_DATES.has(iso)) return true;
    const special = context?.hours?.special?.find((s) => s.date === iso);
    if (special) return special.closed;
    const dt = toUtcDate(iso);
    if (!dt) return false;
    const dayName = weekdaySv[dt.getUTCDay()];
    const period = getPeriodForDate(iso);
    const normal = context?.hours?.normal;
    const d = (period?.days ?? normal)?.[dayName];
    return d?.closed ?? false;
  };

  const getDayHours = (iso?: string | null) => {
    if (!iso) return null;
    const madameBlaOverride = getMadameBlaHoursOverride(iso);
    if (madameBlaOverride) return madameBlaOverride;
    const dt = toUtcDate(iso);
    if (!dt) return null;
    const dayName = weekdaySv[dt.getUTCDay()];
    const period = getPeriodForDate(iso);
    const normal = context?.hours?.normal;
    const d = (period?.days ?? normal)?.[dayName];
    if (!d) return null;
    return { dayName, ...d };
  };

  const tomorrowDate = addDays(realToday, 1);
  const tomorrowHours = tomorrowDate ? getDayHours(tomorrowDate) : null;
  const tomorrowClosed = !tomorrowDate ? null : (!tomorrowHours || tomorrowHours.closed || isClosedDate(tomorrowDate));
  const tomorrowStatus = tomorrowDate
    ? tomorrowClosed
      ? `${tomorrowDate}: stängt`
      : `${tomorrowDate}: öppet ${tomorrowHours?.open ?? "?"}–${tomorrowHours?.close ?? "?"}`
    : "Saknas";

  const nextOpenDate = (() => {
    const start = realToday;
    for (let i = 0; i < 200; i++) {
      const d = addDays(start, i);
      if (!d) continue;
      const hours = getDayHours(d);
      if (hours && !hours.closed && !isClosedDate(d)) return d;
    }
    return null;
  })();

  const buildSystemPrompt = () => `
# 🔒 BOKÄTA – PROMPT SYSTÈME (MODE ZÉRO ERREUR)

## Rôle

Tu es **Bokäta Assistant**, l’assistant officiel de réservation et d’information du restaurant.

Tu représentes **exclusivement** le restaurant connecté à Bokäta.
Tu ne représentes ni Internet, ni une opinion personnelle, ni un service externe.

---

## 1. Source de vérité (règle non négociable)

Tu dois répondre **uniquement** à partir des données fournies dans Bokäta, notamment:

* Informations générales du restaurant
* Horaires et exceptions
* Menu et ingrédients
* Allergènes déclarés
* Capacité, tables, limites par groupe
* Règles de réservation
* Règles internes définies par le restaurateur
* FAQ personnalisée du restaurateur

👉 **Toute information absente = information inconnue.**

Tu n’inventes jamais.
Tu ne complètes jamais avec des suppositions.
Tu ne “raisonnes” pas pour deviner.

---

## 2. Langue

* Tu réponds **dans la langue du client**, parmi:

  * Suédois (SV)
  * Anglais (EN)
  * Français (FR)
* Si la langue n’est pas identifiable, tu réponds dans la langue par défaut définie par le restaurateur.

Tu ne mélanges jamais les langues.

---

## 3. Ton et style

* Ton chaleureux, accueillant et sympa
* Réponses courtes, claires et utiles
* Aucune exagération
* Un humour léger si approprié
* Ajoute un emoji (ex: 😊) dans chaque réponse
* N’utilise jamais le caractère "—"
* Aucune formulation vague

Tutoiement ou vouvoiement **strictement selon la règle définie par le restaurateur**.

---

## 4. Allergies & sécurité alimentaire (priorité absolue)

* Tu **ne garantis jamais** l’absence totale d’allergènes
* Tu indiques uniquement les allergènes explicitement déclarés
* Tu ne recommandes jamais un plat en cas de doute
* En cas d’allergie sévère:

  * tu refuses toute affirmation
  * tu rediriges systématiquement vers le personnel Et tu donnes l-email qui se trouve dans inställningar: E-post för bokningar

Exemples acceptables:

* “Nous ne pouvons pas garantir l’absence totale de traces.”
* “Pour une allergie sévère, merci de contacter directement le personnel. Et tu donnes l-email qui se trouve dans inställningar: E-post för bokningar”

La sécurité du client passe avant toute autre considération.

---

## 5. Réservations & capacité

Tu respectes **strictement**:

* Nombre total de tables
* Capacité maximale
* Limite par groupe
* Règles de réservation (obligatoire ou non)

Si le restaurant est complet:

* Tu le dis clairement
* Tu ne promets jamais une place
* Tu proposes uniquement les alternatives autorisées:

  * autre horaire
  * autre jour
  * take away
  * liste d’attente (si activée)

Tu ne négocies jamais les règles.

---

## 6. Horaires & exceptions

* Tu donnes uniquement les horaires exacts enregistrés
* Tu mentionnes toujours les exceptions (jours fériés, saisonnalité)
* Si une période fermée est active, tu indiques clairement la date de réouverture (NÄSTA ÖPPNA DAG) si disponible
* Si l’information n’est pas définie, tu le dis explicitement

Tu n’utilises jamais:

* “en général”
* “normalement”
* “habituellement”

---

## 6.1 Après réservation (obligatoire)

* Après une réservation, le client reçoit un **e‑mail de confirmation**.
* Si une confirmation manuelle est requise, l’e‑mail est envoyé **après validation**.

---

## 7. Menu & recommandations

* Tu décris uniquement les plats existants
* Tu n’ajoutes jamais d’ingrédients
* Tu ne proposes des adaptations que si elles sont explicitement autorisées
* Tu utilises les recommandations définies par le restaurateur
* Si l’utilisateur demande le menu, tu fournis le lien officiel du menu si disponible

Tu ne fais aucune suggestion créative.

---

## 8. Cas d’incertitude (règle clé Bokäta)

Si une information est:

* absente
* ambiguë
* contradictoire

👉 Tu dois:

1. le dire clairement
2. rester neutre
3. rediriger vers le personnel (Et tu donnes l-email qui se trouve dans inställningar: E-post för bokningar)

Exemple:

> “Je n’ai pas cette information dans Bokäta. Pour être sûr, merci de demander directement au personnel. Et tu donnes l-email qui se trouve dans inställningar: E-post för bokningar”

---

## 9. Internet & sources externes

* Tu **n’utilises jamais Internet** pour:

  * horaires
  * menu
  * réservations
  * allergies
  * règles internes
* Les informations externes générales ne sont autorisées **que si explicitement activées**
* Toute information externe doit être présentée comme générale et non contractuelle

Les données Bokäta priment toujours.

---

## 10. Objectif Bokäta

Ton objectif est de:

* réduire la charge du personnel
* éviter toute erreur client
* fournir des réponses fiables
* orienter vers une solution valide

Tu n’es pas un vendeur.
Tu es un assistant opérationnel.

---

## 11. Principe final (à toujours respecter)

En cas de doute, tu choisis toujours:

* la prudence
* la clarté
* la sécurité

Tu préfères **ne pas répondre** plutôt que mal répondre.

---

### Résultat concret

Avec ce prompt:

* ton IA ne “hallucine” pas
* ton IA ne contredit jamais le restaurateur
* ton IA se comporte comme un employé bien formé
* Bokäta devient crédible face aux restaurateurs sérieux

KUNSKAPSBAS:
${knowledge ?? ""}

RESTO-IDENTITET (måste respekteras):
${restaurantIdentity || "Saknas"}

FAKTA FRÅN DASHBOARD:
${dashboardFacts}

WEBBINFORMATION (endast om Bokäta saknas):
${externalHints.trim() || "Saknas"}

  STÄNGDA PERIODER:
${closedRangesText || "Saknas"}

DAGENS DATUM (system): ${realToday}
VALT DATUM (context): ${context?.baseDate ?? "Saknas"}
IMORGON (för frågor om “imorgon”): ${tomorrowStatus}
NÄSTA ÖPPNA DAG: ${nextOpenDate ?? "Saknas"}

KUNSKAPSKVALITET: ${qualityScore}%${qualityMissing.length ? ` (Saknas: ${qualityMissing.join(", ")})` : ""}

REGEL – KVALITETSBLOCK:
Om KUNSKAPSKVALITET < 70%, begränsa svaret till: öppettider, adress, kontakt, enkel bokning.
För allt annat: be restaurangen fylla i kunskapsbasen och hänvisa till e-post.

REGEL – IMORGON:
Om användaren frågar om “imorgon”, använd IMORGON-data ovan och svara konkret om öppet/stängt.

REGEL – IDENTITET:
Du representerar alltid restaurangen i RESTO-IDENTITET ovan. Säg aldrig att du inte representerar ett café.
Om något fält är "Inconnu", säg att informationen saknas och be restaurangen fylla i det i kunskapsbasen.
Använd alltid RESTO-IDENTITET när någon frågar "vilken plats" eller "vilket café".

INTERDIT:
- Ne demande jamais "quel café/restaurant" ou "quel établissement".
- Ne propose jamais de "créer un menu" ou "suggérer des plats".
Si la question est courte ("menu?", "ouvert?", "adresse?"), réponds pour CE restaurant uniquement.
`.trim();

  const parseTime = (txt: string) => {
    const m = txt.match(/\b(\d{1,2})(?:[:\.h](\d{2}))\b/);
    if (m) {
      const h = Number(m[1]);
      const mm = Number(m[2]);
      if (h >= 0 && h <= 23 && mm >= 0 && mm <= 59) return `${pad2(h)}:${pad2(mm)}`;
    }
    const hOnly = txt.match(/\bkl\s*(\d{1,2})\b/i) || txt.match(/\b(\d{1,2})\s*(?:tiden|tiden|tiden)\b/i);
    if (hOnly) {
      const h = Number(hOnly[1]);
      if (h >= 0 && h <= 23) return `${pad2(h)}:00`;
    }
    return null;
  };

  const parseDate = (txt: string, baseDate?: string) => {
    const realBase = fmtDate(new Date());
    const base = baseDate ?? realBase;
    const baseForRel = baseDate ?? realBase;
    if (/i\s*dag|idag/.test(txt)) return realBase;
    if (/i\s*morgon|imorgon/.test(txt)) return addDays(realBase, 1);
    if (/aujourd['’]hui|aujourdhui/.test(txt)) return realBase;
    if (/demain/.test(txt)) return addDays(realBase, 1);
    const numberWords: Record<string, number> = {
      en: 1,
      ett: 1,
      två: 2,
      tva: 2,
      tre: 3,
      fyra: 4,
      fem: 5,
      sex: 6,
      sju: 7,
      åtta: 8,
      atta: 8,
      nio: 9,
      tio: 10,
    };
    const relWeeks = txt.match(/\bom\s+(\d+|en|ett|två|tva|tre|fyra|fem|sex|sju|åtta|atta|nio|tio)\s+veck/i);
    if (relWeeks) {
      const raw = relWeeks[1].toLowerCase();
      const n = numberWords[raw] ?? Number(raw);
      if (Number.isFinite(n) && n > 0) return addDays(baseForRel, n * 7);
    }
    const relDays = txt.match(/\bom\s+(\d+|en|ett|två|tva|tre|fyra|fem|sex|sju|åtta|atta|nio|tio)\s+dag/i);
    if (relDays) {
      const raw = relDays[1].toLowerCase();
      const n = numberWords[raw] ?? Number(raw);
      if (Number.isFinite(n) && n > 0) return addDays(baseForRel, n);
    }
    if (/nästa\s+vecka/i.test(txt)) return addDays(baseForRel, 7);
    const iso = txt.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
    const dmy = txt.match(/\b(\d{1,2})[\/\.](\d{1,2})\b/);
    if (dmy) {
      const d = Number(dmy[1]);
      const m = Number(dmy[2]);
      const [y] = base.split("-").map(Number);
      if (d >= 1 && d <= 31 && m >= 1 && m <= 12) return `${y}-${pad2(m)}-${pad2(d)}`;
    }
    const months: Record<string, number> = {
      jan: 1,
      januari: 1,
      feb: 2,
      februari: 2,
      mar: 3,
      mars: 3,
      apr: 4,
      april: 4,
      maj: 5,
      jun: 6,
      juni: 6,
      jul: 7,
      juli: 7,
      aug: 8,
      augusti: 8,
      sep: 9,
      september: 9,
      okt: 10,
      oktober: 10,
      nov: 11,
      november: 11,
      dec: 12,
      december: 12,
    };
    const dmWithDen = txt.match(/\bden\s+(\d{1,2})(?:[:\.]?(?:e|a|er|ème|st|nd|rd|th))?\s+([a-zåäö]+)\b/);
    if (dmWithDen) {
      const d = Number(dmWithDen[1]);
      const m = months[dmWithDen[2]];
      const [y] = base.split("-").map(Number);
      if (d >= 1 && d <= 31 && m) return `${y}-${pad2(m)}-${pad2(d)}`;
    }
    const dm = txt.match(/\b(\d{1,2})(?:[:\.]?(?:e|a|er|ème|st|nd|rd|th))?\s+([a-zåäö]+)\b/);
    if (dm) {
      const d = Number(dm[1]);
      const m = months[dm[2]];
      const [y] = base.split("-").map(Number);
      if (d >= 1 && d <= 31 && m) return `${y}-${pad2(m)}-${pad2(d)}`;
    }
    const hasNext = /nästa/i.test(txt);
    for (const d of weekdaySv) {
      if (new RegExp(`\\b${d}\\b`, "i").test(txt)) {
        const baseDt = toUtcDate(base);
        if (!baseDt) return null;
        const cur = baseDt.getUTCDay();
        const target = weekdayIndex[d];
        let delta = (target - cur + 7) % 7;
        if (hasNext) delta = delta === 0 ? 7 : delta + 7;
        return addDays(base, delta);
      }
    }
    return null;
  };

  const parseGuests = (txt: string) => {
    const m = txt.match(/\b(\d{1,3})\s*(gäster|pers|personer|person|guests)\b/i);
    if (m) return Number(m[1]);
    const v = txt.match(/\bvi\s*är\s*(\d{1,3})\b/i);
    if (v) return Number(v[1]);
    const nums = (txt.match(/\b\d{1,3}\b/g) || []).map(Number);
    const filtered = nums.filter((n) => n > 0 && n <= 200);
    return filtered.length ? filtered[0] : null;
  };

  const isBookingIntent = (txt: string) =>
    /(boka|bokning|reservation|reservera|bord|table|bordsbokning|fixa\s+en\s+tid|tid\s+runt|kan\s+du\s+fixa\s+en\s+tid)/i.test(txt) ||
    /\b\d{1,2}[:\.h]\d{2}\b/.test(txt) ||
    /\b\d{1,3}\s*(gäster|guests|personer|pers)\b/i.test(txt);

  if (/(instagram|insta)/i.test(msgLower) && kbInfo.instagram) {
    sendReply(t(`Instagram: ${kbInfo.instagram}.`, `Instagram : ${kbInfo.instagram}.`, `Instagram: ${kbInfo.instagram}.`));
    return;
  }
  if (/facebook/i.test(msgLower) && kbInfo.facebook) {
    sendReply(t(`Facebook: ${kbInfo.facebook}.`, `Facebook : ${kbInfo.facebook}.`, `Facebook: ${kbInfo.facebook}.`));
    return;
  }
  if (/(hemsida|webbplats|website|webb|site)/i.test(msgLower) && kbInfo.website) {
    sendReply(t(`Vår hemsida: ${kbInfo.website}`, `Notre site : ${kbInfo.website}`, `Our website: ${kbInfo.website}`));
    return;
  }
  if (/(typ\s+av\s+restaurang|restaurangtyp|what\s+kind|type\s+of\s+restaurant|quel\s+type)/i.test(msgLower) && kbInfo.restaurantType) {
    sendReply(
      t(
        `Vi är: ${kbInfo.restaurantType}.`,
        `Nous sommes : ${kbInfo.restaurantType}.`,
        `We are: ${kbInfo.restaurantType}.`
      )
    );
    return;
  }
  if (/(stämning|stamning|atmosfär|atmosfar|ambiance|ambiente|beskriv|describe)/i.test(msgLower) && kbInfo.description) {
    sendReply(
      t(
        kbInfo.description,
        kbInfo.description,
        kbInfo.description
      )
    );
    return;
  }
  if (/(vad\s+serverar|what\s+do\s+you\s+serve|servez-vous|menu|mat)/i.test(msgLower) && kbInfo.food) {
    sendReply(
      t(
        kbInfo.food,
        kbInfo.food,
        kbInfo.food
      )
    );
    return;
  }
  if (/(grupp|sällskap|event|företag|födelsedag|birthday|privat|book the whole|hela stället)/i.test(msgLower) && kbInfo.groupEvents) {
    const contactEmail = context?.restaurant?.email || kbInfo.email || "";
    const withContact = (base: string, sv: string, fr: string, en: string) =>
      base + (contactEmail ? t(sv, fr, en) : "");
    sendReply(
      withContact(
        kbInfo.groupEvents,
        ` Kontakta oss gärna på ${contactEmail}.`,
        ` Merci de nous contacter à ${contactEmail}.`,
        ` Please contact us at ${contactEmail}.`
      )
    );
    return;
  }
  if (/(km|kilometer|distance|distans|avstånd|avstand|hur\s+långt|combien\s+de\s+km|a\s+combien\s+de\s+km|à\s+combien\s+de\s+km)/i.test(msgLower) && kbInfo.distance) {
    sendReply(
      t(
        `Vi ligger ${kbInfo.distance}.`,
        `Nous sommes à ${kbInfo.distance}.`,
        `We are ${kbInfo.distance}.`
      )
    );
    return;
  }
  if (/(uteservering|uteplats|terrass|terrasse|patio)/i.test(msgLower) && kbInfo.outdoorSeating) {
    sendReply(
      t(
        `Uteservering: ${kbInfo.outdoorSeating}.`,
        `Terrasse : ${kbInfo.outdoorSeating}.`,
        `Outdoor seating: ${kbInfo.outdoorSeating}.`
      )
    );
    return;
  }
  if (/(hund|hundvänlig|djurvänlig|pets)/i.test(msgLower) && kbInfo.dogFriendly) {
    sendReply(
      t(
        `Hundvänligt: ${kbInfo.dogFriendly}.`,
        `Chiens bienvenus : ${kbInfo.dogFriendly}.`,
        `Dog friendly: ${kbInfo.dogFriendly}.`
      )
    );
    return;
  }
  if (/(rullstol|rullstolsanpassad|wheelchair|accessible)/i.test(msgLower) && kbInfo.wheelchair) {
    sendReply(
      t(
        `Rullstolsanpassad: ${kbInfo.wheelchair}.`,
        `Accessible fauteuil roulant : ${kbInfo.wheelchair}.`,
        `Wheelchair accessible: ${kbInfo.wheelchair}.`
      )
    );
    return;
  }
  if (/(alkohol|alkoholtillstånd|vin|öl|beer|wine)/i.test(msgLower) && kbInfo.alcoholLicense) {
    sendReply(
      t(
        `Alkoholtillstånd: ${kbInfo.alcoholLicense}.`,
        `Licence d’alcool : ${kbInfo.alcoholLicense}.`,
        `Alcohol license: ${kbInfo.alcoholLicense}.`
      )
    );
    return;
  }
  if (/(kök|köket|kitchen)/i.test(msgLower) && kbInfo.kitchenClose) {
    sendReply(
      t(
        `Köket stänger ${kbInfo.kitchenClose}.`,
        `La cuisine ferme ${kbInfo.kitchenClose}.`,
        `The kitchen closes ${kbInfo.kitchenClose}.`
      )
    );
    return;
  }
  if (/(bokningstid|bordsbokningstid|sittning|sittningar|hur\s+länge|hur\s+lang)/i.test(msgLower) && /(bokning|bordsbokning|reservation)/i.test(msgLower)) {
    if (bookingDurationMin) {
      sendReply(
        t(
          `En bordsbokning är normalt ${bookingDurationMin} minuter.`,
          `Une réservation dure généralement ${bookingDurationMin} minutes.`,
          `A table booking is typically ${bookingDurationMin} minutes.`
        )
      );
    } else {
      sendReply(
        t(
          "Jag har tyvärr ingen bokningstid angiven. Kontakta oss så hjälper vi dig.",
          "Je n’ai pas de durée de réservation indiquée. Contactez‑nous et on vous aide.",
          "I don’t have a booking duration set. Please contact us and we’ll help."
        )
      );
    }
    return;
  }
  if (isMapsQuestion && kbInfo.googleMaps) {
    sendReply(
      t(
        `Här hittar du oss och kan se restid: ${kbInfo.googleMaps}`,
        `Voici notre adresse et le temps de trajet : ${kbInfo.googleMaps}`,
        `Here is our location and travel time: ${kbInfo.googleMaps}`
      )
    );
    return;
  }
  if (/(vad händer efter|vad hander efter|after i book|after i reserve|après avoir réservé|apres avoir reserve|confirmation)/i.test(msgLower)) {
    if (context?.requireManualConfirmation) {
      sendReply(
        t(
          "Efter att du bokat får du en bekräftelse via e‑post när restaurangen har godkänt bokningen. 😊",
          "Après votre réservation, vous recevrez un e‑mail de confirmation dès que le restaurant l’aura validée. 😊",
          "After you book, you’ll receive a confirmation email once the restaurant approves it. 😊"
        )
      );
    } else {
      sendReply(
        t(
          "Efter att du bokat får du en bekräftelse via e‑post. 😊",
          "Après votre réservation, vous recevrez un e‑mail de confirmation. 😊",
          "After you book, you’ll receive a confirmation email. 😊"
        )
      );
    }
    return;
  }
  if (
    /(bra\s+ställe|bra\s+stalle|trevlig|trevligt|mysig|mysigt|härlig|harlig|fin\s+miljö|fin\s+miljo|stämning|stamning|atmosfär|atmosfar|ambiance|ambiance|sympa|agréable|agreable|good\s+place|nice\s+place|great\s+place|good\s+vibes|vibes|good\s+atmosphere|nice\s+atmosphere|food\s+good|maten\s+är\s+bra|maten\s+är\s+god|nourriture\s+est\s+bien|nourriture\s+est\s+bonne|food\s+is\s+great)/i.test(
      msgLower
    )
  ) {
    sendReply(
      t(
        "Ja! Vi gör vårt bästa för en varm, trivsam atmosfär och god mat. Du är varmt välkommen. Vill du boka ett bord?",
        "Oui ! On fait notre maximum pour une ambiance chaleureuse et une cuisine soignée. Vous êtes les bienvenus. Souhaitez‑vous réserver ?",
        "Yes! We aim for a warm, welcoming atmosphere and great food. You’re very welcome. Would you like to book a table?"
      )
    );
    return;
  }

  const overlapsMonths = (from?: string, to?: string, months: number[] = []) => {
    if (!from || !to) return false;
    const start = new Date(from + "T00:00:00Z");
    const end = new Date(to + "T00:00:00Z");
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return false;
    const cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
    const endMonth = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
    while (cur.getTime() <= endMonth.getTime()) {
      const m = cur.getUTCMonth() + 1;
      if (months.includes(m)) return true;
      cur.setUTCMonth(cur.getUTCMonth() + 1);
    }
    return false;
  };

  const formatPeriodNote = (period?: { name?: string; from?: string; to?: string } | null) => {
    if (!period) return "";
    const rawLabel = period.name?.trim() ?? "";
    const label = rawLabel && !/^period\s*\d+/i.test(rawLabel) ? rawLabel : "";
    const range = period.from && period.to ? `${period.from}–${period.to}` : "";
    const parts = [label, range].filter(Boolean);
    return parts.join(" ");
  };

  const handleHoursQuestion = async () => {
    const isHoursQuestion = /(öppet|öppnar|öppning|öppettider|öppettid|stängt|stängda|opening|horaires|ouvert|open(?!ai))/i.test(msgLower);
    if (!isHoursQuestion) return false;

    const base = context?.baseDate ?? fmtDate(new Date());
    const currentClosed = closedRangeForDate(realToday);
    const requestedDate = parseDate(msgLower, base);
    const isEasterKeyword = /(påsk|pask|easter|långfredag|langfredag|annandag\s+p[åa]sk)/i.test(msgLower);
    const isSummerKeyword = /(sommar|sommaröppettider|été|ete|summer|summer hours)/i.test(msgLower);
    const isAutumnKeyword = /(höst|host|autumn|fall|automne)/i.test(msgLower);
    const monthNames = {
      januari: 1,
      februari: 2,
      mars: 3,
      april: 4,
      maj: 5,
      juni: 6,
      juli: 7,
      augusti: 8,
      september: 9,
      oktober: 10,
      november: 11,
      december: 12,
    } as const;
    const monthMatch = msgLower.match(/\b(januari|februari|mars|april|maj|juni|juli|augusti|september|oktober|november|december)\b/);
    const monthNumber = monthMatch ? monthNames[monthMatch[1] as keyof typeof monthNames] : null;

    const periodForBase = getPeriodForDate(base);
    if (isPeriodAllClosed(periodForBase, context?.hours?.normal)) {
      const range = periodForBase ? ` (${periodForBase.from}–${periodForBase.to})` : "";
      sendReply(
        t(
          `Vi har stängt under denna period${range}.`,
          `Nous sommes fermés sur cette période${range}.`,
          `We’re closed for this period${range}.`
        )
      );
      return true;
    }

    if (context && "hoursConfigured" in context && context.hoursConfigured === false) {
      if (siteUrl) {
        const webData = await getWebData(siteUrl);
        if (webData.hoursSummary) {
          sendReply(
            t(
              `Enligt hemsidan: ${webData.hoursSummary}. Kontakta oss gärna för att bekräfta.`,
              `Selon le site officiel : ${webData.hoursSummary}. Merci de nous contacter pour confirmer.`,
              `According to the official site: ${webData.hoursSummary}. Please contact us to confirm.`
            )
          );
          return true;
        }
      }
      sendReply(
        t(
          "Våra öppettider är inte publicerade just nu. Kontakta oss så hjälper vi dig.",
          "Nos horaires ne sont pas publiés pour le moment. Contactez‑nous et on vous aide.",
          "Our opening hours aren’t published right now. Please contact us and we’ll help."
        )
      );
      return true;
    }

    if (isSummerKeyword) {
      const periods = context?.hours?.periods ?? [];
      const summerPeriods = periods.filter((p) => {
        if (p?.name && /(sommar|été|ete|summer)/i.test(p.name)) return true;
        return overlapsMonths(p?.from, p?.to, [6, 7, 8]);
      });
      if (summerPeriods.length) {
        const lines = summerPeriods
          .map((p) => {
            const rawLabel = p?.name?.trim() ? p.name.trim() : "";
            const label = rawLabel && !/^period\s*\d+/i.test(rawLabel) ? rawLabel : "";
            const summary = describePeriodHours(p as any);
            if (!summary) return "";
            const range = p?.from && p?.to ? ` (${p.from}–${p.to})` : "";
            return label ? `${label}: ${summary}${range}` : `${summary}${range}`;
          })
          .filter(Boolean);
        if (lines.length) {
          sendReply(
            t(
              `Sommaröppettider: ${lines.join(" | ")}`,
              `Horaires d'été : ${lines.join(" | ")}`,
              `Summer hours: ${lines.join(" | ")}`
            )
          );
          return true;
        }
      }
    }

    if (isAutumnKeyword) {
      const periods = context?.hours?.periods ?? [];
      const autumnPeriods = periods.filter((p) => {
        if (p?.name && /(höst|host|autumn|fall|automne)/i.test(p.name)) return true;
        return overlapsMonths(p?.from, p?.to, [9, 10, 11, 12]);
      });
      if (autumnPeriods.length) {
        const lines = autumnPeriods
          .map((p) => {
            const rawLabel = p?.name?.trim() ? p.name.trim() : "";
            const label = rawLabel && !/^period\s*\d+/i.test(rawLabel) ? rawLabel : "";
            const summary = describePeriodHours(p as any);
            if (!summary) return "";
            const range = p?.from && p?.to ? ` (${p.from}–${p.to})` : "";
            return label ? `${label}: ${summary}${range}` : `${summary}${range}`;
          })
          .filter(Boolean);
        if (lines.length) {
          const closedNotice = currentClosed ? ` Stängt under: ${currentClosed.start}–${currentClosed.end}.` : "";
          sendReply(
            t(
              `Höstens öppettider: ${lines.join(" | ")}.${closedNotice}`,
              `Horaires d'automne : ${lines.join(" | ")}.${closedNotice}`,
              `Autumn hours: ${lines.join(" | ")}.${closedNotice}`
            )
          );
          return true;
        }
      }
    }

    if (isEasterKeyword) {
      const periods = context?.hours?.periods ?? [];
      const easterPeriod = periods.find((p) => (p?.name ? /(påsk|pask|easter)/i.test(p.name) : false));
      if (easterPeriod) {
        const range = easterPeriod.from && easterPeriod.to ? ` (${easterPeriod.from}–${easterPeriod.to})` : "";
        if (/långfredag|langfredag/i.test(msgLower)) {
          const day = easterPeriod.days?.fredag;
          if (day) {
            sendReply(
              t(
                day.closed
                  ? `Långfredag har vi stängt${range}.`
                  : `Långfredag har vi öppet ${day.open}–${day.close}${range}.`,
                day.closed
                  ? `Le Vendredi saint, nous sommes fermés${range}.`
                  : `Le Vendredi saint, nous sommes ouverts ${day.open}–${day.close}${range}.`,
                day.closed
                  ? `We’re closed on Good Friday${range}.`
                  : `We’re open on Good Friday ${day.open}–${day.close}${range}.`
              )
            );
            return true;
          }
        }
        if (/annandag\s+p[åa]sk/i.test(msgLower)) {
          const day = easterPeriod.days?.måndag;
          if (day) {
            sendReply(
              t(
                day.closed
                  ? `Annandag påsk har vi stängt${range}.`
                  : `Annandag påsk har vi öppet ${day.open}–${day.close}${range}.`,
                day.closed
                  ? `Le lundi de Pâques, nous sommes fermés${range}.`
                  : `Le lundi de Pâques, nous sommes ouverts ${day.open}–${day.close}${range}.`,
                day.closed
                  ? `We’re closed on Easter Monday${range}.`
                  : `We’re open on Easter Monday ${day.open}–${day.close}${range}.`
              )
            );
            return true;
          }
        }
        const summary = describePeriodHours(easterPeriod as any);
        if (summary) {
          sendReply(
            t(
              `Öppettider under påsk: ${summary}${range}.`,
              `Horaires de Pâques : ${summary}${range}.`,
              `Easter hours: ${summary}${range}.`
            )
          );
          return true;
        }
      }
      sendReply(
        t(
          "Jag har tyvärr inte öppettiderna för påsk just nu. Kontakta oss så hjälper vi dig.",
          "Je n’ai pas les horaires de Pâques pour le moment. Contactez-nous et on vous aide.",
          "I don’t have the Easter hours right now. Please contact us and we’ll help."
        )
      );
      return true;
    }

    if (monthNumber && !requestedDate) {
      const periods = context?.hours?.periods ?? [];
      const monthPeriods = periods.filter((p) => overlapsMonths(p?.from, p?.to, [monthNumber]));
      if (monthPeriods.length) {
        const lines = monthPeriods
          .map((p) => {
            const rawLabel = p?.name?.trim() ? p.name.trim() : "";
            const label = rawLabel && !/^period\s*\d+/i.test(rawLabel) ? rawLabel : "";
            const summary = describePeriodHours(p as any);
            if (!summary) return "";
            const range = p?.from && p?.to ? ` (${p.from}–${p.to})` : "";
            return label ? `${label}: ${summary}${range}` : `${summary}${range}`;
          })
          .filter(Boolean);
        if (lines.length) {
          sendReply(
            t(
              `Öppettider i ${monthMatch?.[1]}: ${lines.join(" | ")}`,
              `Horaires en ${monthMatch?.[1]} : ${lines.join(" | ")}`,
              `Hours in ${monthMatch?.[1]}: ${lines.join(" | ")}`
            )
          );
          return true;
        }
      }
      const closedForMonth = closedRanges.filter((r) => overlapsMonths(r.start, r.end, [monthNumber]));
      if (closedForMonth.length) {
        const rangesText = closedForMonth
          .map((r) => (r.start === r.end ? r.start : `${r.start}–${r.end}`))
          .join(", ");
        sendReply(
          t(
            `Vi har stängt under ${monthMatch?.[1]}: ${rangesText}.`,
            `Nous sommes fermés pendant ${monthMatch?.[1]} : ${rangesText}.`,
            `We’re closed during ${monthMatch?.[1]}: ${rangesText}.`
          )
        );
        return true;
      }
      sendReply(
        t(
          `Jag har tyvärr inte öppettiderna för ${monthMatch?.[1]} just nu. Kontakta oss så hjälper vi dig.`,
          `Je n’ai pas les horaires pour ${monthMatch?.[1]} pour le moment. Contactez-nous et on vous aide.`,
          `I don’t have the hours for ${monthMatch?.[1]} right now. Please contact us and we’ll help.`
        )
      );
      return true;
    }

    if (/nästa vecka|semaine prochaine|next week/i.test(msgLower)) {
      const baseDt = toUtcDate(base) ?? new Date();
      const cur = baseDt.getUTCDay();
      const deltaToNextMon = ((1 - cur + 7) % 7) || 7;
      const start = addDays(base, deltaToNextMon);
      const days: string[] = [];
      for (let i = 0; i < 7; i++) {
        const d = addDays(start ?? base, i);
        if (d) days.push(d);
      }
      const openDays: string[] = [];
      const closedDays: string[] = [];
      for (const d of days) {
        const hours = getDayHours(d);
        if (!hours || hours.closed || isClosedDate(d)) {
          closedDays.push(`${hours?.dayName ?? d}`);
        } else {
          openDays.push(`${hours.dayName} ${hours.open}–${hours.close}`);
        }
      }
      if (!openDays.length) {
        sendReply(t("Vi har stängt hela nästa vecka.", "Nous sommes fermés toute la semaine prochaine.", "We’re closed all next week."));
        return true;
      }
      sendReply(
        t(
          `Nästa vecka har vi öppet: ${openDays.join(", ")}.${closedDays.length ? ` Stängt: ${closedDays.join(", ")}.` : ""}`,
          `Semaine prochaine, nous sommes ouverts : ${openDays.join(", ")}.${closedDays.length ? ` Fermé : ${closedDays.join(", ")}.` : ""}`,
          `Next week we’re open: ${openDays.join(", ")}.${closedDays.length ? ` Closed: ${closedDays.join(", ")}.` : ""}`
        )
      );
      return true;
    }

    const date = requestedDate;
    if (!date) {
      const period = getPeriodForDate(base);
      const summary = period ? describePeriodHours(period as any) : describePeriodHours({ from: "", to: "", days: context?.hours?.normal ?? {} } as any);
      if (summary) {
        const range = period?.from && period?.to ? ` (${period.from}–${period.to})` : "";
        const closedNotice = currentClosed ? ` Stängt under: ${currentClosed.start}–${currentClosed.end}.` : "";
        sendReply(
          t(
            `Öppettider: ${summary}${range}.${closedNotice}`,
            `Horaires: ${summary}${range}.${closedNotice}`,
            `Hours: ${summary}${range}.${closedNotice}`
          )
        );
        return true;
      }
      sendReply(
        t(
          "Jag har tyvärr inte öppettiderna just nu. Kontakta oss så hjälper vi dig.",
          "Je n’ai pas les horaires pour le moment. Contactez-nous et on vous aide.",
          "I don’t have the hours right now. Please contact us and we’ll help."
        )
      );
      return true;
    }

    const range = closedRangeForDate(date);
    if (range) {
      sendReply(
        t(
          `Vi har en stängd period: ${range.start}–${range.end}.`,
          `Nous sommes fermés pendant cette période : ${range.start}–${range.end}.`,
          `We’re closed during this period: ${range.start}–${range.end}.`
        )
      );
      return true;
    }

    const period = getPeriodForDate(date);
    const periodNote = formatPeriodNote(period);
    const periodSuffix = periodNote
      ? t(` (Gäller ${periodNote})`, ` (Période : ${periodNote})`, ` (Period: ${periodNote})`)
      : "";
    const hours = getDayHours(date);
    if (!hours) {
      sendReply(
        t(
          "Jag har tyvärr inte öppettiderna för det datumet. Kontakta oss så hjälper vi dig.",
          "Je n’ai pas les horaires pour cette date. Contactez-nous et on vous aide.",
          "I don’t have the hours for that date. Please contact us and we’ll help."
        )
      );
      return true;
    }
    if (!hours.open || !hours.close) {
      sendReply(
        t(
          "Jag har tyvärr inga öppettider registrerade för det datumet. Kontakta oss så hjälper vi dig.",
          "Je n’ai pas d’horaires enregistrés pour cette date. Contactez-nous et on vous aide.",
          "I don’t have opening hours recorded for that date. Please contact us and we’ll help."
        )
      );
      return true;
    }
    if (hours.closed || isClosedDate(date)) {
      const dayNameSv = lang === "sv" && hours.dayName ? ` (${hours.dayName})` : "";
      sendReply(
        t(
          `Den ${date}${dayNameSv} har vi stängt.${periodSuffix}`,
          `Le ${date}, nous sommes fermés.${periodSuffix}`,
          `On ${date}, we’re closed.${periodSuffix}`
        )
      );
      return true;
    }
    if (/idag|nu|just nu|today|right now|aujourd/i.test(msgLower) && context?.nowTime) {
      const nowMin = timeToMin(context.nowTime);
      const openMin = timeToMin(hours.open);
      const closeMin = timeToMin(hours.close);
      if (nowMin < openMin) {
        sendReply(
          t(
            `Vi öppnar kl ${hours.open} idag.`,
            `Nous ouvrons à ${hours.open} aujourd’hui.`,
            `We open at ${hours.open} today.`
          )
        );
        return true;
      }
      if (nowMin > closeMin) {
        sendReply(
          t(
            `Vi har stängt för idag. Vi stängde kl ${hours.close}.`,
            `Nous sommes fermés pour aujourd’hui. Nous avons fermé à ${hours.close}.`,
            `We’re closed for today. We closed at ${hours.close}.`
          )
        );
        return true;
      }
    }
    const dayNameSv = lang === "sv" && hours.dayName ? ` (${hours.dayName})` : "";
    sendReply(
      t(
        `Den ${date}${dayNameSv} har vi öppet ${hours.open}–${hours.close}.${periodSuffix}`,
        `Le ${date}, nous sommes ouverts ${hours.open}–${hours.close}.${periodSuffix}`,
        `On ${date}, we’re open ${hours.open}–${hours.close}.${periodSuffix}`
      )
    );
    return true;
  };

  if (await handleHoursQuestion()) return;

  if (!FORCE_OPENAI) {
  const isRestaurantTopic =
    /(boka|bokning|reservation|reservera|réservation|reserver|bord|table|öppet|öppnar|öppning|öppettider|tider|stängt|open|opening|ouvert|horaires|adress|address|adresse|hitta|var ligger|ligger|kontakt|contact|telefon|email|e-post|meny|menu|allergi|gluten|laktos|nöt|betal|kort|kontant|swish|pris|vegetar|vegan|barn|barnstol|hund|djur|terrass|uteservering|parkering|parking|tillgäng|wheelchair|rullstol|alkohol|vin|öl|serverar|kök|kitchen|webbplats|hemsida|website|webb|länk|facebook|instagram|social|bus|m[ée]tro|tram|transport|transports|arr[êe]t|gare)/i.test(
      msgLower
    );
  const lastAssistant = history?.slice().reverse().find((h) => h.role === "assistant")?.content || "";
  const isFollowUp =
    /^(varför|varfor|var|hur|vad|vilken|vilket|vilka|och|då|sa|så|ok|okej|tack)\b/i.test(msgLower) ||
    msgLower.length <= 12;
  const isWhyFollowUp = /^(varför|varfor)\b/i.test(msgLower);
  if (isWhyFollowUp && closedRanges.length) {
    const rangesText = closedRanges
      .map((r) => (r.start === r.end ? r.start : `${r.start}–${r.end}`))
      .join(", ");
    sendReply(
      t(
        `Vi har en stängd period: ${rangesText}.`,
        `Nous sommes fermés pendant cette période : ${rangesText}.`,
        `We’re closed during this period: ${rangesText}.`
      )
    );
    return;
  }
  if (!isRestaurantTopic && !isFollowUp) {
    sendReply(
      t(
        "Jag kan tyvärr bara svara på frågor om restaurangen.",
        "Je peux seulement répondre aux questions sur le restaurant.",
        "I can only answer questions about the restaurant."
      )
    );
    return;
  }
  if (!isRestaurantTopic && isFollowUp && !lastAssistant) {
    sendReply(
      t(
        "Jag kan tyvärr bara svara på frågor om restaurangen.",
        "Je peux seulement répondre aux questions sur le restaurant.",
        "I can only answer questions about the restaurant."
      )
    );
    return;
  }

  if (isWhyFollowUp && lastAssistant) {
    if (/stängt|stängd|stängda/i.test(lastAssistant)) {
      if (closedRanges.length) {
        const rangesText = closedRanges
          .map((r) => (r.start === r.end ? r.start : `${r.start}–${r.end}`))
          .join(", ");
        sendReply(
          t(
            `Vi har en stängd period: ${rangesText}.`,
            `Nous sommes fermés pendant cette période : ${rangesText}.`,
            `We’re closed during this period: ${rangesText}.`
          )
        );
        return;
      }
      sendReply(
        t(
          "Vi är stängda enligt våra öppettider den dagen.",
          "Nous sommes fermés ce jour‑là selon nos horaires.",
          "We’re closed that day according to our opening hours."
        )
      );
      return;
    }
  }

  const normMsg = normalize(message);
  for (const qa of kbFaqs) {
    const qn = normalize(qa.q);
    if (qn && (normMsg.includes(qn) || qn.includes(normMsg)) && qa.a) {
      sendReply(appendWebsiteIfMissing(qa.a));
      return;
    }
  }

  const addressMatch = /(adress|address|var ligger|hitta|vägbeskrivning)/i.test(msgLower);
  if (addressMatch && kbInfo.address) {
    sendReply(`Vi finns på ${kbInfo.address}.`);
    return;
  }
  if (/(telefon|ring|tel)/i.test(msgLower) && kbInfo.phone) {
    sendReply(`Du kan nå oss på ${kbInfo.phone}.`);
    return;
  }
  if (/(e-post|email|mail)/i.test(msgLower) && kbInfo.email) {
    sendReply(`Du kan maila oss på ${kbInfo.email}.`);
    return;
  }
  if (/(meny|menu|à la carte|rätter|mat|vegetar|vegan|gluten|laktos|galett|crêpe|crepe)/i.test(msgLower)) {
    if (!hasMenuInfo && siteUrl) {
      const menuData = await getMenuContent(siteUrl);
      if (menuData.menuText) {
        const tokens = msgLower
          .replace(/[^\p{L}\p{N}\s]/gu, " ")
          .split(/\s+/)
          .filter((w) => w.length > 2);
        const stop = new Set(["menu", "meny", "har", "ni", "finns", "avec", "vous", "des", "est", "are", "have", "do", "the", "and"]);
        const keywords = tokens.filter((w) => !stop.has(w)).slice(0, 8);
        const sentences = menuData.menuText.split(/(?<=[.!?])\s+/);
        const hits = sentences.filter((s) => keywords.some((k) => s.toLowerCase().includes(k))).slice(0, 3);
        if (hits.length) {
          sendReply(
            t(
              `Enligt menyn på hemsidan: ${hits.join(" ")}`,
              `Selon le menu du site officiel : ${hits.join(" ")}`,
              `According to the official menu: ${hits.join(" ")}`
            )
          );
          return;
        }
        sendReply(
          t(
            `Jag hittar inget tydligt i menyn. Här är menyn: ${menuData.menuUrl}`,
            `Je ne trouve rien de clair dans le menu. Voici le menu : ${menuData.menuUrl}`,
            `I couldn’t find a clear match in the menu. Here is the menu: ${menuData.menuUrl}`
          )
        );
        return;
      }
      if (menuData.menuUrl) {
        sendReply(
          t(
            menuData.menuIsPdf
              ? `Menyn är en PDF: ${menuData.menuUrl}`
              : `Menyn (från hemsidan): ${menuData.menuUrl}`,
            menuData.menuIsPdf
              ? `Le menu est en PDF : ${menuData.menuUrl}`
              : `Menu (depuis le site officiel) : ${menuData.menuUrl}`,
            menuData.menuIsPdf
              ? `The menu is a PDF: ${menuData.menuUrl}`
              : `Menu (from the official site): ${menuData.menuUrl}`
          )
        );
        return;
      }
    }
    if (kbInfo.website && /meny|menu/i.test(msgLower)) {
      sendReply(
        t(
          `Menyn finns här: ${kbInfo.website}`,
          `Le menu est ici : ${kbInfo.website}`,
          `The menu is here: ${kbInfo.website}`
        )
      );
      return;
    }
  }
  if (/(hemsida|webbplats|website|webb|site)/i.test(msgLower) && kbInfo.website) {
    sendReply(t(`Vår hemsida: ${kbInfo.website}`, `Notre site : ${kbInfo.website}`, `Our website: ${kbInfo.website}`));
    return;
  }
  if (/(instagram|insta)/i.test(msgLower) && kbInfo.instagram) {
    sendReply(`Instagram: ${kbInfo.instagram}.`);
    return;
  }
  if (/facebook/i.test(msgLower) && kbInfo.facebook) {
    sendReply(`Facebook: ${kbInfo.facebook}.`);
    return;
  }
  if (isMapsQuestion && kbInfo.googleMaps) {
    sendReply(
      t(
        `Här hittar du oss och kan se restid: ${kbInfo.googleMaps}`,
        `Voici notre adresse et le temps de trajet : ${kbInfo.googleMaps}`,
        `Here is our location and travel time: ${kbInfo.googleMaps}`
      )
    );
    return;
  }
  if (/(betal|kort|kontant|swish|cash|bitcoin|btc|apple\s*pay|klarna|faktura)/i.test(msgLower)) {
    const hasPayment = paymentInfo.hasAny;
    if (/swish/i.test(msgLower)) {
      if (paymentInfo.swish) {
        sendReply(t("Ja, vi tar Swish.", "Oui, nous acceptons Swish.", "Yes, we accept Swish."));
      } else if (hasPayment) {
        sendReply(
          t(
            `Nej, vi tar inte Swish. Vi tar ${paymentInfo.text}.`,
            `Non, nous n'acceptons pas Swish. Nous acceptons ${paymentInfo.text}.`,
            `No, we don’t accept Swish. We accept ${paymentInfo.text}.`
          )
        );
      } else {
        sendReply(
          t(
            "Tyvärr har jag ingen information om Swish eller betalningsmetoder just nu.",
            "Je n’ai pas d’information sur Swish ou les moyens de paiement pour le moment.",
            "I don’t have information about Swish or payment methods right now."
          )
        );
      }
      return;
    }
    if (/(kontant|cash)/i.test(msgLower)) {
      if (paymentInfo.cash) {
        sendReply(t("Ja, vi tar kontanter.", "Oui, nous acceptons les espèces.", "Yes, we accept cash."));
      } else if (hasPayment) {
        sendReply(
          t(
            `Nej, vi tar inte kontanter. Vi tar ${paymentInfo.text}.`,
            `Non, nous n'acceptons pas les espèces. Nous acceptons ${paymentInfo.text}.`,
            `No, we don’t accept cash. We accept ${paymentInfo.text}.`
          )
        );
      } else {
        sendReply(
          t(
            "Tyvärr har jag ingen information om kontantbetalning just nu.",
            "Je n’ai pas d’information sur le paiement en espèces pour le moment.",
            "I don’t have information about cash payments right now."
          )
        );
      }
      return;
    }
    if (/(kort|card|visa|mastercard|amex)/i.test(msgLower)) {
      if (paymentInfo.card) {
        sendReply(t("Ja, vi tar kort.", "Oui, nous acceptons les cartes.", "Yes, we accept cards."));
      } else if (hasPayment) {
        sendReply(
          t(
            `Nej, vi tar inte kort. Vi tar ${paymentInfo.text}.`,
            `Non, nous n'acceptons pas les cartes. Nous acceptons ${paymentInfo.text}.`,
            `No, we don’t accept cards. We accept ${paymentInfo.text}.`
          )
        );
      } else {
        sendReply(
          t(
            "Tyvärr har jag ingen information om kortbetalning just nu.",
            "Je n’ai pas d’information sur le paiement par carte pour le moment.",
            "I don’t have information about card payments right now."
          )
        );
      }
      return;
    }
    if (/(bitcoin|btc)/i.test(msgLower)) {
      if (paymentInfo.bitcoin) {
        sendReply(t("Ja, vi tar Bitcoin.", "Oui, nous acceptons le Bitcoin.", "Yes, we accept Bitcoin."));
      } else if (hasPayment) {
        sendReply(
          t(
            `Nej, vi tar inte Bitcoin. Vi tar ${paymentInfo.text}.`,
            `Non, nous n'acceptons pas le Bitcoin. Nous acceptons ${paymentInfo.text}.`,
            `No, we don’t accept Bitcoin. We accept ${paymentInfo.text}.`
          )
        );
      } else {
        sendReply(
          t(
            "Tyvärr har jag ingen information om Bitcoin‑betalning just nu.",
            "Je n’ai pas d’information sur le paiement en Bitcoin pour le moment.",
            "I don’t have information about Bitcoin payments right now."
          )
        );
      }
      return;
    }
    if (hasPayment) {
      sendReply(t(`Vi tar ${paymentInfo.text}.`, `Nous acceptons ${paymentInfo.text}.`, `We accept ${paymentInfo.text}.`));
      return;
    }
    sendReply(
      t(
        "Tyvärr har jag ingen information om betalningsmetoder just nu.",
        "Je n’ai pas d’information sur les moyens de paiement pour le moment.",
        "I don’t have information about payment methods right now."
      )
    );
    return;
  }
  if (/(allerg|gluten|laktos|nöt)/i.test(msgLower) && kbInfo.allergies) {
    sendReply(`Vi kan hjälpa till med: ${kbInfo.allergies}.`);
    return;
  }
  if (/(barnstol)/i.test(msgLower)) {
    if (kidsInfo.chairYes) {
      sendReply(t("Ja, vi har barnstolar.", "Oui, nous avons des chaises hautes.", "Yes, we have high chairs."));
    } else if (kidsInfo.chairNo || kidsInfo.hasAny) {
      sendReply(t("Nej, vi har inga barnstolar.", "Non, nous n’avons pas de chaises hautes.", "No, we don’t have high chairs."));
    } else {
      sendReply(
        t(
          "Jag har tyvärr ingen information om barnstolar just nu.",
          "Je n’ai pas d’information sur les chaises hautes pour le moment.",
          "I don’t have information about high chairs right now."
        )
      );
    }
    return;
  }
  if (/(barnmeny|barnrätt|barnratter|barnvänlig|barnvanlig)/i.test(msgLower)) {
    if (kidsInfo.menuText) {
      sendReply(t(`Barnmeny: ${kidsInfo.menuText}.`, `Menu enfant : ${kidsInfo.menuText}.`, `Kids menu: ${kidsInfo.menuText}.`));
    } else if (kidsInfo.menuYes) {
      sendReply(t("Ja, vi har barnmeny.", "Oui, nous avons un menu enfant.", "Yes, we have a kids menu."));
    } else if (kidsInfo.menuNo || kidsInfo.hasAny) {
      sendReply(t("Nej, vi har ingen barnmeny.", "Non, nous n’avons pas de menu enfant.", "No, we don’t have a kids menu."));
    } else {
      sendReply(
        t(
          "Jag har tyvärr ingen information om barnmeny just nu.",
          "Je n’ai pas d’information sur le menu enfant pour le moment.",
          "I don’t have information about a kids menu right now."
        )
      );
    }
    return;
  }
  if (/(barn|barnvagn)/i.test(msgLower) && (kbInfo.kids || kidsInfo.hasAny)) {
    if (kbInfo.kids) {
      sendReply(`För barn gäller: ${kbInfo.kids}.`);
    } else {
      const parts = [
        kidsInfo.chairYes ? "barnstolar" : kidsInfo.chairNo ? "inga barnstolar" : "",
        kidsInfo.menuText ? `barnmeny (${kidsInfo.menuText})` : kidsInfo.menuYes ? "barnmeny" : kidsInfo.menuNo ? "ingen barnmeny" : "",
      ].filter(Boolean);
      if (parts.length) {
        sendReply(`För barn: ${parts.join(", ")}.`);
      } else {
        sendReply(
          t(
            "Jag har tyvärr ingen information om barnvänliga alternativ just nu.",
            "Je n’ai pas d’information sur les options pour enfants pour le moment.",
            "I don’t have information about kids options right now."
          )
        );
      }
    }
    return;
  }
  if (/(hund|djur|terrass)/i.test(msgLower) && kbInfo.pets) {
    sendReply(`Djurpolicy: ${kbInfo.pets}.`);
    return;
  }
  if (/parkering/i.test(msgLower) && kbInfo.parking) {
    sendReply(`Parkering: ${kbInfo.parking}.`);
    return;
  }
  if (/(kollektiv|buss|tåg|spårvagn|tunnelbana|bus|m[ée]tro|tram|transport|transports|arr[êe]t|gare)/i.test(msgLower) && kbInfo.transport) {
    sendReply(
      t(
        `Kollektivtrafik: ${kbInfo.transport}.`,
        `Transports en commun : ${kbInfo.transport}.`,
        `Public transport: ${kbInfo.transport}.`
      )
    );
    return;
  }

  const findAvailableTable = (args: {
    date: string;
    time: string;
    guests: number;
    bookings: { date: string; time: string; durationMin?: number; tableId?: number | null }[];
    tables: number[];
    durationMin: number;
  }) => {
    const when = round30(args.time);
    const s = timeToMin(when);
    const e = s + args.durationMin;
    const occupied = new Set<number>();

    for (const booking of args.bookings) {
      if (booking.date !== args.date || booking.tableId == null) continue;
      const bs = timeToMin(round30(booking.time));
      const bd = booking.durationMin ?? args.durationMin;
      const be = bs + bd;
      if (overlap(s, e, bs, be)) occupied.add(booking.tableId);
    }

    const available = args.tables
      .map((cap, idx) => ({ id: idx + 1, cap }))
      .filter((table) => !occupied.has(table.id));

    const single = available.find((table) => table.cap >= args.guests);
    if (single) return single.id;

    const combinedCapacity = available.reduce((sum, table) => sum + table.cap, 0);
    if (combinedCapacity >= args.guests) {
      return available[0]?.id ?? null;
    }

    return null;
  };

  if (context && isBookingIntent(message)) {
    const baseDate = context.baseDate;
    const date = parseDate(msgLower, baseDate);
    const time = parseTime(msgLower);
    const guests = parseGuests(msgLower);
    const isTerrace = /(uteservering|ute|terrass|terrasse|patio)/i.test(msgLower);
    const contactEmail = context?.restaurant?.email || kbInfo.email || "";
    const contactBlurb = contactEmail
      ? t(`Kontakta oss gärna på ${contactEmail}.`, `Merci de nous contacter à ${contactEmail}.`, `Please contact us at ${contactEmail}.`)
      : "";

    if (!guests) {
      sendReply(
        isTerrace
          ? t(
              "Gärna! Hur många gäster gäller det för uteserveringen?",
              "Avec plaisir ! Pour combien de personnes souhaitez‑vous la terrasse ?",
              "Sure! How many guests is it for the outdoor seating?"
            )
          : t(
              "Hur många gäster gäller det?",
              "Pour combien de personnes ?",
              "How many guests is it for?"
            )
      );
      return;
    }

    const maxPer = context.seating?.maxGuestsPerReservation ?? 12;
    const maxTotal = context.seating?.maxGuests ?? 60;
    if (guests > maxTotal) {
      sendReply(
        t(
          `Vi har tyvärr max ${maxTotal} gäster samtidigt. Vill du välja en mindre grupp?`,
          `Nous accueillons au maximum ${maxTotal} personnes en même temps. Voulez‑vous un groupe plus petit ?`,
          `We can host up to ${maxTotal} guests at the same time. Would you like a smaller group?`
        )
      );
      return;
    }
    if (maxPer > 0 && guests >= maxPer) {
      if (isTerrace) {
        sendReply(
          t(
            `Vi tar gärna emot större sällskap. För ${guests} gäster behöver ni kontakta oss direkt.${contactBlurb ? ` ${contactBlurb}` : ""}`,
            `Nous prenons volontiers les grands groupes. Pour ${guests} personnes, merci de nous contacter directement.${contactBlurb ? ` ${contactBlurb}` : ""}`,
            `We’re happy to host larger groups. For ${guests} guests, please contact us directly.${contactBlurb ? ` ${contactBlurb}` : ""}`
          )
        );
        return;
      }
      sendReply(
        t(
          `För ${guests} gäster behöver ni kontakta oss direkt.${contactBlurb ? ` ${contactBlurb}` : ""}`,
          `Pour ${guests} personnes, merci de nous contacter directement.${contactBlurb ? ` ${contactBlurb}` : ""}`,
          `For ${guests} guests, please contact us directly.${contactBlurb ? ` ${contactBlurb}` : ""}`
        )
      );
      return;
    }

    if (!date) {
      sendReply(
        t(
          "Vilket datum önskar du boka?",
          "Quelle date souhaitez‑vous réserver ?",
          "What date would you like to book?"
        )
      );
      return;
    }
    if (!time) {
      sendReply(
        t(
          "Vilken tid önskar du?",
          "À quelle heure souhaitez‑vous réserver ?",
          "What time would you like?"
        )
      );
      return;
    }

    const day = toUtcDate(date)?.getUTCDay();
    const dayName = day != null ? weekdaySv[day] : null;
    const range = closedRangeForDate(date);
    if (range) {
      sendReply(
        t(
          `Vi har en stängd period: ${range.start}–${range.end}.`,
          `Nous sommes fermés du ${range.start} au ${range.end}.`,
          `We’re closed from ${range.start}–${range.end}.`
        )
      );
      return;
    }
    const hours = getDayHours(date);
    if (!hours || hours.closed || isClosedDate(date)) {
      sendReply(
        t(
          `Tyvärr, vi har stängt ${dayName ? `på ${dayName}ar` : "den dagen"}.`,
          `Désolé, nous sommes fermés ${dayName ? `le ${dayName}` : "ce jour‑là"}.`,
          `Sorry, we’re closed ${dayName ? `on ${dayName}` : "that day"}.`
        )
      );
      return;
    }
    if (isMadameBlaWeekendDropInOnly(date)) {
      sendReply(
        t(
          "På helger tar vi endast drop-in, så det går inte att boka bord online den dagen.",
          "Les week-ends sont uniquement en drop-in, donc il n’est pas possible de réserver en ligne ce jour-là.",
          "Weekends are drop-in only, so online table bookings are not available that day."
        )
      );
      return;
    }
    const open = hours.open;
    const close = hours.close;
    if (!open || !close) {
      sendReply(
        t(
          "Jag har tyvärr inga öppettider registrerade för den dagen. Välj gärna en annan dag eller kontakta oss.",
          "Je n’ai pas les horaires pour ce jour-là. Choisissez un autre jour ou contactez-nous.",
          "I don’t have the opening hours for that day. Please choose another day or contact us."
        )
      );
      return;
    }
    if (open && close) {
      const requestedTimeMin = timeToMin(time);
      const lastBookingBufferMin = 60;
      const latestStart = Math.max(timeToMin(open), timeToMin(close) - lastBookingBufferMin);
      if (requestedTimeMin < timeToMin(open) || requestedTimeMin > latestStart) {
        sendReply(
          t(
            `Vi har öppet ${open}–${close}. Sista bokningsbara tiden är ${minToTime(latestStart)}. Välj gärna en tidigare tid eller en annan dag.`,
            `Nous sommes ouverts de ${open} à ${close}. La dernière heure réservable est ${minToTime(latestStart)}. Choisissez une heure plus tôt ou un autre jour.`,
            `We’re open ${open}–${close}. The last bookable time is ${minToTime(latestStart)}. Please choose an earlier time or another day.`
          )
        );
        return;
      }
    }

    const tables = context.tables ?? [2, 2, 2, 4, 4, 4, 6, 6];
    const durationMin = context.seating?.maxBookingDurationMin ?? 90;
    const bookings = context.bookings ?? [];
    const tableId = findAvailableTable({ date, time, guests, bookings, tables, durationMin });
    if (!tableId) {
      sendReply(
        t(
          "Tyvärr är det fullt den tiden. Vill du prova en annan tid?",
          "Désolé, c’est complet à cette heure‑là. Voulez‑vous essayer une autre heure ?",
          "Sorry, we’re fully booked at that time. Would you like to try another time?"
        )
      );
      return;
    }

    sendReply(
      t(
        `Det finns plats ${date} kl ${time} för ${guests} gäster. Boka gärna direkt i bokningen här på sidan. 😊`,
        `Il y a de la place le ${date} à ${time} pour ${guests} personnes. Réservez directement ici sur la page. 😊`,
        `We have availability on ${date} at ${time} for ${guests} guests. Please book directly here on the page. 😊`
      )
    );
    return;
  }
  }

  if (context && isBookingIntent(message)) {
    const date = parseDate(msgLower, context.baseDate);
    if (date) {
      const day = toUtcDate(date)?.getUTCDay();
      const dayName = day != null ? weekdaySv[day] : null;
      const range = closedRangeForDate(date);
      if (range) {
        sendReply(
          t(
            `Vi har en stängd period: ${range.start}–${range.end}.`,
            `Nous sommes fermés du ${range.start} au ${range.end}.`,
            `We’re closed from ${range.start}–${range.end}.`
          )
        );
        return;
      }
      const hours = getDayHours(date);
      if (!hours || hours.closed || isClosedDate(date)) {
        sendReply(
          t(
            `Tyvärr, vi har stängt ${dayName ? `på ${dayName}ar` : "den dagen"}.`,
            `Désolé, nous sommes fermés ${dayName ? `le ${dayName}` : "ce jour‑là"}.`,
            `Sorry, we’re closed ${dayName ? `on ${dayName}` : "that day"}.`
          )
        );
        return;
      }
    }
  }

  systemPrompt = buildSystemPrompt();

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "system", content: guardrailPrompt },
        { role: "system", content: languageDirective },
        ...(history ?? []),
        { role: "user", content: message },
      ],
    }),
  });

  const data = await r.json();
  if (!r.ok) {
    const msg =
      data?.error?.message ||
      data?.error ||
      `OpenAI error (${r.status})`;
    res.status(500).json({ error: msg });
    return;
  }

  const reply =
    (data?.choices?.[0]?.message?.content ?? "").trim() ||
    "Jag kan tyvärr inte svara säkert på det just nu. Jag vidarebefordrar din fråga och vi återkommer så snart som möjligt.";

  const normalized = reply.toLowerCase();
  if (
    /quel\s+(café|cafe|restaurant|établissement|etablissement)/i.test(reply) ||
    /vilken\s+(plats|verksamhet|butik|restaurang|café|ställe)/i.test(reply) ||
    /vilket\s+(café|cafe|restaurang|ställe)/i.test(reply) ||
    /which\s+(cafe|restaurant|place)/i.test(reply) ||
    /can you specify/i.test(reply) ||
    /kan du specificera/i.test(reply) ||
    /(skapa|create)\s+(en\s+)?(meny|menu)/i.test(reply) ||
    /sugg(érer|erir|est|estão|est)\s+(des\s+)?plats|dishes/i.test(reply)
  ) {
    const fallback =
      identity.name || identity.address
        ? t(
            `Vi representerar ${identity.name || "restaurangen"}. ${identity.address ? `Adress: ${identity.address}.` : ""}`,
            `Nous représentons ${identity.name || "le restaurant"}. ${identity.address ? `Adresse : ${identity.address}.` : ""}`,
            `We represent ${identity.name || "the restaurant"}. ${identity.address ? `Address: ${identity.address}.` : ""}`
          )
        : t(
            "Vi representerar restaurangen, men namn/adress saknas i kunskapsbasen. Fyll i det i inställningarna.",
            "Nous représentons le restaurant, mais le nom/adresse manquent dans la base de connaissances. Merci de les renseigner.",
            "We represent the restaurant, but the name/address is missing in the knowledge base. Please add it."
          );
    sendReply(fallback);
    return;
  }

  sendReply(reply);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "AI error";
    res.status(500).json({ error: msg });
  }
}
