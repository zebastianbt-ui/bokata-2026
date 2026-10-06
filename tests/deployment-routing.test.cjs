const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load } = require('./load-ts.cjs');
const config = require('../vercel.json');

test('published calendar and booking links route to their authenticated handlers', async () => {
  const calls = [];
  const handler = load('api/booking-settings.ts', {
    '../lib/calendarHandler': (req) => calls.push(['calendar', req.query]),
    '../lib/calendarSyncHandler': (req) => calls.push(['sync', req.query]),
    '../lib/bookingManageHandler': (req) => calls.push(['manage', req.query]),
  }).default;
  for (const [route, expected] of [['calendar', 'calendar'], ['calendar-sync', 'sync'], ['bookings-manage', 'manage']]) {
    const rewrite = config.rewrites.find(rule => rule.source === `/api/${route}`);
    assert.ok(rewrite);
    const url = new URL(rewrite.destination, 'https://www.bokata.se');
    assert.equal(url.pathname, '/api/booking-settings');
    const query = { ...Object.fromEntries(url.searchParams), action: 'google-callback', code: 'example' };
    await handler({ query }, {});
    assert.equal(calls.at(-1)[0], expected);
    assert.equal(calls.at(-1)[1].code, 'example');
  }
});

test('deployment stays within function limit and has valid header entries', () => {
  const endpoints = fs.readdirSync(path.resolve(__dirname, '../api')).filter(file => file.endsWith('.ts'));
  assert.ok(endpoints.length <= 12, `${endpoints.length} endpoints exceeds the hosting limit`);
  for (const rule of config.headers) for (const header of rule.headers) {
    assert.equal(typeof header.key, 'string');
    assert.equal(typeof header.value, 'string');
    assert.deepEqual(Object.keys(header).sort(), ['key', 'value']);
  }
});
