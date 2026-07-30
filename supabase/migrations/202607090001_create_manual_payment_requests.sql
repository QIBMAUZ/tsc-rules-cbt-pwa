-- Manual bank transfer payment requests.
create table if not exists public.manual_payment_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  email text not null,
  payer_name text not null,
  phone text,
  payment_reference text not null,
  receipt_url text,
  amount numeric not null default 1300,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by text
);

alter table public.manual_payment_requests enable row level security;

alter table public.user_subscriptions
add column if not exists payment_method text;

insert into storage.buckets (id, name, public)
values ('manual-payment-receipts', 'manual-payment-receipts', false)
on conflict (id) do nothing;

update storage.buckets
set public = false
where id = 'manual-payment-receipts';

drop policy if exists "Users can create own manual payment requests" on public.manual_payment_requests;
create policy "Users can create own manual payment requests"
on public.manual_payment_requests
for insert
to authenticated
with check (auth.uid() = user_id);

drop policy if exists "Users can read own manual payment requests" on public.manual_payment_requests;
create policy "Users can read own manual payment requests"
on public.manual_payment_requests
for select
to authenticated
using (auth.uid() = user_id);

-- Admin review/list operations are handled by Vercel API with SUPABASE_SERVICE_ROLE_KEY.
-- Receipt uploads are handled by Vercel API with SUPABASE_SERVICE_ROLE_KEY.
