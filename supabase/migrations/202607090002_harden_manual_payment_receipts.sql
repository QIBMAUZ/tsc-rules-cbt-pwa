-- Ensure manual payment receipts are not publicly exposed.
update storage.buckets
set public = false
where id = 'manual-payment-receipts';
