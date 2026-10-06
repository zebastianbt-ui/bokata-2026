import calendarHandler from "../lib/calendarHandler";
import calendarSyncHandler from "../lib/calendarSyncHandler";
import bookingManageHandler from "../lib/bookingManageHandler";
export const config = { maxDuration: 60 };
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { PRIMARY_RESTAURANT_MISMATCH_CODE, resolveOwnerPrimaryRestaurant } from "../lib/ownerPrimary";

const getEnv = (key: string) => process.env[key] ?? "";

type BookingSettingsPayload = {
  restaurantId?: string;
  hours?: unknown;
  seating?: unknown;
  notify_email?: string | null;
  notify_enabled?: boolean | null;
  require_manual_confirmation?: boolean | null;
  knowledge_public?: string | null;
  knowledge?: string | null;
  assistant_name?: string | null;
  web_search_enabled?: boolean | null;
  site_url?: string | null;
  google_maps_url?: string | null;
  facebook_url?: string | null;
  instagram_url?: string | null;
  forceOverwrite?: boolean;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return !!value && typeof value === "object" && !Array.isArray(value);
};

const stringLength = (value: unknown) => (typeof value === "string" ? value.trim().length : 0);

const hasHoursData = (hours: unknown) => {
  if (!isRecord(hours)) return false;
  const normal = isRecord(hours.normal) ? hours.normal : null;
  const special = Array.isArray(hours.special) ? hours.special : [];
  const periods = Array.isArray(hours.periods) ? hours.periods : [];

  const dayHasData = (day: unknown) => {
    if (!isRecord(day)) return false;
    const openLen = stringLength(day.open);
    const closeLen = stringLength(day.close);
    return day.closed === true || openLen > 0 || closeLen > 0;
  };

  if (normal && Object.values(normal).some(dayHasData)) return true;
  if (
    periods.some(
      (period) => isRecord(period) && isRecord(period.days) && Object.values(period.days).some(dayHasData)
    )
  ) {
    return true;
  }
  if (special.some(dayHasData)) return true;
  return false;
};

const hasSeatingData = (seating: unknown) => {
  if (!isRecord(seating)) return false;
  const numericKeys = [
    "maxGuests",
    "maxGuestsPerReservation",
    "groupThreshold",
    "maxBookingDurationMin",
    "maxTables",
    "highChairs",
    "followUpDelayDays",
  ];
  const booleanKeys = ["followUpEnabled"];
  const stringKeys = ["followUpEmail"];

  if (numericKeys.some((key) => typeof seating[key] === "number" && Number.isFinite(seating[key] as number))) {
    return true;
  }
  if (booleanKeys.some((key) => typeof seating[key] === "boolean")) {
    return true;
  }
  if (stringKeys.some((key) => stringLength(seating[key]) > 0)) {
    return true;
  }

  if (isRecord(seating.mealRanges)) {
    const mealRanges = seating.mealRanges as Record<string, unknown>;
    const meals = ["Frukost", "Lunch", "Fika", "Middag"];
    if (
      meals.some((meal) => {
        const value = mealRanges[meal];
        return (
          Array.isArray(value) &&
          value.length === 2 &&
          stringLength(value[0]) > 0 &&
          stringLength(value[1]) > 0
        );
      })
    ) {
      return true;
    }
  }

  return false;
};

const isSuspiciousOverwrite = (args: {
  existingKnowledge: unknown;
  incomingKnowledge: unknown;
  existingHours: unknown;
  incomingHours: unknown;
  existingSeating: unknown;
  incomingSeating: unknown;
}) => {
  const existingKnowledgeLen = stringLength(args.existingKnowledge);
  const incomingKnowledgeLen = stringLength(args.incomingKnowledge);
  const largeKnowledgeDrop =
    existingKnowledgeLen >= 300 &&
    incomingKnowledgeLen + 120 < existingKnowledgeLen &&
    incomingKnowledgeLen < Math.floor(existingKnowledgeLen * 0.9);

  const hoursRemoved = hasHoursData(args.existingHours) && !hasHoursData(args.incomingHours);
  const seatingRemoved = hasSeatingData(args.existingSeating) && !hasSeatingData(args.incomingSeating);

  return largeKnowledgeDrop || hoursRemoved || seatingRemoved;
};

