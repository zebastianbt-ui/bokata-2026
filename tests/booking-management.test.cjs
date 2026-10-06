const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { load } = require("./load-ts.cjs");

const { bookingFarewell } = load('lib/bookingFarewell.ts');
test('Swedish farewell uses Stockholm calendar weeks, including year boundaries', () => {
  const now = new Date('2026-10-06T10:00:00Z');
  assert.equal(bookingFarewell('2026-10-08', now), 'Vi ses på torsdag!');
  assert.equal(bookingFarewell('2026-10-11', now), 'Vi ses på söndag!');
  assert.equal(bookingFarewell('2026-10-12', now), 'Vi ses nästa vecka!');
  assert.equal(bookingFarewell('2026-10-18', now), 'Vi ses nästa vecka!');
  assert.equal(bookingFarewell('2026-10-19', now), 'Vi ses den 19 oktober!');
  assert.equal(bookingFarewell('2027-01-01', now), 'Vi ses den 1 januari 2027!');
  assert.equal(bookingFarewell('2027-01-01', new Date('2026-12-28T10:00:00Z')), 'Vi ses på fredag!');
  assert.equal(bookingFarewell('2026-10-12', new Date('2026-10-11T22:30:00Z')), 'Vi ses på måndag!');
});

const secret = 'test-secret';
const credentials = { bid: 'booking-1', email: 'guest@example.com' };
credentials.sig = crypto.createHmac('sha256', secret).update(`${credentials.bid}:${credentials.email}`).digest('hex');
const original = {
  id: credentials.bid, restaurant_id: 'restaurant-1', date: '2030-01-07', time: '12:00:00',
  guests: 2, name: 'Guest', client_email: credentials.email, client_phone: '123',
  notes: 'Window please\n__BOKATA_TABLE_IDS__:1,2', status: 'confirmed', duration_min: 90,
};
function fixture(options = {}) {
  const calls = [];
  const days = Object.fromEntries(['måndag', 'tisdag', 'onsdag', 'torsdag', 'fredag', 'lördag', 'söndag'].map(day => [day, { open: '11:00', close: '21:00', closed: false }]));
  const settings = { hours: { normal: days }, seating: { maxGuests: 10, maxTables: 10 }, require_manual_confirmation: !!options.manual, notify_enabled: !!options.notify, notify_email: "restaurant@example.com" };
  const client = {
    from(table) {
      const call = { table, filters: [] }; calls.push(call);
      const builder = {
        select(value, opts) { call.select = value; call.count = opts?.count; return builder; },
        eq(...args) { call.filters.push(['eq', ...args]); return builder; },
        neq(...args) { call.filters.push(['neq', ...args]); return builder; },
        maybeSingle() { return builder; },
        then(resolve, reject) {
          let result;
          if (table === 'booking_public_settings') result = { data: settings };
          else if (table === 'floorplans') result = { data: null };
          else if (call.count) result = { count: 0 };
          else if (call.filters.some(f => f[1] === 'id' && f[0] === 'eq')) result = { data: { ...original, ...options.booking } };
          else result = { data: options.full ? [{ time: '13:00', guests: 10, duration_min: 90 }] : [], error: options.availabilityError ? { message: 'offline' } : null };
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return builder;
    },
    async rpc(name, args) { calls.push({ rpc: name, args }); return options.rpcError ? { error: { message: 'missing RPC' } } : { data: [{ id: original.id }] }; },
  };
  process.env.SUPABASE_URL = 'https://example.invalid';
  process.env.SUPABASE_SERVICE_ROLE_KEY = secret;
  process.env.BOOKING_CANCEL_SECRET = secret;
  delete process.env.RESEND_API_KEY;
  const mocks = { '@supabase/supabase-js': { createClient: () => client }, '../lib/rateLimit': { rateLimit: async () => ({ ok: true }) } };
  const handler = load('api/bookings.ts', mocks).default;
  const read = load('api/bookings-manage.ts', mocks).default;
  async function request(body = {}, method = 'PATCH') {
    const req = { method, body: { ...credentials, date: '2030-01-08', time: '13:00', ...body }, query: { ...credentials, ...body }, headers: {}, socket: { remoteAddress: '127.0.0.1' } };
    const res = { code: 200, headers: {}, setHeader(key, value) { this.headers[key] = value; }, status(code) { this.code = code; return this; }, json(data) { this.data = data; return this; } };
    await (method === 'GET' ? read : handler)(req, res);
    return res;
  }
  return { calls, request };
}

test('opening a valid link reads only safe booking fields and does not mutate', async () => {
  const f = fixture(); const res = await f.request({}, 'GET');
  assert.equal(res.code, 200); assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.deepEqual(Object.keys(res.data.booking).sort(), ['date', 'guests', 'name', 'status', 'time']);
  assert.equal(f.calls.some(c => c.rpc), false);
});
test('forged link is rejected before querying a booking', async () => {
  const f = fixture(); assert.equal((await f.request({ sig: '0'.repeat(64) })).code, 403);
  assert.equal(f.calls.length, 0);
});
test('link must match the stored email', async () => {
  const f = fixture({ booking: { client_email: 'someone-else@example.com' } });
  assert.equal((await f.request()).code, 404); assert.equal(f.calls.some(c => c.rpc), false);
});
test('cancelled and past bookings cannot be rescheduled', async () => {
  for (const booking of [{ status: 'cancelled' }, { date: '2020-01-01' }]) {
    const f = fixture({ booking }); assert.equal((await f.request()).code, 409);
    assert.equal(f.calls.some(c => c.rpc), false);
  }
});
test('invalid, past, and closed-hour slots do not write', async () => {
  for (const body of [{ date: '2030-02-30' }, { time: '25:00' }, { date: '2020-01-01' }, { time: '03:00' }]) {
    const f = fixture(); assert.equal((await f.request(body)).code, 400);
    assert.equal(f.calls.some(c => c.rpc), false);
  }
});
test('full slots and unavailable capacity data leave original booking unchanged', async () => {
  for (const options of [{ full: true }, { availabilityError: true }]) {
    const f = fixture(options); assert.ok((await f.request()).code >= 400);
    assert.equal(f.calls.some(c => c.rpc), false);
  }
});
test('reschedule excludes itself from capacity and duplicate counts, and ignores tampered identity fields', async () => {
  const f = fixture(); const res = await f.request({ restaurantId: 'other', guests: 100, name: 'Tampered', notes: 'Changed' });
  assert.equal(res.code, 200);
  const rpc = f.calls.find(c => c.rpc);
  assert.equal(rpc.rpc, 'reschedule_booking_guarded');
  assert.equal(rpc.args.p_booking_id, original.id);
  assert.equal(rpc.args.p_notes, 'Window please');
  assert.equal(rpc.args.p_expected_time, original.time);
  assert.equal(rpc.args.p_date, '2030-01-08');
  assert.equal(rpc.args.p_time, '13:00');
  const availability = f.calls.filter(c => c.table === 'bookings' && !c.filters.some(v => v[0] === 'eq' && v[1] === 'id'));
  assert.equal(availability.length, 2);
  for (const query of availability) {
    assert.ok(query.filters.some(v => v[0] === 'neq' && v[1] === 'id' && v[2] === original.id));
    assert.ok(query.filters.some(v => v[1] === 'restaurant_id' && v[2] === original.restaurant_id));
  }
});
test('manual changes renew the restaurant confirmation token', async () => {
  const f = fixture({ manual: true }); const res = await f.request();
  assert.equal(res.data.status, 'pending');
  const rpc = f.calls.find(c => c.rpc);
  assert.ok(rpc.args.p_confirm_token); assert.ok(rpc.args.p_confirm_expires_at);
});
test('missing guarded RPC fails without unsafe direct update fallback', async () => {
  const f = fixture({ rpcError: true }); assert.equal((await f.request()).code, 409);
  assert.equal(f.calls.filter(c => c.rpc).length, 1);
});
test('successful changes email the guest the new slot and management link, and notify the restaurant', async () => {
  const f = fixture({ notify: true });
  const sent = [];
  const originalFetch = global.fetch;
  process.env.RESEND_API_KEY = 'test-only';
  global.fetch = async (_url, init) => { sent.push(JSON.parse(init.body)); return { ok: true, status: 200, text: async () => '{}' }; };
  try {
    const res = await f.request();
    assert.equal(res.code, 200);
    const guest = sent.find(message => message.to === credentials.email);
    assert.equal(guest.subject, 'Din bokning har ändrats!');
    assert.match(guest.html, /2030-01-08 kl 13:00/);
    assert.match(guest.html, /\/booking\/manage\?bid=booking-1/);
    assert.match(guest.html, /ändra din bokning här/);
    assert.doesNotMatch(guest.html, /bookings-cancel|Avboka din reservation/);
    const restaurant = sent.find(message => message.to === 'restaurant@example.com');
    assert.equal(restaurant.subject, 'Ändrad bokning');
    assert.match(restaurant.html, /Tidigare: 2030-01-07 kl 12:00/);
    assert.equal(res.data.emailDelivery.length, 2);
  } finally { global.fetch = originalFetch; delete process.env.RESEND_API_KEY; }
});
