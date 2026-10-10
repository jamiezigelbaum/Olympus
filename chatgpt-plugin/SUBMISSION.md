# Olympus: ChatGPT directory submission kit

Status: package complete 2026-10-10 (directory endpoint `/openai/mcp`, review
cases and release notes in `plugin.json`, own logo, final privacy policy and
terms); earlier: draft 2026-10-01; tools, tiers and the private answer panel updated
2026-10-02; installer, sources and sensitive-data items updated after the
2026-10-02 product review; installer items updated 2026-10-03 for the
one-line script. Publisher: **Open Coordination Unlimited, Inc.**
(verified OpenAI platform organization). Submit at
platform.openai.com/plugins. Platform rules referenced here come from the
OpenAI Plugins docs (deploy/submission, deploy/app-review, plugin-guidelines)
as of 2026-10-01.

This file and `demo-data/` are kit material, not plugin content: leave both
out of the uploaded ZIP (see the checklist).

## 1. Listing

| Field | Value | Limit |
|---|---|---|
| Name (`displayName`) | Olympus | ≤30 |
| Short description | Ask your own mail and files | ≤30 (27) |
| Developer name | OCU Inc. (`author.name`: OCU Inc. (Open Coordination Unlimited, Inc.)) | ≤80 |
| Category | Productivity | fixed list |
| Website | https://olympusplugin.ai | HTTPS |
| Support | https://olympusplugin.ai/support | HTTPS |
| Privacy policy | https://olympusplugin.ai/privacy | HTTPS |
| Terms of service | https://olympusplugin.ai/terms | HTTPS |
| Support email | support@olympusplugin.ai | |

### Long description

Lives in `plugin.json` (`interface.longDescription`), including the optional
anonymous-questions paragraph. zkAPI copy rule (owner, 2026-10-10): in
anything ChatGPT or its reviewers see, zkAPI is "your own zkAPI account, set
up outside ChatGPT in Olympus on your Mac"; no prices, ETH, wallet, deposit or
funding words, and one neutral side-effect line in the tool descriptions.

### Capabilities

`Answers from your own mail and files`, `Private answers panel`,
`Sources dashboard`, `Anonymous questions` (short labels, as Devic Agency's
accepted package uses).

### Default prompts (current, ≤3 of ≤128 characters)

- Ask Olympus what I decided about the budget last month.
- Use Olympus to find what Sam sent me about the lease.
- Show my Olympus dashboard.

### Tools

Annotations as generated in `connect-relay/server/generated/chatgpt-tools.json`
(R = `readOnlyHint`, D = `destructiveHint`, O = `openWorldHint`). Tools marked
"panel" are `openai/visibility: private`: the dashboard calls them, the model
does not see them.

| Tool | Purpose | R / D / O | Auth |
|---|---|---|---|
| `olympus_dashboard` | Sidebar dashboard (`ui://olympus/dashboard`); install/offline states | yes / no / no | noauth + oauth2 |
| `olympus_search` | Primary answer tool: Personal evidence with citations, plus the one-bit Private note; links the private answer panel (`ui://olympus/private-answer`) | yes / no / no | oauth2 |
| `source_index_status` | One-line status per source | yes / no / no | oauth2 |
| `source_answer` | Answer a question with citations; may return a `job_id`. Listed only when an answer model is set up on the Mac | yes / no / no | oauth2 |
| `source_answer_result` | Collect a pending answer by `job_id` (listed with `source_answer`) | yes / no / no | oauth2 |
| `olympus_connect_source` | One-time sign-in link for Gmail, Google Drive or Dropbox | no / no / yes | oauth2 |
| `olympus_privacy_get` / `olympus_privacy_set` (set: panel) | Read or save what is private for the user | yes / no / no; no / yes / no | oauth2 |
| `ask_anonymously` | Ask a frontier model a question the user already wrote, anonymously, through their own zkAPI account | no / no / yes | oauth2 |
| `open_private_question` | Open the private question panel; the question is typed there and ChatGPT never sees it or the answer | no / no / yes | oauth2 |
| `olympus_scope_list` / `olympus_scope_set` (panel) | Folder and mail choices | yes / no / no; no / no / no | oauth2 |
| `olympus_disconnect_source` (panel) | Stop reading a source; indexed data stays on the Mac | no / yes / no | oauth2 |
| `olympus_model_set` / `olympus_model_retry` (panel) | Switch between models already set up on the Mac (never takes a key); retry a failed built-in install | no / no / no | oauth2 |
| `olympus_sync_source` (panel) | Sync now for one connected source: starts the check and answers at once (at most once a minute per source); the dashboard shows what it found | no / no / no | oauth2 |

## 2. Reviewer instructions

Paste into the submission form (the ZIP must not carry reviewer instructions
or credentials). Credentials live in 1Password, never in this repository.

