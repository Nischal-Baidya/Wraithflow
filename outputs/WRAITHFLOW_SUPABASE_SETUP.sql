-- WraithFlow: initial Supabase schema, RLS, and private journal-photo storage.
-- Run this entire file once in Supabase Dashboard -> SQL Editor -> New query.
-- It is intentionally safe to re-run. It never uses a service-role key.

create extension if not exists pgcrypto;

-- Common server-side timestamp function. The server, rather than a device clock,
-- establishes the conflict version used by the offline-sync layer.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

-- One row per authenticated user. This trigger creates it without requiring a
-- browser client to have elevated database privileges.
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  timezone text not null default 'UTC',
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- Backfill profile rows if authenticated users existed before this migration.
insert into public.profiles (id, display_name)
select id, coalesce(raw_user_meta_data ->> 'full_name', raw_user_meta_data ->> 'name')
from auth.users
on conflict (id) do nothing;

create table if not exists public.habits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (char_length(trim(title)) between 1 and 160),
  description text,
  habit_type text not null check (habit_type in ('binary', 'quantity')),
  unit text,
  target_quantity numeric(14,3),
  schedule_type text not null default 'daily' check (schedule_type in ('daily', 'weekdays', 'custom')),
  scheduled_weekdays smallint[] not null default '{}',
  -- For custom schedules, the client stores a validated rule such as
  -- {"kind":"interval","every":2,"anchorDate":"2026-01-01"} or
  -- {"kind":"dates","dates":["2026-01-01","2026-01-15"]}.
  custom_schedule jsonb not null default '{}'::jsonb,
  color text,
  icon text,
  is_archived boolean not null default false,
  deleted_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint habits_quantity_configuration check (
    (habit_type = 'binary' and target_quantity is null)
    or (habit_type = 'quantity' and target_quantity is not null and target_quantity > 0 and unit is not null)
  ),
  constraint habits_weekdays_valid check (
    coalesce(array_length(scheduled_weekdays, 1), 0) = 0
    or scheduled_weekdays <@ array[0,1,2,3,4,5,6]::smallint[]
  ),
  unique (id, user_id)
);

create table if not exists public.habit_entries (
  id uuid primary key default gen_random_uuid(),
  habit_id uuid not null,
  user_id uuid not null,
  entry_date date not null,
  status text not null default 'pending' check (status in ('pending', 'completed', 'missed')),
  quantity numeric(14,3),
  note text,
  deleted_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint habit_entries_habit_owner_fk foreign key (habit_id, user_id)
    references public.habits(id, user_id) on delete cascade,
  constraint habit_entries_one_per_day unique (habit_id, entry_date),
  constraint habit_entries_quantity_nonnegative check (quantity is null or quantity >= 0)
);

create table if not exists public.goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (char_length(trim(title)) between 1 and 200),
  description text,
  category text not null check (category in ('study', 'fitness', 'coding', 'finance', 'looks', 'behaviour')),
  progress numeric(5,2) not null default 0 check (progress between 0 and 100),
  target_date date,
  notes text,
  deleted_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (id, user_id)
);

create table if not exists public.goal_milestones (
  id uuid primary key default gen_random_uuid(),
  goal_id uuid not null,
  user_id uuid not null,
  title text not null check (char_length(trim(title)) between 1 and 200),
  target_date date,
  is_completed boolean not null default false,
  completed_at timestamptz,
  sort_order integer not null default 0,
  deleted_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint goal_milestones_goal_owner_fk foreign key (goal_id, user_id)
    references public.goals(id, user_id) on delete cascade
);

create table if not exists public.planner_tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  goal_id uuid,
  title text not null check (char_length(trim(title)) between 1 and 240),
  notes text,
  priority text not null default 'medium' check (priority in ('low', 'medium', 'high', 'urgent')),
  plan_period text not null default 'daily' check (plan_period in ('daily', 'weekly', 'monthly', 'yearly')),
  planned_date date,
  due_at timestamptz,
  status text not null default 'pending' check (status in ('pending', 'completed', 'cancelled')),
  completed_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint planner_tasks_goal_owner_fk foreign key (goal_id, user_id)
    references public.goals(id, user_id) on delete restrict
);

create table if not exists public.journal_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  entry_date date not null,
  template_type text not null default 'day' check (template_type in ('day', 'goal_review', 'weekly_review', 'monthly_review', 'gratitude', 'custom')),
  title text not null default '',
  body text not null default '',
  mood text,
  tags text[] not null default '{}',
  deleted_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (id, user_id)
);

create table if not exists public.journal_photos (
  id uuid primary key default gen_random_uuid(),
  journal_entry_id uuid not null,
  user_id uuid not null,
  object_path text not null unique,
  caption text,
  sort_order integer not null default 0,
  deleted_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint journal_photos_entry_owner_fk foreign key (journal_entry_id, user_id)
    references public.journal_entries(id, user_id) on delete cascade
);

