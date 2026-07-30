-- TSC Rules CBT subscriptions and admin support tables
create table if not exists public.user_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  email text,
  status text default 'inactive',
  payment_reference text,
  amount numeric,
  currency text,
  verified boolean default false,
  paid_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (user_id)
);

create table if not exists public.admin_users (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  email text unique not null,
  created_at timestamptz default now(),
  unique (user_id)
);

create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists set_user_subscriptions_updated_at on public.user_subscriptions;
create trigger set_user_subscriptions_updated_at
before update on public.user_subscriptions
for each row execute function public.set_updated_at();

alter table public.user_subscriptions enable row level security;
alter table public.admin_users enable row level security;

drop policy if exists "Users can read own subscription" on public.user_subscriptions;
create policy "Users can read own subscription"
on public.user_subscriptions
for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "Admins can read subscriptions" on public.user_subscriptions;
create policy "Admins can read subscriptions"
on public.user_subscriptions
for select
to authenticated
using (exists (select 1 from public.admin_users au where au.user_id = auth.uid()));

drop policy if exists "Admins can read admin users" on public.admin_users;
create policy "Admins can read admin users"
on public.admin_users
for select
to authenticated
using (exists (select 1 from public.admin_users au where au.user_id = auth.uid()));

-- No insert/update/delete policy is granted to normal clients for user_subscriptions.
-- The Vercel API uses SUPABASE_SERVICE_ROLE_KEY server-side to activate verified payments.
