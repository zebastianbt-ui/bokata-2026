import React, { useCallback, useEffect, useRef, useState } from "react";

type Connection = { provider: "google" | "apple"; connected: boolean; lastSyncedAt: string | null; error: string | null; feedUrl?: string };
type CalendarState = { googleAvailable: boolean; connections: Connection[] };
export default function CalendarConnections({ restaurantId, accessToken, isOwner }: {
  restaurantId: string; accessToken: string; isOwner: boolean;
}) {
  const [state, setState] = useState<CalendarState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const initialSync = useRef(false);
  const request = useCallback(async (action: string, body?: Record<string, string>, signal?: AbortSignal) => {
    const query = new URLSearchParams({ action, ...(body ? {} : { restaurantId }) });
    const response = await fetch(`/api/calendar?${query}`, {
      method: body ? "POST" : "GET", cache: "no-store", signal,
      headers: { Authorization: `Bearer ${accessToken}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify({ restaurantId, ...body }) } : {}),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Kalendern kunde inte anslutas. Försök igen.");
    return data;
  }, [restaurantId, accessToken]);
  const refresh = useCallback(async () => setState(await request("status")), [request]);
  useEffect(() => {
    if (!isOwner) { setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true); setState(null); setError("");
    request("status", undefined, controller.signal).then(setState)
      .catch(err => { if (!controller.signal.aborted) setError(err.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [request, isOwner]);
  const run = async (action: string, provider: string) => {
    setBusy(`${provider}:${action}`); setError(""); setMessage("");
    try {
      const data = await request(action, { provider });
      if (action === "google-connect") { window.location.assign(data.url); return; }
      if (action === "sync") {
        setMessage(data.busy ? "Synkroniseringen pågår redan."
          : data.remaining ? "Synkroniseringen har startat. Fler bokningar överförs automatiskt inom kort."
          : "Google Calendar är uppdaterat.");
      }
      if (action === "apple-connect") setMessage("Länken är klar. Öppna Apple Kalender nedan för att slutföra prenumerationen.");
      if (action === "disconnect") setMessage(provider === "apple"
        ? "Länken är inaktiverad. Ta även bort prenumerationen i Apple Kalender."
        : "Synkroniseringen är avstängd. Kalendern och tidigare händelser finns kvar i Google Calendar.");
      await refresh();
    } catch (err) { setError(err instanceof Error ? err.message : "Försök igen senare."); }
    finally { setBusy(""); }
  };
  useEffect(() => {
    const result = new URLSearchParams(window.location.search).get("calendar");
    if (!result || initialSync.current || !state) return;
    initialSync.current = true;
    const url = new URL(window.location.href); url.searchParams.delete("calendar");
    window.history.replaceState({}, "", url);
    if (result === "connected") {
      setMessage("Google Calendar är anslutet. Dina bokningar synkroniseras nu.");
      void run("sync", "google");
    } else if (result === "cancelled") setMessage("Anslutningen avbröts. Du kan försöka igen när du vill.");
    else setError("Google Calendar kunde inte anslutas. Försök igen och godkänn kalenderåtkomsten hos Google.");
  }, [state]);
  const google = state?.connections.find(c => c.provider === "google");
  const apple = state?.connections.find(c => c.provider === "apple");
  const button = "inline-flex items-center justify-center rounded-xl px-4 py-2.5 text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed";
  const primary = `${button} bg-violet-700 text-white hover:bg-violet-800`;
  const secondary = `${button} border border-gray-200 bg-white text-gray-700 hover:bg-gray-50`;
  const copyAppleLink = async () => {
    try {
      await navigator.clipboard.writeText(apple?.feedUrl || "");
      setMessage("Kalenderlänken är kopierad.");
    } catch { setError("Länken kunde inte kopieras. Markera och kopiera den i fältet nedan."); }
  };
  return <div onInputCapture={e => e.stopPropagation()} onChangeCapture={e => e.stopPropagation()}>
    <p className="text-sm text-gray-600 mb-4">Se dina bokningar i kalendern du redan använder. Välj Google Calendar, Apple Kalender eller båda.</p>
    {!isOwner ? <p className="text-sm text-gray-600">Restaurangens ägare kan ansluta en kalender.</p> : <>
      {loading && <p role="status" className="text-sm text-gray-500">Hämtar kalenderanslutningar…</p>}
      {error && <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800" role="alert">{error}</div>}
      {message && <div className="mb-4 rounded-xl bg-violet-50 p-3 text-sm text-violet-800" role="status">{message}</div>}
      <div className="space-y-4">
        <div className="rounded-2xl border border-violet-100 bg-white p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-bold text-gray-800">Google Calendar</h3>
            {google?.connected && <span className="rounded-full bg-green-50 px-2.5 py-1 text-xs font-semibold text-green-800">Ansluten</span>}
          </div>
          <p className="mt-2 text-sm text-gray-600">En separat Bokäta-kalender skapas i ditt Google-konto. Nya bokningar, ändringar och avbokningar synkroniseras automatiskt.</p>
          <p className="mt-2 text-xs text-gray-500">Uppdateras normalt inom några minuter. Dina övriga kalendrar påverkas inte.</p>
          {google?.error && <p className="mt-3 text-sm text-rose-700">{google.error}</p>}
          {google?.lastSyncedAt && <p className="mt-3 text-xs text-gray-500">Senast synkroniserad: {new Date(google.lastSyncedAt).toLocaleString("sv-SE")}</p>}
          <div className="mt-4 flex flex-wrap gap-2">
            {google?.connected ? <>
              <button type="button" className={primary} disabled={!!busy} onClick={() => void run("sync", "google")}>{busy === "google:sync" ? "Synkroniserar…" : "Synkronisera nu"}</button>
              {google.error && <button type="button" className={secondary} disabled={!!busy || !state?.googleAvailable} onClick={() => void run("google-connect", "google")}>Anslut igen</button>}
              <button type="button" className={secondary} disabled={!!busy} onClick={() => void run("disconnect", "google")}>Koppla från</button>
            </> : <button type="button" className={primary} disabled={!!busy || !state?.googleAvailable} onClick={() => void run("google-connect", "google")}>{busy === "google:google-connect" ? "Öppnar Google…" : "Anslut Google Calendar"}</button>}
          </div>
          {google?.connected && <p className="mt-3 text-xs text-gray-500">Om du kopplar från finns kalendern och tidigare händelser kvar i Google Calendar, men uppdateras inte längre.</p>}
          {state && !state.googleAvailable && <p className="mt-3 text-xs text-gray-500">Google-anslutningen är inte aktiverad för Bokäta ännu.</p>}
        </div>
        <div className="rounded-2xl border border-violet-100 bg-white p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-bold text-gray-800">Apple Kalender</h3>
            {apple?.connected && <span className="rounded-full bg-violet-50 px-2.5 py-1 text-xs font-semibold text-violet-800">Prenumerationslänk klar</span>}
          </div>
          <p className="mt-2 text-sm text-gray-600">Prenumerera på restaurangens bokningar på iPhone, iPad eller Mac. Välj iCloud när du lägger till kalendern för att se den på dina Apple-enheter.</p>
          <p className="mt-2 text-xs text-gray-500">Apple styr hur ofta kalendern hämtas. Ändringar kan därför visas med fördröjning.</p>
          {apple?.feedUrl ? <>
            <div className="mt-4 flex flex-wrap gap-2">
              <a className={primary} href={apple.feedUrl.replace(/^https?:/, "webcal:")}>Öppna Apple Kalender</a>
              <button type="button" className={secondary} onClick={() => void copyAppleLink()}>Kopiera kalenderlänk</button>
            </div>
            <details className="mt-4 text-sm text-gray-600">
              <summary className="cursor-pointer font-semibold">Lägg till manuellt</summary>
              <p className="mt-2">På iPhone eller iPad: Kalender → Kalendrar → Lägg till kalender → Lägg till prenumererad kalender. På Mac: Arkiv → Ny kalenderprenumeration.</p>
              <label className="mt-3 block text-xs font-semibold" htmlFor="apple-calendar-url">Din privata kalenderlänk</label>
              <input id="apple-calendar-url" className="mt-1 w-full rounded-lg border border-gray-200 p-2 text-xs" readOnly value={apple.feedUrl} onFocus={event => event.target.select()} />
              <p className="mt-2 text-xs">Länken ger åtkomst till bokningarnas namn och tider. Dela den bara med personer som ska ha tillgång.</p>
            </details>
            <button type="button" className="mt-4 text-sm font-semibold text-gray-500 underline disabled:opacity-50" disabled={!!busy} onClick={() => void run("disconnect", "apple")}>Inaktivera kalenderlänken</button>
          </> : <button type="button" className={`${primary} mt-4`} disabled={!!busy || !state} onClick={() => void run("apple-connect", "apple")}>{busy === "apple:apple-connect" ? "Skapar länk…" : "Anslut Apple Kalender"}</button>}
        </div>
      </div>
      <p className="mt-4 text-xs leading-relaxed text-gray-500">Namn, antal gäster, tid och bokningsstatus visas. Kalendern omfattar de senaste 30 dagarna och det kommande året. Ändra och avboka alltid i Bokäta.</p>
    </>}
  </div>;
}
