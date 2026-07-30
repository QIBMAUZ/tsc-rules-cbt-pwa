-- Fix admin_users RLS infinite recursion (42P17).
-- Do not make admin_users policies query admin_users itself.

alter table public.admin_users enable row level security;
alter table public.user_subscriptions enable row level security;

-- Remove recursive and stale policies.
drop policy if exists "Admins can read admin users" on public.admin_users;
drop policy if exists "Users can read own admin row" on public.admin_users;
drop policy if exists "Users can read own admin_users row" on public.admin_users;

drop policy if exists "Admins can read subscriptions" on public.user_subscriptions;
drop policy if exists "Users can read own subscription" on public.user_subscriptions;

-- Non-recursive admin_users read: a logged-in user may only see their own admin marker.
create policy "Users can read own admin_users row"
on public.admin_users
for select
to authenticated
using (auth.uid() = user_id);

-- Regular users can read their own subscription record.
create policy "Users can read own subscription"
on public.user_subscriptions
for select
to authenticated
using (auth.uid() = user_id);

-- Backend/service-role access is unrestricted by RLS automatically because service_role has BYPASSRLS.
-- Admin dashboard API routes use SUPABASE_SERVICE_ROLE_KEY server-side for broader support lookups.
