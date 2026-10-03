-- 0016  Validation, audit coverage, indexes, snapshots and cross-row invariants
--
--  M4   row-level audit (fn_audit_row; hashes stripped) on ingredients, recipe_lines, tables, vouchers, installments.
--       (platform tables are audited in 0015.)
--  M5   restaurants.timezone must be a real tz database name (pg_timezone_names). vat_rate 0..100 and
--  /SL4 opening_float >= 0 already exist as CHECK constraints (0002) and are now covered by tests.
--       expenses.expense_date is no longer a client-writable value with a server-timezone default: it is DERIVED
--       from the open business day (the day's opened_at in the TENANT's timezone) and a supplied value must equal it
--       (invalid_expense_date). A day left open past midnight keeps its own business date.
--  L5   expenses.category_name_snapshot (filled by trigger, like method_name_snapshot) so a later category rename
--       cannot rewrite history.
--  L6   day_sessions_closed_consistency also requires payment_snapshot and inventory_variance for a closed day.
--  L4   idempotency: a request hash is mandatory (null/blank rejected), keys are unique per
--       (restaurant_id, key, command) and fn_idempotency_complete names the command it completes.
--  L7   (only the agreed subset) payments: a reversal is for the same order / voucher / method as the original and for
--       at most its amount; orders: table_id must be the table of its table_session. (order_items.station_id =
--       menu_items.station_id is enforced in 0012.)
--  M9   missing foreign-key indexes (see supabase/tests/database/17_hardening_validation.test.sql for the rule and the
--       reviewed exceptions: actor columns such as created_by, whose parents are never deleted).

-- ── M4 ──────────────────────────────────────────────────────────────────────
do $$
declare
  t text;
begin
  foreach t in array array['ingredients', 'recipe_lines', 'tables', 'vouchers', 'installments'] loop
    execute format(
      'create trigger trg_audit after insert or update or delete on public.%I for each row execute function public.fn_audit_row(%L)',
      t, '');
  end loop;
end $$;

-- ── M5 timezone ─────────────────────────────────────────────────────────────
create or replace function public.fn_validate_timezone()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.timezone is null or not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = new.timezone) then
    perform public.fn_err('invalid_timezone');
  end if;
  return new;
end;
$$;
revoke all on function public.fn_validate_timezone() from public, anon, authenticated;
create trigger trg_validate_timezone before insert or update of timezone on public.restaurants
  for each row execute function public.fn_validate_timezone();

-- ── L5 + M5 expenses ────────────────────────────────────────────────────────
alter table public.expenses add column category_name_snapshot text;
alter table public.expenses alter column expense_date drop default;   -- derived by fn_expense_context

create or replace function public.fn_expense_context()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_day uuid;
  v_bdate date;
begin
  if tg_op = 'DELETE' then
    if old.day_session_id is not null
       and exists (select 1 from public.day_sessions d where d.id = old.day_session_id and d.status = 'closed') then
      perform public.fn_err('day_closed');
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE' then
    if old.day_session_id is not null
       and exists (select 1 from public.day_sessions d where d.id = old.day_session_id and d.status = 'closed') then
      perform public.fn_err('day_closed');
    end if;
    new.created_by := old.created_by;
    new.day_session_id := old.day_session_id;
    if new.expense_date is distinct from old.expense_date then
      perform public.fn_err('invalid_expense_date');
    end if;
    if new.payment_method_id is not distinct from old.payment_method_id then
      new.method_name_snapshot := old.method_name_snapshot;
      new.method_affects_drawer_snapshot := old.method_affects_drawer_snapshot;
    end if;
    if new.expense_category_id is not distinct from old.expense_category_id then
      new.category_name_snapshot := old.category_name_snapshot;
    end if;
  else
    -- INSERT: a client may only insert into its own tenant. Checked BEFORE any lookup so the error cannot
    -- distinguish another tenant's ids from unknown ones (same SQLSTATE/message as the RLS policy).
    if (select auth.uid()) is not null then
      if new.restaurant_id is distinct from (select public.current_restaurant_id()) then
        raise exception using errcode = '42501',
          message = 'new row violates row-level security policy for table "expenses"';
      end if;
      new.created_by := (select public.current_user_id());
      new.day_session_id := null;
    end if;
    if new.day_session_id is null then
      select d.id into v_day from public.day_sessions d
      where d.restaurant_id = new.restaurant_id and d.status = 'open';
      new.day_session_id := v_day;
    end if;
    -- an expense always belongs to an OPEN business day of its own tenant
    if new.day_session_id is null
       or exists (select 1 from public.day_sessions d
                  where d.id = new.day_session_id and d.restaurant_id = new.restaurant_id and d.status = 'closed') then
      perform public.fn_err('day_closed');
    end if;
    -- business date = the open day's opening date in the tenant's timezone
    select (d.opened_at at time zone r.timezone)::date into v_bdate
    from public.day_sessions d join public.restaurants r on r.id = d.restaurant_id
    where d.id = new.day_session_id and d.restaurant_id = new.restaurant_id;
    if v_bdate is null then perform public.fn_err('day_closed'); end if;
    if new.expense_date is not null and new.expense_date is distinct from v_bdate then
      perform public.fn_err('invalid_expense_date');
    end if;
    new.expense_date := v_bdate;
  end if;

  if tg_op = 'INSERT' or new.payment_method_id is distinct from old.payment_method_id then
    select pm.name, pm.affects_cash_drawer into new.method_name_snapshot, new.method_affects_drawer_snapshot
    from public.payment_methods pm
    where pm.id = new.payment_method_id and pm.restaurant_id = new.restaurant_id;
    if not found then
      perform public.fn_err('invalid_reference', 'payment_method_id');
    end if;
  end if;
  if tg_op = 'INSERT' or new.expense_category_id is distinct from old.expense_category_id then
    select ec.name into new.category_name_snapshot
    from public.expense_categories ec
    where ec.id = new.expense_category_id and ec.restaurant_id = new.restaurant_id;
    if not found then
      perform public.fn_err('invalid_reference', 'expense_category_id');
    end if;
  end if;
  return new;
