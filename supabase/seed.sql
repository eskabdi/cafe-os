-- CafeOS demo seed (Central Cafe) — DEMO / DEV ONLY. Never run against production.
--
-- DEMO CREDENTIALS
--   Admin identities (Supabase Auth email + password; PIN login is NOT available to them):
--     platform super admin   admin@cafeos.example.com
--     central-cafe owners    selam@centralcafe.example.com, dawit@centralcafe.example.com
--     second-cafe owner      owner@secondcafe.example.com
--     DEMO-ONLY password for all four: DemoAdmin#2026   (never use outside local/dev)
--   Staff (non-admin roles) sign in by PIN, verified server-side (profile_secrets + fn_verify_pin).
--     Their auth.users rows use synthetic non-routable emails <username>@<slug>.staff.cafeos.invalid and
--     random unusable passwords; profiles.auth_method = 'pin'.
--     central-cafe: hanna=3456 (cashier) yonas=4567 / meron=5678 (waiters) abebe=6789 (kitchen)
--                   sara=7890 (pastry) kalkidan=1111 (bar)
--     second-cafe:  waiter=2222   (exists for tenant-isolation tests)
--   demo QR tokens (hash stored, raw value only here): `demo-<table label lowercase>`, e.g. demo-t01
-- Names below are DATA: no application code depends on them. Safe to re-run (idempotent).

-- act as the service role for the duration of the seed (fn_provision_tenant / fn_set_user_pin require it)
select set_config('request.jwt.claims', '{"role":"service_role"}', false);

-- ── platform plans & admin ──
insert into public.plans (name, price_etb_monthly, max_staff, max_menu_items, features) values
  ('Starter', 990, 8, 60,  '{"installments": false, "multi_station": false}'),
  ('Growth',  2490, 25, 250, '{"installments": true, "multi_station": true}'),
  ('Pro',     4990, null, null, '{"installments": true, "multi_station": true}')
on conflict (name) do nothing;

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, confirmation_token, recovery_token,
                        email_change_token_new, email_change)
select '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', u.email,
       case when u.demo_password then extensions.crypt('DemoAdmin#2026', extensions.gen_salt('bf'))
            else extensions.crypt(gen_random_uuid()::text, extensions.gen_salt('bf')) end,
       now(), '{"provider":"email","providers":["email"]}', '{}', '', '', '', ''
from (values
  ('00000000-0000-4000-8000-0000000000c1'::uuid, 'admin@cafeos.example.com', true),
  ('00000000-0000-4000-8000-0000000000a1'::uuid, 'selam@centralcafe.example.com', true),
  ('00000000-0000-4000-8000-0000000000a2'::uuid, 'dawit@centralcafe.example.com', true),
  ('00000000-0000-4000-8000-0000000000a3'::uuid, 'hanna@central-cafe.staff.cafeos.invalid', false),
  ('00000000-0000-4000-8000-0000000000a4'::uuid, 'yonas@central-cafe.staff.cafeos.invalid', false),
  ('00000000-0000-4000-8000-0000000000a5'::uuid, 'meron@central-cafe.staff.cafeos.invalid', false),
  ('00000000-0000-4000-8000-0000000000a6'::uuid, 'abebe@central-cafe.staff.cafeos.invalid', false),
  ('00000000-0000-4000-8000-0000000000a7'::uuid, 'sara@central-cafe.staff.cafeos.invalid', false),
  ('00000000-0000-4000-8000-0000000000a8'::uuid, 'kalkidan@central-cafe.staff.cafeos.invalid', false),
  ('00000000-0000-4000-8000-0000000000b1'::uuid, 'owner@secondcafe.example.com', true),
  ('00000000-0000-4000-8000-0000000000b2'::uuid, 'waiter@second-cafe.staff.cafeos.invalid', false)
) u(id, email, demo_password)
on conflict (id) do nothing;

insert into public.platform_admins (id, full_name, role)
values ('00000000-0000-4000-8000-0000000000c1', 'Platform Admin', 'platform_super_admin')
on conflict (id) do nothing;

