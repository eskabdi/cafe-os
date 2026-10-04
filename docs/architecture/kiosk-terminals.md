# Kiosk terminals (shared floor device with staff tiles)

User decision (2026-10-03): the shared floor terminal shows **tiles of the staff**, but only on **registered kiosk devices** (not an open roster by
link). Tenant = `<slug>.cafeos.et`; the device additionally holds a secret token issued by a tenant admin.

## Flow
1. A user with `kiosks.manage` (tenant_admin always; grantable in the role matrix) calls `fn_register_kiosk(name)` while signed in on the tenant host.
   The RPC returns `{id, name, token}`: the **raw token exists only in this response**. The DB stores `sha256(token)` (`kiosk_devices.token_hash`,
   no client grant, stripped from audit rows). Token = 32 random bytes as 64 hex characters. Max 25 active kiosks per tenant.
2. The admin registers and sets the device up from **Settings > Terminals** (see UI flow below). The device keeps the token in origin-scoped storage.
3. The kiosk page calls `staff-roster` with `{restaurant_slug (from the hostname), kiosk_token}`. The service role resolves hash -> kiosk (not revoked) ->
   tenant, requires the tenant's slug to equal the claimed one and the tenant not to be suspended/cancelled, refreshes `last_seen_at` (throttled
   1/min, not audited) and returns `{staff: [tiles], pin_pad_idle_seconds}`: tiles = `id`, short name (first + middle), role label, colour, icon; `pin_pad_idle_seconds` =
   the tenant's PIN-pad idle timer (0025, integer 15..300, default 60). Any failure = the same `401 invalid_kiosk`.
4. A tile tap + 4-digit PIN goes to `pin-login` (tile path: `{restaurant_slug, kiosk_token, profile_id, pin}`). The DB re-validates kiosk and profile
   (`fn_kiosk_tile_eligible`) and `fn_verify_pin` verifies the peppered digest; same lockout (3/6/9) and the same generic 401 as every other failure.
5. Revocation: `fn_revoke_kiosk(id)` (idempotent, audited, tenant-scoped; foreign and unknown ids both `not_found`). It takes effect on the next call:
   the token stops resolving. `fn_list_kiosks()` shows name, created_by, created_at, last_seen_at, revoked_at (never a token or hash).
   Registration/revocation are blocked for suspended and past_due tenants like every write.

## Who appears on tiles (no role-name literal)
Active staff with `auth_method = 'pin'`, an active non-admin role, no pending identity rotation, and `profile_secrets.pin_length = 4`. Consequently the
**6-digit Cashier never appears** (the Cashier signs in with username + 6-digit PIN on any device) and admins/platform admins never appear.
Tiles never carry username, email, secrets or permissions. A tenant that gives a Cashier-like duty to a 4-digit role does show that role's staff.

## Threat model
| threat | control / residual |
|---|---|
| Roster scraping from the internet | needs a registered token (256-bit) + matching slug; no token => identical 401; per-IP and per-IP+slug throttling; `no-store`, `noindex` |
| Stolen / copied token | the thief sees first-name tiles of 4-digit staff and can attempt PINs through the tile path. Mitigations: admins revoke instantly; `last_seen_at` shows unexpected devices; PIN lockout 3/6/9 applies per account; tokens are per tenant. **Residual: lockout DoS** - with a token (or just a username) an attacker can lock a staff member out (15 min, 1 h, 24 h); admin `fn_reset_pin_lockout` unlocks |
| Token on the device | stored in origin-scoped storage (localStorage or IndexedDB) of the kiosk browser: readable by anyone with devtools on that device and by XSS on the origin. Trade-off accepted for a shared floor device; mitigations: strict CSP, kiosk browser in locked-down mode, revoke on theft/staff change. A non-extractable alternative (WebAuthn / device-bound keys) is a follow-up |
| Cross-tenant use of a token | the DB requires token tenant = slug tenant; Origin of another tenant's subdomain is refused |
| Suspended / cancelled tenant | kiosk resolves like an unknown token |
| Offline DB leak | only `sha256(token)` and bcrypt(HMAC(pin)) exist; tokens are high-entropy so the hash is not brute-forceable |
| Tile for the wrong person (shoulder surfing) | inherent to shared terminals; PIN entry is display-only (dots), lockout limits guessing |

Rotation: registering a new kiosk and revoking the old one is the rotation procedure (there is no "reveal token" operation by design).

## Review-gate hardening (post-review)