end;
$$;

-- ── L6 ──────────────────────────────────────────────────────────────────────
alter table public.day_sessions drop constraint day_sessions_closed_consistency;
alter table public.day_sessions add constraint day_sessions_closed_consistency check (
  (status = 'open' and closed_at is null)
  or (status = 'closed'
      and closed_at is not null and closed_by is not null and order_count is not null
      and gross_collected is not null and cash_collected is not null and cash_expenses is not null
      and expenses_total is not null and expected_cash is not null and counted_cash is not null
      and cash_variance is not null and net_profit is not null and inventory_variance is not null
      and station_snapshot is not null and expense_snapshot is not null and payment_snapshot is not null)
);

-- ── L4 idempotency ──────────────────────────────────────────────────────────
alter table public.idempotency_keys drop constraint idempotency_keys_tenant_key;
alter table public.idempotency_keys add constraint idempotency_keys_tenant_key_command_key unique (restaurant_id, key, command);

drop function public.fn_idempotency_begin(text, text, text);
drop function public.fn_idempotency_complete(text, jsonb);

create or replace function public.fn_idempotency_begin(p_key text, p_command text, p_request_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rid uuid := public.fn_tenant_status_guard(true);
  v_id uuid;
  v_row public.idempotency_keys%rowtype;
begin
  if p_key is null or char_length(p_key) not between 8 and 128
     or p_command is null or char_length(btrim(p_command)) not between 1 and 80 then
    perform public.fn_err('invalid_input', 'idempotency_key');
  end if;
  -- the payload fingerprint is what makes a replay safe: without it a reused key could smuggle in a different request
  if p_request_hash is null or btrim(p_request_hash) = '' or char_length(p_request_hash) > 128 then
    perform public.fn_err('invalid_input', 'request_hash');
  end if;
  insert into public.idempotency_keys (restaurant_id, key, command, request_hash, created_by)
  values (v_rid, p_key, p_command, p_request_hash, (select auth.uid()))
  on conflict (restaurant_id, key, command) do nothing
  returning id into v_id;
  if v_id is not null then
    return null;  -- first execution: caller proceeds
  end if;
  select * into v_row from public.idempotency_keys k
  where k.restaurant_id = v_rid and k.key = p_key and k.command = p_command;
  if v_row.request_hash is distinct from p_request_hash then
    perform public.fn_err('idempotency_conflict');
  end if;
  return jsonb_build_object('replay', true, 'result', v_row.result);
end;
$$;

create or replace function public.fn_idempotency_complete(p_key text, p_command text, p_result jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rid uuid := public.fn_tenant_status_guard(true);
begin
  update public.idempotency_keys set result = p_result
  where restaurant_id = v_rid and key = p_key and command = p_command;
end;
$$;
revoke all on function public.fn_idempotency_begin(text, text, text), public.fn_idempotency_complete(text, text, jsonb)
  from public, anon, authenticated, service_role;

-- ── L7 cross-row invariants (agreed subset) ─────────────────────────────────
create or replace function public.fn_payment_reversal_check()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  o public.payments%rowtype;
begin
  if new.kind = 'reversal' then
    select * into o from public.payments p where p.id = new.reversed_payment_id and p.restaurant_id = new.restaurant_id;
    if not found then perform public.fn_err('invalid_reference', 'reversed_payment_id'); end if;
    if o.kind = 'reversal' then perform public.fn_err('invalid_reversal', 'cannot reverse a reversal'); end if;
    if new.amount > o.amount then perform public.fn_err('invalid_reversal', 'amount exceeds the original'); end if;
    if new.order_id is distinct from o.order_id
       or new.voucher_id is distinct from o.voucher_id
       or new.payment_method_id is distinct from o.payment_method_id then
      perform public.fn_err('invalid_reversal', 'order / voucher / method must match the original');
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.fn_payment_reversal_check() from public, anon, authenticated;
create trigger trg_payment_reversal_check before insert on public.payments
  for each row execute function public.fn_payment_reversal_check();

create or replace function public.fn_order_table_check()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_table uuid;
begin
  if new.table_session_id is not null then
    select ts.table_id into v_table from public.table_sessions ts
    where ts.id = new.table_session_id and ts.restaurant_id = new.restaurant_id;
    if new.table_id is distinct from v_table then
      perform public.fn_err('table_mismatch', 'orders.table_id must be the table of its table session');
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.fn_order_table_check() from public, anon, authenticated;
create trigger trg_order_table_check before insert or update of table_id, table_session_id on public.orders
  for each row execute function public.fn_order_table_check();

-- ── M9 indexes ──────────────────────────────────────────────────────────────
create index stock_movements_day_idx on public.stock_movements (restaurant_id, day_session_id) where day_session_id is not null;
create index orders_table_session_idx on public.orders (restaurant_id, table_session_id) where table_session_id is not null;
create index orders_customer_session_idx on public.orders (restaurant_id, customer_session_id) where customer_session_id is not null;
create index table_sessions_day_idx on public.table_sessions (restaurant_id, day_session_id) where day_session_id is not null;
create index installments_payment_idx on public.installments (restaurant_id, payment_id) where payment_id is not null;
create index vouchers_down_method_idx on public.vouchers (restaurant_id, down_payment_method_id) where down_payment_method_id is not null;
