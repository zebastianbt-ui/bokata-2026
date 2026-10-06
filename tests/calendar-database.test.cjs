const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const sql = name => fs.readFileSync(path.join(__dirname, '..', 'docs/sql', name), 'utf8');
const restaurant = '11111111-1111-4111-8111-111111111111';
const otherRestaurant = '11111111-1111-4111-8111-111111111112';
const owner = '22222222-2222-4222-8222-222222222222';
const lock1 = '33333333-3333-4333-8333-333333333333';
const lock2 = '44444444-4444-4444-8444-444444444444';

test('PostgreSQL calendar migration: changes enqueue sync, isolation, leases and RLS', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth;
      create table auth.users(id uuid primary key);
      create table public.restaurants(id uuid primary key, owner_id uuid references auth.users(id), name text);
      create table public.bookings(id text primary key, restaurant_id uuid references public.restaurants(id), name text,
        date date, time time, guests integer, status text, created_at timestamptz default now());
      insert into auth.users values ('${owner}');
      insert into restaurants values ('${restaurant}', '${owner}', 'First'), ('${otherRestaurant}', '${owner}', 'Second');
    `);
    await db.exec(sql('2026-10-06-calendar-connections.sql'));
    // The migration can be applied a second time without destroying connections.
    await db.exec(sql('2026-10-06-calendar-connections.sql'));
    const { rows } = await db.query(`insert into calendar_connections(restaurant_id,provider,created_by,refresh_token,needs_sync)
      values ($1,'google',$3,'encrypted',false),($2,'google',$3,'encrypted',false),($1,'apple',$3,null,false) returning *`, [restaurant, otherRestaurant, owner]);
    const connection = rows.find(row => row.restaurant_id === restaurant && row.provider === 'google');
    await db.query(`insert into bookings(id,restaurant_id,date,time,status) values ('one',$1,'2050-01-01','12:00','confirmed')`, [restaurant]);
    let first = (await db.query('select * from calendar_connections where id=$1', [connection.id])).rows[0];
    assert.equal(first.needs_sync, true); assert.equal(first.sync_revision, 1);
    assert.equal((await db.query('select needs_sync from calendar_connections where restaurant_id=$1', [otherRestaurant])).rows[0].needs_sync, false);
    const updatedBefore = (await db.query("select calendar_updated_at from bookings where id='one'")).rows[0].calendar_updated_at;
    await db.exec("update calendar_connections set needs_sync=false; update bookings set time='14:00', status='pending' where id='one';");
    first = (await db.query('select * from calendar_connections where id=$1', [connection.id])).rows[0];
    assert.equal(first.needs_sync, true); assert.equal(first.sync_revision, 2);
    assert.ok((await db.query("select calendar_updated_at from bookings where id='one'")).rows[0].calendar_updated_at >= updatedBefore);
    await db.exec("update calendar_connections set needs_sync=false; delete from bookings where id='one';");
    assert.equal((await db.query('select needs_sync from calendar_connections where id=$1', [connection.id])).rows[0].needs_sync, true);
    assert.equal((await db.query('select claim_calendar_sync($1,$2) as claimed', [connection.id, lock1])).rows[0].claimed, true);
    assert.equal((await db.query('select claim_calendar_sync($1,$2) as claimed', [connection.id, lock2])).rows[0].claimed, false);
    await db.query("update calendar_connections set sync_lock_until=now()-interval '1 second' where id=$1", [connection.id]);
    assert.equal((await db.query('select claim_calendar_sync($1,$2) as claimed', [connection.id, lock2])).rows[0].claimed, true);
    await db.exec('set role anon');
    await assert.rejects(() => db.query('select * from public.calendar_connections'), /permission denied/);
    await assert.rejects(() => db.query('select * from public.calendar_oauth_states'), /permission denied/);
    await assert.rejects(() => db.query('select public.claim_calendar_sync($1,$2)', [connection.id, lock1]), /permission denied/);
    await db.exec('reset role; set role authenticated');
    await assert.rejects(() => db.query('select * from public.calendar_connections'), /permission denied/);
    await db.exec('reset role');
  } finally { await db.close(); }
});
