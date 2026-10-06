import React, { useEffect, useState } from "react";
import { BOOKING_TIME_ZONE } from "../../lib/specialRestaurantRules";

type Booking = { date: string; time: string; guests: number; name: string; status: string };

export default function ManageBookingPage() {
  const [credentials] = useState(() => Object.fromEntries(new URLSearchParams(window.location.search)));
  const [booking, setBooking] = useState<Booking | null>(null);
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: BOOKING_TIME_ZONE }).format(new Date());

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/bookings-manage?${new URLSearchParams(credentials)}`, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Bokningen kunde inte hämtas.");
        setBooking(data.booking);
        setDate(data.booking.date);
        setTime(data.booking.time);
      })
      .catch((err) => { if (!controller.signal.aborted) setError(err.message || "Kontrollera din anslutning och försök igen."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [credentials]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true); setError(""); setSuccess("");
    try {
      const response = await fetch("/api/bookings", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...credentials, date, time }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Bokningen kunde inte ändras.");
      setBooking((previous) => previous && { ...previous, date, time, status: data.status });
      const emailFailed = !data.emailDelivery?.some((delivery: any) => delivery.purpose === "guest-confirmation" && delivery.ok);
      setSuccess(data.status === "pending"
        ? "Ändringen är sparad och väntar på restaurangens bekräftelse. Du får ett mejl när bokningen har bekräftats."
        : emailFailed
          ? "Din bokning har ändrats, men bekräftelsemejlet kunde inte skickas. Dina nya uppgifter visas nedan."
          : "Din bokning har ändrats! En ny bekräftelse skickas till din e-postadress inom kort. Kontrollera gärna din skräppost om du inte hittar mejlet.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kontrollera din anslutning och försök igen.");
    } finally { setSaving(false); }
  };

  const editable = booking && ["confirmed", "pending"].includes(booking.status) && booking.date >= today;
  return (
    <main className="min-h-screen bg-violet-50/40 px-4 py-12 text-gray-800">
      <section className="max-w-xl mx-auto rounded-3xl bg-white border border-violet-100 p-6 sm:p-8 shadow-sm">
        <p className="font-bold text-pink-600 mb-5">Bokäta</p>
        <h1 className="text-2xl font-extrabold">Ändra din bokning</h1>
        {loading && <p className="mt-4" role="status">Hämtar din bokning…</p>}
        {error && <p className="mt-4 p-3 rounded-xl bg-rose-50 text-rose-800" role="alert">{error}</p>}
        {success && <p className="mt-4 p-3 rounded-xl bg-green-50 text-green-800" role="status">{success}</p>}
        {booking && <>
          <div className="my-6 p-4 rounded-2xl bg-violet-50">
            <p className="font-semibold">{booking.name}</p>
            <p>{booking.date} kl {booking.time} · {booking.guests} gäster</p>
            {booking.status === "pending" && <p className="mt-2">Väntar på restaurangens bekräftelse</p>}
          </div>
          {editable ? <form onSubmit={submit} className="space-y-5">
            <p className="text-gray-600">Välj ett nytt datum och klockslag. Vi kontrollerar att det finns plats när du sparar.</p>
            <div>
              <label htmlFor="booking-date" className="block font-semibold mb-2">Datum</label>
              <input id="booking-date" type="date" required min={today} value={date} disabled={saving}
                onChange={(event) => { setDate(event.target.value); setSuccess(""); }} className="w-full rounded-xl border border-violet-200 px-4 py-3" />
            </div>
            <div>
              <label htmlFor="booking-time" className="block font-semibold mb-2">Tid</label>
              <input id="booking-time" type="time" required value={time} disabled={saving}
                onChange={(event) => { setTime(event.target.value); setSuccess(""); }} className="w-full rounded-xl border border-violet-200 px-4 py-3" />
            </div>
            <button disabled={saving || (date === booking.date && time === booking.time)} type="submit"
              className="w-full rounded-2xl px-5 py-3 font-semibold text-white bg-gradient-to-r from-violet-600 via-pink-600 to-rose-600 disabled:opacity-50">
              {saving ? "Sparar…" : "Spara ändringar"}
            </button>
          </form> : <p>Den här bokningen kan inte längre ändras. Kontakta restaurangen för hjälp.</p>}
        </>}
      </section>
    </main>
  );
}
