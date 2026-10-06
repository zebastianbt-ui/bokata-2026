-- Apply before deploying guest booking management.
-- Uses the same restaurant/day lock as create_booking_guarded.
-- No direct-update fallback: a failed reschedule leaves the original booking intact.
create or replace function public.reschedule_booking_guarded(
  p_booking_id text,
  p_expected_date date,
  p_expected_time text,
  p_expected_status text,
  p_date date,
  p_time text,
  p_duration_min integer,
  p_max_guests integer,
  p_max_tables integer,
  p_notes text,
  p_table_id integer,
  p_status text,
  p_confirm_token uuid,
  p_confirm_expires_at timestamptz
)
returns table(id text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.bookings%rowtype;
  v_changes public.bookings%rowtype;
  v_start integer;
  v_end integer;
  v_guests integer;
  v_tables integer;
  v_same_email integer;
  v_table_ids text[];
  v_now timestamp := now() at time zone 'Europe/Stockholm';
begin
  select b.* into v_booking from public.bookings b where b.id::text = p_booking_id;
  if not found then raise exception 'BOKATA_BOOKING_NOT_FOUND'; end if;

  perform pg_advisory_xact_lock(hashtext(v_booking.restaurant_id::text || ':' || p_date::text));
  select b.* into v_booking from public.bookings b where b.id::text = p_booking_id for update;
  if not found then raise exception 'BOKATA_BOOKING_NOT_FOUND'; end if;
  if v_booking.status not in ('pending', 'confirmed')
    or v_booking.date is distinct from p_expected_date
    or v_booking.time::time is distinct from p_expected_time::time
    or v_booking.status is distinct from p_expected_status
    or v_booking.date + v_booking.time::time < v_now
    or p_date + p_time::time < v_now
  then raise exception 'BOKATA_BOOKING_CHANGED'; end if;

  if p_status not in ('pending', 'confirmed') or p_duration_min < 1 then
    raise exception 'BOKATA_INVALID_UPDATE';
  end if;
  v_start := public.bokata_time_to_minutes(p_time);
  v_end := v_start + p_duration_min;

  select count(*)::integer into v_same_email
  from public.bookings b
  where b.restaurant_id = v_booking.restaurant_id and b.date = p_date
    and b.id::text <> p_booking_id and coalesce(b.status, '') <> 'cancelled'
    and lower(b.client_email) = lower(v_booking.client_email);
  if v_same_email >= 2 then raise exception 'BOKATA_SAME_EMAIL_LIMIT'; end if;

  select coalesce(sum(b.guests), 0)::integer, count(*)::integer into v_guests, v_tables
  from public.bookings b
  where b.restaurant_id = v_booking.restaurant_id and b.date = p_date
    and b.id::text <> p_booking_id and coalesce(b.status, '') <> 'cancelled'
    and public.bokata_time_to_minutes(b.time::text) < v_end
    and v_start < public.bokata_time_to_minutes(b.time::text) + greatest(coalesce(b.duration_min, 90), 1);
  if v_guests + v_booking.guests > greatest(coalesce(p_max_guests, 60), 1) then
    raise exception 'BOKATA_GUEST_CAPACITY_EXCEEDED';
  end if;
  if v_tables + 1 > greatest(coalesce(p_max_tables, 20), 1) then
    raise exception 'BOKATA_TABLE_CAPACITY_EXCEEDED';
  end if;

  v_table_ids := array_remove(array[p_table_id::text], null) || coalesce(
    string_to_array(substring(p_notes from '__BOKATA_TABLE_IDS__:([0-9,]+)'), ','), array[]::text[]);
  if cardinality(v_table_ids) > 0 and exists (
    select 1 from public.bookings b
    where b.restaurant_id = v_booking.restaurant_id and b.date = p_date
      and b.id::text <> p_booking_id and coalesce(b.status, '') <> 'cancelled'
      and public.bokata_time_to_minutes(b.time::text) < v_end
      and v_start < public.bokata_time_to_minutes(b.time::text) + greatest(coalesce(b.duration_min, 90), 1)
      and v_table_ids && (array_remove(array[b.table_id::text], null) || coalesce(
        string_to_array(substring(b.notes from '__BOKATA_TABLE_IDS__:([0-9,]+)'), ','), array[]::text[]))
  ) then raise exception 'BOKATA_TABLE_CAPACITY_EXCEEDED'; end if;

  -- Populate using the actual column type (supports both legacy text and SQL time).
  select * into v_changes from jsonb_populate_record(null::public.bookings, jsonb_build_object('time', p_time));
  update public.bookings b set
    date = p_date, time = v_changes.time, duration_min = p_duration_min,
    notes = p_notes, table_id = p_table_id, status = p_status,
    confirm_token = p_confirm_token, confirm_expires_at = p_confirm_expires_at
  where b.id::text = p_booking_id;
  return query select p_booking_id;
end;
$$;

revoke all on function public.reschedule_booking_guarded(text,date,text,text,date,text,integer,integer,integer,text,integer,text,uuid,timestamptz) from public, anon, authenticated;
grant execute on function public.reschedule_booking_guarded(text,date,text,text,date,text,integer,integer,integer,text,integer,text,uuid,timestamptz) to service_role;
