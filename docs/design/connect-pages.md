# Connect pages

Status: built 2026-10-09 (unified dashboard, phase C). Owner decision of
2026-10-09: every unconnected source's button says **Connect**, and every
Connect opens a browser tab. Gmail, Drive and Dropbox go to the provider's
sign-in, as they already did. Readwise and X bookmarks open a key-entry page
that the owner's own engine serves. The key is encrypted inside the page, so
the relay only ever carries ciphertext. The 2026-10-01 rule still holds: no
key is ever typed into ChatGPT.

## Before this change

**Relay, `/go/<id>`.** `connect-relay/server/relay.ts` (`handoff`) took
`GET` only. It routed the request to the install named in
`oly2g.<installId>.<secret>`, with no request body, on the `browser` response
policy: HTML, text or JSON, a redirect only to Google, Dropbox, the engine's
loopback port or the relay, and a CSP of
`sandbox; default-src 'none'; … form-action 'none'`. That policy allows no
script and no form. On the engine side, the relay client
(`connect-relay/client/forward.ts`) forwarded `/go/` as a GET only. The
engine (`src/workers/chatgpt/handoff.ts`) answered a link once, with a 302.
So the relay already passed whatever page the engine sent back, but it
refused a POST and allowed no script.

**Local setup sheets** (`src/workers/email-source/index.ts`,
`src/workers/source-dashboard.ts`):

| Source | Local route | What it needs |
|---|---|---|
| Readwise | `POST /dashboard/connect/api-key {source:'readwise', api_key}` → `connectPublicApiKeySource` (core/connect.ts) | One access token from readwise.io/access_token. Checked with Readwise, then stored in the secret store as `readwise.personal.token`. |
| X bookmarks | `POST /dashboard/connect/oauth/start {source:'x', client_id, client_secret}`, then X's sign-in, then `GET /oauth/callback/x` | The owner's **own** X developer app (paid X API access, Read, a confidential Web App client) with the dashboard's callback URI registered, which is the computer's loopback address. X is never publisher-owned, and the relay hand-back is publisher-only. |
| Telegram | `olympus connect telegram --pair` (core/messaging-pairing.ts) | An interactive Python helper that needs the **controlling terminal** (`controlling_terminal_required`) so that the phone number, login code and two-factor password never reach argv, logs or chat. Then chat selection. |
| WhatsApp | `olympus connect whatsapp --pair` | The bundled bridge writes a rotating QR **PNG to a local file** (`qr_png_path`), which the phone scans from Linked devices. Then chat selection. |

## What works from a browser tab anywhere

- **Readwise: fully.** It is one token. The page encrypts it, and the engine
  feeds it into the same `/dashboard/connect/api-key` route that the local
  sheet uses.
- **X bookmarks: partly.** The page collects the app's Client ID and Client
  secret, encrypted, and stores them as the owner's registration through the
  same `/dashboard/connect/oauth/start` route. It then links to X's sign-in.
  X returns to the callback URI registered in the owner's X app, which is the
  computer's loopback address (`http://127.0.0.1:<port>/oauth/callback/x`).
  So the last step completes only in a browser on the computer that runs
  Olympus. The page says this, and shows the exact callback URI. Finishing X
  from any device would take an X-specific relay hand-back: a relay callback
  URI registered in the owner's app, `/oauth/callback/x` on the relay, and the
  engine accepting a BYO-client relay state. That widens the signed-state
  hand-back to bring-your-own clients and was left out of this change.
- **Telegram: not from a tab, today.** The pairing helper reads its secrets
  only from a private controlling terminal, by design. A pairing page would
  need a new engine-side pairing session: the worker would spawn the helper
  with a pipe protocol in place of the TTY, and the page would ask for the
  phone number, then the code, then the 2FA password, in three encrypted
  steps. That is a change to the helper's custody model (the login code and
  2FA password would go through the relay as ciphertext), not a page. The
  source stays on its help link.
- **WhatsApp: not from a tab, today.** The QR exists only as a local PNG that
  rotates during the pairing run started from the CLI. A pairing page would
  need the worker to own the bridge process and stream each QR to the page.
  The page would have to refresh without network script, since this CSP
  allows no `connect-src`, so it would need meta refresh or relay-side
  support. It would also need the chat-scope step that follows. A QR is a
  linking credential for the bridge's session, and anyone who sees it while
  it is live can link their phone to it. Showing it through the relay is
  therefore a weaker boundary than the key pages, and it needs its own
  decision. The source stays on its help link.

## Design

**Hand-off kind `key_page`** (`src/workers/chatgpt/handoff.ts`).
`olympus_connect_source {source: 'readwise' | 'x'}` mints
`{kind: 'key_page', source}` on the same one-time link grammar: single use,
ten minutes, held in memory, never logged.

