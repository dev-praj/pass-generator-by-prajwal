-- GatePass: free QR entry passes for college club events.
--
-- Run this whole file once in the Supabase SQL editor (Dashboard → SQL Editor → New query → paste → Run).
-- It is idempotent: running it again changes nothing. Every object it creates is prefixed gp_,
-- so it can share a Supabase project with other apps.
--
-- Security model
--   • Organisers sign in (Supabase Auth). They own their events, passes and scans through RLS.
--   • Attendees never sign in. A pass is read by its 32-character random token through gp_pass(),
--     which returns that one pass and nothing else.
--   • Gate staff never sign in. They hold the event's 8-character gate code. Every staff action
--     (join, scan, look up, counter) is a SECURITY DEFINER function that checks the code first.
--   • The first scan of a pass is recorded by one INSERT guarded by a unique partial index
--     (gp_scans_first_once), so two gates can never both accept the same pass.

-- ─────────────────────────────────────────────────────────────── helpers

create extension if not exists pgcrypto with schema extensions;

-- 8 characters from a 31-letter alphabet without look-alikes (no I, L, O, 0, 1): 31^8 ≈ 8.5 × 10^11.
create or replace function public.gp_new_code()
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  b bytea;
  i int;
  v int;
  v_out text := '';
begin
  while char_length(v_out) < 8 loop
    b := extensions.gen_random_bytes(16);
    for i in 0..15 loop
      v := get_byte(b, i);
      if v < 248 and char_length(v_out) < 8 then          -- 248 = 31 × 8, rejection keeps it unbiased
        v_out := v_out || substr(alphabet, (v % 31) + 1, 1);
      end if;
    end loop;
  end loop;
  return v_out;
end;
$$;

-- 24 random bytes → 32 URL-safe characters (192 bits). Unguessable.
create or replace function public.gp_new_token()
returns text
language sql
volatile
security definer
set search_path = ''
as $$
  select translate(encode(extensions.gen_random_bytes(24), 'base64'), '+/', '-_');
$$;

