# Kiosk terminals (shared floor device with staff tiles)

User decision (2026-10-03): the shared floor terminal shows **tiles of the staff**, but only on **registered kiosk devices** (not an open roster by
link). Tenant = `<slug>.cafeos.et`; the device additionally holds a secret token issued by a tenant admin.

## Flow
1. A user with `kiosks.manage` (tenant_admin always; grantable in the role matrix) calls `fn_register_kiosk(name)` while signed in on the tenant host.
   The RPC returns `{id, name, token}`: the **raw token exists only in this response**. The DB stores `sha256(token)` (`kiosk_devices.token_hash`,
   no client grant, stripped from audit rows). Token = 32 random bytes as 64 hex characters. Max 25 active kiosks per tenant.
2. The admin pastes the token into the device (a one-time setup screen in the SPA, UI part to be built). The device keeps it in origin-scoped storage.
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
