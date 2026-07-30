-- Temporary audit table for one-time Legacy Payment Recovery imports.
-- Safe to remove later after exporting/retaining any required audit records.
create table if not exists public.legacy_payment_recovery_audit (
  id uuid primary key default gen_random_uuid(),
  admin_email text not null,
  user_email text not null,
  payment_reference text not null,
  action text not null default 'Legacy Payment Recovery',
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.legacy_payment_recovery_audit enable row level security;

drop policy if exists "Admins can read legacy payment recovery audit" on public.legacy_payment_recovery_audit;
create policy "Admins can read legacy payment recovery audit"
on public.legacy_payment_recovery_audit
for select
to authenticated
using (exists (select 1 from public.admin_users au where au.user_id = auth.uid()));

-- Inserts are intentionally handled only by the Vercel API using SUPABASE_SERVICE_ROLE_KEY.
