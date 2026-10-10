#!/usr/bin/env bash
# Concurrency tests that pgTAP (one session per file) cannot express: real concurrent psql sessions against the
# throwaway cluster started by scripts/db-test.sh (run after both pgTAP passes; invoked by db-test.sh unless --no-race).
#   * last tenant_admin: two admins deactivate each other at the same time            (H2)  -> exactly 1 active admin
#   * same race through fn_change_user_role (demotion)                                  (H2)
#   * last platform_super_admin: two super admins deactivate each other                 (SM6)
#   * one account, one portal: concurrent platform_admins + profiles insert for the same user (3B) -> exactly one
#   * closed-day guard vs fn_close_day-style UPDATE, both orders of arrival             (H3)
#   * 60 concurrent wrong PIN guesses against one account                               (SM3) -> failed_attempts stays 3
#   * 20 concurrent blocked-login handlers for one user                                 (SS1) -> exactly one notification set
#   * Phase 4 orders (0030): 8 submits racing for the last unit of stock -> exactly 1 order; 10 concurrent retries of ONE
#     idempotency key -> exactly 1 order; 20 submits with opposite cart line order + concurrent receipts -> no deadlock, ledger
#     consistent; cancel vs KDS start in both orders of arrival -> exactly one wins, no half state
# Needs PGHOST / PGPORT / PGUSER=postgres / PGDATABASE in the environment (db-test.sh exports them) and the seeded
# schema. NEVER run it against a real project: it provisions throwaway tenants (race-*) and leaves them behind.
set -uo pipefail
PSQL=(psql -X -q -t -A -v ON_ERROR_STOP=0)
FAILS=0
pass() { echo "ok   - $1"; }
fail() { echo "FAIL - $1"; FAILS=$((FAILS + 1)); }
check() { # check "name" "expected" "actual"
  if [ "$2" = "$3" ]; then pass "$1 (= $3)"; else fail "$1: expected '$2', got '$3'"; fi
}
q() { "${PSQL[@]}" -c "$1"; }

q "insert into public.plans (name, price_etb_monthly) values ('Growth', 2490) on conflict (name) do nothing" >/dev/null
SVC="select set_config('request.jwt.claims', '{\"role\":\"service_role\"}', false);"
new_user() { # id email [confirmed]
  q "insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, confirmation_token, recovery_token, email_change_token_new, email_change)
     values ('00000000-0000-0000-0000-000000000000', '$1', 'authenticated', 'authenticated', '$2', 'x', now(), '{\"provider\":\"email\"}', '{}', '', '', '', '') on conflict do nothing" >/dev/null
}
new_tenant() { # slug owner_id owner_email
  new_user "$2" "$3"
  q "$SVC select public.fn_provision_tenant('Race $1', '$1', '$2', '$3', 'Owner', null, null, (select id from public.plans where name = 'Growth'), 'owner')" >/dev/null
  q "update public.restaurants set status = 'active' where slug = '$1'" >/dev/null
}
as_user() { # uid sql...  -> a transaction that runs as the authenticated user (aal2 claim), with the statements given
  local uid="$1"; shift
  printf "begin;\nselect set_config('app.platform_mfa_required', 'off', true);\nselect set_config('request.jwt.claims', '{\"sub\":\"%s\",\"role\":\"authenticated\",\"aal\":\"aal2\"}', true);\nset local role authenticated;\n%s\ncommit;\n" "$uid" "$*"
}
add_factor() { # uid -> a verified TOTP factor (platform RPCs need aal2 AND a live authenticator, 0030)
  q "insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
     values (gen_random_uuid(), '$1', 'race-' || substr(gen_random_uuid()::text, 1, 8), 'totp', 'verified', clock_timestamp(), clock_timestamp())" >/dev/null
}
active_admins() { q "select count(*) from public.profiles p join public.roles r on r.id = p.role_id and r.restaurant_id = p.restaurant_id join public.restaurants x on x.id = p.restaurant_id where x.slug = '$1' and p.is_active and r.system_key = 'tenant_admin'"; }

