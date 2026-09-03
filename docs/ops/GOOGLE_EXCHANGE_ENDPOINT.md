# Google token-exchange endpoint

Status: canonical for the publisher-owned Google token exchange

Owner-approved direction (2026-09-03): Google requires `client_secret` at the
token endpoint for a Web-application OAuth client, even with PKCE. A secret
shipped inside the open-source Olympus plugin is not secret, so the token
exchange for the **publisher** Google web client (the one behind the
one-click "Connect Gmail" / "Connect Google Drive" flow — see
[`docs/ops/OAUTH_RELAY.md`](OAUTH_RELAY.md)) happens in a small publisher-side
service that holds the secret instead: a Cloudflare Worker on the owner's own
zone, `olympusplugin.ai`, implemented at [`exchange/`](../../exchange).

This document is the contract for that Worker: why it exists, its threat
model and controls, its API, the worker-side change that uses it (applied —
see "Worker-side integration" below), and the owner's deployment runbook.

Dropbox needs no such endpoint — Dropbox's OAuth client with PKCE does not
require a secret at the token endpoint, so the Dropbox publisher flow talks to
Dropbox directly (`docs/ops/OAUTH_RELAY.md`, "Dropbox"). X stays
bring-your-own and is never publisher-owned. Nothing here changes either.

## Why this exists

Recap of the constraint (spelled out in full in `docs/ops/OAUTH_RELAY.md`,
"Open decision — the web client secret" — now settled):

- A Google **Desktop app** OAuth client is a public client: it can exchange a
  code for tokens with just its client ID and a PKCE verifier. Olympus's
  loopback flow already uses one, and that is unaffected by anything here.
- A Google **Web application** OAuth client is a confidential client: Google's
  token endpoint requires `client_secret` on every exchange and refresh,
  regardless of whether the authorization request used PKCE. This is Google's
  rule, not an Olympus choice, and it is why the relay flow (any dashboard
  origin that is not loopback) needs a Web application client rather than
  reusing the Desktop one — a Desktop client cannot register an `https`
  redirect URI at all.
- Olympus ships as public, auditable source. A secret embedded in that source
  is not confidential — anyone can extract it — so it cannot be the thing that
  satisfies Google's requirement.
- The fix is to move the one step that needs the secret — the token exchange
  and the token refresh — out of the distributed worker and into a service the
  owner runs and the secret never leaves.

## What this is not

This endpoint does **not** make Olympus's Google integration more trustworthy
than PKCE already makes it. It exists solely so that Google's confidential-
client requirement can be satisfied without shipping the secret. Read the
threat model below before assuming otherwise.

## Threat model and controls

**This is a public API.** Anyone who can construct a valid
`{code, code_verifier, redirect_uri}` triple can call it and receive tokens.
That is not a flaw introduced by this design — it is the same property PKCE
already has: whoever holds the verifier that matches the code's
`code_challenge` can complete the exchange, with or without a client secret in
the middle. The secret proves **the calling application's identity to
Google** (this is genuinely Olympus's exchange, not some other app), not the
caller's identity to this endpoint. This endpoint has no way to authenticate
*who* is calling it beyond that, and no design here changes that — see "Why
state verification is not possible here" below for the one place this bites.

Given that, the controls below are about bounding blast radius and cost, not
about closing a gap that PKCE leaves open:

| Control | What it does | Where |
|---|---|---|
| Rate limiting | Per-IP fixed-window counter, default 20 requests / 60s, backed by a Workers KV namespace | `exchange/src/rate-limit.ts` |
| Body size cap | 8 KiB, enforced against a claimed `Content-Length` and against the actual bytes read (a lying or absent `Content-Length` does not help) | `exchange/src/index.ts` (`readBoundedJson`) |
| Strict JSON schema | Exact allowed field set (an unknown field refuses the whole request), bounded lengths, and a character-class check on every field (RFC 7636 shape for `code_verifier`, printable ASCII for `code`/`state`/`refresh_token`) | `exchange/src/schema.ts` |
| `redirect_uri` allowlist | Exact match against the configured relay URL(s), or a loopback form (defense in depth — see below) | `exchange/src/redirect-allowlist.ts` |
| No logging of codes/tokens | The only thing ever logged is `{path, status, duration_ms}` — never a request or response body, never a header value | `exchange/src/index.ts` (`logRequest`) |
| No CORS | No `Access-Control-Allow-*` header is ever returned, and any request carrying an `Origin` header is refused outright — this is a server-to-server endpoint, never called from a browser | `exchange/src/index.ts` (`hasBrowserOrigin`) |
| Timeouts | 10s timeout on every call to Google, via `AbortController` | `exchange/src/google.ts` |
| Structured error passthrough | Google's error responses are forwarded with their exact status and body (Google's OAuth error bodies are a small fixed vocabulary and never echo the secret); this endpoint's own errors are a fixed `{error, error_description}` shape that never includes exception text, a stack trace, or anything read from `env` | `exchange/src/index.ts` (`respondFromGoogle`, `errorResponse`) |

