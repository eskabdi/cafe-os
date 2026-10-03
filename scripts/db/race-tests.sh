#!/usr/bin/env bash
# Concurrency tests that pgTAP (one session per file) cannot express: real concurrent psql sessions against the
# throwaway cluster started by scripts/db-test.sh (run after both pgTAP passes; invoked by db-test.sh unless --no-race).
#   * last tenant_admin: two admins deactivate each other at the same time            (H2)  -> exactly 1 active admin
#   * same race through fn_change_user_role (demotion)                                  (H2)
#   * last platform_super_admin: two super admins deactivate each other                 (SM6)
#   * closed-day guard vs fn_close_day-style UPDATE, both orders of arrival             (H3)
#   * 60 concurrent wrong PIN guesses against one account                               (SM3) -> failed_attempts stays 3
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
as_user() { # uid sql...  -> a transaction that runs as the authenticated user, with the statements given
  local uid="$1"; shift
  printf "begin;\nselect set_config('app.platform_mfa_required', 'off', true);\nselect set_config('request.jwt.claims', '{\"sub\":\"%s\",\"role\":\"authenticated\"}', true);\nset local role authenticated;\n%s\ncommit;\n" "$uid" "$*"
}
active_admins() { q "select count(*) from public.profiles p join public.roles r on r.id = p.role_id and r.restaurant_id = p.restaurant_id join public.restaurants x on x.id = p.restaurant_id where x.slug = '$1' and p.is_active and r.system_key = 'tenant_admin'"; }

echo "== H2: two admins deactivate each other concurrently"
A=00000000-0000-4000-8000-0000000fa001; B=00000000-0000-4000-8000-0000000fa002
new_tenant race-admins $A race-a@race.example.com
new_user $B race-b@race.example.com
q "insert into public.profiles (id, restaurant_id, first_name, username, role_id, auth_method)
   select '$B', r.id, 'Second', 'second', (select id from public.roles where restaurant_id = r.id and system_key = 'tenant_admin'), 'password' from public.restaurants r where r.slug = 'race-admins'" >/dev/null
check "two active admins before" 2 "$(active_admins race-admins)"
as_user $A "update public.profiles set is_active = false where id = '$B'; select pg_sleep(1.5);" | "${PSQL[@]}" >/tmp/race.$$.1 2>&1 &
p1=$!
sleep 0.4
as_user $B "update public.profiles set is_active = false where id = '$A';" | "${PSQL[@]}" >/tmp/race.$$.2 2>&1 &
p2=$!
wait $p1 $p2
check "exactly one active admin after the race (trigger path)" 1 "$(active_admins race-admins)"
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
as_user $S1 "update public.platform_admins set is_active = false where id = '$S2'; select pg_sleep(1.5);" | "${PSQL[@]}" >/tmp/race.$$.1 2>&1 &
p1=$!
sleep 0.4
as_user $S2 "update public.platform_admins set is_active = false where id = '$S1';" | "${PSQL[@]}" >/tmp/race.$$.2 2>&1 &
p2=$!
wait $p1 $p2
check "exactly one active super admin after the race" 1 "$(q "select count(*) from public.platform_admins where is_active and role = 'platform_super_admin'")"
q "update public.platform_admins set is_active = true where id = '00000000-0000-4000-8000-0000000000c1'" >/dev/null

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

rm -f /tmp/race.$$.*
if [ "$FAILS" -ne 0 ]; then echo "race tests: $FAILS failure(s)"; exit 1; fi
echo "race tests: all passed"