echo "== H2: two admins deactivate each other concurrently"
A=00000000-0000-4000-8000-0000000fa001; B=00000000-0000-4000-8000-0000000fa002
new_tenant race-admins $A race-a@race.example.com
new_user $B race-b@race.example.com
q "insert into public.profiles (id, restaurant_id, first_name, username, role_id, auth_method)
   select '$B', r.id, 'Second', 'second', (select id from public.roles where restaurant_id = r.id and system_key = 'tenant_admin'), 'password' from public.restaurants r where r.slug = 'race-admins'" >/dev/null
check "two active admins before" 2 "$(active_admins race-admins)"
as_user $A "select public.fn_set_user_active('$B', false); select pg_sleep(1.5);" | "${PSQL[@]}" >/tmp/race.$$.1 2>&1 &
p1=$!
sleep 0.4
as_user $B "select public.fn_set_user_active('$A', false);" | "${PSQL[@]}" >/tmp/race.$$.2 2>&1 &
p2=$!
wait $p1 $p2
check "exactly one active admin after the race (fn_set_user_active / trigger path)" 1 "$(active_admins race-admins)"
grep -q last_tenant_admin /tmp/race.$$.1 /tmp/race.$$.2 && pass "the loser got last_tenant_admin" || fail "nobody got last_tenant_admin"

echo "== H2: same race through fn_change_user_role"
q "update public.profiles set is_active = true where id in ('$A', '$B')" >/dev/null
# the update above is itself serial; both are active again
check "two active admins again" 2 "$(active_admins race-admins)"
WAITER="(select id from public.roles where restaurant_id = (select restaurant_id from public.profiles where id = '$A') and name = 'Waiter')"
as_user $A "select public.fn_change_user_role('$B', $WAITER); select pg_sleep(1.5);" | "${PSQL[@]}" >/tmp/race.$$.1 2>&1 &
p1=$!
sleep 0.4
as_user $B "select public.fn_change_user_role('$A', $WAITER);" | "${PSQL[@]}" >/tmp/race.$$.2 2>&1 &
p2=$!
wait $p1 $p2
check "exactly one active admin after the race (RPC path)" 1 "$(active_admins race-admins)"

echo "== SM6: two platform super admins deactivate each other"
S1=00000000-0000-4000-8000-0000000fb001; S2=00000000-0000-4000-8000-0000000fb002
new_user $S1 race-su1@race.example.com; new_user $S2 race-su2@race.example.com
q "insert into public.platform_admins (id, full_name, role) values ('$S1', 'Race Super 1', 'platform_super_admin'), ('$S2', 'Race Super 2', 'platform_super_admin')" >/dev/null
# the demo seed's own super admin would hide the race: park it
q "update public.platform_admins set is_active = false where id = '00000000-0000-4000-8000-0000000000c1'" >/dev/null
add_factor $S1; add_factor $S2
as_user $S1 "select public.fn_platform_set_admin_active('$S2', false, 'race test'); select pg_sleep(1.5);" | "${PSQL[@]}" >/tmp/race.$$.1 2>&1 &
p1=$!
sleep 0.4
as_user $S2 "select public.fn_platform_set_admin_active('$S1', false, 'race test');" | "${PSQL[@]}" >/tmp/race.$$.2 2>&1 &
p2=$!
wait $p1 $p2
check "exactly one active super admin after the race" 1 "$(q "select count(*) from public.platform_admins where is_active and role = 'platform_super_admin'")"
q "update public.platform_admins set is_active = true where id = '00000000-0000-4000-8000-0000000000c1'" >/dev/null