Rate limiting fails **open**, not closed, both when the KV binding is absent
AND when a present binding's `get` or `put` throws — a transient KV error, a
misconfigured permission, a regional outage
(`exchange/src/rate-limit.ts`, every KV call wrapped in its own `try`/`catch`).
A defense-in-depth control must never take down the one endpoint the
publisher flow depends on; letting a KV exception propagate would turn an
abuse control into an outage generator for every caller the moment KV has a
bad moment, which is exactly backwards. The runbook below makes creating and
binding the KV namespace a required setup step regardless — an undeployed
rate limiter is a silent gap, not a loud one, even though a deployed one that
starts failing is not an outage either.

### Why the `redirect_uri` allowlist accepts loopback forms it should never see

In Olympus's current worker design (`docs/ops/OAUTH_RELAY.md`,
`dashboardPublisherOAuthFlow`), the Google **publisher web client** — the only
one that ever reaches this endpoint — is used exclusively when the dashboard
origin is *not* loopback, with `redirect_uri` fixed to the one relay URL. A
loopback dashboard uses the Desktop pilot client directly against Google and
never calls this endpoint at all. So in the design as built today, a loopback
`redirect_uri` should never actually arrive here.

The allowlist accepts it anyway (`exchange/src/redirect-allowlist.ts`,
`isLoopbackRedirectUri`), mirroring the relay page's own origin rules
(`docs/ops/OAUTH_RELAY.md`, "Origin rules"). This is deliberate defense in
depth, not a design gap it needs to fix later: if worker-side routing ever
changes so that a loopback flow could reach this endpoint, its allowlist
already agrees with the relay's, rather than silently diverging and either
refusing a legitimate loopback flow or (worse) needing an emergency allowlist
change under pressure.

### Why state verification is not possible here — and what that implies

The relay's `state` is an HMAC-signed payload, and the key that signs and
verifies it is **worker-local** (`docs/ops/OAUTH_RELAY.md`, "State format";
`src/core/oauth-relay.ts` in the main Olympus source, read-only reference for
this document). Every Olympus install mints its own key and never shares it
with anything else — not with the relay, and not with this endpoint. That is
by design: the key is what lets a worker distinguish a flow it started from
one it did not, and a key shared across every install (or held centrally by
the publisher) would make that distinction meaningless the moment any one
install's traffic could be observed.

This endpoint therefore accepts `state` in the request schema (bounded length,
printable-ASCII shape) purely as an opaque passthrough field it can validate
the *shape* of. It does **not**, and architecturally **cannot**, verify the
signature, recover which install minted it, or use it to decide whether to
honor the request. It is never forwarded to Google (Google's token endpoint
does not take a `state` parameter) and never logged.

