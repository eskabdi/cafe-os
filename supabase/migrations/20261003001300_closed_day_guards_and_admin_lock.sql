-- 0013  H3/SL1 closed-day freeze on EVERY table that belongs to a business day, and H2/SL2 last-admin race.
--
-- H3. fn_guard_closed_day() is a BEFORE INSERT/UPDATE/DELETE row trigger. It resolves the business day of the row
--     (directly, or through the order / voucher / table session it belongs to), locks that day_sessions row
--     FOR SHARE and raises day_closed when the day is closed. FOR SHARE serialises against fn_close_day (which will
--     take FOR UPDATE on the same row): a write either lands before the close (and is in its snapshot) or fails after
--     it. There is no way around it for any role, including service_role and the table owner.
--
--       table             resolves day through            post-close mutable columns (the ONLY compensating paths)
--       orders            orders.day_session_id           none
--       order_items       order                           none
--       payments          payments.day_session_id         none (append-only anyway; reversals are NEW rows in the open day)
--       stock_movements   stock_movements.day_session_id  none (append-only anyway)
--       vouchers          order                           none
--       installments      voucher -> order                paid, paid_at, payment_id (collection; the linked payment
--                                                         must belong to an OPEN day)
--       table_sessions    table_sessions.day_session_id   none
--       customer_sessions table session                   status, last_seen_at (session hygiene, not financial data)
--
--     Open question for Phase 4/9 (documented in rpc-conventions.md): flipping orders.payment_status of a
--     closed-day order after a late installment settles needs an explicit allowlist entry here, never a bypass.
--     expenses keep their own day logic in fn_expense_context (INSERT resolves the open day itself).
--
-- H2. The last-active-tenant_admin guard (trigger and fn_change_user_role precheck) was a check-then-act race: two
--     admins deactivating each other concurrently both saw "another admin exists". Both paths now take
--     FOR NO KEY UPDATE on the tenant's tenant_admin ROLE row first (it conflicts with itself but not with the
--     FOR KEY SHARE that profile inserts/updates take on the same row through the role FK), so the second
--     transaction re-evaluates after the first commits. Proven by scripts/db/race-tests.sh (two real sessions).

create or replace function public.fn_guard_closed_day()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_kind    text   := tg_argv[0];
  v_allowed text[] := string_to_array(coalesce(tg_argv[1], ''), ',');
  v_old     jsonb;
  v_new     jsonb;
  v_changed text[];
  v_day     uuid;
  v_days    uuid[] := '{}';
  v_status  text;
  v_row     jsonb;
  v_pay_day uuid;
begin
  if tg_op = 'DELETE' then v_old := to_jsonb(old);
  elsif tg_op = 'INSERT' then v_new := to_jsonb(new);
  else v_old := to_jsonb(old); v_new := to_jsonb(new);
  end if;

  -- an UPDATE that only touches allowlisted columns skips the day freeze (still checked for the linked payment)
  if tg_op = 'UPDATE' and cardinality(v_allowed) > 0 then
    select array_agg(k.key) into v_changed
    from jsonb_each(v_new) k
    where k.key <> 'updated_at' and v_old -> k.key is distinct from k.value;
    if v_changed is not null and v_changed <@ v_allowed then
      if tg_table_name = 'installments' and new.payment_id is not null then
        select p.day_session_id into v_pay_day from public.payments p where p.id = new.payment_id;
        if v_pay_day is not null and exists (select 1 from public.day_sessions d where d.id = v_pay_day and d.status = 'closed') then
          perform public.fn_err('day_closed');
        end if;
      end if;
      return new;
    end if;
  end if;

  foreach v_row in array array[v_old, v_new] loop
    continue when v_row is null;
    v_day := case v_kind
      when 'self' then (v_row ->> 'day_session_id')::uuid
      when 'order' then (select o.day_session_id from public.orders o where o.id = (v_row ->> 'order_id')::uuid)
      when 'voucher' then (select o.day_session_id from public.vouchers v join public.orders o on o.id = v.order_id
                           where v.id = (v_row ->> 'voucher_id')::uuid)
      when 'table_session' then (select t.day_session_id from public.table_sessions t where t.id = (v_row ->> 'table_session_id')::uuid)
    end;
    if v_day is not null and not (v_day = any (v_days)) then v_days := v_days || v_day; end if;
  end loop;

  foreach v_day in array v_days loop
    select d.status into v_status from public.day_sessions d where d.id = v_day for share;
    if v_status = 'closed' then
      perform public.fn_err('day_closed');
    end if;
  end loop;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
revoke all on function public.fn_guard_closed_day() from public, anon, authenticated;

create trigger trg_01_closed_day before insert or update or delete on public.orders
  for each row execute function public.fn_guard_closed_day('self');
create trigger trg_01_closed_day before insert or update or delete on public.order_items
  for each row execute function public.fn_guard_closed_day('order');
create trigger trg_01_closed_day before insert or update or delete on public.payments
  for each row execute function public.fn_guard_closed_day('self');
create trigger trg_01_closed_day before insert or update or delete on public.stock_movements
  for each row execute function public.fn_guard_closed_day('self');
create trigger trg_01_closed_day before insert or update or delete on public.vouchers
  for each row execute function public.fn_guard_closed_day('order');
create trigger trg_01_closed_day before insert or update or delete on public.installments
  for each row execute function public.fn_guard_closed_day('voucher', 'paid,paid_at,payment_id');
create trigger trg_01_closed_day before insert or update or delete on public.table_sessions
  for each row execute function public.fn_guard_closed_day('self');
create trigger trg_01_closed_day before insert or update or delete on public.customer_sessions
  for each row execute function public.fn_guard_closed_day('table_session', 'status,last_seen_at');

-- ── H2: serialised last-admin guard ─────────────────────────────────────────
create or replace function public.fn_guard_last_admin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.is_active
     and (not new.is_active or new.role_id is distinct from old.role_id)
     and exists (select 1 from public.roles r where r.id = old.role_id and r.system_key = 'tenant_admin')
  then
    -- serialise every admin-removing transaction of this tenant (see header); then re-check on a fresh snapshot
    perform 1 from public.roles r
    where r.restaurant_id = old.restaurant_id and r.system_key = 'tenant_admin'
    for no key update;
    if not exists (
         select 1
         from public.profiles p
         join public.roles r on r.id = p.role_id and r.restaurant_id = p.restaurant_id
         where p.restaurant_id = old.restaurant_id
           and p.id <> old.id
           and p.is_active
           and r.system_key = 'tenant_admin'
       )
    then
      perform public.fn_err('last_tenant_admin');
    end if;
  end if;
  return new;
end;
$$;