echo "== 3B: one auth user cannot become a tenant profile AND a platform admin through two concurrent transactions"
X=00000000-0000-4000-8000-0000000fe001
new_user $X race-dual@race.example.com
printf "begin;\ninsert into public.platform_admins (id, full_name, role) values ('%s', 'Dual', 'platform_support');\nselect pg_sleep(1.5);\ncommit;\n" "$X" | "${PSQL[@]}" >/tmp/race.$$.1 2>&1 &
p1=$!
sleep 0.4
printf "begin;\ninsert into public.profiles (id, restaurant_id, first_name, username, role_id, auth_method) select '%s', r.id, 'Dual', 'dual', (select id from public.roles where restaurant_id = r.id and system_key = 'tenant_admin'), 'password' from public.restaurants r where r.slug = 'race-admins';\ncommit;\n" "$X" | "${PSQL[@]}" >/tmp/race.$$.2 2>&1 &
p2=$!
wait $p1 $p2
check "the account is in exactly one portal after the race" 1 "$(q "select (select count(*) from public.platform_admins where id = '$X') + (select count(*) from public.profiles where id = '$X')")"
grep -q auth_method_mismatch /tmp/race.$$.2 && pass "the loser got auth_method_mismatch" || fail "nobody got auth_method_mismatch"

echo "== H3: closed-day guard vs concurrent day close"
CLOSE="update public.day_sessions set status = 'closed', closed_at = now(), closed_by = owner_id, order_count = 0, gross_collected = 0, cash_collected = 0, cash_expenses = 0, expenses_total = 0, expected_cash = 0, counted_cash = 0, cash_variance = 0, net_profit = 0, inventory_variance = 0, station_snapshot = '[]', expense_snapshot = '[]', payment_snapshot = '[]'"
for scenario in close_first insert_first; do
  slug="race-day-${scenario//_/-}"; owner="00000000-0000-4000-8000-0000000fc00$([ $scenario = close_first ] && echo 1 || echo 2)"
  new_tenant "$slug" "$owner" "$slug@race.example.com"
  rid="(select id from public.restaurants where slug = '$slug')"
  day="(select id from public.day_sessions where restaurant_id = $rid and status = 'open')"
  ORDER="insert into public.orders (restaurant_id, day_session_id, order_no, created_by, subtotal, vat_rate_snapshot, vat_amount, total) values ($rid, $day, 'ORD-0001', '$owner', 1, 15, 0.15, 1.15);"
  CLOSE_SQL="begin; $(echo "$CLOSE" | sed "s/owner_id/'$owner'/") where id = $day;"
  if [ $scenario = close_first ]; then
    printf "%s select pg_sleep(1.5); commit;\n" "$CLOSE_SQL" | "${PSQL[@]}" >/tmp/race.$$.1 2>&1 &
    p1=$!; sleep 0.4
    printf "%s\n" "$ORDER" | "${PSQL[@]}" >/tmp/race.$$.2 2>&1 &
    p2=$!; wait $p1 $p2
    check "insert racing a close that commits first is refused" 0 "$(q "select count(*) from public.orders where restaurant_id = $rid")"
    grep -q day_closed /tmp/race.$$.2 && pass "with day_closed" || fail "no day_closed error"
  else
    printf "begin; %s select pg_sleep(1.5); commit;\n" "$ORDER" | "${PSQL[@]}" >/tmp/race.$$.1 2>&1 &
    p1=$!; sleep 0.4
    printf "%s commit;\n" "$CLOSE_SQL" | "${PSQL[@]}" >/tmp/race.$$.2 2>&1 &
    p2=$!; wait $p1 $p2
    check "an insert that got in first is committed before the close can proceed" 1 "$(q "select count(*) from public.orders where restaurant_id = $rid")"
    check "and the close then succeeds" closed "$(q "select status from public.day_sessions where restaurant_id = $rid")"
  fi
done