What this implies: **this endpoint's acceptance of a request adds no
authorization beyond PKCE.** The security properties of the whole flow are
exactly the ones already documented in `docs/ops/OAUTH_RELAY.md`, "The
redirect this opens, and what it costs" — the consent screen and Google's app
verification are the real controls, and the worker's own `state`
verification (steps 0-6 in that document's "What the worker must verify") is
what protects a *specific user's* dashboard from a forged flow. This endpoint
sits entirely outside that boundary: by the time a request reaches here, the
worker-side state verification has already happened (the worker only calls
this endpoint after deciding to trust the code it received), so this endpoint
requiring nothing further is not a weaker check being skipped — it is a check
that has already been done by someone who actually can do it.

### Refresh-flow ownership

Refresh tokens are stored **only on the user's own machine**, in that
install's secret store, exactly as they are today for every other source.
This endpoint is completely stateless: it holds no database, no per-user
record, and no token of any kind at rest. A call to
`POST /exchange/google/refresh` is a pure function of its input — hand it a
refresh token and Google's client secret, get back whatever Google returns —
and nothing here would even notice if the *same* refresh token were sent by
two different installs (which should never happen, since a refresh token is
never shared between installs by anything Olympus does). Losing this Worker
entirely, or an attacker fully compromising it, discloses `GOOGLE_CLIENT_SECRET`
and nothing else — no user data, no user tokens, no user identifiers ever
pass through its logs (see "No logging" above) or its (absent) storage.

## API

Base: `https://auth.olympusplugin.ai/exchange` (see "Hostname and routing"
below for why this hostname). Both routes are `POST` only and reject every
other method with `405`.

### `POST /exchange/google`

Request body (`application/json`):

```json
{
  "code": "<authorization code from Google>",
  "code_verifier": "<the PKCE verifier the worker generated>",
  "redirect_uri": "<must equal the authorization request's redirect_uri>",
  "state": "<optional — accepted for shape, never used; see above>"
}
```

On success: Google's token response, forwarded unchanged, with the same
status code (normally `200`) — `{access_token, refresh_token?, expires_in,
scope, token_type}`.

On a Google-side failure: Google's error response, forwarded unchanged, with
the same status code — `{error, error_description?}`.

On a request this endpoint itself refuses, before ever calling Google:

| Status | `error` | Cause |
|---|---|---|
| 400 | `invalid_request` | Schema violation: wrong type, out-of-range length, bad character class, unknown field, or missing required field |
| 400 | `redirect_uri_not_allowed` | `redirect_uri` matched neither the exact allowlist nor a loopback form |
| 403 | `browser_origin_refused` | The request carried an `Origin` header |
| 405 | `method_not_allowed` | Method was not `POST` |
| 413 | `payload_too_large` | Body exceeded 8 KiB, by header or by actual bytes read |
| 429 | `rate_limited` | Per-IP budget exhausted (`Retry-After` header set) |
| 502 | `upstream_unreachable` | A network-level failure reaching Google |
| 504 | `upstream_timeout` | Google did not respond within 10s |
| 500 | `internal_error` | Anything unexpected — deliberately uninformative |

### `POST /exchange/google/refresh`

Request body:

```json
{ "refresh_token": "<the refresh token stored on the user's machine>" }
```

Same response shapes and error table as above (the `redirect_uri_not_allowed`
row does not apply to this route — a refresh has no `redirect_uri`). Rate
limiting shares the same per-IP key namespace as `/exchange/google`, so a
caller hammering either route exhausts one shared budget rather than two.

## Hostname and routing

**Chosen: `auth.olympusplugin.ai/exchange/*`**, as a Cloudflare **Worker
Route** layered onto the zone that already hosts the relay's Cloudflare Pages
project (`docs/ops/OAUTH_RELAY.md`, "Hosting").

Why this over a dedicated `api.olympusplugin.ai`:

- **No new DNS record or certificate.** `auth.olympusplugin.ai` is already a
  verified, certificate-issued hostname on a zone the owner controls. A Worker
  Route adds a path match on an existing hostname; a new subdomain would need
  its own DNS record (automatic on Cloudflare, but still a step) and its own
  certificate issuance.
- **This is the intended layering, confirmed live rather than assumed.** A
  Worker Route is expected to take precedence over a Pages custom domain for
  any path it matches on the same zone — the Pages project continues serving
  `/oauth/callback/` untouched, and the Worker Route intercepts only
  `/exchange/*`. Cloudflare's own documentation does not spell out this exact
  precedence in so many words, so this is the design's intent, not a cited
  guarantee; step 7 of the runbook below (`curl` against both paths after
  deploy) is what actually confirms it holds on this zone, and step 7 must
  pass before anything depends on it.
- **The exchange endpoint is never a browser-facing `redirect_uri`.** Only the
  relay page's URL is registered with Google as a redirect URI; this endpoint
  is called worker-to-worker. That means, unlike the relay URL, changing its
  hostname later would require no re-registration with Google — so even the
  cost of being wrong here is low. Reusing the existing zone is simply the
  path of least new infrastructure today.
- **One zone, one account, one place to look.** Everything under
  `olympusplugin.ai` — the relay, the exchange endpoint, and anything else the
  publisher OAuth apps need later — stays in the same Cloudflare account with
  the same DNS and TLS posture, rather than accumulating a subdomain per
  concern.

If a second route is ever added under this Worker (unrelated to Google), the
existing `docs/ops/OAUTH_RELAY.md` note about growing past one route into
`api.olympusplugin.ai` still applies — nothing here forecloses that.

## Worker-side integration (applied)

PR #2 (`claude/oauth-relay-worker`, merged) added the worker-side plumbing for
the relay flow — `src/core/oauth-relay.ts`, `src/core/publisher-oauth-client.ts`,
and the `/dashboard/connect/oauth/*` routes in
`src/workers/email-source/index.ts`. This section originally specified, and now
documents as built, the follow-up that makes the dashboard's Google connect
flow call this endpoint.

### Configuration

`googlePublisherExchangeUrl()` lives in `src/core/oauth-relay.ts`, next to
`oauthRelayUrl()`, with the identical validation shape: an unparseable or
non-https (non-loopback) `OLYMPUS_GOOGLE_PUBLISHER_EXCHANGE_URL` override is
ignored rather than obeyed. `googlePublisherExchangeRefreshUrl()` derives the
refresh route as `${googlePublisherExchangeUrl()}/refresh` — never a second
independent env var, so the two can never drift apart.
`DEFAULT_GOOGLE_PUBLISHER_WEB_CLIENT_ID` in `src/core/publisher-oauth-client.ts`
is filled in with the owner's "Olympus Publisher" Web-application client id
(`OLYMPUS_GOOGLE_PUBLISHER_WEB_CLIENT_ID` overrides it, same as every other
publisher identifier in that file).

### `src/core/connect.ts` — `exchangeAuthorizationCode`

The function that builds the token-exchange request now branches before
choosing a transport: `isGooglePublisherExchangeClient(source, clientId)` is
true only when the flow's `clientId` equals `googlePublisherWebClientId()`.
When it is, the exchange POSTs JSON --
`{code, code_verifier, redirect_uri, state?}`, no `client_secret` field at
all — to `googlePublisherExchangeUrl()` instead of form-encoding a request
straight to `options.tokenUrl`. Every other path — the packaged Desktop pilot
client (loopback), a bring-your-own Google client, Dropbox, X — is unchanged
and still exchanges directly with its provider. The response parsing below the
HTTP call is shared by both branches unmodified: the exchange endpoint returns
Google's token response unchanged (see "API" above), so the existing
`payload.access_token` / `payload.refresh_token` / `payload.expires_in` /
`payload.scope` handling applies identically either way.

`dashboardOAuthClientSecretRequired()` already returns `false` for Google
sources and `dashboardGoogleOAuthClientSecret()` already returns `undefined`
when no matching stored secret exists — the publisher web client id never
matches a stored client id, so no client secret is ever resolved for this
path in the first place, and the publisher branch's JSON body has no field to
put one in even if it were.

### `src/workers/credential-broker/index.ts` — `refreshOAuth2AccessToken`

The same branch, in the same shape, applies to the refresh path: when the
stored credential's `oauth2Refresh.exchangeVia === 'publisher_endpoint'` (or,
for a credential connected before that field existed, when its resolved
`clientId` still equals `googlePublisherWebClientId()`), the refresh POSTs
JSON `{refresh_token}` to `googlePublisherExchangeRefreshUrl()` instead of
form-encoding a request straight to `options.tokenUrl` — again with no
`client_secret` involved on the worker's side. The HTTP call is wrapped in a
bounded timeout (`fetchWithTimeout`, 20s) and a network failure or timeout is
raised as the same `OAuth2TokenEndpointError` shape the direct path uses
(`502`/`upstream_unreachable` or `504`/`upstream_timeout`), so it flows through
the broker's existing refusal handling and reaches the dashboard as an
ordinary provider refusal.

