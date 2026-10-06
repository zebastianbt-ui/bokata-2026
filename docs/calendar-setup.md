# Restaurant calendars

The dashboard's **Inställningar → Kalenderanslutningar** lets the restaurant owner enable Google Calendar, Apple Calendar, or both. The feature is implemented locally; the production database and Google OAuth project still need configuration.

## What is synchronized

- Google: a dedicated `Bokäta · restaurant name` calendar, using only the `calendar.app.created` permission. The app does not read or write the owner's existing calendars.
- Apple: a private, revocable iCalendar subscription. The owner completes the subscription in Apple Calendar and can select iCloud to use it across devices.
- Both: guest name, party size, start/end time and pending/confirmed status. Phone numbers, email addresses and free-text notes are excluded. Booking times use Europe/Stockholm, with daylight saving handled before exporting UTC timestamps.
- Rolling window: previous 30 days and next 365 days. Older and farther-future reservations are outside this calendar view.
- One-way synchronization: make changes in Bokäta. Rescheduling updates the existing Google event; cancellation/deletion removes it. Apple receives the current snapshot at its next refresh. Apple's refresh hint is 15 minutes, but the client controls the actual interval.
- Disconnecting Google stops synchronization and deletes the stored refresh token; existing Google calendar entries remain. Reconnecting the same accessible calendar reuses it. The user can remove the old calendar in Google if desired. Disconnecting Apple invalidates its link; the subscription can then be removed in Apple Calendar.

## Production configuration (once for Bokäta)

1. Apply `docs/sql/2026-10-06-calendar-connections.sql` in the production Supabase SQL editor. This creates server-only connection/OAuth state tables, a booking timestamp trigger, a reconciliation queue flag, and synchronization leases. It does not enable any connections by itself.
2. Set server environment variables (never `VITE_` variables):
   - `SITE_URL=https://www.bokata.se` (canonical HTTPS origin).
   - `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (existing server configuration).
   - `CALENDAR_ENCRYPTION_KEY`: 32 random bytes encoded as base64, for example generated with `openssl rand -base64 32`. Store in the hosting secret manager. Keep stable: changing it invalidates all Apple links and makes existing Google refresh tokens unreadable.
   - `GOOGLE_CALENDAR_CLIENT_ID` and `GOOGLE_CALENDAR_CLIENT_SECRET`.
   - `CRON_SECRET`: a strong random secret. Vercel includes it as `Authorization: Bearer …` on scheduled requests.
3. In Google Cloud, enable **Google Calendar API**, configure the OAuth consent screen for external users, and create a **Web application** OAuth client. Add this exact redirect URI:

   `https://www.bokata.se/api/calendar?action=google-callback`

   Request only `https://www.googleapis.com/auth/calendar.app.created`. Configure the support contact, app domain, privacy policy and test users; complete Google's production publishing/verification requirements before making this available to all restaurant owners. OAuth clients in testing mode can have short-lived refresh grants.
4. Deploy the code and migration together. `vercel.json` invokes `/api/calendar-sync` every five minutes; **this frequency requires Vercel Pro/Enterprise**. On Hobby, use an authenticated external scheduler instead and remove that cron entry before deploying. Do not silently replace it with a daily job: that would violate the intended refresh behavior. The endpoint requires the bearer secret; `x-vercel-cron` alone is rejected.
5. Log in as a restaurant owner, open the calendar settings and authorize a test Google account. Confirm the first synchronization, then subscribe from an Apple device. No customer emails are sent by calendar synchronization and no guest attendees are added.

## Reliability and access

- Only the restaurant's actual owner can connect/disconnect/read subscription URLs. Each provider has one connection per restaurant. On ownership transfer, prior Apple URLs stop resolving and Google credentials are disabled by the worker. An old Apple row must be removed by an administrator before the new owner creates a replacement subscription.
- OAuth uses a single-use, ten-minute random state, bound to an HttpOnly/SameSite browser cookie and the authenticated owner. Refresh tokens are encrypted with AES-256-GCM and bound to the restaurant.
- Database booking triggers mark Google connections dirty for inserts, updates and deletes, regardless of whether the booking came from the public form, AI, dashboard or guest modification flow.
- The worker processes up to 30 eligible restaurants per run with three concurrent workers, bounded requests and a two-minute per-connection lease. A revision check preserves changes arriving during a sync. Interrupted and failed syncs remain queued; a daily refresh advances the rolling window. Monitor backlog and function execution time as the restaurant count grows.
- Event IDs are deterministic for retries; existing events are matched by their private booking ID. Only app-tagged events are removed. Both snapshots are fully paginated before reconciliation. Query failures return errors, never an empty successful feed/snapshot.
- Calendar feed responses are private/no-store/noindex. The signed subscription URL is a bearer credential and should be excluded/redacted from infrastructure request logs. No private URL, authorization token, or refresh token is logged by the app.

## Validation

Run `npm test` and `npm run check`.

Tests cover Swedish daylight-saving transitions, event updates/deletions, retry behavior, changes arriving during synchronization, private-link revocation, OAuth state/cookie replay protection, encrypted tokens, restaurant ownership, cron authentication, and PostgreSQL migration/trigger/lease/RLS behavior using an in-memory PGlite database. UI verification uses mocked providers; a real Google OAuth/Apple subscription smoke test is still required after environment setup.

## References

- [Google's app-created-calendar scope](https://developers.google.com/workspace/calendar/api/auth)
- [Google web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Google calendar creation](https://developers.google.com/workspace/calendar/api/v3/reference/calendars/insert)
- [Apple calendar subscriptions](https://support.apple.com/en-us/102301)
- [Vercel cron scheduling limits](https://vercel.com/docs/cron-jobs/usage-and-pricing)