- `fn_register_kiosk` requires step-up (`fn_require_step_up()`, aal2 when the admin has MFA or the tenant requires it); revoking never does.
- `fn_revoke_kiosk` is allowed for a `past_due` tenant (it only reduces access); suspended/cancelled tenants are still blocked. A second revoke is a no-op and writes no second audit event.
- `kiosk_devices.revoked_at` is one-way (`trg_revocation_final`): a revoked kiosk is re-registered, never revived.
- Registration is serialized per tenant (advisory lock) so the 25-active-kiosk cap holds under concurrency.
- The migration refuses to run if a tenant already holds the newly reserved slug `status` (rename it first).
- CORS wildcard origins need a base of at least two labels (`https://*.cafeos.et`, never `https://*.com`); plain `http` wildcards are accepted only for `localhost`.
- Known residuals: Edge Function rate limits are per isolate and keyed on forwarded-IP headers (enforce at the platform edge); the roster's `pin_length = 4` filter means a future 6-digit role would not appear as a tile.

## UI flow (SPA, `src/features/terminal`)

Routes: `/terminal` on a tenant subdomain (the tenant host `/` redirects there when the device holds a token) and `/r/:slug/terminal` as the dev/preview
fallback; admin page `/r/:slug/settings/terminals`. The slug is derived with `tenantSlugFromHost(location.host)` (`src/lib/utils/host.ts`, a mirror of
`supabase/functions/_shared/host.ts`; `host.test.ts` asserts the reserved list and classification stay identical). The slug only picks which roster to ask for.

1. **Gate.** The token lives in `src/lib/utils/kiosk-token.ts` (the only extra `localStorage` user, allowlisted in the forbidden-pattern lint): key
   `cafeos:kiosk:<slug>`, validated as 64 hex, all access in try/catch, never logged, never in a URL, never rendered after its one-time display.
   No token, or `staff-roster` answering 401, shows one neutral screen: "This terminal is not set up. Ask a manager to register it." with links to the
   username + PIN login (the Cashier) and admin sign-in. **A 401 does not erase the stored token** (see "Forged / unexpected 401" below); when a token exists the
   screen offers an explicit "Remove setup from this device" button. Transient failures (429/network/5xx) keep the token and offer a retry; a failed
   background refetch keeps the previous tiles (and an open PIN pad) on screen.
2. **Tiles.** Exactly the roster rows, as a `radiogroup` (roving tabindex, arrow/Home/End move focus, Enter/Space/click select, 44px+ targets, visible focus).
   Colour must be strict `#rrggbb` (else a neutral slate) and the foreground is chosen for >= 4.5:1; the icon is looked up in a small lucide allowlist keyed by the
   icon slug on the row, with a generic person fallback. No code knows any role name; admin and 6-digit Cashier are absent only because the roster omits them.
3. **PIN pad.** Selecting a tile shows a fixed 4-dot pad (`PinPad fixedLength={4}`): dots fill, digits are never echoed, labelled Delete and "Sign in" keys,
   physical keyboard supported. Submit goes to `pin-login` tile path (`pinLoginTile`) and then installs the session like the username path and routes to `/r/<slug>`.
   Failure always shows one generic message from `TILE_LOGIN_MESSAGES` (`src/lib/supabase/tile-login-messages.ts`: no username wording, no PIN-length hints; the username `StaffLogin` keeps `PIN_LOGIN_MESSAGES`) in a `role=alert` using the platform `status-error` token (not the tenant brand colour), clears the PIN.
4. **Shared-device hygiene.** 60 s without activity on the pad (not while a request is in flight) returns to the tiles and drops the PIN; "Not you?" does the same
   and returns focus to the tile; the PIN exists only in the pad's state and is cleared on submit. Nothing person-specific is put in the page title. Signing out
   from the app returns a device that holds a token to the terminal (otherwise to the normal staff login).
5. **Admin Terminals page** (UX gate `can('kiosks.manage')`; the RPCs and RLS are the real check). Lists `fn_list_kiosks`; `fn_register_kiosk(name)` shows the raw
   token once (kept only in component state, not in the query cache) with Copy and "Set this device up" (stores it in this browser); "I have saved it" discards it.
   Revoke asks for confirmation (`fn_revoke_kiosk`). A `mfa_required` answer is shown as a neutral "confirm with your second sign-in step" message.

Typography: the terminal UI is English only for now and uses the existing Inter stack; the Amharic typography rules (Tayitu.ttf primary, Jiret.ttf secondary)
are unchanged and not yet applied here. Arabic numerals only.

Not in this UI yet: forced PIN-change screen and the notification toast. Roster freshness relies on refetch on mount/window focus (no polling); a revoked
terminal is noticed on its next load, focus or sign-in attempt.