echo "== SM3: 60 concurrent wrong PIN guesses"
P=00000000-0000-4000-8000-0000000fd001
new_user $P "pinrace@race-pin.staff.cafeos.invalid"
q "update auth.users set raw_app_meta_data = '{\"staff\": true}' where id = '$P'" >/dev/null
new_tenant race-pin 00000000-0000-4000-8000-0000000fd000 race-pin-owner@race.example.com
new_user 00000000-0000-4000-8000-0000000fd002 "pinrace@race-pin.staff.cafeos.invalid" 2>/dev/null
q "update auth.users set email = 'pinrace@race-pin.staff.cafeos.invalid' where id = '$P'" >/dev/null
q "insert into public.profiles (id, restaurant_id, first_name, username, role_id, auth_method)
   select '$P', r.id, 'Pin', 'pinrace', (select id from public.roles where restaurant_id = r.id and name = 'Waiter'), 'pin' from public.restaurants r where r.slug = 'race-pin'" >/dev/null
GOOD=$(printf '%s' 'x' | openssl dgst -sha256 -hex | awk '{print $2}')
WRONG=$(printf '%s' 'y' | openssl dgst -sha256 -hex | awk '{print $2}')
q "$SVC select public.fn_set_user_pin('$P', '$GOOD')" >/dev/null
for i in $(seq 1 60); do
  ( printf "begin; select set_config('request.jwt.claims', '{\"role\":\"service_role\"}', true); set local role service_role; select public.fn_verify_pin('%s', '%s'); commit;\n" "$P" "$WRONG" | "${PSQL[@]}" >/dev/null 2>&1 ) &
done
wait
check "failed_attempts after 60 concurrent wrong guesses" 3 "$(q "select failed_attempts from public.profile_secrets where profile_id = '$P'")"
check "account is locked" t "$(q "select (locked_until > now()) from public.profile_secrets where profile_id = '$P'")"
check "the right PIN is refused while locked" invalid "$(q "$SVC select public.fn_verify_pin('$P', '$GOOD') ->> 'status'" | tail -1)"
check "and the lock did not move the counter" 3 "$(q "select failed_attempts from public.profile_secrets where profile_id = '$P'")"

echo "== SS1: 20 concurrent blocked-login notifications for one user (dedupe is serialised)"
for i in $(seq 1 20); do
  ( printf "begin; select set_config('request.jwt.claims', '{\"role\":\"service_role\"}', true); set local role service_role; select public.fn_staff_login_blocked('%s'); commit;\n" "$P" | "${PSQL[@]}" >/dev/null 2>&1 ) &
done
wait
check "one notification for the user (the owner admin gets one too)" 2 "$(q "select count(*) from public.user_notifications n join public.restaurants r on r.id = n.restaurant_id where r.slug = 'race-pin'")"
check "the user's own notifications" 1 "$(q "select count(*) from public.user_notifications where recipient_id = '$P'")"
check "must_change_pin is set" t "$(q "select must_change_pin from public.profile_secrets where profile_id = '$P'")"

echo "== P4: order pipeline under concurrency"
O=00000000-0000-4000-8000-0000000fe000
new_tenant race-orders $O race-orders@race.example.com
RID="(select id from public.restaurants where slug = 'race-orders')"
q "do \$x\$
declare
  v_rid uuid := (select id from public.restaurants where slug = 'race-orders');
  v_day uuid := (select id from public.day_sessions where restaurant_id = v_rid and status = 'open');
  v_st uuid := (select id from public.stations where restaurant_id = v_rid and name = 'Kitchen');
  v_cat uuid := (select id from public.categories where restaurant_id = v_rid and name = 'Lunch');
  v_lo uuid; v_hi uuid;
