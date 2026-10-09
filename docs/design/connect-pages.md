# Connect pages

Status: built 2026-10-09 (unified dashboard, phase C). Owner decision of
2026-10-09: every unconnected source's button says **Connect**, and every
Connect opens a browser tab. Gmail, Drive and Dropbox go to the provider's
sign-in, as they already did. Readwise and X bookmarks open a key-entry page
that the relay renders from its own fixed template, keyed to the owner's
engine. The key is encrypted inside the page, so
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

Revised 2026-10-09 after independent review (PR #201): the relay, not the
engine, renders the page, so no install can put its own words, fields or
plain form on the relay's domain.

**Hand-off kind `key_page`** (`src/workers/chatgpt/handoff.ts`).
`olympus_connect_source {source: 'readwise' | 'x'}` mints
`{kind: 'key_page', source}` on the same one-time link grammar: single use,
ten minutes, held in memory, never logged. The tool mints it only when the
relay advertised that it renders connect pages (below); otherwise it answers
`connect_unavailable` and the panel keeps the help link.

1. `GET /go/<id>` spends the link. The engine generates a fresh P-256 key
   pair for this view; the private key is non-extractable. It *arms* one
   submission for the id (ten minutes from the view) and answers with a
   **descriptor** only (`application/vnd.olympus.connect-page+json`):
   `{v: 1, source, key}`, plus for X the loopback `callback` its app must
   list. A reload, or anyone else opening the link, gets "expired".
2. **The relay renders the page** (`connect-relay/shared/connect-page.ts`,
   `renderConnectPage`). It reads at most 1 KiB of the descriptor and
   accepts only the closed shape: exactly those keys, `source` from the
   closed list, `key` a base64url uncompressed P-256 point, `callback` only
   for X and only `http://127.0.0.1:<port>/oauth/callback/x`. Anything else
   is a 502 and a `response_connect_page` refusal in the log. Every label,
   sentence and field on the page is the template's: Readwise `token`;
   X `client_id` and `client_secret`. A descriptor in answer to a POST is
   never rendered.
3. The page's script makes an ephemeral P-256 key pair, runs ECDH with the
   engine key, then HKDF-SHA-256 (salt = page public ‖ engine public,
   info = context `olympus-connect-page-v1|<id>|<source>`) to derive an
   AES-256-GCM key. It seals the JSON of the fixed fields only (it refuses
   any other field name), with the context as associated data, clears the
   inputs and submits a form of only `epk`, `iv` and `ct`. The typed inputs
   have no `name`, so their plain values are never part of any submission.
   The button is disabled and an error is shown until the script runs, so a
   browser that blocks it says so instead of doing nothing.
4. `POST /go/<id>`: the relay forwards only a form body that is exactly
   `epk` (a P-256 point), `iv` (12 bytes) and `ct` (base64url), once each,
   nothing else, at most 8 KiB. Any other body is a 400 at the relay and
   never reaches an install, so no install can collect a plaintext form
   through `/go/`.
5. The engine reads nothing for a link with no armed page (404). It checks
   `Origin` (`null`, which the sandboxed page sends, the relay origin, or
   absent; anything else is 403), the form content type, then reads at most
   8 KiB. It then takes the armed entry, decrypts, and requires exactly the
   source's field set. A body that does not open puts the page back with its
   original expiry, up to three times, so junk from someone holding the link
   id cannot spend the owner's page. The fields go to
   `createKeyPageConnector` (`setup-backend.ts`), which posts in process to
   the dashboard's own routes on the loopback origin. The answer is one
   fixed sentence, with `form-action 'none'`. No worker message, provider
   text, key or ciphertext is ever echoed or logged.

**Relay** (`connect-relay/server/relay.ts`, `response-policy.ts`). The
rendered page has:

```
sandbox allow-scripts allow-forms; default-src 'none';
script-src 'sha256-<CONNECT_PAGE_SCRIPT>'; style-src 'unsafe-inline';
form-action https://<relay>/go/; base-uri 'none'; frame-ancestors 'none'
```

The page keeps an opaque origin (no `allow-same-origin`), so it cannot touch
the relay origin's storage. It cannot open connections (`connect-src` falls
back to `'none'`) and runs only the pinned script. An install's own answers
on `/go/` (an expired page, a redirect) keep the no-script, no-form
`handoff` policy, as before this change. The relay client
(`connect-relay/client/forward.ts`) forwards `POST /go/<id>`, exact path, no
query.

**Capability.** The relay's session `ready` message now names
`capabilities: ['connect_page_v1']`. The relay client passes it to the
engine's status file (`remote-access/status.json`, `relay.capabilities`),
and the worker's public-URL source sets `connectPages` only when it is
present. The panel shows Connect on Readwise and X, and the tool mints a key
page, only then; against an older relay both keep the help link.

**Script version skew.** The relay serves the page, the script and the CSP
hash from one build, so they can never disagree, and the engine never sends
script. Pinning a current and a previous hash is therefore unnecessary. The
engine–relay contract is the descriptor (`v: 1`) and the capability name; a
change to either is a new version the relay advertises before engines use
it.

**Panel.** `dashboard-view-model.ts`: when the capability is present, the
Readwise and X rows' Connect and Reconnect fixes call
`olympus_connect_source`, as Gmail's do. Telegram and WhatsApp keep the help
link. The panel client is unchanged: it already opens any `/go/` link and
polls until the row reads connected.

## Threat model

- **Relay (passive or breached logs):** it sees the descriptor, the page and
  the ciphertext, never a key that opens it. Bodies are never logged.
- **Relay (active operator):** it terminates TLS and now renders the page,
  so a malicious operator could swap the public key or the script and read
  what is typed. This protects against a curious or breached relay, not
  against its operator (as before; a key page cannot be served by OpenAI
  because the owner rule keeps keys out of ChatGPT).
- **Rogue install on the relay domain:** anyone can register an install and
  mint a `/go/` link. It can no longer serve text, fields or a plain form on
  the relay domain: its own HTML keeps the no-script, no-form sandbox, a
  descriptor outside the closed shape is a 502, and a POST that is not a
  sealed body never reaches it. The most it can show is the genuine Readwise
  or X page keyed to its own engine, which would phish a Readwise token or
  X app values. That is the same class as the OAuth hand-off links (a rogue
  can already send a victim through a genuine-looking sign-in) and is
  accepted for v1.
- **Unauthenticated submission (L1):** the POST carries no session or owner
  credential. What authorises it is holding the link id and producing
  ciphertext that opens with the per-view engine key. Someone who learned
  the link id after the owner's view (it is in the tool result OpenAI sees)
  can seal a value of their own to the public key on the page, but only if
  they also saw the page; then they could connect their own Readwise
  account or X app to the owner's Olympus. Same class as the OAuth links,
  whose callback also authenticates only by state; accepted, bounded by one
  view, ten minutes and single use.
- **Link leak:** the first opener spends it. If someone else opens it first,
  the owner sees "expired" and nothing was typed.
- **CSRF and replay:** a cross-site POST carries a foreign `Origin` and is
  refused. A sandboxed one still needs ciphertext that opens with the
  per-view engine key, bound to the link id and source. A sealed body for
  one link does not open another; a submission that connects is single use.

## Rollout

**Deploy order: relay first.** The relay build carries the template, the
POST shape check and the `connect_page_v1` capability. Rebuild and redeploy
the relay before (or with) engines that carry this change. An engine on an
older relay sees no capability and keeps the help link. An older engine on
the new relay never mints key pages, so nothing changes for it. Changing
`CONNECT_PAGE_SCRIPT` needs only a relay redeploy.
