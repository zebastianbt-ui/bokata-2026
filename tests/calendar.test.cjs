const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./load-ts.cjs');
const calendar = load('lib/restaurantCalendar.ts');
const google = load('lib/googleCalendarSync.ts');
const restaurantId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const id = '33333333-3333-4333-8333-333333333333';
process.env.CALENDAR_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.SITE_URL = 'https://www.bokata.se';
const connection = { id, restaurant_id: restaurantId, created_by: userId, provider: 'google', calendar_id: 'test-calendar',
  feed_nonce: 'nonce', refresh_token: 'encrypted', last_synced_at: null, last_error: null, sync_revision: 0 };
const booking = { id: 'booking-1', restaurant_id: restaurantId, name: 'Åsa Svensson', guests: 4, date: '2030-07-08', time: '12:00',
  duration_min: 90, status: 'confirmed', created_at: '2030-01-01T00:00:00Z', calendar_updated_at: '2030-02-01T00:00:00Z' };

test('Stockholm times convert correctly in winter, summer, and across midnight', () => {
  assert.equal(calendar.bookingStartUtc('2030-01-08', '12:00:00').toISOString(), '2030-01-08T11:00:00.000Z');
  assert.equal(calendar.bookingStartUtc('2030-07-08', '12:00').toISOString(), '2030-07-08T10:00:00.000Z');
  const event = calendar.calendarEvent({ ...booking, time: '23:30', duration_min: 120 });
  assert.equal(event.end.dateTime, '2030-07-08T23:30:00.000Z');
  assert.throws(() => calendar.bookingStartUtc('2026-03-29', '02:30'));
  assert.equal(calendar.bookingStartUtc('2026-10-25', '12:00').toISOString(), '2026-10-25T11:00:00.000Z');
});
test('ICS escapes injected properties, folds UTF-8 safely, and keeps a stable UID when moved', () => {
  const feed = calendar.renderCalendarFeed('Madame Blå', [{ ...booking, name: 'Å'.repeat(80) + ',;\\\r\nBEGIN:VEVENT' }]);
  assert.ok(feed.endsWith('\r\n'));
  assert.equal(feed.match(/^BEGIN:VEVENT$/gm).length, 1);
  for (const line of feed.split('\r\n')) assert.ok(Buffer.byteLength(line, 'utf8') <= 75);
  assert.match(feed.replace(/\r\n /g, ''), /\\,\\;\\\\\\nBEGIN:VEVENT/);
  const first = calendar.renderCalendarFeed('Test', [booking]);
  const moved = calendar.renderCalendarFeed('Test', [{ ...booking, date: '2030-07-09' }]);
  assert.equal(first.match(/UID:(.*)/)[1], moved.match(/UID:(.*)/)[1]);
  assert.match(first, /DTSTART:20300708T100000Z/);
  assert.match(first, /DTEND:20300708T113000Z/);
});
test('feeds exclude cancelled bookings and sensitive notes/contact details', () => {
  const feed = calendar.renderCalendarFeed('Test', [
    { ...booking, client_email: 'private@example.com', client_phone: 'SECRET-PHONE', notes: 'SECRET-NOTE' },
    { ...booking, id: 'cancelled', status: 'cancelled' }, { ...booking, id: 'pending', status: 'pending' },
  ]);
  assert.equal(feed.match(/BEGIN:VEVENT/g).length, 2);
  assert.match(feed, /STATUS:TENTATIVE/);
  assert.doesNotMatch(feed, /private@example.com|SECRET-/);
});
test('refresh tokens are encrypted, tamper-evident and bound to their restaurant', () => {
  const sealed = calendar.sealCalendarToken('secret-refresh-token', restaurantId);
  assert.ok(!sealed.includes('secret-refresh-token'));
  assert.equal(calendar.openCalendarToken(sealed, restaurantId), 'secret-refresh-token');
  assert.throws(() => calendar.openCalendarToken(sealed, 'another-restaurant'));
  assert.throws(() => calendar.openCalendarToken(sealed.slice(0, -6) + 'AAAAAA', restaurantId));
});
test('private Apple links cannot be forged and revocation/rotation invalidates old links', () => {
  const sig = calendar.feedSignature(connection);
  assert.equal(calendar.validFeedSignature(connection, sig), true);
  assert.equal(calendar.validFeedSignature({ ...connection, id: 'other' }, sig), false);
  assert.equal(calendar.validFeedSignature({ ...connection, feed_nonce: 'rotated' }, sig), false);
  assert.equal(calendar.validFeedSignature(connection, '0'.repeat(64)), false);
});
test('Google reconciliation creates once, updates in place and removes cancelled/deleted events', () => {
  const created = google.planGoogleCalendarSync(connection, [booking], []);
  assert.equal(created.length, 1); assert.equal(created[0].method, 'POST');
  const event = { ...created[0].body };
  assert.deepEqual(google.planGoogleCalendarSync(connection, [booking], [event]), []);
  const moved = google.planGoogleCalendarSync(connection, [{ ...booking, time: '15:00' }], [event]);
  assert.equal(moved[0].method, 'PATCH'); assert.equal(moved[0].id, event.id);
  const removed = google.planGoogleCalendarSync(connection, [], [event, { id: 'personal', summary: 'Personal event' }]);
  assert.equal(removed.length, 1); assert.equal(removed[0].id, event.id); assert.equal(removed[0].method, 'DELETE');
  const recreated = google.planGoogleCalendarSync(connection, [{ ...booking, calendar_updated_at: '2030-03-01T00:00:00Z' }], []);
  assert.notEqual(recreated[0].id, created[0].id);
});

