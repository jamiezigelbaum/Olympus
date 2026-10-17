# Olympus: Grok Bot and Cursor marketplace submission

Status: READY except two items (§5): the live privacy policy must name Cursor
(merged in #424, published with the 1.1.0 site), and Jamie's in-app test from
Grok Bot. Scripted end-to-end receipt and legal pass done 2026-10-15. Form:
https://x.ai/bot/marketplace/submit-a-plugin. Publisher terms (Anysphere):
https://cursor.com/marketplace-publisher-terms. Jamie accepted the publisher
terms for Open Coordination Unlimited, Inc., including their indemnity of
Anysphere, on 2026-10-15 ("Yes, I accept the terms."). Jamie clicks submit
himself.

This file is kit material only. Nothing in it ships in the package.

## 1. Form values

| Field | Value |
|---|---|
| First name / Last name | Jamie / Zigelbaum |
| Work email | Jamie's choice: an address he reads, e.g. support@olympusplugin.ai |
| Organization name | Open Coordination Unlimited, Inc. |
| Organization handle | `ocu-inc` (lowercase, no spaces; matches the planned GitHub org). Fallback if a hyphen is refused: `ocuinc` |
| Website URL | https://olympusplugin.ai |
| Logotype URL | https://olympusplugin.ai/assets/img/olympus-logo-512.png (512×512 PNG, opaque background plate; the same mark as the ChatGPT listing's `chatgpt-plugin/assets/icon.png`) |
| Where do you want to be listed? | Grok Bot, Cursor, Grok (coming soon): tick all three |
| MCP Server URL or Public GitHub Repository | https://mcp.olympusplugin.ai/mcp |
| Brief Description | §2 |
| Testing Instructions | §3, with the demo username and password from 1Password added where marked |
| Tested locally and in-app | Tick only once §5 is complete |

The listing must show our own privacy policy and terms (publisher terms,
"Privacy policy and terms display"). They are https://olympusplugin.ai/privacy
and https://olympusplugin.ai/terms. Support: https://olympusplugin.ai/support,
support@olympusplugin.ai. Licence: MIT (https://github.com/jamiezigelbaum/Olympus).

## 2. Brief description

> Olympus lets Grok Bot and Cursor answer questions from your own mail,
> files and notes, with citations. It runs on your own computer (a Mac, or a
> Linux computer running Omarchy), indexes the sources you connect there,
> and labels each item Personal, Private or Secret; automatic labels can be
> wrong. The app receives excerpts only from Personal items. For Private
> items it may receive an answer written from them on your computer (or by
> Venice, if you set it up) and their titles and sources, never the items'
> text, though the answer can repeat what they say.
> Once Olympus recognizes a Secret, it is never sent or answered from. You
> approve each app with one click on your computer. Olympus is free,
> open-source software (MIT).
> Privacy: https://olympusplugin.ai/privacy · Terms: https://olympusplugin.ai/terms

## 3. Testing instructions

> Olympus normally runs on the user's own computer, and each user approves
> the app with one click there. Reviewers don't need a computer running
> Olympus: a demo Olympus with made-up sample data is connected to the same
> server, and it alone accepts a username and password. The demo is
> read-only.
>
> 1. Add Olympus (MCP server URL https://mcp.olympusplugin.ai/mcp) in Grok
>    Bot or Cursor.
> 2. The app asks you to sign in and opens a page at mcp.olympusplugin.ai.
>    Choose **Reviewing Olympus? Sign in to the demo**. The sign-in page
>    names the app it connects ("Grok Bot or Cursor", or "Grok") and the site
>    you return to.
> 3. On "Sign in to the Olympus demo", enter the username and password below
>    and choose **Sign in and connect**. No MFA, email code or private network
>    is needed. You return to the app, connected.
> 4. Try these:
>    - "Use Olympus: what did Sam say about renewing my lease?" Olympus
>      returns cited excerpts from Sam's two emails and the lease summary
>      (renewal from 1 December at $2,215 a month; answer by 15 October;
>      dishwasher replaced), and the app answers from them.
>    - "Use Olympus: what did we decide about the kitchen renovation
>      budget?" Excerpts from the budget decision, the renovation plan and
>      Priya's email: capped at $18,000, Hollis & Daughters at $16,400.
>    - "Use Olympus: are my sources indexed?" Lists the demo's sources and
>      their status. The demo's files are in Dropbox; the other sources are
>      set up but empty.
>    - Private item: "Use Olympus: what does my bank's overdraft notice say?"
>      The notice is labelled Private, so its text is not sent to the app:
>      Olympus reports that it found no Public or Personal evidence.
>    - Secret item: "Use Olympus: what's the admin password for my old
>      router?" The same: a Secret is never sent or answered from.
>
> The demo belongs to a fictional person, Robin Vale: about 22 sample emails,
> notes and documents covering a lease renewal, a kitchen renovation budget,
> a trip to Lisbon and a book club. Nothing in it is real. The demo's labels
> were set by its publisher. A search usually returns within a few seconds.
>
> Username: [from 1Password]  Password: [from 1Password]

## 4. Reviewer demo engine

- Separate from the ChatGPT reviewer demo (`olympus-demo` on olympus-test),
  which stays frozen until OpenAI's review ends; this submission never
  touches it or the pinned `/openai/mcp` listing.
- Host: Hetzner Cloud server `olympus-grokbot-review` (project
  "multiplayer", Falkenstein; CX23, 2 vCPU, 4 GB RAM plus 4 GB swap, Ubuntu
  26.04), `ssh claw@2.31.36.62`. The firewall allows inbound SSH only; the
  engine reaches the relay outbound. Paid; created by Jamie on 2026-10-15.
  The engine runs as the unprivileged user `olympus-review`, on OpenClaw
  2026.9.5 and Node 24.20.0, matching olympus-demo. Shut it down after the
  marketplace review ends.
- Its `worker.env` must not carry `OLYMPUS_ENGINE_HOST=1` (olympus-demo's
  older build has it): on an OpenClaw-hosted engine it moves the Gateway's
  data folder away from the relay child's, and the relay never comes up.
- Plugin 1.1.0 from main 931cd17d (2026-10-17). Its worker runs from the
  user unit `olympus-worker.service` that `olympus worker install` writes.
  A plugin upgrade installs to a new folder, so after installing the new
  package and restarting the Gateway, run `olympus worker install` again;
  the old unit otherwise restarts into a missing file. (`olympus worker
  uninstall` alone leaves no worker here: the native worker service needs
  `worker.service` plugin config this engine does not have.)
- Its only source is a demo Dropbox account (folder `/OlympusDemo`) holding
  `chatgpt-plugin/demo-data/`; it carries the demo marker and has
  `remote.demoConsent` with an Argon2id hash. Credentials are in 1Password
  only. Jamie's own Dropbox is not connected (a first attempt connected the
  wrong account; it was disconnected before any folder was chosen).
- Tiers match `chatgpt-plugin/demo-data/README.md`: 18 Personal, 3 Private
  (the money files), 1 Secret (the router note). On the default preset
  nothing was flagged Private automatically, so the three Private labels are
  owner overrides (`olympus tier set … private`), moved with
  `olympus tier migrate` (3 vectors copied, no re-embedding). §3 says the
  labels were set by the demo's publisher.
- The relay sends Grok Bot or Cursor's demo sign-in to it through
  `RELAY_DEMO_CLIENT_INSTALLS` (PR #416). The ChatGPT reviewer path is unchanged.
- A demo grant on this surface gets only `olympus_search` and
  `source_index_status` (PR #416): no anonymous questions, no answer model, no
  writes.

## 5. Pre-submission checklist

- [x] PR #416 merged (8828c376); relay deployed from exact main 149eefe9
      with `connect-relay/deploy/deploy.sh`, reviewer check passed
      (2026-10-15). PR #429 (6d74a540) lets the demo sign-in redirect back to
      Cursor's callback (before it, the relay refused that redirect with a
      502); relay redeployed from 6d74a540, reviewer check passed. PR #435
      (931cd17d, independent Codex review receipt on the PR) admits every
      cloud return address Cursor's and Grok's client documents publish, by
      CIMD and by registration; relay redeployed from 931cd17d, reviewer
      check passed (2026-10-17). Drop-in
      `olympus-relay.service.d/grokbot-demo.conf` sets
      `RELAY_DEMO_CLIENT_INSTALLS` for Cursor's and Grok's client ids to the
      reviewer engine's install id.
- [x] Reviewer engine running, seeded, and indexed; tiers match
      `chatgpt-plugin/demo-data/README.md` (2026-10-15).
- [x] Scripted end-to-end receipt for every sign-in path (Cursor's client
      with `/agents/`, `/bot/` and Grok's exchange page; Grok's client with
      grok.com and console.x.ai; each by CIMD and by registration) and
      every §3 case, plus the refusals (§6, 2026-10-17).
- [ ] In-app test by Jamie from Grok Bot (his account; demo password from
      1Password): add the server, sign in to the demo, ask the lease
      question. The relay's `demo_sign_in_page` log line then shows which
      app and return address Grok Bot used.
- [x] Logo URL serves 200 `image/png`, same bytes as
      `site/assets/img/olympus-logo-512.png` (2026-10-15).
- [ ] Privacy and terms URLs live (both 200); the live policy names Cursor
      and Anysphere. Merged in #424 (f2778d53) but not yet on
      olympusplugin.ai/privacy: it describes 1.1.0 features, so it goes live
      with the 1.1.0 site publish (#422).
- [x] Legal pass (Olympus profile) on §2 and §3 recorded below (re-run on
      the final §3, 2026-10-15).
- [x] Jamie has accepted the publisher terms, including the indemnity
      (2026-10-15).
- [ ] Jamie ticks "tested locally and in-app" (only after §6) and clicks
      submit.

## 6. Receipts

### Every sign-in path (2026-10-17 16:13Z)

Against the live relay (olympus-relay 931cd17daff0) and the reviewer engine
on plugin 1.1.0 (931cd17d); password read from 1Password on stdin, no code
or token printed. Each path: demo page 200 naming the app, sign-in 303 to
exactly the requested return address, `/connect/token` 200 with a refresh
token, `tools/list` = `olympus_search`, `source_index_status` only,
`source_answer` refused as `unknown_operation`; by CIMD each also ran the
lease question (Sam's two emails, the lease summary, the garden by-laws).

| Path | Client named | Returns to | Result |
|---|---|---|---|
| CIMD, Cursor's id | Grok Bot or Cursor | `www.cursor.com/agents/mcp/oauth/callback` | ok |
| CIMD, Cursor's id | Grok Bot or Cursor | `www.cursor.com/bot/mcp/oauth/callback` | ok |
| CIMD, Cursor's id | Grok Bot or Cursor | `grok.com/connectors-oauth-exchange-code/` | ok |
| CIMD, Grok's id | Grok | `grok.com/connectors-oauth-exchange-code/` | ok |
| CIMD, Grok's id | Grok | `console.x.ai/connectors-oauth-exchange-code/` | ok |
| Registration of Cursor's published list (5 addresses) → Cursor's id with its 3 cloud ones | Grok Bot or Cursor | each of the 3 | ok ×3 |
| Registration as Grok Bot sent it (`/agents/` + localhost) → Cursor's id, `/agents/` only | Grok Bot or Cursor | `/agents/` | ok |
| Registration of Grok's exchange page alone → Grok's id | Grok | grok.com | ok |
| Registration of Grok's published list → Grok's id | Grok | console.x.ai | ok |

Refused, as intended: Cursor's id with a loopback address or console.x.ai,
and Grok's id with Cursor's `/agents/` or a loopback address (400 error
page, no redirect); registrations of loopback addresses alone, Cursor's
address with console.x.ai, or with an unlisted address (400
`invalid_redirect_uri`). 18/18 checks ok.

Content cases on the new build (Cursor's id, `/bot/`): kitchen budget →
plan, budget decision and Priya's email; bank overdraft notice (Private) and
router password (Secret) → "Olympus found no Public or Personal evidence for
this question in 5 searched sources."

The relay logged one `demo_sign_in_page` line per page, with the app, the
return address and the status (200 shown, 400 refused), and nothing else.
olympus-demo untouched; read-only status after the deploy: Dropbox synced
16:07Z, items unchanged (20 Personal, 4 Private).

Full log: the parent session's notes folder,
`grok-bot-reviewer-paths-receipt-2026-10-17.log`.

### First receipt (2026-10-15)

2026-10-15 23:35Z, against the live relay (olympus-relay 6d74a5404cc7) as
Cursor's pinned client (`https://cursor.com/oauth/mcp-client.json`, redirect
`https://www.cursor.com/agents/mcp/oauth/callback`, PKCE S256), password read
from 1Password on stdin, no token printed:

- `GET /connect/demo/authorize` → 200, "Sign in to the Olympus demo",
  names Grok Bot or Cursor.
- Sign-in POST → 303 to `https://www.cursor.com/agents/mcp/oauth/callback`
  with a code; `/connect/token` → 200, access token (expires_in 3600) and a
  refresh token.
- MCP `initialize` → 200 `olympus`; `tools/list` → `olympus_search`,
  `source_index_status` only. `source_answer` and `ask_anonymously` →
  `unknown_operation`.
- `source_index_status` → the demo's sources and their state.
- `olympus_search`: lease question 737 ms, Sam's two emails and the lease
  summary; kitchen budget 630 ms, budget decision, plan and Priya's email;
  bank overdraft notice (Private) and router password (Secret) → "Olympus
  found no Public or Personal evidence for this question in 5 searched
  sources."
- olympus-demo (ChatGPT reviewer engine) untouched; read-only status after
  each change: Dropbox syncs still completing on schedule, items unchanged
  (20 Personal, 4 Private).

Full log: the parent session's notes folder,
`grok-bot-reviewer-path-receipt-2026-10-15.log`.

## 7. Legal pass (legal-review skill, Olympus profile)

First pass 2026-10-15, on §2 and §3, against origin/main 0510258c plus PR #416
and Cursor's publisher terms. Re-run on the final §3 the same day, against the
§6 receipt: each §3 result is what the receipt shows; the Private case says
only that the text isn't sent (the demo grant has no answer model, so §2's
"answer written from them" is not claimed for the demo); §3 says the demo's
labels were set by its publisher, not detected; the timing claim is "usually
within a few seconds", not a promise.

Fixed in this file:
- §2 said the app gets "at most an answer written on your computer" for
  Private items. Venice can write that answer off the computer, and the
  item's title and source go with it. Now worded as in the privacy policy.
- §2 said "Secret items are never used". The ruling wording is "once Olympus
  recognizes a Secret, it is never sent or answered from".
- §2 now says automatic labels can be wrong.
- §3's Secret case said "never indexed". Olympus keeps a location record of
  each Secret, so it now says "never sent or answered from".
- Publisher terms: the product is named "Cursor" only. Nothing compares
  Olympus with Grok, Grok Bot or Cursor or criticizes them. "Free" is the
  owner's ruling wording, and OCU charges nothing. Venice and zkAPI are
  optional third-party services the user pays for directly; they are not
  fees through the Marketplace.

For the privacy policy: resolved in #424 (f2778d53), which names Cursor and
Anysphere in the recipients, the relay section and the accepted clients.
Not live until the 1.1.0 site publish. The original findings:
- `site/privacy/index.html` names Grok Bot but not Cursor. Two absolute
  lists omit Cursor, although the relay accepts Cursor's client (Grok Bot
  and Cursor's cloud agents share it): "through the relay only the published
  clients of ChatGPT, Claude, Grok and Grok Bot are accepted" (Security) and
  "ChatGPT, Claude, Grok and Grok Bot reach your computer through the relay"
  (relay section). Proposed: "… ChatGPT, Claude, Grok, Grok Bot and Cursor …"
  in both.
- Recipients: "xAI (Grok and Grok Bot)" / "Anthropic and xAI provide Claude,
  Grok and Grok Bot". Grok Bot signs in with Cursor's client (Anysphere's
  app, `src/workers/remote-oauth/pinned-clients.ts`), and the marketplace is
  run by Anysphere. Proposed: "Anthropic (Claude), xAI (Grok), and Anysphere
  (Cursor and Grok Bot, with the models they use) receive …". Who operates
  Grok Bot could not be confirmed from a public page (x.ai/bot answered
  403); confirm before landing.
- Any content change bumps the policy's effective date. Fold it into the
  open legal PR (#413) or the next legal pass, and land it before submitting,
  since the listing must show an accurate policy.

Owner ruling to revisit: 2026-10-13, "Nothing is added in Grok Bot; it uses
the grok.com connection". A marketplace listing adds Olympus inside Grok Bot.
Once listed, `site/install/grok/` and the reply brief should mention that
route too (website and legal sessions, after acceptance).
