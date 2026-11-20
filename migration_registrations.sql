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