function apiFixture(options = {}) {
  const rows = { restaurants: [{ id: restaurantId, name: 'Test', owner_id: userId }],
    calendar_connections: options.connections || [], calendar_oauth_states: [], bookings: [] };
  const calls = [];
  const client = { auth: { getUser: async () => options.unauthorized ? { error: true } : { data: { user: { id: options.otherUser ? 'other-user' : userId } } } },
    from(table) {
      const filters = []; let operation = 'read', payload, returnRows = false;
      const builder = {
        select() { returnRows = true; return builder; },
        eq(key, value) { filters.push(row => row[key] === value); return builder; },
        gt(key, value) { filters.push(row => row[key] > value); return builder; },
        lt(key, value) { filters.push(row => row[key] < value); return builder; },
        in(key, values) { filters.push(row => values.includes(row[key])); return builder; },
        gte() { return builder; }, lte() { return builder; }, order() { return builder; }, range() { return builder; },
        maybeSingle() { builder.singleRow = true; return builder; }, single() { builder.singleRow = true; return builder; },
        insert(data) { operation = 'insert'; payload = data; return builder; },
        upsert(data) { operation = 'upsert'; payload = data; return builder; },
        update(data) { operation = 'update'; payload = data; return builder; },
        delete() { operation = 'delete'; return builder; },
        then(resolve, reject) {
          calls.push({ table, operation });
          if (options.errorTable === table) return Promise.resolve({ error: { message: 'test error' } }).then(resolve, reject);
          let matched = rows[table].filter(row => filters.every(fn => fn(row)));
          if (operation === 'insert') { rows[table].push({ ...payload }); matched = [payload]; }
          if (operation === 'upsert') {
            const existing = rows[table].find(row => row.restaurant_id === payload.restaurant_id && row.provider === payload.provider);
            if (existing) Object.assign(existing, payload);
            else rows[table].push({ id, feed_nonce: 'test', ...payload });
          }
          if (operation === 'delete') rows[table] = rows[table].filter(row => !matched.includes(row));
          if (operation === 'update') matched.forEach(row => Object.assign(row, payload));
          const data = builder.singleRow ? matched[0] || null : matched;
          return Promise.resolve({ data: returnRows ? structuredClone(data) : null }).then(resolve, reject);
        },
      };
      return builder;
    },
  };
  process.env.SUPABASE_URL = 'https://test.invalid'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-only';
  process.env.GOOGLE_CALENDAR_CLIENT_ID = 'client-id'; process.env.GOOGLE_CALENDAR_CLIENT_SECRET = 'client-secret'; process.env.CRON_SECRET = 'cron-test';
  const handler = load('api/calendar.ts', { '@supabase/supabase-js': { createClient: () => client }, '../lib/rateLimit': { rateLimit: async () => ({ ok: true }) } }).default;
  const request = async (action, { method = 'GET', query = {}, body = {}, headers = {} } = {}) => {
    const req = { method, query: { action, restaurantId, ...query }, body: { restaurantId, ...body }, headers: { authorization: 'Bearer test', ...headers } };
    const res = { code: 200, headers: {}, setHeader(key, value) { this.headers[key] = value; }, status(code) { this.code = code; return this; },
      json(data) { this.data = data; return this; }, send(data) { this.data = data; return this; }, end() { return this; }, redirect(code, url) { this.code = code; this.url = url; return this; } };
    await handler(req, res); return res;
  };
  client.rpc = async (name, args) => {
    const row = rows.calendar_connections.find(row => row.id === args.p_id);
    if (!row || options.busy) return { data: false };
    row.sync_lock_token = args.p_token;
    return { data: true };
  };
  return { rows, request, calls, client };
}
test('calendar connections require authentication and restaurant ownership', async () => {
  const noAuth = apiFixture(); assert.equal((await noAuth.request('status', { headers: { authorization: '' } })).code, 401);
  const other = apiFixture({ otherUser: true }); assert.equal((await other.request('status')).code, 403);
  assert.equal(other.calls.some(c => c.table === 'calendar_connections'), false);
});
test('status never returns Google refresh credentials or private calendar ids', async () => {
  const f = apiFixture({ connections: [connection] }); const response = await f.request('status');
  assert.equal(response.code, 200);
  assert.doesNotMatch(JSON.stringify(response.data), /encrypted|test-calendar|feed_nonce/);
});
test('feed requires the private link and stops working after disconnect', async () => {
  const apple = { ...connection, provider: 'apple' };
  const f = apiFixture({ connections: [apple] });
  assert.equal((await f.request('feed', { query: { id, token: '0'.repeat(64) } })).code, 404);
  const args = { query: { id, token: calendar.feedSignature(apple) }, headers: { authorization: '' } };
  const before = await f.request('feed', args); assert.equal(before.code, 200); assert.match(before.data, /BEGIN:VCALENDAR/);
  assert.equal((await f.request('disconnect', { method: 'POST', body: { provider: 'apple' } })).code, 200);
  assert.equal((await f.request('feed', args)).code, 404);
});
test('feed fails closed on data errors instead of returning an empty calendar', async () => {
  const apple = { ...connection, provider: 'apple' };
  const f = apiFixture({ connections: [apple], errorTable: 'bookings' });
  assert.equal((await f.request('feed', { query: { id, token: calendar.feedSignature(apple) } })).code, 503);
});
test('Google consent is limited to app calendars and state is bound to the initiating browser', async () => {
  const f = apiFixture(); const response = await f.request('google-connect', { method: 'POST' });
  assert.equal(response.code, 200);
  const url = new URL(response.data.url);
  assert.equal(url.searchParams.get('scope'), calendar.GOOGLE_CALENDAR_SCOPE);
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://www.bokata.se/api/calendar?action=google-callback');
  assert.match(response.headers['Set-Cookie'], /HttpOnly; SameSite=Lax/);
  const state = url.searchParams.get('state');
  assert.notEqual(f.rows.calendar_oauth_states[0].state_hash, state);
  const rejected = await f.request('google-callback', { query: { state, code: 'code' } });
  assert.match(rejected.url, /calendar=error$/);
  assert.equal(f.rows.calendar_oauth_states.length, 1);
  const cookie = response.headers['Set-Cookie'].split(';')[0];
  const cancelled = await f.request('google-callback', { query: { state, error: 'access_denied' }, headers: { cookie } });
  assert.match(cancelled.url, /calendar=cancelled$/);
  assert.equal(f.rows.calendar_oauth_states.length, 0);
  const replay = await f.request('google-callback', { query: { state, error: 'access_denied' }, headers: { cookie } });
  assert.match(replay.url, /calendar=error$/);
});
test('Google callback saves encrypted credentials and redirects without exposing tokens', async () => {
  const f = apiFixture();
  const response = await f.request('google-connect', { method: 'POST' });
  const state = new URL(response.data.url).searchParams.get('state');
  const cookie = response.headers['Set-Cookie'].split(';')[0];
  const previousFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, init) => {
    requests.push({ url, init });
    return { ok: true, status: 200, text: async () => JSON.stringify(url.includes('oauth2')
      ? { access_token: 'access-test', refresh_token: 'refresh-test', scope: calendar.GOOGLE_CALENDAR_SCOPE }
      : { id: 'created-calendar' }) };
  };
  try {
    const result = await f.request('google-callback', { query: { state, code: 'code' }, headers: { cookie } });
    assert.match(result.url, /calendar=connected$/);
    const stored = f.rows.calendar_connections[0];
    assert.equal(stored.calendar_id, 'created-calendar');
    assert.notEqual(stored.refresh_token, 'refresh-test');
    assert.equal(calendar.openCalendarToken(stored.refresh_token, `${restaurantId}:google`), 'refresh-test');
    assert.equal(stored.needs_sync, true);
    assert.equal(requests.length, 2);
    assert.match(JSON.parse(requests[1].init.body).summary, /Bokäta/);
  } finally { global.fetch = previousFetch; }
});
test('Google synchronization preserves a newer queued change and releases the lease', async () => {
  const saved = { ...connection, needs_sync: true, refresh_token: calendar.sealCalendarToken('refresh-test', `${restaurantId}:google`) };
  const f = apiFixture({ connections: [saved] });
  const sync = load('lib/googleCalendarSync.ts', { './restaurantCalendar': { ...calendar, readCalendarBookings: async () => [booking] } });
  const previousFetch = global.fetch;
  const sent = [];
  global.fetch = async (url, init) => {
    sent.push({ url, init });
    if (init?.method === 'POST' && !url.includes('oauth2')) saved.sync_revision++;
    const result = url.includes('oauth2') ? { access_token: 'access-test' } : init?.method === 'POST' ? { id: 'event' } : { items: [] };
    return { ok: true, status: 200, text: async () => JSON.stringify(result) };
  };
  try {
    const result = await sync.syncGoogleCalendar(f.client, { ...saved });
    assert.equal(result.changed, 1);
    assert.equal(saved.needs_sync, true);
    assert.equal(saved.sync_lock_token, null);
    const event = JSON.parse(sent.find(c => c.init.method === 'POST' && !c.url.includes('oauth2')).init.body);
    assert.equal(event.summary, '4 gäster · Åsa Svensson');
    assert.equal(event.attendees, undefined);
  } finally { global.fetch = previousFetch; }
});
test('failed Google synchronization stays queued for retry and reports reconnect when access expires', async () => {
  const saved = { ...connection, needs_sync: true, refresh_token: calendar.sealCalendarToken('refresh-test', `${restaurantId}:google`) };
  const f = apiFixture({ connections: [saved] });
  const previousFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ error: 'invalid_grant' }) });
  try {
    await assert.rejects(() => google.syncGoogleCalendar(f.client, { ...saved }), /Anslut Google Calendar igen/);
    assert.equal(saved.needs_sync, true); assert.equal(saved.last_synced_at, null);
    assert.equal(saved.sync_lock_token, null); assert.match(saved.last_error, /Anslut Google/);
  } finally { global.fetch = previousFetch; }
});
test('cron cannot be invoked with a forged cron header or without its bearer secret', async () => {
  const handler = load('api/calendar-sync.ts').default;
  for (const headers of [{ 'x-vercel-cron': '1' }, { authorization: 'Bearer wrong' }]) {
    const res = { code: 200, setHeader() {}, status(code) { this.code = code; return this; }, end() {} };
    await handler({ method: 'GET', headers }, res); assert.equal(res.code, 401);
  }
});
