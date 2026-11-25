-- Current TSC Rules CBT subscription price for new purchases is NGN 2000.
-- This migration changes only forward defaults; existing historical rows keep their recorded amounts.

alter table public.manual_payment_requests
  alter column amount set default 2000;

alter table public.external_payment_records
  alter column amount set default 2000;
