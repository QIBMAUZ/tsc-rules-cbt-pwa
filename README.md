# TSC Rules CBT Practice PWA

Static PWA for Ogun State Teaching Service CBT practice with 300 reviewed questions, practice/exam modes, score history, Vercel Analytics, Supabase Auth, secure Flutterwave subscription verification, restore access, and an admin support dashboard.

## Supabase setup

Project URL:

```
https://zmflnrviunljqzbmbbnm.supabase.co
```

Run the SQL migration in:

```
supabase/migrations/202607030001_create_subscriptions.sql

supabase/migrations/202607050001_fix_user_subscription_rls.sql
```

It creates:

- `user_subscriptions`: one subscription row per auth user.
- `admin_users`: allow-list for support admins.

RLS is enabled. Authenticated users can only read their own subscription. Admin users can read subscription records for support lookup. Normal frontend users have no insert/update/delete policy for subscription activation; activation is handled by the Vercel API using the service role key.

## Vercel environment variables

Frontend/public values used by the static app build:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

These are injected into `dist/config.js` during `npm run build`. The source `index.html` does not hardcode the Supabase project URL or anon key.

Server-only values required by API routes:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `FLW_SECRET_KEY`
- `TSC_PRICE_CUTOVER_AT` or `SUBSCRIPTION_PRICE_CUTOVER_AT` — ISO timestamp for the production switch to ₦2,000. This is used only to distinguish trusted pre-cutover ₦1,300 bank-transfer records from new underpayments.

Never expose `SUPABASE_SERVICE_ROLE_KEY` or `FLW_SECRET_KEY` in frontend code.

## Flutterwave setup

The app opens Flutterwave Checkout for ₦2,000 NGN. The checkout callback sends the transaction id/reference to:

```
/api/verify-flutterwave-payment
```

The serverless function verifies the transaction with Flutterwave, confirms successful status, amount `2000`, and currency `NGN`, then activates `user_subscriptions` for the logged-in Supabase user.

## Restore access

Logged-in users can restore a previous Flutterwave payment by entering either:

- Flutterwave `transaction_id`
- Flutterwave `tx_ref` / payment reference

Fake references, failed payments, wrong amount, and wrong currency do not unlock access.

## Admin setup

Add support/admin users to `admin_users` after they create and verify a Supabase account:

```sql
insert into public.admin_users (user_id, email)
values ('AUTH_USER_UUID', 'admin@qibmauz.com');
```

Admins can search by email or payment reference in the app dashboard, review manual bank-transfer requests, and activate access only after support verification.


## PWA caching

The service worker caches static app shell files, icons, background artwork, and `questions.json`. It bypasses Vercel Analytics and all `/api/` requests so auth/payment/admin requests are never cached.

Current cache version: `tsc-rules-cbt-v26`.

## Test checklist

- Signup with email/password.
- Verify email before subscribing.
- Login/logout session persistence.
- Forgot password email flow.
- One full CBT free per browser.
- Subscribe with Flutterwave and verify server-side.
- Restore access with valid transaction id.
- Restore access with valid tx_ref.
- Fake/random reference is blocked.
- Failed/cancelled/wrong amount/wrong currency payments are blocked.
- Subscribed user logs in on another device and access unlocks after Supabase subscription check.
- Admin dashboard hidden from non-admins.
- Admin can search subscriptions and mark active after support verification.
- `questions.json` remains exactly 300 questions.
- `node --check service-worker.js` passes.
- `node --check api/verify-flutterwave-payment.js` passes.
- `node --check api/admin-subscriptions.js` passes.
- `npm run build` succeeds with `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` set.

## Deployment

Do not deploy until all Vercel environment variables are set. The build will fail if `VITE_SUPABASE_URL` or `VITE_SUPABASE_ANON_KEY` is missing. Then run:

```bash
vercel --prod
```

## Manual bank transfer setup

Apply `supabase/migrations/202607090001_create_manual_payment_requests.sql` to add `manual_payment_requests`, the receipt storage bucket, and the optional `payment_method` column used for bank-transfer approvals. Admins can review pending requests in the in-app Admin Dashboard and approve only after confirming the Moniepoint transfer.

Apply `supabase/migrations/202607090002_harden_manual_payment_receipts.sql` if the manual receipt bucket was already created, so receipt uploads remain private and are viewed only through admin signed links.

Apply `supabase/migrations/202607090003_external_bank_payments.sql` to add external direct-bank-payment tracking, manual activation audit fields, and the waiting-for-account workflow.

Apply `supabase/migrations/202607110001_ensure_subscription_user_unique.sql` to ensure `user_subscriptions.user_id` is unique and Flutterwave subscription activation can upsert by authenticated user id.
