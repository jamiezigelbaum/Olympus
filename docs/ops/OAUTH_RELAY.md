# OAuth callback relay

Status: canonical for the publisher-owned OAuth callback

Owner decision (2026-09-03): connecting a source must be "click Gmail, log in,
done" for every user, including a user whose Olympus worker runs on a VPS or a
home server while the browser is on a laptop. Olympus therefore ships
publisher-owned OAuth apps for Google and Dropbox (X stays bring-your-own) with
**one fixed callback**: a static relay page on a domain the publisher controls,
which bounces the browser back to whatever dashboard origin the flow's own
`state` names.

This document is the contract. The relay page is
[`relay/oauth/callback/index.html`](../../relay/oauth/callback/index.html); the
worker side lives in [`src/core/oauth-relay.ts`](../../src/core/oauth-relay.ts)
(state minting and verification), the publisher client identifiers in
[`src/core/publisher-oauth-client.ts`](../../src/core/publisher-oauth-client.ts),
and the routes in `src/workers/email-source/index.ts`. It satisfies
["What the worker must verify"](#what-the-worker-must-verify).

### Which flow a source takes

| Source | Dashboard origin | Client | `redirect_uri` | `state` |
|---|---|---|---|---|
| `gmail`, `google-drive` | loopback | packaged Google **Desktop** pilot client | `http://127.0.0.1:<port>/oauth/callback/<source>` | random |
| `gmail`, `google-drive` | anything else | publisher Google **Web** client | the relay URL | signed |
| `dropbox` | any | publisher Dropbox app key | the relay URL | signed |
| `x` | any | bring-your-own | the dashboard's own callback | random |

Two rules decide this, and both are enforced in `dashboardPublisherOAuthFlow`:

- **A registration the owner made wins.** Publisher mode is offered only to an
  install that has registered no client id of its own for that source (pasted
  into the dashboard, or already bound to a connected handle). Bring-your-own
  stays reachable from every publisher card as "Use my own app instead".
- **Google on loopback keeps the loopback redirect.** A Desktop app client
  cannot register an https redirect URI, so the pilot client cannot use the
  relay — and does not need to: a loopback callback reaches the worker directly.
  Same publisher app, no relay, no signed state.

Both publisher identifiers ship **empty**. Until the owner creates the apps,
every non-loopback case answers "not configured" and the dashboard shows exactly
the bring-your-own path it shows today.

The publisher-side token-exchange endpoint is still unbuilt. When it lands, only
the exchange leg moves: the relay contract, the state format, and the registered
`redirect_uri` are unchanged by it.

### The worker's state signing key

`dashboard.oauth.relay_state_key` in the worker's own secret store, as JSON:
`{ current, previous?, rotatedAt? }`. `current` is 32 random bytes, base64url,
minted on first use and cached in the worker process; new states are always
signed with it. It signs and verifies `state` and nothing else — it is never
sent to a provider, never put in a page, and never reachable from an
unauthenticated route: the callback route only reads it once a pending attempt
an authenticated start route created already exists.

**Rotation.** Rotating replaces `current` with a fresh key and demotes the old
one to `previous`, recording `rotatedAt`. `previous` keeps verifying for
**one flow TTL** (`OAUTH_RELAY_STATE_TTL_MS`, ten minutes) past `rotatedAt` —
long enough that a state minted just before rotation and still fresh at
verification time keeps working — and stops verifying once that window passes,
so a compromised key that prompted the rotation cannot forge a state forever
after. Only one demoted key is ever kept: rotating twice in quick succession
does not chain two grace windows. `src/core/oauth-relay.ts` implements the
type, the rotation, and the persisted JSON shape
(`rotateOAuthRelayStateKeys`, `serializeOAuthRelayStateKeys`,
`parseOAuthRelayStateKeys`); nothing in this repository currently calls
rotation on a schedule or exposes it as an operator command — until it does,
rotation is a manual edit of the stored JSON.

## Why a relay at all

A loopback redirect (`http://127.0.0.1:<port>/oauth/callback`) only works when
the browser and the worker are the same machine. A per-user public callback
cannot be registered, because Google and Dropbox require every redirect URI to
be registered on the app in advance, and the publisher does not know the users'
origins. One fixed, publicly reachable URL that forwards to the user's own
origin is the only shape that satisfies both.

The relay is deliberately powerless:

- it is static HTML with one inline script, no server, no storage, no analytics,
  no network requests of its own;
- it never sees a PKCE verifier, a client secret, or a token;
- it holds no key, so it cannot verify a signature and does not pretend to;
- it only decides *whether to bounce* and *where*, from the public half of the
  `state` the user's own worker minted.

The worker — not the relay — is the authority that accepts or rejects a flow.

Powerless is not the same as harmless. Making one registered `redirect_uri`
forward to any origin a state names is an open redirector, and it carries a real
consent-phishing risk that the owner has accepted with a named compensating
control. Read ["The redirect this opens, and what it
costs"](#the-redirect-this-opens-and-what-it-costs) before changing anything
here.

## Flow

1. The user clicks "Connect Gmail" in their own Olympus dashboard.
2. The worker mints a flow: a PKCE verifier, a nonce, and a signed `state`
   (below). The verifier never leaves the worker.
3. The worker sends the browser to the provider with
   `redirect_uri = <relay URL>` and that `state`.
4. The user signs in and consents at the provider.
5. The provider redirects the browser to the relay with `code` and `state`
   (or `error` and `error_description`).
6. The relay decodes the public half of `state` and validates the origin and
   the source. A loopback origin is followed immediately; any other origin is
   shown to the person on an interstitial and followed only when they click
   Continue. Either way the destination is
   `<origin>/oauth/callback/<source>?…` carrying only `code`, `state`, `error`,
   `error_description`.
7. The worker verifies the signature, the nonce, the origin, and the source,
   then completes the PKCE token exchange with `redirect_uri = <relay URL>`.

## State format

```
state       = BASE64URL(payload) "." BASE64URL(HMAC-SHA256(key, BASE64URL(payload)))
payload     = UTF-8 JSON, no padding on either segment
```

```json
{ "v": 1, "origin": "https://olympus.example.org", "source": "gmail", "nonce": "…", "iat": 1800000000 }
```

| Field | Rule |
|---|---|
| `v` | integer, exactly `1` for this version |
| `origin` | the user's dashboard origin, serialized (see [Origin rules](#origin-rules)) |
| `source` | one of `gmail`, `google-drive`, `dropbox`, `x` |
| `nonce` | 16–128 base64url characters; 32 random bytes (43 characters) recommended; single use |
| `iat` | issue time, Unix seconds |

Rules that both sides depend on:

- The signature covers the **ASCII of the first segment**, not the raw JSON. No
  canonicalization problem, no re-encoding ambiguity.
- Both segments are base64url without padding, matching `^[A-Za-z0-9_-]+$`.
- Exactly two segments, separated by one `.`.
- Total `state` length is capped at **2048 characters**; the relay refuses a
  longer one before decoding anything.
- Duplicate keys in the payload JSON resolve last-wins in every `JSON.parse`
  implementation involved, so a worker must not emit them and must not treat
  the first occurrence as authoritative when re-parsing.
- The HMAC key is 32 random bytes, worker-local, in the worker's secret store.
  It never leaves the worker and is never derived from anything the browser
  sees. On rotation, keep the previous key accepted for one flow TTL.

The relay parses **only the first segment**. It never inspects, and cannot
check, the signature.

### Versioning

`v` is the version of the payload the relay parses. The relay accepts `v: 1`
and refuses everything else, so an older cached copy of the page fails closed
rather than misreading a newer payload.

A field may be **added** to the payload under `v: 1` — the relay ignores
unknown fields. Changing the meaning, type, or presence of `v`, `origin`,
`source`, or `nonce`, or changing the segment or signature construction, is a
`v: 2` change and requires shipping the relay page **before** any worker emits
`v: 2`, because the relay is cached by browsers and CDNs and the worker cannot
know which copy a user's browser will run. When `v: 2` ships, the relay accepts
both versions for at least one release, then drops `v: 1`.

## Origin rules

The relay redirects only to an origin the state names, and only when the string
is a bare serialized origin. Everything below is enforced twice: by a regular
expression, and by a round-trip through the browser's own `URL` parser
(`url.origin === value`, empty username/password, `pathname === '/'`, no query,
no fragment).

Accepted:

| Shape | Example |
|---|---|
| `https` on a dotted DNS name | `https://olympus.example.org` |
| `https` with an explicit non-default port | `https://olympus.example.org:8443` |
| `http` on loopback only | `http://127.0.0.1:8787`, `http://localhost:3000`, `http://[::1]:8787` |
| `https` on loopback | `https://localhost:8443` |

Refused (rendered as a plain error, no redirect):

- any scheme other than `http`/`https`, including `javascript:`, `data:`,
  `file:`, and protocol-relative `//host`;
- `http` on anything but `127.0.0.1`, `localhost`, `[::1]`;
- any path, query, fragment, or trailing slash — `https://host/` is refused;
- userinfo in any form (`https://user@host`, `https://user:pw@host`);
- uppercase characters (the worker emits a normalized lowercase origin);
- the scheme's default port written out (`:443` on `https`, `:80` on `http`) —
  the URL parser drops it, so the string cannot round-trip;
- a single-label host (`https://dashboard`), a **non-loopback** IPv4 address
  (`https://203.0.113.4`), and any non-loopback IPv6 literal — the loopback
  literals `127.0.0.1` and `[::1]` are accepted under either scheme;
- a port outside 1–65535, a trailing-dot host, whitespace, or a newline;
- anything longer than 255 characters.

`source` must be exactly one of `gmail`, `google-drive`, `dropbox`, `x`. The
destination path is built as `/oauth/callback/<source>` from that allowlisted
value, so no path can be smuggled through it.

## Redirect and passthrough

**The branch that matters: a loopback destination is followed automatically, and
every other destination is not.** Everything below is downstream of that rule.

On success the destination is always:

```
origin + '/oauth/callback/' + source + '?' + params
```

`params` carries **only** `code`, `state`, `error`, `error_description`, in
that order, each re-encoded by `URLSearchParams`. Every other query parameter
the provider added (`scope`, `authuser`, `prompt`, `hd`, …) is dropped. A
parameter longer than 4096 characters is refused rather than forwarded.

**Loopback** — `127.0.0.1`, `localhost`, `[::1]` — is followed with
`location.replace`, and the page also fills in a visible "Continue to your
dashboard" link with the same URL, so a browser that blocks the scripted
navigation still lets the user finish by clicking.

**Every other destination stops at an interstitial.** The page shows the
destination origin prominently, headlines it as "Olympus is returning you to
<host>", and offers two controls: a "Continue" link carrying the same validated
URL, and a "This isn't my Olympus" cancel that renders a refusal and sends
nothing. Nothing navigates until the person chooses. The cancel control is wired
with `addEventListener`; there are no inline handlers, because the
Content-Security-Policy hash covers only the script block itself.

Why the asymmetry: a loopback code can only reach software already running on
that person's machine, so there is no decision worth interrupting for. Any other
origin was chosen by whoever minted the state — see
["The redirect this opens, and what it costs"](#the-redirect-this-opens-and-what-it-costs).

## Error handling

A provider error is a **result**, not a refusal: `error` and
`error_description` are forwarded to the dashboard so the user sees "Google
said you cancelled" in the product rather than on a bare relay URL.

The relay refuses — plain error text, no redirect, nothing forwarded — when:

| Reason | Meaning |
|---|---|
| `missing_state` | no `state` parameter, or an empty one |
| `state_too_large` | `state` longer than 2048 characters |
| `invalid_state` | wrong segment count, non-base64url characters, undecodable bytes, non-object payload, wrong `v`, or a malformed `nonce`/`iat` |
| `invalid_origin` | the origin fails the rules above |
| `invalid_source` | the source is not in the allowlist |
| `missing_result` | neither `code` nor `error` was present, or both were empty |
| `parameter_too_large` | a forwarded parameter exceeds 4096 characters |

## What the worker must verify

The relay's checks stop it from being a general-purpose open redirector. They
are **not** the security boundary. The worker must treat every inbound
`/oauth/callback/<source>` request as hostile input and verify, in order:

0. **Never mint a state outside an authenticated dashboard session.** The
   flow-START route is a control-session route: a `state` is only ever handed to
   a browser that is already authenticated to that dashboard, and the nonce
   record should be bound to that session. Without this, an attacker who can
   reach the worker's start route gets Olympus to mint a *validly signed* state
   for a flow the attacker chose — the reverse of the phishing case, ending with
   the attacker's provider account ingested into the victim's Olympus, where its
   content is then trusted and answered from. A signature check cannot catch
   that, because the signature is genuine.
1. **Signature.** Recompute `HMAC-SHA256(key, first_segment)` over the exact
   first segment as received and compare in constant time. Try the previous key
   only within the rotation window.
2. **Version.** Refuse any `v` the worker does not implement.
3. **Nonce.** It must match a pending flow record the worker itself created,
   still unconsumed and unexpired. Consume it atomically — one code per nonce,
   replay refused.
4. **Origin.** It must equal the worker's own dashboard origin as the *worker*
   knows it, not as the request claims. A signed state naming a different
   origin is a bug or an attack; refuse it.
5. **Source.** It must equal the source recorded with the nonce.
6. **Freshness.** `iat` within the flow TTL (10 minutes is ample) in addition
   to the nonce's own expiry.
7. **Result.** With `error`, render the provider's failure and end the flow;
   never exchange. With `code`, exchange it using the verifier stored with the
   nonce and `redirect_uri` set to the exact relay URL string used in the
   authorization request.
8. **Hygiene.** Never log `code` or `state`. Never reflect any query parameter
   into the page without escaping. Redirect to a clean URL once the code is
   consumed so it does not linger in history. Rate-limit unsolicited callbacks;
   an inbound request must never *create* flow state.

A worker that skips step 0, step 1, or step 3 is exploitable no matter what the
relay does. A worker that performs them is safe even if the relay is replaced
wholesale by an attacker who controls the relay's hosting.

## The redirect this opens, and what it costs

The relay redirects to any origin a `state` names, including a state it cannot
authenticate. That is an open redirector at a registered `redirect_uri`, which
RFC 9700 (OAuth 2.0 Security Best Current Practice) §4.11 tells you not to
build; §4.1.3 is the exact-string redirect-URI matching this design leans on to
keep the *registered* value pinned even though what it forwards to is not. An
earlier
draft of this document claimed the resulting risk was "exactly as possible with
a loopback redirect". That was **wrong**, and the corrected version is below.

### The attack this enables

1. The attacker builds a Dropbox (or Google) authorization URL with **Olympus's
   publisher `client_id`**, `redirect_uri` = the relay, **their own** PKCE
   `code_challenge`, and a forged `state` naming `https://attacker.example`.
   The signature segment is garbage; nothing verifies it before the browser
   arrives back at the relay.
2. They send the victim that link. The victim sees a genuine provider consent
   screen for Olympus — real provider domain, real app name, correct scopes.
3. The victim clicks Allow. The provider redirects to the relay with a valid
   authorization code.
4. The relay bounces the code to `https://attacker.example`.
5. The attacker exchanges the code with the verifier they kept. A Dropbox app
   using PKCE needs no client secret, so nothing else is in the way. They now
   hold a refresh token for the victim's Dropbox, under Olympus's name.

No Olympus worker is involved at any step, and **PKCE does not help** — the
attacker holds the verifier because the attacker started the flow.

**The loopback comparison is wrong.** A loopback `redirect_uri` delivers the
code to `127.0.0.1` on the victim's own machine; there is no origin an attacker
can name. The relay is precisely what turns one registered URI into "any
origin". The honest comparison is any multi-tenant SaaS OAuth app, where consent
phishing lands the victim's data in an attacker-controlled account — same shape,
same defences, and those defences are the provider's, not ours.

### What is done about it

- **No non-loopback destination is auto-followed.** The relay renders an
  interstitial naming the destination origin and requires a click, with a "This
  isn't my Olympus" cancel that ends the flow and says nothing was sent. This is
  a speed bump, not a fix — a determined victim clicks through anything — but it
  removes the silent case, which is the one that scales.
- **Loopback auto-continues**, because the code can only reach software already
  running on that person's own machine.
- **Strict origin and source rules** keep the page from being a general-purpose
  redirector: a fixed destination path, four parameter names, no arbitrary URLs,
  paths, fragments, or schemes.
- **The worker rejects everything aimed at a real user.** A forged state pointed
  at someone's actual dashboard dies at the signature and the nonce.
- **The provider is the real control.** The consent screen names the app and the
  scopes, and app verification is what stands between an attacker and a
  convincing consent screen: Google's restricted-scope review plus CASA, and
  Dropbox's production review. **A verification reviewer may object to an
  open-redirector `redirect_uri`.** Expect that conversation; do not be
  surprised by it.

There is no cryptographic fix available to a static page. Any signature it could
check requires knowing which key to trust, which requires an enrollment registry,
which requires a server — at which point the design is a publisher-run callback
service, not a relay.

### The residual risk, and who accepts it

What remains, unfixed: **a user who is phished into consenting can have their
Google or Dropbox data delivered to an attacker, through Olympus's publisher
app, without any Olympus component being compromised.**

The alternatives all cost the thing this design exists to buy:

| Option | What it costs |
|---|---|
| This relay | the risk above, reduced but not removed by the interstitial |
| Per-user OAuth apps | kills "click Gmail, log in, done" — every user registers their own app |
| Publisher-run callback service with an enrollment registry | closes the redirect properly; ends the "no server, no publisher-held state" property, and puts every user's callback through publisher infrastructure |
| Loopback only | no risk, no remote workers — the users this exists for cannot connect at all |

**Accepted by the owner on 2026-09-03**: the relay's
open-redirect consent-phishing exposure, with the non-loopback interstitial as
the compensating control, plus provider consent screens and verification. In the
owner's words: "accept the risk with the interstitial, go ahead".

That acceptance covers the design. It does not skip the sequencing: **nothing is
registered with Google or Dropbox until the relay is live at its final URL**, so
that the URI registered with a provider is one that already serves this page.
Registering first and hosting later leaves a redirect URI pointing at a 404 that
anyone who later controls the path can claim.

### Two smaller notes

**Why not restrict origins further?** A published allowlist is impossible — every
user's dashboard origin is different and unknown to the publisher, which is the
entire reason the relay exists. The strict pattern above is the useful middle: it
stops arbitrary URLs, paths, fragments, and schemes while still serving any user.

**One disclosure to accept.** The authorization code and the state appear in the
query string of a request to the relay's host, so they land in that host's
request logs — Cloudflare's, in the owner's own account. The code is single-use,
short-lived, and useless without the PKCE verifier that never leaves the user's
worker. `relay/_headers` sets `Referrer-Policy: no-referrer` so the code cannot
travel onward in a `Referer` header either.

## Hosting

The relay is served from a domain the owner controls: `olympusplugin.ai`,
registered on Cloudflare. The relay gets its own subdomain, which keeps the apex
free for the product site.

```
https://auth.olympusplugin.ai/oauth/callback/
```

That exact string, with the trailing slash, is the `redirect_uri` to register
with both providers and to send in both the authorization request and the token
exchange.

`relay/` is the site root, so `relay/oauth/callback/index.html` serves at
`/oauth/callback/`. There is no build step: what is in `relay/` on `main` is what
is served.

### Owner steps (browser, not automated)

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** →
   **Connect to Git**, and pick this repository. Do this **after the public
   flip**, so the Cloudflare GitHub app is granted access to a repository that is
   already public rather than while it is private.
2. Production branch `main`. **Build command: none.** **Build output directory:
   `relay`.** Everything else stays default — there is nothing to build.
3. **Custom domains** → add `auth.olympusplugin.ai`. The zone is already on
   Cloudflare, so the DNS record is created for you and the certificate issues
   automatically.
4. Confirm the page is live and fails closed:
   `https://auth.olympusplugin.ai/oauth/callback/?code=x&state=y` must render the
   refusal text and stay put.
5. Confirm the headers arrive:
   `curl -sI https://auth.olympusplugin.ai/oauth/callback/` should show
   `content-security-policy`, `strict-transport-security`,
   `x-content-type-options`, and `referrer-policy`.

### Fallback: deploy without the Git integration

```sh
wrangler pages deploy relay --project-name olympus-auth
```

Run it from a checkout of `main`. It needs a Cloudflare API token with the
**Cloudflare Pages: Edit** permission in the environment
(`CLOUDFLARE_API_TOKEN`), which stays **out of this repository** — no token,
account id, or project secret is committed here. Use this while the repository is
still private, or to push a fix without waiting on the Git integration.

### Headers

`relay/_headers` carries the response headers Cloudflare Pages applies to every
path:

- **Content-Security-Policy** — the same directives as the page's meta tag, plus
  `frame-ancestors 'none'`, which a meta tag cannot express. The two must stay in
  step; `test/oauth-relay-page.test.ts` fails if they drift, including the
  script and style hashes.
- **Strict-Transport-Security** — `max-age=63072000; includeSubDomains`. No
  `preload`: that is a commitment made at the apex, and it is the owner's call,
  not this file's.
- **X-Content-Type-Options: nosniff** and **Referrer-Policy: no-referrer**.
- **X-Frame-Options: DENY**, matching `frame-ancestors` for anything that still
  reads the older header. The page also refuses to run inside a frame on its
  own, because headers are the host's promise and the page should not depend on
  one being kept.
- **Cross-Origin-Opener-Policy: same-origin**, which severs `window.opener` when
  the dashboard opened this flow in a new tab. Nothing in this design uses the
  opener — but note it, because a future design that wants the callback tab to
  `postMessage` its result back to the dashboard would have to change this
  header rather than wonder why the handle is null.

The meta tag stays in the HTML as well, so the policy still applies anywhere
`_headers` is not honoured — a local file, a mirror, a different host.

`no-referrer` is load-bearing rather than decorative: this page's own URL carries
the authorization code. Modern browsers already trim the query from a
cross-origin `Referer`, and this removes the header outright.

### Two earlier concerns are now gone

- **Repository renames.** The callback URL no longer contains the repository name
  or the owner's GitHub login, so renaming the repository during the public flip
  changes nothing about the registered `redirect_uri`.
- **Google authorized domains.** `olympusplugin.ai` is an ordinary registrable
  domain the owner controls and can verify; the Public Suffix List question that
  hung over `github.io` does not arise.

The sequencing rule is unchanged: the relay must be live at this URL **before**
the URI is registered with any provider.

> GitHub Pages
> (`https://<owner>.github.io/Olympus/oauth/callback/`, published by a
> workflow that uploaded only `relay/`) was the fallback plan before
> `olympusplugin.ai` was registered. It is not used, and the repository ships no
> Pages workflow. Kept here only so the earlier plan is not mistaken for the
> current one.

### The token-exchange endpoint

The owner picked the publisher-side exchange option for Google (see the
runbook below). It is a **Cloudflare Worker on this same zone**,
`https://auth.olympusplugin.ai/exchange/*` — same domain, same account, no new
vendor — implemented at [`exchange/`](../../exchange) and fully specified in
[`docs/ops/GOOGLE_EXCHANGE_ENDPOINT.md`](GOOGLE_EXCHANGE_ENDPOINT.md). That
document also specifies the small worker-side change — not yet applied; see
its "Worker-side integration" section — that makes the dashboard's Google
connect flow call it. Nothing in this relay contract depends on it: the relay
still only ever sees `code` and `state` in a query string, never a secret or a
token.

## Publisher app runbook

### Dropbox

1. <https://www.dropbox.com/developers/apps> → **Create app**.
2. **Scoped access**; access type **Full Dropbox** (or App folder, if the
   product decides to scope it that way — this changes what users can connect).
3. **Permissions** tab: `files.metadata.read`, `files.content.read`
   (`sharing.read` as well, to match the scopes the connector already requests).
   Submit the permission change before generating tokens.
4. **Redirect URIs**: add
   `https://auth.olympusplugin.ai/oauth/callback/` **and** the
   loopback URIs the existing same-machine flow uses
   (`http://127.0.0.1`). The loopback listener picks an ephemeral port, so
   confirm Dropbox accepts the portless entry and add explicit ports if it does
   not.
5. Use PKCE. A Dropbox app using PKCE does not need the app secret at the token
   endpoint, so the worker can complete the exchange with the public client ID
   alone. Keep the app secret out of the distributed product.
6. **Threshold**: a Dropbox app in development is capped (currently 50 users
   linked) until it is submitted for production approval. Apply before the user
   count matters, and expect a review of the scopes and the privacy policy.

### Google

1. Google Cloud console → APIs & Services → Credentials → **Create
   credentials** → **OAuth client ID** → **Web application**.
2. **Authorized redirect URIs**: add
   `https://auth.olympusplugin.ai/oauth/callback/`, exactly, trailing slash
   included. Google matches the string, not the path prefix (RFC 9700 §4.1.3).
3. Keep the existing **Desktop app** client for the same-machine loopback flow.
   A Desktop client cannot register an `https` redirect URI, so the two clients
   coexist: Desktop for loopback, Web for the relay.
4. OAuth consent screen: add `olympusplugin.ai` to **Authorized domains**. It is
   an ordinary registrable domain the owner controls, so verification is the
   normal Search Console flow — either the DNS TXT record (easiest, the zone is
   already on Cloudflare) or an HTML file dropped into `relay/`. The Public
   Suffix List problem that `github.io` would have raised does not exist here.
5. **Settled — the web client secret goes through a publisher-side exchange.**
   A Google *Web application* client must send `client_secret` at the token
   endpoint, even with PKCE, and the worker runs on the user's machine, so a
   publisher secret shipped with Olympus would not be secret. The owner picked
   the publisher-side token-exchange endpoint over the alternatives (shipping
   the secret as a public identifier; staying loopback-only for Google). It is
   a Cloudflare Worker on this same zone at `https://auth.olympusplugin.ai/exchange/*`,
   specified and implemented in
   [`docs/ops/GOOGLE_EXCHANGE_ENDPOINT.md`](GOOGLE_EXCHANGE_ENDPOINT.md) and
   [`exchange/`](../../exchange). Deploying it (creating the Web application
   client below, setting the secret, `wrangler deploy`) is the remaining owner
   step that runbook walks through. The relay contract is unaffected either
   way — the exchange happens in a publisher endpoint, never in the relay.
6. **Thresholds**: `gmail.readonly` and `drive.readonly` are *restricted*
   scopes. An unpublished app stays in Testing with a hard cap (currently 100
   test users). Publishing an app with restricted scopes requires Google's
   OAuth verification **and** an annual third-party security assessment (CASA),
   which costs money and weeks. Plan the soft launch inside the Testing cap and
   start verification before it binds.

### X

Unchanged: bring-your-own client. X users register their own app and their own
redirect URI; the relay is not involved. `x` remains in the relay's source
allowlist so that a future publisher-owned X app needs no relay change, and so
an `x` state is never silently misrouted.

## Change process

The relay page is a live OAuth redirect target for every user. Changing it:

- keep `relay/oauth/callback/index.html` self-contained — no external script,
  style, image, or font, and no request of any kind;
- the Content-Security-Policy meta tag pins the SHA-256 of the inline script and
  the inline style. Editing either without updating the tag produces a page that
  silently does nothing in a real browser. `test/oauth-relay-page.test.ts`
  recomputes both and fails on drift; it also prints the correct values;
- never widen the origin rules or the source allowlist without re-reading
  ["The redirect this opens, and what it costs"](#the-redirect-this-opens-and-what-it-costs),
  and never remove the non-loopback interstitial;
- payload changes follow [Versioning](#versioning): relay first, worker second.
