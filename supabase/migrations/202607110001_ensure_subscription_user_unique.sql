-- Ensure automatic subscription activation can upsert by Supabase auth user_id.
alter table public.user_subscriptions
add column if not exists payment_method text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.user_subscriptions'::regclass
      and contype = 'u'
      and conkey = array[
        (select attnum from pg_attribute where attrelid = 'public.user_subscriptions'::regclass and attname = 'user_id')
      ]::smallint[]
  ) then
    alter table public.user_subscriptions
    add constraint user_subscriptions_user_id_unique unique (user_id);
  end if;
end $$;