-- ═════════ Tenant 1: Central Cafe ═════════
do $seed$
declare
  v_plan uuid := (select id from public.plans where name = 'Growth');
  v_rid uuid;
  v_day uuid;
  v_role uuid;
begin
  if exists (select 1 from public.restaurants where slug = 'central-cafe') then
    return;
  end if;

  perform public.fn_provision_tenant('Central Cafe', 'central-cafe', '00000000-0000-4000-8000-0000000000a1',
                                     'selam@centralcafe.example.com', 'Selam', 'Abate', 'Girma', v_plan, 'selam');
  select id into v_rid from public.restaurants where slug = 'central-cafe';
  update public.restaurants set phone = '+251 11 467 2299', address = 'Bole Medhanialem, Addis Ababa',
         tin = '0032918475', vat_rate = 15, opening_float = 2500, auto_consume_stock = true,
         status = 'active'
   where id = v_rid;
  update public.subscriptions set status = 'active' where restaurant_id = v_rid;
  update public.day_sessions set opening_float = 2500 where restaurant_id = v_rid and status = 'open'
  returning id into v_day;

  -- staff (prototype manager collapses into tenant_admin)
  insert into public.profiles (id, restaurant_id, first_name, middle_name, last_name, username, role_id, auth_method)
  select s.id, v_rid, s.first, s.middle, s.last, s.username, r.id, case when s.role_name = 'Administrator' then 'password' else 'pin' end
  from (values
    ('00000000-0000-4000-8000-0000000000a2'::uuid, 'Dawit',    'Kebede',  'Haile',   'dawit',    'Administrator'),
    ('00000000-0000-4000-8000-0000000000a3'::uuid, 'Hanna',    'Girma',   'Tesfaye', 'hanna',    'Cashier'),
    ('00000000-0000-4000-8000-0000000000a4'::uuid, 'Yonas',    'Tesfaye', 'Bekele',  'yonas',    'Waiter'),
    ('00000000-0000-4000-8000-0000000000a5'::uuid, 'Meron',    'Alemu',   'Tadesse', 'meron',    'Waiter'),
    ('00000000-0000-4000-8000-0000000000a6'::uuid, 'Abebe',    'Worku',   'Mekonnen','abebe',    'Kitchen'),
    ('00000000-0000-4000-8000-0000000000a7'::uuid, 'Sara',     'Bekele',  'Assefa',  'sara',     'Pastry'),
    ('00000000-0000-4000-8000-0000000000a8'::uuid, 'Kalkidan', 'Haile',   'Desta',   'kalkidan', 'Bar')
  ) s(id, first, middle, last, username, role_name)
  join public.roles r on r.restaurant_id = v_rid and r.name = s.role_name;

  perform public.fn_set_user_pin(s.id, s.pin)
  from (values
    ('00000000-0000-4000-8000-0000000000a3'::uuid, '3456'), ('00000000-0000-4000-8000-0000000000a4'::uuid, '4567'),
    ('00000000-0000-4000-8000-0000000000a5'::uuid, '5678'), ('00000000-0000-4000-8000-0000000000a6'::uuid, '6789'),
    ('00000000-0000-4000-8000-0000000000a7'::uuid, '7890'), ('00000000-0000-4000-8000-0000000000a8'::uuid, '1111')
  ) s(id, pin);

  -- prototype seedMenu / seedIng / seedRecipes (keys are local to this seed only)
  create temp table _m (k text, name text, cat text, station text, price numeric, emoji text, descr text) on commit drop;
  insert into _m values
    ('m1','Doro Wat','Lunch','Kitchen',420,'🍲','Slow-cooked spicy chicken stew with berbere, niter kibbeh and a boiled egg, served with injera.'),
    ('m2','Kitfo','Lunch','Kitchen',480,'🥩','Finely minced beef with mitmita and niter kibbeh, served with ayib and gomen.'),
    ('m3','Shiro Wat','Lunch','Kitchen',220,'🍛','Smooth spiced chickpea stew finished with berbere oil, served with injera.'),
    ('m4','Tibs','Lunch','Kitchen',390,'🍖','Sautéed beef with rosemary, onion, jalapeño and tomato.'),
    ('m5','Beyaynetu','Lunch','Kitchen',260,'🥗','Fasting platter of shiro, gomen, lentils and salad on injera.'),
    ('m6','Foto','Breakfast','Kitchen',180,'🥣','Cracked barley cooked in berbere butter with eggs and yogurt.'),
    ('m7','Chechebsa','Breakfast','Kitchen',165,'🫓','Torn flatbread sautéed in niter kibbeh and berbere, topped with ayib.'),
    ('m8','Enkulal Firfir','Breakfast','Kitchen',175,'🍳','Scrambled eggs with onion, tomato and shredded injera.'),
    ('m9','Chicken Burger','Fast Food','Kitchen',280,'🍔','Crispy chicken fillet, lettuce, tomato and house sauce in a brioche bun with fries.'),
    ('m10','Club Sandwich','Fast Food','Kitchen',240,'🥪','Triple-decker with chicken, egg, cheese and fries.'),
    ('m11','French Fries','Fast Food','Kitchen',120,'🍟','Golden hand-cut fries with ketchup and green chili.'),
    ('m12','Meat Pizza','Fast Food','Kitchen',340,'🍕','Thin-crust pizza with spiced minced beef, mozzarella and peppers.'),
    ('m13','Butter Croissant','Breakfast','Pastry',95,'🥐','Flaky all-butter croissant baked in-house every morning.'),
    ('m14','Blueberry Muffin','Breakfast','Pastry',110,'🧁','Soft muffin loaded with blueberries and a crumb top.'),
    ('m15','Chocolate Cake','Fast Food','Pastry',160,'🍰','Dark chocolate layer cake with ganache.'),
    ('m16','Cheesecake','Fast Food','Pastry',190,'🍰','New York style cheesecake with berry compote.'),
    ('m17','Macchiato','Beverages','Bar',70,'☕','Espresso layered with steamed milk — the Addis classic.'),
    ('m18','Jebena Buna','Beverages','Bar',60,'☕','Traditional Ethiopian coffee brewed in a jebena, served with popcorn.'),
    ('m19','Avocado Juice','Beverages','Bar',150,'🥑','Thick avocado smoothie layered with mango and lime.'),
    ('m20','Mango Splash','Beverages','Bar',130,'🥭','Fresh pressed mango with sparkling water and mint.'),
    ('m21','Spiced Tea','Beverages','Bar',45,'🫖','Black tea with cardamom, clove and cinnamon.'),
    ('m22','Soft Drink','Beverages','Bar',55,'🥤','Chilled 330ml can — cola, orange or lemon.');

  create temp table _g (k text, name text, station text, unit text, stock numeric, min numeric, cost numeric) on commit drop;
  insert into _g values
    ('g1','Onion','Kitchen','kg',42,12,65),('g2','Chicken','Kitchen','kg',18,8,320),
    ('g3','Beef (mince)','Kitchen','kg',12,6,540),('g4','Berbere','Kitchen','kg',6.5,3,480),
    ('g5','Niter Kibbeh','Kitchen','kg',8,4,390),('g6','Tomato','Kitchen','kg',22,10,70),
    ('g7','Injera','Kitchen','pcs',240,80,12),('g8','Shiro flour','Kitchen','kg',15,6,180),
    ('g9','Eggs','Kitchen','pcs',90,40,14),('g10','Cooking oil','Kitchen','L',20,8,175),
    ('g11','Potato','Kitchen','kg',26,10,45),('g12','Cheese','Kitchen','kg',5.2,3,620),
    ('g13','Chicken breast','Kitchen','kg',9,5,420),('g14','Burger buns','Kitchen','pcs',48,24,22),
    ('g15','Pizza base','Kitchen','pcs',20,10,45),('g16','Barley','Kitchen','kg',7,4,90),
    ('g17','Flour','Pastry','kg',25,10,78),('g18','Butter','Pastry','kg',9,4,620),
    ('g19','Sugar','Pastry','kg',14,6,95),('g20','Eggs (pastry)','Pastry','pcs',60,30,14),
    ('g21','Cocoa','Pastry','kg',2.4,2,780),('g22','Cream cheese','Pastry','kg',3.5,2,890),
    ('g23','Blueberries','Pastry','kg',1.2,1.5,640),
    ('g24','Coffee beans','Bar','kg',8,4,720),('g25','Milk','Bar','L',24,12,85),
    ('g26','Avocado','Bar','kg',6,4,140),('g27','Mango','Bar','kg',5,4,120),
    ('g28','Tea leaves','Bar','kg',2.2,1.5,380),('g29','Soft drinks','Bar','pcs',64,36,38),
    ('g30','Sparkling water','Bar','pcs',30,24,32);

  create temp table _r (m text, g text, qty numeric) on commit drop;
  insert into _r values
    ('m1','g1',0.35),('m1','g2',0.45),('m1','g4',0.06),('m1','g5',0.05),('m1','g6',0.2),('m1','g7',2),('m1','g9',1),
    ('m2','g3',0.28),('m2','g5',0.04),('m2','g12',0.06),('m2','g1',0.1),
    ('m3','g8',0.18),('m3','g1',0.15),('m3','g4',0.03),('m3','g10',0.04),('m3','g7',2),
    ('m4','g3',0.3),('m4','g1',0.2),('m4','g6',0.15),('m4','g10',0.05),
    ('m5','g8',0.15),('m5','g1',0.12),('m5','g6',0.12),('m5','g10',0.03),('m5','g7',2),
    ('m6','g16',0.2),('m6','g5',0.05),('m6','g9',2),('m6','g4',0.02),
    ('m7','g7',1),('m7','g5',0.05),('m7','g4',0.03),('m7','g12',0.06),
    ('m8','g9',3),('m8','g1',0.12),('m8','g6',0.1),('m8','g7',1),('m8','g10',0.03),
    ('m9','g13',0.18),('m9','g14',1),('m9','g11',0.25),('m9','g12',0.04),('m9','g6',0.05),('m9','g10',0.15),
    ('m10','g14',2),('m10','g13',0.12),('m10','g9',1),('m10','g12',0.05),('m10','g11',0.2),
    ('m11','g11',0.35),('m11','g10',0.18),
    ('m12','g15',1),('m12','g3',0.15),('m12','g12',0.1),('m12','g6',0.1),
    ('m13','g17',0.09),('m13','g18',0.06),('m13','g19',0.01),
    ('m14','g17',0.08),('m14','g18',0.03),('m14','g19',0.04),('m14','g20',1),('m14','g23',0.03),
    ('m15','g17',0.06),('m15','g21',0.03),('m15','g19',0.05),('m15','g20',2),('m15','g18',0.04),
    ('m16','g22',0.14),('m16','g19',0.04),('m16','g20',1),('m16','g17',0.03),
    ('m17','g24',0.018),('m17','g25',0.16),('m18','g24',0.022),
    ('m19','g26',0.35),('m19','g27',0.18),('m19','g25',0.08),
    ('m20','g27',0.4),('m20','g30',1),('m21','g28',0.012),('m22','g29',1);

  insert into public.menu_items (restaurant_id, name, description, category_id, station_id, price, emoji, sort_order)
  select v_rid, m.name, m.descr, c.id, s.id, m.price, m.emoji, row_number() over (order by substring(m.k from 2)::int)::int * 10
  from _m m
  join public.categories c on c.restaurant_id = v_rid and c.name = m.cat
  join public.stations s on s.restaurant_id = v_rid and s.name = m.station;

  insert into public.ingredients (restaurant_id, name, station_id, unit, stock, min_level, cost_per_unit, opening_stock)
  select v_rid, g.name, s.id, g.unit, g.stock, g.min, g.cost, g.stock
  from _g g join public.stations s on s.restaurant_id = v_rid and s.name = g.station;

  insert into public.stock_movements (restaurant_id, ingredient_id, station_id, qty_delta, reason, note, day_session_id)
  select v_rid, i.id, i.station_id, i.stock, 'opening', 'Seed opening stock', v_day
  from public.ingredients i where i.restaurant_id = v_rid and i.stock > 0;

  insert into public.recipe_lines (restaurant_id, menu_item_id, ingredient_id, qty_per_serving)
  select v_rid, mi.id, ig.id, r.qty
  from _r r
  join _m m on m.k = r.m join public.menu_items mi on mi.restaurant_id = v_rid and mi.name = m.name
  join _g g on g.k = r.g join public.ingredients ig on ig.restaurant_id = v_rid and ig.name = g.name;

  -- tables (prototype seedTables): Main Hall 6, Terrace 4, VIP 2
  insert into public.tables (restaurant_id, table_area_id, label, capacity, sort_order)
  select v_rid, a.id, t.label, t.cap, t.ord
  from (values
    ('Main Hall','T01',4,1),('Main Hall','T02',2,2),('Main Hall','T03',2,3),('Main Hall','T04',4,4),
    ('Main Hall','T05',2,5),('Main Hall','T06',2,6),
    ('Terrace','T07',4,7),('Terrace','T08',2,8),('Terrace','T09',2,9),('Terrace','T10',4,10),
    ('VIP','V01',6,11),('VIP','V02',6,12)
  ) t(area, label, cap, ord)
  join public.table_areas a on a.restaurant_id = v_rid and a.name = t.area;

  -- QR credentials for every other table (prototype seedQr); only the sha256 of the token is stored
  insert into public.qr_credentials (restaurant_id, table_id, token_hash, issued_by)
  select v_rid, t.id, encode(sha256(convert_to('demo-' || lower(t.label), 'UTF8')), 'hex'),
         '00000000-0000-4000-8000-0000000000a2'
  from public.tables t
  where t.restaurant_id = v_rid and t.label in ('T01','T03','T05','T07','T09','V01');