const isSuspiciousAiOverwrite = (existingKnowledge: unknown, incomingKnowledge: unknown) => {
  const existingLen = stringLength(existingKnowledge);
  const incomingLen = stringLength(incomingKnowledge);
  return (
    existingLen >= 300 &&
    incomingLen + 120 < existingLen &&
    incomingLen < Math.floor(existingLen * 0.9)
  );
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Shared deployment entry point; each handler enforces its own authorization.
  if (req.query.calendarRoute === "calendar") return calendarHandler(req, res);
  if (req.query.calendarRoute === "sync") return calendarSyncHandler(req, res);
  if (req.query.calendarRoute === "manage") return bookingManageHandler(req, res);
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method Not Allowed" });
    return;
  }

  const supabaseUrl = getEnv("SUPABASE_URL") || getEnv("VITE_SUPABASE_URL");
  const anonKey = getEnv("SUPABASE_ANON_KEY") || getEnv("VITE_SUPABASE_ANON_KEY");
  const serviceKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !anonKey || !serviceKey) {
    res.status(500).json({ error: "Missing Supabase env vars" });
    return;
  }

  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) {
    res.status(401).json({ error: "Missing auth token" });
    return;
  }

  const authClient = createClient(supabaseUrl, anonKey, { auth: { persistSession: false } });
  const { data: userData, error: userError } = await authClient.auth.getUser(token);
  if (userError || !userData?.user) {
    res.status(401).json({ error: "Invalid auth token" });
    return;
  }

  const {
    restaurantId,
    hours,
    seating,
    notify_email,
    notify_enabled,
    require_manual_confirmation,
    knowledge_public,
    knowledge,
    assistant_name,
    web_search_enabled,
    site_url,
    google_maps_url,
    facebook_url,
    instagram_url,
    forceOverwrite,
  } = (req.body ?? {}) as BookingSettingsPayload;

  if (!restaurantId) {
    res.status(400).json({ error: "Missing restaurantId" });
    return;
  }

  const hasBookingPayload =
    hours !== undefined ||
    seating !== undefined ||
    notify_email !== undefined ||
    notify_enabled !== undefined ||
    require_manual_confirmation !== undefined ||
    knowledge_public !== undefined;

  const hasAiPayload =
    knowledge !== undefined ||
    assistant_name !== undefined ||
    web_search_enabled !== undefined ||
    site_url !== undefined ||
    google_maps_url !== undefined ||
    facebook_url !== undefined ||
    instagram_url !== undefined;

  if (!hasBookingPayload && !hasAiPayload) {
    res.status(400).json({ error: "No settings payload provided" });
    return;
  }

  const serviceClient = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const userId = userData.user.id;

  const ownerPrimary = await resolveOwnerPrimaryRestaurant(serviceClient, userId);
  if (ownerPrimary.error) {
    res.status(500).json({ error: ownerPrimary.error });
    return;
  }

  if (
    ownerPrimary.isOwner &&
    !ownerPrimary.missingTable &&
    ownerPrimary.restaurantId &&
    ownerPrimary.restaurantId !== restaurantId
  ) {
    res.status(409).json({
      error: "Write blocked: this account can only update its primary restaurant settings.",
      code: PRIMARY_RESTAURANT_MISMATCH_CODE,
      expectedRestaurantId: ownerPrimary.restaurantId,
    });
    return;
  }

  const { data: memberships, error: membershipError } = await serviceClient
    .from("memberships")
    .select("restaurant_id, role")
    .eq("user_id", userId)
    .eq("restaurant_id", restaurantId)
    .limit(1);

  const membership = memberships?.[0] ?? null;

  if (membershipError) {
    res.status(500).json({ error: membershipError.message });
    return;
  }

  if (!membership) {
    const { data: ownedRestaurant, error: restaurantError } = await serviceClient
      .from("restaurants")
      .select("id, owner_id")
      .eq("id", restaurantId)
      .maybeSingle();

    if (restaurantError) {
      res.status(500).json({ error: restaurantError.message });
      return;
    }

    if (ownedRestaurant?.owner_id !== userId) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const { error: insertMembershipError } = await serviceClient
      .from("memberships")
      .insert({ restaurant_id: restaurantId, user_id: userId, role: "owner" });
    if (insertMembershipError && insertMembershipError.code !== "23505") {
      res.status(500).json({ error: insertMembershipError.message });
      return;
    }
  }

  if (hasAiPayload) {
    const { data: existingAiSettings, error: existingAiSettingsError } = await serviceClient
      .from("ai_settings")
      .select("knowledge")
      .eq("restaurant_id", restaurantId)
      .maybeSingle();

    if (existingAiSettingsError) {
      res.status(500).json({ error: existingAiSettingsError.message });
      return;
    }

    if (!forceOverwrite && isSuspiciousAiOverwrite(existingAiSettings?.knowledge, knowledge)) {
      res.status(409).json({
        error:
          "Blocked suspicious AI knowledge overwrite. Reload the dashboard first, then retry only if this large change is intentional.",
        code: "SUSPICIOUS_OVERWRITE_BLOCKED",
      });
      return;
    }

    const { error: aiError } = await serviceClient.from("ai_settings").upsert(
      {
        restaurant_id: restaurantId,
        knowledge: knowledge ?? null,
        assistant_name: assistant_name ?? null,
        web_search_enabled: web_search_enabled ?? null,
        site_url: site_url ?? null,
        google_maps_url: google_maps_url ?? null,
        facebook_url: facebook_url ?? null,
        instagram_url: instagram_url ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "restaurant_id" }
    );

    if (aiError) {
      res.status(500).json({ error: aiError.message });
      return;
    }

    if (!hasBookingPayload) {
      res.status(200).json({ ok: true });
      return;
    }
  }

  const { data: existingSettings, error: existingSettingsError } = await serviceClient
    .from("booking_public_settings")
    .select("knowledge_public,hours,seating")
    .eq("public_id", restaurantId)
    .maybeSingle();

  if (existingSettingsError) {
    res.status(500).json({ error: existingSettingsError.message });
    return;
  }

  if (
    !forceOverwrite &&
    isSuspiciousOverwrite({
      existingKnowledge: existingSettings?.knowledge_public,
      incomingKnowledge: knowledge_public,
      existingHours: existingSettings?.hours,
      incomingHours: hours,
      existingSeating: existingSettings?.seating,
      incomingSeating: seating,
    })
  ) {
    res.status(409).json({
      error:
        "Blocked suspicious settings overwrite. Reload the dashboard first, then retry only if this large change is intentional.",
      code: "SUSPICIOUS_OVERWRITE_BLOCKED",
    });
    return;
  }

  const { error } = await serviceClient.from("booking_public_settings").upsert(
    {
      public_id: restaurantId,
      hours,
      seating,
      notify_email: notify_email ?? null,
      notify_enabled: notify_enabled ?? null,
      require_manual_confirmation: require_manual_confirmation ?? null,
      knowledge_public: knowledge_public ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "public_id" }
  );

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.status(200).json({ ok: true });
}