-- Indexes serve the dashboard, planners, history, heatmap and sync queries.
create index if not exists habits_user_active_idx on public.habits (user_id, is_archived, updated_at desc);
create index if not exists habit_entries_user_date_idx on public.habit_entries (user_id, entry_date desc);
create index if not exists habit_entries_habit_date_idx on public.habit_entries (habit_id, entry_date desc);
create index if not exists goals_user_target_idx on public.goals (user_id, target_date);
create index if not exists milestones_goal_sort_idx on public.goal_milestones (goal_id, sort_order);
create index if not exists planner_tasks_user_date_idx on public.planner_tasks (user_id, planned_date, due_at);
create index if not exists journal_entries_user_date_idx on public.journal_entries (user_id, entry_date desc);
create index if not exists journal_photos_entry_sort_idx on public.journal_photos (journal_entry_id, sort_order);

-- Timestamp triggers for conflict-aware offline sync. A client must never blindly
-- overwrite a row whose server updated_at is newer than its saved base version.
drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at before update on public.profiles for each row execute procedure public.set_updated_at();
drop trigger if exists habits_set_updated_at on public.habits;
create trigger habits_set_updated_at before update on public.habits for each row execute procedure public.set_updated_at();
drop trigger if exists habit_entries_set_updated_at on public.habit_entries;
create trigger habit_entries_set_updated_at before update on public.habit_entries for each row execute procedure public.set_updated_at();
drop trigger if exists goals_set_updated_at on public.goals;
create trigger goals_set_updated_at before update on public.goals for each row execute procedure public.set_updated_at();
drop trigger if exists goal_milestones_set_updated_at on public.goal_milestones;
create trigger goal_milestones_set_updated_at before update on public.goal_milestones for each row execute procedure public.set_updated_at();
drop trigger if exists planner_tasks_set_updated_at on public.planner_tasks;
create trigger planner_tasks_set_updated_at before update on public.planner_tasks for each row execute procedure public.set_updated_at();
drop trigger if exists journal_entries_set_updated_at on public.journal_entries;
create trigger journal_entries_set_updated_at before update on public.journal_entries for each row execute procedure public.set_updated_at();
drop trigger if exists journal_photos_set_updated_at on public.journal_photos;
create trigger journal_photos_set_updated_at before update on public.journal_photos for each row execute procedure public.set_updated_at();

-- Row Level Security: authenticated users can access only rows bearing their id.
alter table public.profiles enable row level security;
alter table public.habits enable row level security;
alter table public.habit_entries enable row level security;
alter table public.goals enable row level security;
alter table public.goal_milestones enable row level security;
alter table public.planner_tasks enable row level security;
alter table public.journal_entries enable row level security;
alter table public.journal_photos enable row level security;

drop policy if exists profiles_own_rows on public.profiles;
create policy profiles_own_rows on public.profiles for all to authenticated
  using ((select auth.uid()) = id) with check ((select auth.uid()) = id);
drop policy if exists habits_own_rows on public.habits;
create policy habits_own_rows on public.habits for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists habit_entries_own_rows on public.habit_entries;
create policy habit_entries_own_rows on public.habit_entries for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists goals_own_rows on public.goals;
create policy goals_own_rows on public.goals for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists goal_milestones_own_rows on public.goal_milestones;
create policy goal_milestones_own_rows on public.goal_milestones for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists planner_tasks_own_rows on public.planner_tasks;
create policy planner_tasks_own_rows on public.planner_tasks for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists journal_entries_own_rows on public.journal_entries;
create policy journal_entries_own_rows on public.journal_entries for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists journal_photos_own_rows on public.journal_photos;
create policy journal_photos_own_rows on public.journal_photos for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- Private Storage bucket. File paths must be: <authenticated-user-id>/<entry-id>/<file-name>.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'journal-photos', 'journal-photos', false, 10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists journal_photos_select_own_folder on storage.objects;
create policy journal_photos_select_own_folder on storage.objects for select to authenticated
  using (bucket_id = 'journal-photos' and (storage.foldername(name))[1] = (select auth.uid()::text));
drop policy if exists journal_photos_insert_own_folder on storage.objects;
create policy journal_photos_insert_own_folder on storage.objects for insert to authenticated
  with check (bucket_id = 'journal-photos' and (storage.foldername(name))[1] = (select auth.uid()::text));
drop policy if exists journal_photos_update_own_folder on storage.objects;
create policy journal_photos_update_own_folder on storage.objects for update to authenticated
  using (bucket_id = 'journal-photos' and (storage.foldername(name))[1] = (select auth.uid()::text))
  with check (bucket_id = 'journal-photos' and (storage.foldername(name))[1] = (select auth.uid()::text));
drop policy if exists journal_photos_delete_own_folder on storage.objects;
create policy journal_photos_delete_own_folder on storage.objects for delete to authenticated
  using (bucket_id = 'journal-photos' and (storage.foldername(name))[1] = (select auth.uid()::text));

-- Optional hardening verification queries (run separately if desired):
-- select tablename, rowsecurity from pg_tables where schemaname = 'public' order by tablename;
-- select id, public, file_size_limit from storage.buckets where id = 'journal-photos';