### Provenance: `exchangeVia`

`src/core/connect.ts` writes `oauth2Refresh.exchangeVia: 'publisher_endpoint'`
onto the connected-handle registry entry at the moment a Google
publisher-Web-client connection completes — a fact about how *that* exchange
actually happened, not a value re-derived from the stored client id on every
read. This is the same "provenance, not presence" reasoning
`client_id_source` already uses (`docs/ops/OAUTH_RELAY.md`): a future rotation
of `DEFAULT_GOOGLE_PUBLISHER_WEB_CLIENT_ID` must not stop an
already-connected publisher credential's refresh from finding the exchange
endpoint. `src/workers/credential-broker/connected-handles.ts` carries the
field through normalization (`normalizeOAuth2`, rejecting any value other than
the one literal) and into the broker's `EnvOAuth2RefreshDefinition`
(`deriveEnvCredentialHandlesFromRegistry`). Absent for every other credential
-- the Desktop pilot client, any bring-your-own registration, Dropbox, X --
all of which keep refreshing directly with their provider exactly as before.

### What did *not* change

- The relay page (`relay/oauth/callback/index.html`) and its contract
  (`docs/ops/OAUTH_RELAY.md`) are untouched — this endpoint is never in the
  browser's path.
- `dashboardPublisherOAuthFlow` and the rest of PR #2's routing (which client,
  which redirect URI, when the relay's signed state is minted) are untouched --
  this only changes where the *token exchange* HTTP call goes once that
  routing has already decided "publisher web client."
