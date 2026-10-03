# pin-login (Edge Function)

PIN sign-in for **non-admin staff only**. `tenant_admin` and `platform_super_admin` never use a PIN: they sign in with
Supabase Auth email + password (TOTP MFA capable). The PIN path answers admins exactly like a wrong PIN.

## Contract
Two request shapes (exact key sets; mixing them is `invalid_request`):
- **username path** (any device; the only path for the 6-digit Cashier): `{ restaurant_slug, username, pin }` with a 4 or 6 digit PIN.
- **tile path** (registered kiosk): `{ restaurant_slug, kiosk_token, profile_id, pin }` with a 4-digit PIN. The kiosk token is validated by the
  DB (`fn_kiosk_tile_eligible`: token hash, not revoked, tenant slug equal, tenant not suspended/cancelled) and the profile must be an eligible
  4-digit non-admin PIN member of that tenant; otherwise the same work is done on a random id and the answer is the same 401. Lockout is shared
  with the username path (3/6/9 failures).
A page whose Origin is `<other-slug>.cafeos.et` cannot sign in to a different tenant (same generic 401).

`POST /functions/v1/pin-login`, JSON body (max 1024 bytes, exactly these keys):

```json
{ "restaurant_slug": "demo-cafe", "username": "abebe", "pin": "4829" }
```

| result | status | body |
|---|---|---|
| success | 200 | `{ "access_token", "refresh_token", "expires_in" }` (nothing else) |
| unknown tenant / unknown user / inactive / locked / admin / wrong PIN / **correct PIN while another session of that user is active** | 401 | `{ "error": "invalid_credentials" }` (byte-identical, same timing floor) |
| bad shape (slug, username, a PIN that is not 4 or 6 digits; the function cannot know which length a user has and never reveals it) | 400 / 413 | `{ "error": "invalid_request" }` |
| throttled | 429 | `{ "error": "try_later" }` + `Retry-After` |
| infrastructure failure | 503 | `{ "error": "server_error" }` |

The client then calls `supabase.auth.setSession({ access_token, refresh_token })`.

## Environment (function runtime only)
| var | notes |
|---|---|
| `SUPABASE_URL` | injected by Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | injected by Supabase. **Function env only**; never in `VITE_*`, `.env.example` or the browser |
| `SUPABASE_ANON_KEY` | injected by Supabase; used to redeem the one-time token without privileges |
| `ALLOWED_ORIGINS` | comma-separated exact origins, e.g. `https://app.example.com,http://localhost:5173`. No wildcard (a `*` entry is ignored). Unset = no browser origin allowed |

Set with `supabase secrets set ALLOWED_ORIGINS=...`.

## Security notes
- Verification and lockout (escalating: 3rd failure 15 min, 6th 1 h, 9th 24 h; counter resets only on success or admin reset) are in `fn_verify_pin`, which registers failures itself. Do not also call
  `fn_register_pin_failure` from here (double count).
- Same DB work (and a response-time floor of about 450 ms plus jitter) for every outcome.
- In-memory token buckets (per IP, per tenant+username) are per isolate and best effort; the DB lockout is authoritative.
  Trade-off: someone can burn a victim's per-username bucket, which only delays that username, like the DB lockout does.
- The session is minted via `admin.generateLink` + `verifyOtp` (see the comment block in `index.ts`). The hashed token stays
  server-side. PINs and tokens are never logged.
- **One concurrent session per PIN staff** (migration 0023): after a correct PIN the function asks `fn_staff_has_active_session` (auth.sessions, 2 h window). If active it calls
  `fn_staff_login_blocked` (notifications to the user and tenant admins, `must_change_pin`, audit; on the tile path the kiosk token hash is passed so the notification names the kiosk) and answers the
  generic 401. If the check itself fails the answer is 503 and no session is minted. Known gap: check and mint are two steps, so two simultaneous logins can both pass.
- Only identities with `fn_user_auth_method = 'pin'` and a `*.staff.cafeos.invalid` email can be minted.

## Local run
```bash
pnpm dlx supabase functions serve pin-login --env-file supabase/functions/.env.local
```
Status: written without a Deno runtime available; **not executed against a real Supabase stack**. Pure logic is covered by
`tests/unit/pin-login-logic.test.ts`.

## Pepper
Also needs `PIN_PEPPER` (see ../README.md): the function sends the database only `HMAC-SHA256(pin, PIN_PEPPER)`.
