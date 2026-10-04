-- 0027  aal2 is not enough for a PIN account: fn_require_aal2() also refuses auth_method = 'pin' (finding H1)
--
--  Problem: a PIN staff member holds a REAL GoTrue session, so they can call auth.mfa.enroll / challengeAndVerify directly,
--  reach aal2 and then pass fn_require_aal2() (0026). A PIN-only delegate holding users.manage or settings.session_timers could
--  thereby approve/reject PIN changes or edit the session timers, which 0026 meant to reserve for a real authenticator.
--
--  Fix (server side, authoritative): fn_require_aal2() raises the SAME P0001 'mfa_required' when the caller's profile
--  (id = auth.uid()) has auth_method = 'pin', whatever the JWT says. It also fails closed when there is no profile row
--  (no caller, a platform admin without a tenant profile, a deleted profile). The password/tenant_admin path is unchanged:
--  aal = 'aal2' passes. Same error shape, same position in every caller (tenant guard -> permission -> aal2 -> validation),
--  so aal1 and PIN callers learn nothing extra. No grant change: still no client EXECUTE. fn_require_step_up() is untouched.

create or replace function public.fn_require_aal2()
returns void
language plpgsql stable security definer set search_path = ''
as $$
begin
  if coalesce((select auth.jwt()) ->> 'aal', '') <> 'aal2'
     or not exists (select 1 from public.profiles p
                    where p.id = (select auth.uid()) and p.auth_method <> 'pin') then
    perform public.fn_err('mfa_required');
  end if;
end;
$$;
revoke all on function public.fn_require_aal2() from public, anon, authenticated;