## Review-fix notes (UI)

- **Forged / unexpected 401 (behaviour change).** The terminal used to clear the stored token on any roster 401. It no longer does: a suspended tenant, a
  gateway/proxy 401 or a forged response would otherwise erase every terminal's setup. The device shows the same neutral screen, keeps the token, and a person
  can press "Remove setup from this device". Revocation therefore needs no client cooperation (the server already refuses the token).
- **Bearer credential in localStorage.** The kiosk token is a bearer credential stored in origin-scoped `localStorage` (readable via devtools or XSS on the
  origin). Mitigations are the CSP in `public/_headers`, revocation and the per-tile PIN lockout. A non-extractable, device-bound key (WebAuthn / signed
  challenge) is a **follow-up**.
- **Inactivity sign-out after login.** `InactivityGuard` (mounted once inside `AuthProvider`, `src/features/auth`) ends the session of every signed-in
  tenant user whose role is not the `tenant_admin` system role (decided from `role.system_key` in the server-derived session context, never a role name) and
  who is not a platform admin. Constants are in `src/features/auth/inactivity.ts`: `IDLE_MS = 15_000` (a "Still there?" `alertdialog` appears, focus on
  Continue, countdown in a `role=status` text) and `WARN_MS = 15_000` (sign-out), i.e. **30 s of inactivity in total**. Activity = pointerdown, keydown,
  touchstart, wheel, visibility return; only Continue answers the warning. Deadlines use `Date.now()`, so a tablet that slept signs out on the first tick or
  visibility event after waking; an in-flight mutation counts as activity. Sign-out calls `supabase.auth.signOut()` (deletes the server session, freeing the
  one-session rule at once), clears the TanStack Query cache and routes to the terminal when the device holds a kiosk token, otherwise to `/r/<slug>/login`.
  Tabs of one browser sync through an optional `BroadcastChannel` (activity resets the others; a sign-out signs the rest out). This is UX/hygiene: the server
  session limits stay the authority, and the timings are single constants so they can become per-tenant settings. The PIN-pad idle timer (60 s back to the
  tiles) is a separate, unchanged timer. Playwright shortens the timings through `window.__CAFEOS_INACTIVITY__`, honoured only when `import.meta.env.DEV`.
- **Roster filtering is server-side only.** The client renders every roster row verbatim (tested with rows named "Admin"/"Cashier"); admins and the 6-digit
  Cashier are excluded by `staff-roster`, never by the UI. Roster name/role text is stripped of control, bidi-override and zero-width characters before rendering.
- The tile sign-in request aborts after 15 s and shows the generic network message so the idle timer cannot be pinned behind a hung request.
- The one-time setup code on the Terminals page hides after 3 minutes; on dismiss after a copy the page tries to overwrite the clipboard (best effort).

## Per-tenant timers (migration 0025)

User request (2026-10-04): the inactivity sign-out and the PIN-pad idle timer are per-tenant settings, edited by the tenant admin.

- Stored in `restaurant_session_settings` (one row per tenant): `idle_warning_seconds` (default 15: the "Still there?" dialog appears), `signout_seconds`
  (default 30: sign-out, counted in TOTAL from the last activity, so the warning is visible for `signout - idle_warning` seconds), `pin_pad_idle_seconds`
  (default 60: kiosk PIN pad back to the tiles). Bounds (DB CHECK and RPC validation): `5 <= idle_warning < signout`, `15 <= signout <= 900`, `15 <= pin_pad <= 300`.
- Edited with `fn_update_session_timers(p_idle_warning_seconds, p_signout_seconds, p_pin_pad_idle_seconds)` / `fn_reset_session_timers()`: permission
  `settings.session_timers` (tenant_admin always; grantable), aal2 (`fn_require_aal2`, 0026; no pass without an authenticator), writable tenant; audited with old/new values.
- The signed-in SPA reads them from `fn_get_session_context().session_timers` (or `fn_get_session_timers()`), for every tenant user including one whose PIN
  change is required/pending (the timers must keep running then). The kiosk reads `pin_pad_idle_seconds` from the `staff-roster` response; it belongs to the
  token's tenant. Clients should still clamp to the same bounds and fall back to the defaults (15 / 30 / 60) when the field is missing.
- `InactivityGuard`'s constants (`IDLE_MS = 15_000`, `WARN_MS = 15_000`) map to `idle_warning_seconds * 1000` and `(signout_seconds - idle_warning_seconds) * 1000`.
- Changes take effect for a signed-in device on its next session-context fetch (no Realtime push); a kiosk on its next roster fetch.
