-- 0028  aal2 needs a LIVE authenticator: fn_require_aal2() also requires a verified factor row (finding L1)
--
--  Problem: fn_require_aal2() (0026, 0027) trusts the JWT's aal claim. An access token is signed and self-contained, so a token
--  issued at aal2 keeps saying aal2 until it expires (jwt_expiry, 1 hour) even after the authenticator behind it was removed
--  (auth.mfa.unenroll from another session). Every other live token of that account therefore still passed: PIN-change
--  approvals and session-timer writes worked for up to an hour with no authenticator left on the account.
--
--  Fix (server side, authoritative): besides  aal = 'aal2'  and  a profile (id = auth.uid()) with auth_method <> 'pin'  (0027),
--  fn_require_aal2() requires that auth.uid() CURRENTLY owns a verified factor in auth.mfa_factors. The factor predicate is exactly
--  the one fn_require_step_up() (0015) and fn_platform_mfa_satisfied() use: user_id = auth.uid() and status = 'verified' (no
--  factor_type filter there, none here). Removing the last verified factor therefore takes effect on the very next call, whatever
--  the token says. It fails closed: no caller, no factor, an unverified leftover or somebody else's factor all raise the SAME
--  P0001 'mfa_required' as before (no new error code, no new detail).
--
--  Unchanged: signature, STABLE, SECURITY DEFINER, empty search_path, ACL (no client EXECUTE), the two callers
--  (fn_decide_pin_change behind fn_approve_pin_change / fn_reject_pin_change, fn_store_session_timers behind
--  fn_update_session_timers / fn_reset_session_timers) and their check order tenant guard -> permission -> aal2 -> validation,
--  so an aal1 / PIN / factor-less caller still learns nothing about ids or input validity. fn_require_step_up() is untouched.
--
--  Not covered (inherent; see auth-flows.md, Residual risks): a token issued at aal2 stays aal2 for as long as a verified factor
--  exists, until it expires. The check proves the account still HAS an authenticator, not that this particular token used it.

create or replace function public.fn_require_aal2()
returns void
language plpgsql stable security definer set search_path = ''
as $$
begin
  if coalesce((select auth.jwt()) ->> 'aal', '') <> 'aal2'
     or not exists (select 1 from public.profiles p
                    where p.id = (select auth.uid()) and p.auth_method <> 'pin')
     or not exists (select 1 from auth.mfa_factors f
                    where f.user_id = (select auth.uid()) and f.status = 'verified') then
    perform public.fn_err('mfa_required');
  end if;
end;
$$;
revoke all on function public.fn_require_aal2() from public, anon, authenticated;
