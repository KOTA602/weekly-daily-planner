create table if not exists public.events (
  id text primary key,
  title text not null default '',
  date text not null,
  "startTime" text not null,
  "endTime" text not null,
  "googleEventId" text,
  reminders jsonb not null default '[]'::jsonb,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);

create table if not exists public.tasks (
  id text primary key,
  title text not null default '',
  date text,
  completed boolean not null default false,
  "order" numeric not null default 1000,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);

create table if not exists public.memos (
  id text primary key,
  date text,
  content text not null default '',
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);

create table if not exists public.settings (
  id text primary key,
  value jsonb not null default '{}'::jsonb,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);

alter table public.events enable row level security;
alter table public.tasks enable row level security;
alter table public.memos enable row level security;
alter table public.settings enable row level security;

drop policy if exists "events_select_anon" on public.events;
drop policy if exists "events_insert_anon" on public.events;
drop policy if exists "events_update_anon" on public.events;
drop policy if exists "events_delete_anon" on public.events;
drop policy if exists "tasks_select_anon" on public.tasks;
drop policy if exists "tasks_insert_anon" on public.tasks;
drop policy if exists "tasks_update_anon" on public.tasks;
drop policy if exists "tasks_delete_anon" on public.tasks;
drop policy if exists "memos_select_anon" on public.memos;
drop policy if exists "memos_insert_anon" on public.memos;
drop policy if exists "memos_update_anon" on public.memos;
drop policy if exists "memos_delete_anon" on public.memos;
drop policy if exists "settings_select_anon" on public.settings;
drop policy if exists "settings_insert_anon" on public.settings;
drop policy if exists "settings_update_anon" on public.settings;
drop policy if exists "settings_delete_anon" on public.settings;

create policy "events_select_anon" on public.events for select to anon using (true);
create policy "events_insert_anon" on public.events for insert to anon with check (true);
create policy "events_update_anon" on public.events for update to anon using (true) with check (true);
create policy "events_delete_anon" on public.events for delete to anon using (true);

create policy "tasks_select_anon" on public.tasks for select to anon using (true);
create policy "tasks_insert_anon" on public.tasks for insert to anon with check (true);
create policy "tasks_update_anon" on public.tasks for update to anon using (true) with check (true);
create policy "tasks_delete_anon" on public.tasks for delete to anon using (true);

create policy "memos_select_anon" on public.memos for select to anon using (true);
create policy "memos_insert_anon" on public.memos for insert to anon with check (true);
create policy "memos_update_anon" on public.memos for update to anon using (true) with check (true);
create policy "memos_delete_anon" on public.memos for delete to anon using (true);

create policy "settings_select_anon" on public.settings for select to anon using (true);
create policy "settings_insert_anon" on public.settings for insert to anon with check (true);
create policy "settings_update_anon" on public.settings for update to anon using (true) with check (true);
create policy "settings_delete_anon" on public.settings for delete to anon using (true);