1. `GET /go/<id>` spends the link. The engine generates a fresh P-256 key
   pair for this view; the private key is non-extractable. The engine *arms*
   one submission for the id (ten minutes from the view) and serves the page
   (`src/workers/chatgpt/connect-page.ts`). The page carries the public key,
   the context `olympus-connect-page-v1|<id>|<source>`, the fields to type,
   and the one pinned script. A reload, or anyone else opening the link,
   gets "expired".
2. The script (`connect-relay/shared/connect-page.ts`) makes an ephemeral
   P-256 key pair, runs ECDH with the engine key, then HKDF-SHA-256
   (salt = page public ‖ engine public, info = context) to derive an
   AES-256-GCM key. It encrypts the JSON of the typed fields, with the
   context as associated data. It clears the inputs and submits a form that
   contains only `epk`, `iv` and `ct`. The typed inputs have no `name`, so
   their plain values are never part of any submission, with or without
   script.
3. `POST /go/<id>`: the engine checks `Origin` (`null`, which a sandboxed
   page sends, or the relay origin; anything else gets 403 and the page stays
   armed), the form content type, and the size (8 KiB). It then **takes** the
   armed entry, so one attempt is spent whatever it holds. It decrypts, and
   requires exactly the source's field set (Readwise `token`; X `client_id`,
   `client_secret`). The fields go to `createKeyPageConnector`
   (`setup-backend.ts`), which posts in process to the dashboard's own routes
   on the loopback origin. The answer is one fixed sentence. No worker
   message, provider text, key or ciphertext is ever echoed or logged.

**Relay** (`connect-relay/server/relay.ts`, `response-policy.ts`). `/go/`
accepts `POST`, but only `application/x-www-form-urlencoded`, capped at 8 KiB
and read through the usual upload accounting. It is routed on the control
lane like the GET. `/go/` answers get a new `handoff` policy:

```
sandbox allow-scripts allow-forms; default-src 'none';
script-src 'sha256-<CONNECT_PAGE_SCRIPT>'; style-src 'unsafe-inline';
form-action https://<relay>/go/; base-uri 'none'; frame-ancestors 'none'
```

The page keeps an opaque origin (no `allow-same-origin`), so it cannot touch
the relay origin's storage. It cannot open connections (`connect-src` falls
back to `'none'`), and it can run nothing but the pinned script. Any install
can register, so any install can serve that one script, but nothing else. The
provider-callback route keeps the no-script `browser` policy. The relay
client (`connect-relay/client/forward.ts`) now forwards `POST /go/<id>`,
exact path, no query.

**Panel.** `dashboard-view-model.ts`: the Readwise and X rows' Connect,
Reconnect and connecting fixes call `olympus_connect_source`, as Gmail's do.
Telegram and WhatsApp keep the help link. The panel client is unchanged: it
already opens any `/go/` link and polls until the row reads connected.

## Threat model

- **Relay (passive or compromised logs):** it sees the page, including the
  engine public key, and the ciphertext. It never sees a key that opens the
  ciphertext.
- **Relay (active):** it serves the page through TLS it terminates, so a
  malicious relay operator could swap the public key or the script and read
  what is typed. This protects against a curious or breached relay, not
  against the relay's operator. The ChatGPT private-answer panel avoids this
  because OpenAI serves the panel's code. A key page cannot, because the
  owner rule keeps keys out of ChatGPT.
- **Rogue install on the relay domain:** anyone can register an install and
  mint a `/go/` link that shows a key page on `mcp.olympusplugin.ai`. Before
  this change, no install could collect input on that domain. Now a phishing
  link could ask a victim for a Readwise token or X app secret and post it,
  encrypted to the attacker's engine. The script is fixed, so it cannot do
  anything else. This is a residual risk for review (see the PR).
- **Link leak** (OpenAI sees the link in the tool result): the first opener
  spends it. If someone else opens it first, the owner sees "expired" and
  nothing was typed. A leaked link after the owner's view is already spent.
- **CSRF and replay:** a cross-site POST carries a foreign `Origin` and is
  refused. A sandboxed one still needs ciphertext that opens with the
  per-view engine key, bound to the link id and source. Every submission is
  single use, and a sealed body for one link does not open another.

## Rollout

The relay's `/go/` POST support and the pinned script hash ship in the relay
build. **The relay must be rebuilt and redeployed** before an engine that
mints key pages is useful. Until then, the old relay refuses the POST (405),
and its no-script CSP stops the page from encrypting, so nothing is sent.
Changing `CONNECT_PAGE_SCRIPT` changes the hash, which needs a relay redeploy
in the same release.
