-- Runs last (sorted): removes the helper schema that 00_helpers.test.sql committed, so a `supabase test db`
-- run leaves nothing behind in the local database. See the header of 00_helpers.test.sql.
begin;
select plan(1);
drop schema if exists tests cascade;
select hasnt_schema('tests', 'test helper schema removed');
select * from finish();
commit;