begin
  insert into public.ingredients (restaurant_id, name, station_id, unit, stock, opening_stock) values
    (v_rid, 'Race A', v_st, 'pcs', 1000, 1000), (v_rid, 'Race B', v_st, 'pcs', 1000, 1000), (v_rid, 'Race Last', v_st, 'pcs', 1, 1);
  insert into public.stock_movements (restaurant_id, ingredient_id, station_id, qty_delta, reason, day_session_id)
  select v_rid, i.id, v_st, i.stock, 'opening', v_day from public.ingredients i where i.restaurant_id = v_rid;
  select (array_agg(id order by id))[1], (array_agg(id order by id desc))[1] into v_lo, v_hi from public.ingredients where restaurant_id = v_rid and name in ('Race A', 'Race B');
  insert into public.menu_items (restaurant_id, name, category_id, station_id, price) values
    (v_rid, 'Race P', v_cat, v_st, 10), (v_rid, 'Race Q', v_cat, v_st, 20), (v_rid, 'Race Last', v_cat, v_st, 30);
  -- P consumes the HIGHER ingredient id, Q the LOWER one: a cart [P, Q] and a cart [Q, P] would lock in opposite order line by line
  insert into public.recipe_lines (restaurant_id, menu_item_id, ingredient_id, qty_per_serving)
  select v_rid, (select id from public.menu_items where restaurant_id = v_rid and name = 'Race P'), v_hi, 1
  union all select v_rid, (select id from public.menu_items where restaurant_id = v_rid and name = 'Race Q'), v_lo, 1
  union all select v_rid, (select id from public.menu_items where restaurant_id = v_rid and name = 'Race Last'),
                   (select id from public.ingredients where restaurant_id = v_rid and name = 'Race Last'), 1;
end \$x\$" >/dev/null
item() { q "select id from public.menu_items where restaurant_id = $RID and name = '$1'"; }
P_ID=$(item 'Race P'); Q_ID=$(item 'Race Q'); L_ID=$(item 'Race Last')
LEDGER_GAP="select count(*) from public.ingredients i where i.restaurant_id = $RID and i.stock <> (select coalesce(sum(m.qty_delta), 0) from public.stock_movements m where m.ingredient_id = i.id)"

for i in $(seq 1 8); do
  ( as_user $O "select public.fn_submit_order('[{\"menu_item_id\": \"$L_ID\", \"qty\": 1}]', 'race-last-unit-000$i');" | "${PSQL[@]}" >/tmp/race.$$.last.$i 2>&1 ) &
done
wait
check "8 submits racing for the last unit: exactly one order" 1 "$(q "select count(*) from public.order_items where restaurant_id = $RID and menu_item_id = '$L_ID'")"
check "the other 7 got insufficient_stock" 7 "$(grep -l insufficient_stock /tmp/race.$$.last.* | wc -l)"
check "stock is exactly 0, never negative" 0.000 "$(q "select stock from public.ingredients where restaurant_id = $RID and name = 'Race Last'")"
check "ledger consistent" 0 "$(q "$LEDGER_GAP")"

for i in $(seq 1 10); do
  ( as_user $O "select public.fn_submit_order('[{\"menu_item_id\": \"$P_ID\", \"qty\": 2}]', 'race-same-key-0001') ->> 'id';" | "${PSQL[@]}" >/tmp/race.$$.key.$i 2>&1 ) &
done
wait
check "10 concurrent retries of one idempotency key: exactly one order" 1 "$(q "select count(*) from public.orders where restaurant_id = $RID and client_key = 'race-same-key-0001'")"
check "every retry got that same order id" 1 "$(cat /tmp/race.$$.key.* | grep -E '^[0-9a-f-]{36}$' | sort -u | wc -l | tr -d ' ')"
check "and none failed" 0 "$(cat /tmp/race.$$.key.* | grep -c ERROR)"
check "stock consumed once (2 units)" 2 "$(q "select -sum(m.qty_delta)::int from public.stock_movements m join public.orders o on o.id = m.order_id where o.client_key = 'race-same-key-0001'")"