> Olympus normally runs on the user's own Mac, and each user approves ChatGPT
> by clicking Approve on their Mac. Reviewers do not need a Mac: a demo
> Olympus engine with made-up sample data is connected to the same relay, and
> it alone accepts a username and password.
>
> 1. Add the Olympus plugin and start a chat. Ask "Show my Olympus dashboard."
>    Before you connect, the dashboard says Olympus is not set up yet; this
>    is expected.
> 2. Ask a question such as "What did Sam say about the lease renewal?".
>    ChatGPT asks you to connect Olympus and opens a sign-in page at
>    mcp.olympusplugin.ai.
> 3. On that page, choose **"Reviewing Olympus? Sign in to the demo"**.
> 4. On "Sign in to the Olympus demo", enter the username and password from
>    this form and choose **Sign in and connect**. No MFA, email code or
>    private network is needed.
> 5. You return to ChatGPT, connected. Try the test cases below.
>
> The demo belongs to a fictional person, Robin Vale: about 25 sample emails,
> notes and documents covering a lease renewal, a kitchen renovation budget, a
> dentist appointment, a trip to Lisbon and a book club. A few items are
> deliberately Private (clinic visit, lab results, bank notice, tax notes) or
> Secret (fake router recovery codes). Private items are never sent to
> ChatGPT: when a question matches them, a small Olympus panel under
> ChatGPT's reply shows the answer, marked "Not sent to ChatGPT". Secret items
> are never answered from. Nothing in the demo is real.
>
> Answers, and private answers in the panel, can take up to a minute.
>
> The demo also has anonymous questions set up with its own zkAPI account,
> ready to use: ask "Use Olympus to ask a private question anonymously",
> type a general question in the panel that opens, and choose Ask
> anonymously. The answer appears in the panel only and can take up to three
> minutes. Nothing is sold, bought or paid in ChatGPT.
>
> How Olympus handles sensitive data: Olympus is software the user runs on
> their own Mac. It indexes the user's own mail and files there, which can
> contain health, financial or identity information. Olympus labels each item
> Personal, Private or Secret on the Mac. Only Personal items can reach
> ChatGPT's model. Private items are answered on the Mac and shown only in
> an encrypted Olympus panel that ChatGPT's model does not receive, and
> Secret items (passwords, recovery codes, keys) are never given to any
> model. The plugin does not ask users for sensitive data, OCU keeps no
> hosted copy of anyone's content, and the privacy policy asks users not to
> submit such data through the plugin. Owner decision 2026-10-10: submit with
> this explanation rather than narrow the build.

## 3. Test cases

The 5 positive and 3 negative cases, the commerce statement and the release
notes live in `plugin.json` (`extensions.com.openai.review` and
`.publication`); `test/chatgpt-plugin-package.test.ts` pins their shape.
Data: `demo-data/` (README has the file-to-tier map). Never add a negative
case that could spend money (a zkAPI ask is a spend).

Spare (if a reviewer asks about Secrets): `What's the admin password for my
old router?` → Olympus finds nothing usable; Secret items are not indexed, so
no password or code is returned.

## 4. Demo video (60-90 s)

Recorded last, from the tested dashboard: the video waits until the dashboard
UX is locked and the test cases above pass on the demo engine. Screen
recording of ChatGPT on the web, with captions, no voice needed.

| # | Time | Shot | On screen |
|---|---|---|---|
| 1 | 0-8 s | Title card | "Olympus: ask ChatGPT about your own mail, files and notes. Your data stays on your Mac." |
| 2 | 8-18 s | Add Olympus from the directory; ask "Show my Olympus dashboard" | Not-set-up state |
| 3 | 18-30 s | Connect: sign-in page → "Sign in to the demo" → Sign in and connect → back in ChatGPT | Caption: "Real users approve on their own Mac with one click; this demo uses sample data." |
| 4 | 30-45 s | P1 lease question | Answer with numbered citations; hover/open one citation |
| 5 | 45-55 s | P3 budget question | Answer pulling note + email |
| 6 | 55-65 s | Sidebar dashboard (P4) | Sources ready, indexing complete |
| 7 | 65-78 s | N1 lab results | Short ChatGPT reply; the private answer panel opens under it with the answer and "Not sent to ChatGPT"; caption: "Private answers appear only in this panel. Secrets are never answered." |
| 8 | 78-88 s | End card | olympusplugin.ai · Privacy · Support |

Upload unlisted; paste the URL as `demo_recording_url` in the form.

## 5. Pre-submission checklist

Identity and listing
- [ ] Developer name "OCU Inc." is accepted against the verified
      organization "Open Coordination Unlimited, Inc." (unverified names are
      rejected; if the portal wants an exact match, use the full name in
      `interface.developerName`). Both fields are pinned in
      `test/chatgpt-plugin-package.test.ts`.
- [ ] Submitter has org owner or Apps Management Write (`api.apps.write`).
- [ ] Website, support, privacy and terms URLs are live over HTTPS
      (`site/`, deployed with `site/deploy/deploy.sh`).
- [x] Privacy policy and terms final, effective 10 October 2026 (owner:
      no external legal review). The policy has a "Privacy policy in brief"
      section under the headings OpenAI's automated check expects (data
      collected, uses, recipients, retention incl. account and billing,
      controls and rights with a 30-day answer, contact) and covers
      anonymous questions. Deploy the site before submitting.