- The connect card: `dashboardPublisherOAuthSources` already offered
  publisher mode to Gmail and Google Drive generically the moment
  `googlePublisherWebClientId()` answers a value, and the sheet's copy
  (`src/workers/dashboard/components.ts`) is source-name-driven already — one
  Connect button, "Use my own app instead" behind a disclosure, identical to
  Dropbox's card. Filling in the client id is what turns it on; nothing about
  the card itself needed to change.
- Nothing about how a connected handle is stored, displayed, or disconnected
  changes — a publisher-web-client Google account looks identical to any other
  Google account everywhere downstream of the token response.

## Testing

`exchange/test/google-exchange.test.ts` covers schema refusals (missing
fields, wrong shapes, unknown fields), the `redirect_uri` allowlist (exact
match, loopback forms, near-misses, garbage), rate limiting (per-key budget,
window reset, independent keys, shared budget across both routes), the
success and refresh passthrough paths (including asserting the exact form
body sent to Google), Google error/timeout/network-failure handling, and that
`GOOGLE_CLIENT_SECRET` never appears in a response body, a response header, or
a log line. Run it with:

```sh
bun test exchange/test
```

Typecheck the Worker on its own `tsconfig.json` (deliberately not part of the
root project's `include` — it targets the Workers runtime, not Bun/Node):

```sh
cd exchange && ../node_modules/.bin/tsc --noEmit
# or, from the repo root:
node_modules/.bin/tsc -p exchange/tsconfig.json --noEmit
```

`test/google-publisher-exchange.test.ts`, in the main project, covers the
worker-side integration this document specifies above: the publisher relay
flow end to end through `withWorkerBearerAuth` with a fake relay bounce and a
fake exchange endpoint (asserting the exact JSON body shape, that
`redirect_uri` equals the relay URL, and that no `client_secret` field is
ever sent); a loopback dashboard still using the packaged Desktop pilot
client and exchanging directly with Google; refresh routed to the endpoint
for an endpoint-minted credential (by `exchangeVia` and, for a
pre-migration credential, by client-id fallback) and to Google directly for
a bring-your-own credential; the endpoint's 400/401/502/504 error shapes
rendered as ordinary connect refusals; and that no secret-shaped string
appears in any response. Run it with `bun test test/google-publisher-exchange.test.ts`.

## Owner runbook

Everything below is the owner's step; nothing in this pull request performs
any of it. `exchange/` ships with no secret, no live client id, and no real KV
namespace id — every value that must be real is a placeholder marked as such
in `exchange/wrangler.toml`.

1. **Create the Google Web application client**, if PR #2's runbook step
   (`docs/ops/OAUTH_RELAY.md`, "Google") has not already been done:
   - Google Cloud console → APIs & Services → Credentials → **Create
     credentials** → **OAuth client ID** → **Web application**.
   - **Authorized redirect URIs**: exactly
     `https://auth.olympusplugin.ai/oauth/callback/`, trailing slash included
     — this is the relay URL, not anything under `/exchange/`. The exchange
     endpoint is never a browser redirect target and is never registered with
     Google.
   - OAuth consent screen: `olympusplugin.ai` under **Authorized domains**
     (already true if the relay's Google runbook step ran first).
   - Copy the **Client ID** and **Client secret** Google issues.
2. **Store the secret in 1Password** (or the owner's usual credential vault)
   immediately — this is the only copy that should ever exist outside
   Cloudflare's own secret store and Google's console.
3. **Set the client id as a var:**
   ```sh
   cd exchange
   bun install   # first time only — installs wrangler and typescript
   ```
   Edit `wrangler.toml` and replace the empty `GOOGLE_CLIENT_ID` value with
   the client id from step 1. This is a var, not a secret — it is fine for it
   to be visible in the deployed Worker's configuration and in this
   repository once filled in, because every browser that reaches the consent
   screen already sees it.
4. **Set the secret** (never as a var, never committed):
   ```sh
   bunx wrangler secret put GOOGLE_CLIENT_SECRET
   # paste the client secret from step 1 when prompted
   ```
5. **Create and bind the rate-limit KV namespace:**
   ```sh
   bunx wrangler kv namespace create RATE_LIMIT_KV
   ```
   Paste the returned `id` into `wrangler.toml`'s `[[kv_namespaces]]` block,
   replacing `REPLACE_WITH_KV_NAMESPACE_ID`. Skipping this step does not break
   the endpoint — rate limiting fails open (see "Threat model" above) — but it
   does mean the endpoint has no abuse control at all until this is done, so
   do it before real traffic exists.
6. **Deploy:**
   ```sh
   bunx wrangler deploy
   ```
   This both publishes the Worker and, on first deploy, provisions the Worker
   Route named in `wrangler.toml` (`auth.olympusplugin.ai/exchange/*`) on the
   `olympusplugin.ai` zone. No separate "route binding" console step is needed
   beyond having the zone on this Cloudflare account, which it already is (the
   relay's Pages project is on the same zone).
7. **Confirm it is live, refuses cleanly, AND that the relay still works.**
   The Worker Route/Pages coexistence this design relies on
   ("Hostname and routing" above) is this design's intent, not a documented
   Cloudflare guarantee — these two checks are what actually confirm it on
   this zone, and both must pass:
   ```sh
   curl -s -X POST https://auth.olympusplugin.ai/exchange/google \
     -H 'Content-Type: application/json' -d '{}'
   # expect: {"error":"invalid_request","error_description":"..."} with HTTP 400
   curl -s -X POST https://auth.olympusplugin.ai/exchange/google
   # expect: {"error":"invalid_request", ...} (POST with no body) — never a 500

   curl -sI https://auth.olympusplugin.ai/oauth/callback/
   # expect: 200, and the relay's own headers (content-security-policy,
   # strict-transport-security, x-content-type-options, referrer-policy —
   # docs/ops/OAUTH_RELAY.md, "Confirm the headers arrive") — proving the
   # Worker Route intercepted only /exchange/* and the Pages project still
   # serves everything else on the same hostname.
   ```
   If the second check ever stops returning the relay's headers (a 404, or a
   plain response missing them), the Worker Route has started shadowing the
   relay and this needs fixing before anything else proceeds — the relay is
   the one thing registered with Google and cannot go dark.

   A real end-to-end exchange proof needs a live authorization code and
   verifier, which only exists mid-flow; the checks above only confirm both
   services are deployed, routed correctly, and fail closed on bad input. The
   first real exchange proof is the first live "Connect Gmail" click, which
   the worker-side integration (above, applied) now makes possible.
8. **The worker-side integration is applied** (see above) — no further pull
   request is needed for it. What remains here is deployment: steps 1-7 are
   the owner's own Cloudflare and Google Cloud console actions, none of which
   this repository can perform on the owner's behalf.
9. **Google verification thresholds**, unchanged from
   `docs/ops/OAUTH_RELAY.md` but worth restating here because this endpoint is
   what makes clearing them possible at all: `gmail.readonly` and
   `drive.readonly` are *restricted* scopes. An unpublished Web application
   client stays capped at **100 test users** while in Testing. Moving past
   that cap requires Google's **OAuth verification** plus an annual **CASA**
   (third-party security assessment) for restricted scopes — both of which
   review the app's data handling, and both of which presuppose a real,
   reachable, non-secret-leaking token exchange. Without this endpoint (or
   the loopback-only fallback), there is no way to pass that review for the
   web-client flow at all, because the alternative — a secret shipped in
   public source — is exactly the kind of finding that review exists to
   catch. Plan verification to start once the soft launch is inside the
   Testing cap, per the existing guidance.

## Keeping this endpoint out of the public package

`exchange/` is source in this repository but is **not** part of the published
Olympus npm package: `V0_4_PUBLIC_PACKAGE_FILES` in `src/core/public-surface.ts`
is a positive allowlist (nothing is packaged unless it is named there), so a
new top-level directory is excluded by default and needs no explicit
exclusion rule. The same is true of the repository going public on GitHub —
`exchange/`'s source, tests, and this document are meant to be public (the
whole point of this design is that the secret never has to be), and
`bun scripts/public-flip-scan.ts` scans for owner identifiers, not for
directory membership, so it is unaffected by this addition beyond scanning a
few more files.

This document is added to the canonical documentation allowlist in
`scripts/private-ops-disposition.ts` (`ALLOWED_DOCS`), which enumerates every
file under `docs/` by exact path — an unlisted `docs/` file fails
`bun scripts/private-ops-disposition.ts verify` (exercised by
`test/private-ops-disposition.test.ts`), so this addition needed that one-line
allowlist update alongside creating the file.