end
$seed$;

-- ═════════ Tenant 2: minimal, for isolation tests ═════════
do $seed$
declare
  v_plan uuid := (select id from public.plans where name = 'Starter');
  v_rid uuid;
begin
  if exists (select 1 from public.restaurants where slug = 'second-cafe') then
    return;
  end if;
  perform public.fn_provision_tenant('Second Cafe', 'second-cafe', '00000000-0000-4000-8000-0000000000b1',
                                     'owner@secondcafe.example.com', 'Mulu', 'Alem', 'Negash', v_plan, 'owner');
  select id into v_rid from public.restaurants where slug = 'second-cafe';
  update public.restaurants set status = 'active' where id = v_rid;
  update public.subscriptions set status = 'active' where restaurant_id = v_rid;

  insert into public.profiles (id, restaurant_id, first_name, middle_name, last_name, username, role_id, auth_method)
  select '00000000-0000-4000-8000-0000000000b2', v_rid, 'Tigist', 'Bekele', null, 'waiter', r.id, 'pin'
  from public.roles r where r.restaurant_id = v_rid and r.name = 'Waiter';

  perform public.fn_set_user_pin('00000000-0000-4000-8000-0000000000b2', '2222');

  insert into public.menu_items (restaurant_id, name, category_id, station_id, price)
  select v_rid, 'Second Cafe Special', c.id, s.id, 100
  from public.categories c, public.stations s
  where c.restaurant_id = v_rid and c.name = 'Lunch' and s.restaurant_id = v_rid and s.name = 'Kitchen';

  insert into public.tables (restaurant_id, table_area_id, label, capacity)
  select v_rid, a.id, 'B01', 2 from public.table_areas a where a.restaurant_id = v_rid and a.name = 'Main Hall';
end
$seed$;

select set_config('request.jwt.claims', '', false);
