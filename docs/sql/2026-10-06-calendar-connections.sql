-- Apply before enabling the calendar routes. Credentials stay server-only.
create table if not exists public.calendar_connections (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  provider text not null check (provider in ('google', 'apple')),
  created_by uuid not null references auth.users(id) on delete cascade,
  calendar_id text,
  refresh_token text,
  feed_nonce uuid not null default gen_random_uuid(),
  last_synced_at timestamptz,
  last_attempt_at timestamptz,
  needs_sync boolean not null default true,
  sync_revision bigint not null default 0,
  last_error text,
  sync_lock_until timestamptz,
  sync_lock_token uuid,
  created_at timestamptz not null default now(),
  unique (restaurant_id, provider)
);
create table if not exists public.calendar_oauth_states (
  state_hash text primary key,
  browser_hash text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  expires_at timestamptz not null
);
alter table public.calendar_connections enable row level security;
alter table public.calendar_oauth_states enable row level security;
revoke all on public.calendar_connections, public.calendar_oauth_states from anon, authenticated;
grant all on public.calendar_connections, public.calendar_oauth_states to service_role;

alter table public.bookings add column if not exists calendar_updated_at timestamptz not null default now();
create or replace function public.touch_booking_calendar_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin
  new.calendar_updated_at := now();
  return new;
end;
$$;
drop trigger if exists bookings_calendar_updated_at on public.bookings;
create trigger bookings_calendar_updated_at before update on public.bookings
for each row execute function public.touch_booking_calendar_updated_at();

create or replace function public.claim_calendar_sync(p_id uuid, p_token uuid)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  update public.calendar_connections
  set last_attempt_at = now(), sync_lock_until = now() + interval '2 minutes', sync_lock_token = p_token
  where id = p_id and provider = 'google'
    and (sync_lock_until is null or sync_lock_until < now());
  return found;
end;
$$;
revoke all on function public.claim_calendar_sync(uuid,uuid) from public, anon, authenticated;
grant execute on function public.claim_calendar_sync(uuid,uuid) to service_role;

-- Every booking source (dashboard, AI, public form, rescheduling, cancellation)
-- marks its restaurant dirty. Deletes also trigger reconciliation.
create or replace function public.queue_restaurant_calendar_sync()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op <> 'INSERT' then
    update public.calendar_connections set needs_sync = true, sync_revision = sync_revision + 1
    where restaurant_id = old.restaurant_id and provider = 'google';
  end if;
  if tg_op = 'INSERT' or (tg_op = 'UPDATE' and new.restaurant_id is distinct from old.restaurant_id) then
    update public.calendar_connections set needs_sync = true, sync_revision = sync_revision + 1
    where restaurant_id = new.restaurant_id and provider = 'google';
  end if;
  return null;
end;
$$;
drop trigger if exists bookings_calendar_sync on public.bookings;
create trigger bookings_calendar_sync after insert or update or delete on public.bookings
for each row execute function public.queue_restaurant_calendar_sync();
create index if not exists calendar_connections_sync_idx on public.calendar_connections(last_attempt_at)
where provider = 'google' and refresh_token is not null;
