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
   1/min, not audited) and returns tiles: `id`, short name (first + middle), role label, colour, icon. Any failure = the same `401 invalid_kiosk`.
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
   username + PIN login (the Cashier) and admin sign-in. A 401 also clears the stored token. Transient failures (429/network/5xx) keep the token and offer a retry.
2. **Tiles.** Exactly the roster rows, as a `radiogroup` (roving tabindex, arrow/Home/End move focus, Enter/Space/click select, 44px+ targets, visible focus).
   Colour must be strict `#rrggbb` (else a neutral slate) and the foreground is chosen for >= 4.5:1; the icon is looked up in a small lucide allowlist keyed by the
   icon slug on the row, with a generic person fallback. No code knows any role name; admin and 6-digit Cashier are absent only because the roster omits them.
3. **PIN pad.** Selecting a tile shows a fixed 4-dot pad (`PinPad fixedLength={4}`): dots fill, digits are never echoed, labelled Delete and "Sign in" keys,
   physical keyboard supported. Submit goes to `pin-login` tile path (`pinLoginTile`) and then installs the session like the username path and routes to `/r/<slug>`.
   Failure always shows the generic `PIN_LOGIN_MESSAGES` text in a `role=alert` using the platform `status-error` token (not the tenant brand colour), clears the PIN.
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