BEFORE=$(q "select count(*) from public.orders where restaurant_id = $RID")
for i in $(seq 1 10); do
  ( as_user $O "select public.fn_submit_order('[{\"menu_item_id\": \"$P_ID\", \"qty\": 1}, {\"menu_item_id\": \"$Q_ID\", \"qty\": 1}]', 'race-pq-00000$i');" | "${PSQL[@]}" >/tmp/race.$$.pq.$i 2>&1 ) &
  ( as_user $O "select public.fn_submit_order('[{\"menu_item_id\": \"$Q_ID\", \"qty\": 1}, {\"menu_item_id\": \"$P_ID\", \"qty\": 1}]', 'race-qp-00000$i');" | "${PSQL[@]}" >/tmp/race.$$.qp.$i 2>&1 ) &
  ( as_user $O "select public.fn_receive_stock((select id from public.ingredients where restaurant_id = $RID and name = 'Race A'), 1, 'race-recv-a-000$i'); select public.fn_receive_stock((select id from public.ingredients where restaurant_id = $RID and name = 'Race B'), 1, 'race-recv-b-000$i');" | "${PSQL[@]}" >/tmp/race.$$.rcv.$i 2>&1 ) &
done
wait
check "20 submits with opposite line order + 20 receipts: no deadlock" 0 "$(cat /tmp/race.$$.pq.* /tmp/race.$$.qp.* /tmp/race.$$.rcv.* | grep -ci deadlock)"
check "no error at all" 0 "$(cat /tmp/race.$$.pq.* /tmp/race.$$.qp.* /tmp/race.$$.rcv.* | grep -c ERROR)"
check "all 20 orders created" 20 "$(( $(q "select count(*) from public.orders where restaurant_id = $RID") - BEFORE ))"
check "ledger consistent after the mix" 0 "$(q "$LEDGER_GAP")"
check "Race A + Race B = 2000 - 2 (same-key order) - 40 (20 carts x 2 lines) + 20 received" 1978.000 "$(q "select sum(stock) from public.ingredients where restaurant_id = $RID and name in ('Race A', 'Race B')")"

KIT="(select id from public.stations where restaurant_id = $RID and name = 'Kitchen')"
for scenario in start_first cancel_first; do
  OID=$(as_user $O "select public.fn_submit_order('[{\"menu_item_id\": \"$Q_ID\", \"qty\": 1}]', 'race-cvs-$scenario') ->> 'id';" | "${PSQL[@]}" | grep -E '^[0-9a-f-]{36}$')
  START="select public.fn_set_station_items_status('$OID', $KIT, 'preparing');"
  CANCEL="select public.fn_cancel_order('$OID');"
  if [ $scenario = start_first ]; then FIRST="$START"; SECOND="$CANCEL"; else FIRST="$CANCEL"; SECOND="$START"; fi
  as_user $O "$FIRST select pg_sleep(1.5);" | "${PSQL[@]}" >/tmp/race.$$.1 2>&1 &
  p1=$!; sleep 0.4
  as_user $O "$SECOND" | "${PSQL[@]}" >/tmp/race.$$.2 2>&1 &
  p2=$!; wait $p1 $p2
  if [ $scenario = start_first ]; then
    check "start then cancel: order stays preparing" preparing "$(q "select status from public.orders where id = '$OID'")"
    grep -q order_not_cancellable /tmp/race.$$.2 && pass "the late cancel got order_not_cancellable" || fail "late cancel: $(cat /tmp/race.$$.2)"
    check "no reversal was written" 0 "$(q "select count(*) from public.stock_movements where order_id = '$OID' and reason = 'reversal'")"
  else
    check "cancel then start: order stays cancelled" cancelled "$(q "select status from public.orders where id = '$OID'")"
    grep -q invalid_state_transition /tmp/race.$$.2 && pass "the late start got invalid_state_transition" || fail "late start: $(cat /tmp/race.$$.2)"
    check "the consumption was reversed exactly once" 1 "$(q "select count(*) from public.stock_movements where order_id = '$OID' and reason = 'reversal'")"
  fi
done
check "ledger consistent at the end" 0 "$(q "$LEDGER_GAP")"

rm -f /tmp/race.$$.*
if [ "$FAILS" -ne 0 ]; then echo "race tests: $FAILS failure(s)"; exit 1; fi
echo "race tests: all passed"
