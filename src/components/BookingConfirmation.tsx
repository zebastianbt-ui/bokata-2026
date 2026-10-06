import React from "react";
import { bookingFarewell } from "../../lib/bookingFarewell";

type ConfirmationReservation = {
  email: string; date: string; time: string; guests: number; name: string;
  phone?: string; notes?: string;
};

export default function BookingConfirmation({ reservation }: { reservation: ConfirmationReservation }) {
  return (
          <section className="max-w-2xl mx-auto">
            <div className="rounded-3xl bg-white shadow-sm border border-violet-100 p-6 md:p-8 text-center">
              <h2 className="text-xl md:text-2xl font-extrabold text-gray-800">Tack! Din bokning är skickad</h2>
              <p className="text-gray-600 mt-2">
                En bekräftelse skickas till <span className="font-semibold">{reservation.email}</span> inom kort.
              </p>
              <p className="text-gray-600 mt-2">
                Om du inte hittar mejlet, glöm inte att kontrollera din skräppost.
              </p>

              <div className="mt-6 text-sm bg-violet-50 border border-violet-100 rounded-2xl p-4 text-left">
                <div>
                  <span className="font-semibold">Datum:</span> {reservation.date}
                </div>
                <div>
                  <span className="font-semibold">Tid:</span> {reservation.time}
                </div>
                <div>
                  <span className="font-semibold">Gäster:</span> {reservation.guests}
                </div>
                <div>
                  <span className="font-semibold">Namn:</span> {reservation.name}
                </div>
                {reservation.phone && (
                  <div>
                    <span className="font-semibold">Telefon:</span> {reservation.phone}
                  </div>
                )}
                {reservation.notes && (
                  <div>
                    <span className="font-semibold">Kommentar:</span> {reservation.notes}
                  </div>
                )}
              </div>

              <p className="mt-6 text-xl font-bold text-violet-700">
                {bookingFarewell(reservation.date)}
              </p>

            </div>
          </section>
  );
}
