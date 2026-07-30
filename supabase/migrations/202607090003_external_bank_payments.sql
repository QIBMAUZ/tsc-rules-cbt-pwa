-- External/direct bank payments recorded before the payer creates an account.
create table if not exists public.external_payment_records (
  id uuid primary key default gen_random_uuid(),
  payer_name text not null,
  bank_name text,
  amount numeric not null default 1300,
  payment_reference text not null,
  phone text,
  note text,
  status text not null default 'waiting_for_account' check (status in ('waiting_for_account','attached','rejected')),
  user_id uuid references auth.users(id) on delete set null,
  email text,
  created_at timestamptz not null default now(),
  attached_at timestamptz,
  reviewed_by text
);

alter table public.external_payment_records enable row level security;

alter table public.manual_payment_requests
add column if not exists bank_name text,
add column if not exists note text;

-- Admin operations are handled only by Vercel API routes using SUPABASE_SERVICE_ROLE_KEY.
-- No client-side RLS policy is granted for external_payment_records.
