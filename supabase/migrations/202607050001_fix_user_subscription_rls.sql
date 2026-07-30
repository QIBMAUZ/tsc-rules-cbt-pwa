-- Re-affirm user_subscriptions RLS for logged-in users.
-- This fixes/repairs production projects where the policy was not applied.
alter table public.user_subscriptions enable row level security;

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