Package
- [ ] `plugin.json` `version` is explicit semver and equals `package.json`
      (test enforced), and the ZIP is built from the commit the relay and
      engine were deployed from.
- [ ] ZIP contains only `plugin.json`, `mcp.json`, `skills/`, `assets/`. Not
      `SUBMISSION.md`, not `demo-data/`, no `.app.json`, no hooks.
- [x] Icons: square, ≥48 px, PNG/JPEG/WebP/SVG, ≤5 MiB (test enforced).
      `assets/icon.png` is the site's mountain mark (2026-10-10), replacing
      the emoji-style placeholder; `brandColor` #2f5d50, `brandColorDark`
      #7fbfa9.
- [ ] Skills pass the automated scan. The setup skill shows the user exactly
      one reviewed command to run in Terminal themselves,
      `curl -fsSL https://olympusplugin.ai/install.sh | sh`, and never runs
      commands itself (owner decision 2026-10-03: the 1.0 installer is a
      script). If the scan rejects a `curl | sh` instruction in a skill, link
      https://olympusplugin.ai/install/ instead and rescan.

Installer
- [ ] The build under review is published to the site:
      `bun scripts/publish-release-to-site.ts` (packages the beta.11 Google
      Desktop client, the source default: owner decision 2026-10-03),
      then `site/deploy/deploy.sh --dry-run` and `site/deploy/deploy.sh`.
      `curl -fsSL https://olympusplugin.ai/install.sh | grep '^OLYMPUS_VERSION='`
      shows the version in `plugin.json`.
- [ ] Fresh-install test on a clean macOS user on Apple silicon: the one
      command ends with Olympus running; ChatGPT desktop → add the plugin →
      "Connect Olympus" → Approve on the Mac → connect Dropbox → a Personal
      and a Private question. Then re-run the command (repair), install the
      next rc over it (upgrade), and run the uninstall command.
- [ ] An Intel Mac (or `uname -m` x86_64 without Rosetta) is refused with
      the plain message, and nothing is written.

Server and UI
- [ ] MCP endpoint `https://mcp.olympusplugin.ai/openai/mcp` (Streamable
      HTTP, allowlisted tools, its own OAuth resource) is deployed; it cannot
      change after approval. `/mcp` stays for developer-mode connectors and
      gets new tools first.
- [ ] Domain verification: the token from the platform is served as plain
      text at `https://mcp.olympusplugin.ai/.well-known/openai-apps-challenge`
      (relay config, not this repo).
- [ ] `_meta.ui.domain` is set on the dashboard resource to a dedicated,
      unique origin for this plugin, and the CSP (`connectDomains`,
      `resourceDomains`; no `frameDomains`) is minimal.
- [ ] Every tool has explicit `readOnlyHint`, `destructiveHint`,
      `openWorldHint`; responses carry no request ids, traces or timestamps
      that are not needed.
- [ ] Mixed auth works from a fresh ChatGPT account: dashboard before
      linking, OAuth prompt on the answer tool (`olympus_search`), PKCE S256,
      `resource` echoed.
- [ ] Works on desktop and mobile ChatGPT (dashboard and private answer panel
      included).
- [ ] The relay's CORS list for the private answer panel (ChatGPT widget
      origins) is confirmed against a live panel in the web and desktop apps
      (design: "Private answer panel", Relay).

Reviewer demo
- [ ] Demo engine has anonymous questions on, with a funded zkAPI account
      (owner funds it) so the zkAPI case never runs dry.
- [ ] Demo engine holds only `demo-data/`, carries the demo marker, and has
      `remote.demoConsent` with an Argon2id hash; credentials stored in
      1Password and entered in the form only.
- [ ] Sign-in works immediately with no MFA, email code, magic link or
      private network.
- [ ] Each intended tier in `demo-data/README.md` is confirmed on the demo
      engine, especially the Private items behind N1, and the demo engine's
      built-in private model is ready so N1's panel shows an answer.
- [ ] All 5 positive and 3 negative cases pass on the demo engine through the
      relay, from a fresh ChatGPT account.
- [ ] Demo video recorded last, from the tested dashboard.

Policy
- [ ] Sensitive data decided and documented: users' sources can hold health,
      financial and children's information, and the privacy form invites
      people to describe it. State in the privacy policy and here what
      reaches OpenAI (Personal excerpts, file names, the "What's private for
      you?" description, folder names via the panel's `_meta`, the one-bit
      Private-match note) and what never does (Private contents and private
      answers, Secrets), then confirm against the
      [plugin guidelines](https://developers.openai.com/plugins/plugin-guidelines)
      that this handling is permitted (product review 2026-10-02, #17).
- [ ] Guidelines reread for: restricted data (Olympus never sends Private or
      Secret items, but users' sources may contain such data), data
      minimization, "unofficial connector" wording (Olympus is a knowledge
      engine; its own read access to Gmail/Drive uses the user's own OAuth
      grants), suitability for ages 13-17, and local-execution products.
- [ ] Release notes written.
