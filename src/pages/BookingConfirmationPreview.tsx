import React, { useState } from "react";
import BookingConfirmation from "../components/BookingConfirmation";
import forkTransparent from "../assets/fork-transparent.png";
import { BOOKING_TIME_ZONE } from "../../lib/specialRestaurantRules";

export default function BookingConfirmationPreview() {
  const [date, setDate] = useState(() => {
    const today = new Intl.DateTimeFormat("sv-SE", { timeZone: BOOKING_TIME_ZONE }).format(new Date());
    const sample = new Date(`${today}T12:00:00Z`);
    sample.setUTCDate(sample.getUTCDate() + (4 - sample.getUTCDay() + 7) % 7);
    return sample.toISOString().slice(0, 10);
  });
  return <div className="min-h-screen bg-white text-gray-900">
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
              <div className="text-sm text-gray-500">Madame Blå</div>
            </div>
          </div>
        </div>
      </header>
    <aside className="mx-auto max-w-2xl px-4 pt-5 pb-3 text-sm text-gray-600" aria-label="Förhandsvisning">
      <p className="font-semibold text-violet-700">Förhandsvisning – ingen riktig bokning har skapats.</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <label htmlFor="preview-date">Prova ett annat datum:</label>
        <input id="preview-date" type="date" value={date} onChange={event => { if (event.target.value) setDate(event.target.value); }} className="rounded-lg border border-violet-200 px-3 py-1.5" />
      </div>
    </aside>
    <main className="max-w-6xl mx-auto px-4 pt-2 md:pt-8 pb-8">
      <BookingConfirmation reservation={{ email: "gast@example.com", date, time: "11:00", guests: 2, name: "Anna Svensson" }} />
    </main>
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
  </div>;
}