-- Accepts "abcd-2345", "ABCD 2345", etc.
create or replace function public.gp_norm_code(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select upper(regexp_replace(coalesce(p, ''), '[^A-Za-z0-9]', '', 'g'));
$$;

-- ─────────────────────────────────────────────────────────────── tables

create table if not exists public.gp_events (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name        text not null check (char_length(btrim(name)) between 1 and 80),
  club        text not null default '' check (char_length(club) <= 80),
  starts_at   timestamptz not null,
  venue       text not null default '' check (char_length(venue) <= 120),
  art         smallint not null default 0 check (art between 0 and 9),
  gate_code   text not null unique default public.gp_new_code() check (gate_code ~ '^[A-HJKMNP-Z2-9]{8}$'),
  created_at  timestamptz not null default now()
);
create index if not exists gp_events_owner_idx on public.gp_events (owner_id, starts_at desc);

create table if not exists public.gp_passes (
  id          uuid primary key default gen_random_uuid(),
  event_id    uuid not null references public.gp_events (id) on delete cascade,
  token       text not null unique default public.gp_new_token() check (char_length(token) >= 32),
  name        text not null check (char_length(btrim(name)) between 1 and 120),
  contact     text not null default '' check (char_length(contact) <= 160),
  created_at  timestamptz not null default now()
);
create index if not exists gp_passes_event_idx on public.gp_passes (event_id, created_at);

-- Every scan of a known pass. is_first marks the one that let the person in.
create table if not exists public.gp_scans (
  id          bigint generated always as identity primary key,
  event_id    uuid not null references public.gp_events (id) on delete cascade,
  pass_id     uuid not null references public.gp_passes (id) on delete cascade,
  is_first    boolean not null,
  gate        text not null default 'Gate' check (char_length(gate) between 1 and 40),
  device      text not null default '' check (char_length(device) <= 40),
  scanned_at  timestamptz not null default now()
);
-- The rule the whole app rests on: at most one accepted scan per pass.
create unique index if not exists gp_scans_first_once on public.gp_scans (pass_id) where is_first;
create index if not exists gp_scans_event_idx on public.gp_scans (event_id, scanned_at desc);
create index if not exists gp_scans_pass_idx on public.gp_scans (pass_id);

-- ─────────────────────────────────────────────────────────────── privileges + RLS

alter table public.gp_events enable row level security;
alter table public.gp_passes enable row level security;
alter table public.gp_scans  enable row level security;

revoke all on public.gp_events, public.gp_passes, public.gp_scans from anon, authenticated;

grant select, delete on public.gp_events to authenticated;
grant insert (name, club, starts_at, venue, art) on public.gp_events to authenticated;
grant update (name, club, starts_at, venue, art) on public.gp_events to authenticated;

grant select, delete on public.gp_passes to authenticated;
grant insert (event_id, name, contact) on public.gp_passes to authenticated;
grant update (name, contact) on public.gp_passes to authenticated;

grant select, delete on public.gp_scans to authenticated;   -- no direct insert: scans go through gp_scan()

drop policy if exists gp_events_owner_select on public.gp_events;
create policy gp_events_owner_select on public.gp_events
  for select to authenticated using (owner_id = (select auth.uid()));
drop policy if exists gp_events_owner_insert on public.gp_events;
create policy gp_events_owner_insert on public.gp_events
  for insert to authenticated with check (owner_id = (select auth.uid()));
drop policy if exists gp_events_owner_update on public.gp_events;
create policy gp_events_owner_update on public.gp_events
  for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
drop policy if exists gp_events_owner_delete on public.gp_events;
create policy gp_events_owner_delete on public.gp_events
  for delete to authenticated using (owner_id = (select auth.uid()));

drop policy if exists gp_passes_owner_all on public.gp_passes;
create policy gp_passes_owner_all on public.gp_passes
  for all to authenticated
  using (exists (select 1 from public.gp_events e where e.id = gp_passes.event_id and e.owner_id = (select auth.uid())))
  with check (exists (select 1 from public.gp_events e where e.id = gp_passes.event_id and e.owner_id = (select auth.uid())));

drop policy if exists gp_scans_owner_select on public.gp_scans;
create policy gp_scans_owner_select on public.gp_scans
  for select to authenticated
  using (exists (select 1 from public.gp_events e where e.id = gp_scans.event_id and e.owner_id = (select auth.uid())));
drop policy if exists gp_scans_owner_delete on public.gp_scans;
create policy gp_scans_owner_delete on public.gp_scans
  for delete to authenticated
  using (exists (select 1 from public.gp_events e where e.id = gp_scans.event_id and e.owner_id = (select auth.uid())));

-- ─────────────────────────────────────────────────────────────── attendee: read one pass

create or replace function public.gp_pass(p_token text)
returns json
language sql
stable
security definer
set search_path = ''
as $$
  select json_build_object(
    'name', p.name,
    'event', json_build_object('name', e.name, 'club', e.club, 'starts_at', e.starts_at, 'venue', e.venue, 'art', e.art),
    'checked_in_at', s.scanned_at,
    'gate', s.gate
  )
  from public.gp_passes p
  join public.gp_events e on e.id = p.event_id
  left join public.gp_scans s on s.pass_id = p.id and s.is_first
  where p.token = p_token and char_length(p_token) >= 32;
$$;

-- ─────────────────────────────────────────────────────────────── gate staff

create or replace function public.gp_counts(p_event uuid)
returns json
language sql
stable
security definer
set search_path = ''
as $$
  select json_build_object(
    'total',   (select count(*) from public.gp_passes where event_id = p_event),
    'checked', (select count(*) from public.gp_scans where event_id = p_event and is_first),
    'bounced', (select count(*) from public.gp_scans where event_id = p_event and not is_first)
  );
$$;

-- Join a gate: returns the event (no passes) or null for a wrong code.
create or replace function public.gp_gate_join(p_code text)
returns json
language sql
stable
security definer
set search_path = ''
as $$
  select json_build_object(
    'event_id', e.id, 'name', e.name, 'club', e.club, 'starts_at', e.starts_at, 'venue', e.venue, 'art', e.art,
    'counts', public.gp_counts(e.id)
  )
  from public.gp_events e
  where e.gate_code = public.gp_norm_code(p_code);
$$;

-- Internal: admit a pass. The INSERT … ON CONFLICT on gp_scans_first_once is the atomic step.
create or replace function public.gp_admit(p_event uuid, p_pass uuid, p_name text, p_gate text, p_device text)
returns json
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_gate   text := left(coalesce(nullif(btrim(p_gate), ''), 'Gate'), 40);
  v_device text := left(coalesce(p_device, ''), 40);
  v_first  public.gp_scans;
  v_tries  int;
begin
  insert into public.gp_scans (event_id, pass_id, is_first, gate, device)
  values (p_event, p_pass, true, v_gate, v_device)
  on conflict (pass_id) where is_first do nothing
  returning * into v_first;

  if found then
    return json_build_object('status', 'ok', 'name', p_name, 'scanned_at', v_first.scanned_at,
                             'gate', v_first.gate, 'counts', public.gp_counts(p_event));
  end if;

  -- Someone got in on this pass already. Log the attempt and report the first scan.
  select * into v_first from public.gp_scans where pass_id = p_pass and is_first;
  insert into public.gp_scans (event_id, pass_id, is_first, gate, device)
  values (p_event, p_pass, false, v_gate, v_device);
  select count(*) into v_tries from public.gp_scans where pass_id = p_pass and not is_first;

  return json_build_object('status', 'dup', 'name', p_name, 'first_at', v_first.scanned_at,
                           'first_gate', v_first.gate, 'same_device', v_first.device = v_device and v_device <> '',
                           'repeats', v_tries, 'counts', public.gp_counts(p_event));
end;
$$;

-- Scan a pass token at the gate.
create or replace function public.gp_scan(p_code text, p_token text, p_gate text default 'Gate', p_device text default '')
returns json
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_event uuid;
  v_pass  public.gp_passes;
begin
  select id into v_event from public.gp_events where gate_code = public.gp_norm_code(p_code);
  if v_event is null then
    return json_build_object('status', 'bad_code');
  end if;

  select * into v_pass from public.gp_passes where token = p_token;
  if not found then
    return json_build_object('status', 'unknown');
  end if;
  if v_pass.event_id <> v_event then
    return json_build_object('status', 'wrong_event');
  end if;

  return public.gp_admit(v_event, v_pass.id, v_pass.name, p_gate, p_device);
end;
$$;

-- Dead phone at the gate: look a guest up by name (contact is masked).
create or replace function public.gp_gate_find(p_code text, p_query text)
returns json
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(json_agg(r order by r.name), '[]'::json)
  from (
    select p.id, p.name,
           case when p.contact = '' then ''
                when position('@' in p.contact) > 0
                  then left(p.contact, 2) || '•••' || substr(p.contact, position('@' in p.contact))
                else '•••' || right(regexp_replace(p.contact, '\D', '', 'g'), 4)
           end as hint,
           s.scanned_at as checked_in_at, s.gate
    from public.gp_events e
    join public.gp_passes p on p.event_id = e.id
    left join public.gp_scans s on s.pass_id = p.id and s.is_first
    where e.gate_code = public.gp_norm_code(p_code)
      and char_length(btrim(coalesce(p_query, ''))) >= 2
      and p.name ilike '%' || replace(replace(replace(btrim(p_query), '\', '\\'), '%', '\%'), '_', '\_') || '%'
    order by p.name
    limit 8
  ) r;
$$;

-- Admit someone found by name.
create or replace function public.gp_gate_admit(p_code text, p_pass uuid, p_gate text default 'Gate', p_device text default '')
returns json
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_event uuid;
  v_name  text;
begin
  select e.id, p.name into v_event, v_name
  from public.gp_events e join public.gp_passes p on p.event_id = e.id
  where e.gate_code = public.gp_norm_code(p_code) and p.id = p_pass;
  if v_event is null then
    return json_build_object('status', 'unknown');
  end if;
  return public.gp_admit(v_event, p_pass, v_name, p_gate, p_device);
end;
$$;

-- Live counter + the last few scans, for gate phones (they poll this).
create or replace function public.gp_gate_stats(p_code text)
returns json
language sql
stable
security definer
set search_path = ''
as $$
  select json_build_object(
    'counts', public.gp_counts(e.id),
    'recent', coalesce((
      select json_agg(x order by x.scanned_at desc)
      from (
        select p.name, s.gate, s.is_first, s.scanned_at
        from public.gp_scans s join public.gp_passes p on p.id = s.pass_id
        where s.event_id = e.id
        order by s.scanned_at desc
        limit 6
      ) x
    ), '[]'::json)
  )
  from public.gp_events e
  where e.gate_code = public.gp_norm_code(p_code);
$$;

-- ─────────────────────────────────────────────────────────────── organiser helpers

-- New gate code (old one stops working immediately).
create or replace function public.gp_rotate_code(p_event uuid)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_code text;
begin
  update public.gp_events set gate_code = public.gp_new_code()
  where id = p_event and owner_id = auth.uid()
  returning gate_code into v_code;
  return v_code;
end;
$$;

-- ─────────────────────────────────────────────────────────────── function privileges

revoke all on function public.gp_new_code()                              from public, anon, authenticated;
revoke all on function public.gp_new_token()                             from public, anon, authenticated;
revoke all on function public.gp_counts(uuid)                            from public, anon, authenticated;
revoke all on function public.gp_admit(uuid, uuid, text, text, text)     from public, anon, authenticated;
revoke all on function public.gp_pass(text)                              from public;
revoke all on function public.gp_gate_join(text)                         from public;
revoke all on function public.gp_scan(text, text, text, text)            from public;
revoke all on function public.gp_gate_find(text, text)                   from public;
revoke all on function public.gp_gate_admit(text, uuid, text, text)      from public;
revoke all on function public.gp_gate_stats(text)                        from public;
revoke all on function public.gp_rotate_code(uuid)                       from public, anon;

-- Column defaults call these as the inserting user.
grant execute on function public.gp_new_code()  to authenticated;
grant execute on function public.gp_new_token() to authenticated;

grant execute on function public.gp_pass(text)                         to anon, authenticated;
grant execute on function public.gp_gate_join(text)                    to anon, authenticated;
grant execute on function public.gp_scan(text, text, text, text)       to anon, authenticated;
grant execute on function public.gp_gate_find(text, text)              to anon, authenticated;
grant execute on function public.gp_gate_admit(text, uuid, text, text) to anon, authenticated;
grant execute on function public.gp_gate_stats(text)                   to anon, authenticated;
grant execute on function public.gp_rotate_code(uuid)                  to authenticated;

-- ─────────────────────────────────────────────────────────────── realtime (organiser's live counter)

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'gp_scans') then
    alter publication supabase_realtime add table public.gp_scans;
  end if;
end;
$$;


-- Appended attendee registration migration (also available as migration_registrations.sql).
-- GatePass attendee registrations.
-- Run once in Supabase SQL Editor after deploying the /host/ restructure.
-- This migration is idempotent and can also be run as part of schema.sql.

-- Safe public event listing: only expose the fields needed by the attendee page.
create or replace function public.gp_public_events()
returns table (
  id uuid,
  name text,
  club text,
  starts_at timestamptz,
  venue text,
  art smallint
)
language sql
stable
security definer
set search_path = public
as $$
  select e.id, e.name, e.club, e.starts_at, e.venue, e.art
  from public.gp_events e
  order by e.starts_at asc;
$$;

revoke all on function public.gp_public_events() from public;
grant execute on function public.gp_public_events() to anon, authenticated;

create table if not exists public.gp_registrations (
  id          uuid primary key default gen_random_uuid(),
  event_id    uuid not null references public.gp_events (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  name        text not null,
  phone       text not null,
  email       text,
  reg_no      text not null,
  semester    smallint not null check (semester between 1 and 8),
  branch      text not null,
  pass_id     uuid references public.gp_passes (id) on delete set null,
  created_at  timestamptz not null default now(),
  constraint gp_registrations_event_user_unique unique (event_id, user_id)
);

create unique index if not exists gp_registrations_event_reg_no_unique
  on public.gp_registrations (event_id, lower(reg_no));
create index if not exists gp_registrations_event_idx
  on public.gp_registrations (event_id);

alter table public.gp_registrations enable row level security;
revoke all on public.gp_registrations from public, anon, authenticated;
grant select on public.gp_registrations to authenticated;

drop policy if exists gp_registrations_attendee_select on public.gp_registrations;
create policy gp_registrations_attendee_select on public.gp_registrations
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists gp_registrations_owner_select on public.gp_registrations;
create policy gp_registrations_owner_select on public.gp_registrations
  for select to authenticated
  using (exists (
    select 1 from public.gp_events e
    where e.id = gp_registrations.event_id and e.owner_id = (select auth.uid())
  ));

drop policy if exists gp_registrations_owner_delete on public.gp_registrations;
create policy gp_registrations_owner_delete on public.gp_registrations
  for delete to authenticated
  using (exists (
    select 1 from public.gp_events e
    where e.id = gp_registrations.event_id and e.owner_id = (select auth.uid())
  ));

-- Registration and pass creation happen together in one database transaction.
create or replace function public.gp_register(
  p_event_id uuid,
  p_name text,
  p_phone text,
  p_email text,
  p_reg_no text,
  p_semester smallint,
  p_branch text
)
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_name text := btrim(coalesce(p_name, ''));
  v_phone text := regexp_replace(coalesce(p_phone, ''), '[[:space:]-]', '', 'g');
  v_email text := nullif(btrim(coalesce(p_email, '')), '');
  v_reg_no text := upper(btrim(coalesce(p_reg_no, '')));
  v_branch text := btrim(coalesce(p_branch, ''));
  v_event_starts_at timestamptz;
  v_pass_id uuid;
  v_token text;
  v_allowed_branches constant text[] := array['CSE', 'ISE', 'AIML', 'AIDS', 'ECE', 'EEE', 'ME', 'CV', 'Other'];
begin
  if v_user_id is null then
    raise exception 'Sign in is required to register.' using errcode = 'P0001';
  end if;

  select e.starts_at into v_event_starts_at
  from public.gp_events e where e.id = p_event_id;
  if not found then
    raise exception 'This event is no longer available.' using errcode = 'P0001';
  end if;
  if v_event_starts_at <= now() then
    raise exception 'Registration for this event has ended.' using errcode = 'P0001';
  end if;

  -- Repeated submit for the same signed-in user returns the original pass.
  select p.token into v_token
  from public.gp_registrations r
  left join public.gp_passes p on p.id = r.pass_id
  where r.event_id = p_event_id and r.user_id = v_user_id;
  if found then
    if v_token is null then
      raise exception 'Your registration has no active pass. Please contact the event organiser.' using errcode = 'P0001';
    end if;
    return v_token;
  end if;

  if char_length(v_name) not between 2 and 80 then
    raise exception 'Enter a name between 2 and 80 characters.' using errcode = 'P0001';
  end if;

  if left(v_phone, 3) = '+91' then
    v_phone := substring(v_phone from 4);
  end if;
  if left(v_phone, 1) = '0' then
    v_phone := substring(v_phone from 2);
  end if;
  if v_phone !~ '^[0-9]{10}$' then
    raise exception 'Enter a valid 10-digit phone number.' using errcode = 'P0001';
  end if;

  if v_email is not null and (char_length(v_email) > 254 or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$') then
    raise exception 'Enter a valid email address or leave it blank.' using errcode = 'P0001';
  end if;

  if v_reg_no !~ '^[A-Z0-9]{5,20}$' then
    raise exception 'Enter a SAN/USN with 5 to 20 letters or numbers.' using errcode = 'P0001';
  end if;

  if p_semester is null or p_semester not between 1 and 8 then
    raise exception 'Choose a semester from 1 to 8.' using errcode = 'P0001';
  end if;

  if not (v_branch = any (v_allowed_branches)) then
    raise exception 'Choose a valid branch.' using errcode = 'P0001';
  end if;

  -- A unique violation rolls back both inserts inside this block.
  begin
    insert into public.gp_passes (event_id, name, contact)
    values (p_event_id, v_name, v_phone)
    returning id, token into v_pass_id, v_token;

    insert into public.gp_registrations
      (event_id, user_id, name, phone, email, reg_no, semester, branch, pass_id)
    values
      (p_event_id, v_user_id, v_name, v_phone, v_email, v_reg_no, p_semester, v_branch, v_pass_id);
  exception when unique_violation then
    select p.token into v_token
    from public.gp_registrations r
    left join public.gp_passes p on p.id = r.pass_id
    where r.event_id = p_event_id and r.user_id = v_user_id;
    if found and v_token is not null then
      return v_token;
    end if;

    if exists (
      select 1 from public.gp_registrations r
      where r.event_id = p_event_id and lower(r.reg_no) = lower(v_reg_no)
    ) then
      raise exception 'This SAN/USN is already registered for this event.' using errcode = 'P0001';
    end if;

    raise exception 'Could not create the registration. Please try again.' using errcode = 'P0001';
  end;

  return v_token;
end;
$$;

revoke all on function public.gp_register(uuid, text, text, text, text, smallint, text) from public, anon, authenticated;
grant execute on function public.gp_register(uuid, text, text, text, text, smallint, text) to authenticated;

create or replace function public.gp_my_registrations()
returns table (event_id uuid, pass_token text)
language sql
stable
security definer
set search_path = public
as $$
  select r.event_id, p.token
  from public.gp_registrations r
  join public.gp_passes p on p.id = r.pass_id
  where r.user_id = auth.uid();
$$;

revoke all on function public.gp_my_registrations() from public, anon, authenticated;
grant execute on function public.gp_my_registrations() to authenticated;

create or replace function public.gp_delete_registration(p_registration_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_pass_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Sign in is required.' using errcode = 'P0001';
  end if;

  delete from public.gp_registrations r
  using public.gp_events e
  where r.id = p_registration_id
    and e.id = r.event_id
    and e.owner_id = auth.uid()
  returning r.pass_id into v_pass_id;

  if not found then
    raise exception 'Registration not found or you do not own this event.' using errcode = 'P0001';
  end if;

  if v_pass_id is not null then
    delete from public.gp_passes where id = v_pass_id;
  end if;

  return true;
end;
$$;

revoke all on function public.gp_delete_registration(uuid) from public, anon, authenticated;
grant execute on function public.gp_delete_registration(uuid) to authenticated;

-- Add registrations to Realtime only if the publication exists and the table
-- has not already been added.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'gp_registrations'
     ) then
    alter publication supabase_realtime add table public.gp_registrations;
  end if;
end;
$$;
