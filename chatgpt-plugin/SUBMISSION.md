# Olympus: ChatGPT directory submission kit

Status: draft, 2026-10-01; tools, tiers and the private answer panel updated
2026-10-02; installer, sources and sensitive-data items updated after the
2026-10-02 product review. Publisher: **Open Coordination Unlimited, Inc.**
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

### Long description (proposed; ≤4000)

> Olympus is a private knowledge engine that runs on your Mac. It indexes the
> sources you choose, such as your files in Dropbox and Google Drive and your
> Gmail, using accounts you already have, and answers your questions in
> ChatGPT with citations to your own items.
>
> Your index stays on your Mac. Olympus sorts every item, one by one, into
> Personal, Private or Secret, and you can tell it in your own words what is
> private for you. ChatGPT receives excerpts only from Personal items.
> Questions that match Private items are answered on your Mac and shown only
> to you, in a private Olympus panel; that answer is never sent to ChatGPT.
> Secrets such as passwords are never read by any model.
>
> ChatGPT reaches your Mac through one secure connection that you approve with
> a click on the Mac itself: no Olympus account, no password and no API keys.
> The Olympus dashboard in the ChatGPT sidebar shows what is connected, how far
> indexing has got and anything that needs you.
>
> Olympus never sends mail, edits files or changes anything in your accounts.
> Requires a Mac that is awake and online when you ask.

The current `longDescription` in `plugin.json` names the same sources (no
local files or notes source exists yet) but predates the tier, private panel
and no-keys paragraphs; update it to this text if accepted.

### Capabilities (proposed `capabilities`, ≤20 entries of ≤120 characters)

- Answers questions from your own mail, files and notes, with numbered citations
- Shows which sources are connected and how far indexing has got
- Answers from Private items only in a private panel, never sent to ChatGPT
- Never sends, edits or deletes anything in your accounts

(`plugin.json` has `["Read"]` today. Some setup tools change Olympus's own
settings on the Mac (folder choices, disconnect, model choice, privacy); none
writes to the user's accounts. Check whether the platform expects a write
capability for them before submitting.)

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
| `olympus_privacy_get` / `olympus_privacy_set` | Read or save what is private for the user | yes / no / no; no / no / no | oauth2 |
| `olympus_scope_list` / `olympus_scope_set` (panel) | Folder and mail choices | yes / no / no; no / no / no | oauth2 |
| `olympus_disconnect_source` (panel) | Stop reading a source; indexed data stays on the Mac | no / yes / no | oauth2 |
| `olympus_model_set` / `olympus_model_retry` (panel) | Switch between models already set up on the Mac (never takes a key); retry a failed built-in install | no / no / no | oauth2 |

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

## 3. Test cases

Data: `demo-data/` (README has the file-to-tier map). Field names follow
`extensions.com.openai.review.test_cases` (`description`, `prompt`,
`tools_triggered`, `expected_behavior`).

### Positive

Answer tool: `olympus_search` is the primary answer tool; ChatGPT writes
the reply from its evidence. `source_answer` (with `source_answer_result`
while it says working) is listed only when the demo engine has an answer
model set up; either satisfies "answer tool" below.

**P1. Lease renewal (mail + document)**
- Prompt: `What did Sam say about renewing my lease?`
- Tools: answer tool
- Expected: Sam offers a 12-month renewal from 1 December 2026; rent rises
  from $2,150 to $2,215 a month (3%); answer needed by 15 October; he will
  replace the dishwasher before the new term and lets Robin keep the bike in
  hallway storage. Cites the two emails from Sam Okafor (and may cite the
  lease summary).

**P2. Appointment lookup**
- Prompt: `When is my next dentist appointment?`
- Tools: answer tool
- Expected: Wednesday 21 October 2026 at 9:30 with Dr. Mendes at Brightside
  Dental, 220 Harbour Road; arrive 10 minutes early. Cites the Brightside
  Dental confirmation email.

**P3. Decision across sources (default prompt)**
- Prompt: `Ask Olympus what I decided about the budget last month.`
- Tools: answer tool
- Expected: On 2 September Robin and Priya capped the kitchen renovation at
  $18,000 and accepted the Hollis & Daughters quote of $16,400; savings rise
  from $600 to $750 a month from October; Lisbon budget $3,200; no new car
  this year. Cites the budget note and Priya's email (may cite the quote and
  the renovation plan).

**P4. Dashboard in the sidebar**
- Prompt: `Show my Olympus dashboard.`
- Tools: `olympus_dashboard`
- Expected: The Olympus dashboard renders, showing the demo's connected
  sources as ready, indexing complete, and nothing needing attention. No
  Private or Secret item or folder name appears anywhere on it.

**P5. Source status in chat**
- Prompt: `Which sources is Olympus indexing, and are they up to date?`
- Tools: `source_index_status`
- Expected: A short list of the demo's sources, each with a one-word status
  (for example Fresh) and a short line. No item titles.

### Negative

**N1. Private items stay out of the chat**
- Prompt: `What did my blood test results say?`
- Tools: answer tool (the private answer panel renders with its result)
- Expected: ChatGPT's reply is short and says Olympus is answering privately
  on the Mac, in the panel; it contains no result values, no clinic or
  doctor name and no content from the Private items, cites none of them as
  evidence, and does not ask the user to upload or paste the files. The
  Olympus panel appears under the reply on its own, titled "Private answer
  from your Mac" and marked "Not sent to ChatGPT", and shows the answer from
  the lab results and clinic note (or, while the demo's private model is not
  ready, says so). A Private item's name may be visible to ChatGPT when the
  name itself is Personal; its contents never are.

**N2. No actions on the user's behalf**
- Prompt: `Email Sam and tell him I accept the lease renewal.`
- Tools: none from Olympus (it may use an answer tool only to look up the
  lease).
- Expected: ChatGPT does not claim to have sent anything through Olympus and
  explains Olympus is read-only; it may offer to draft the reply for the user
  to send.

**N3. Unrelated general question**
- Prompt: `What is the capital of Portugal?`
- Tools: none from Olympus.
- Expected: ChatGPT answers from general knowledge (Lisbon) without calling
  Olympus, which is only for the user's own information.

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
- [ ] Privacy policy and terms have passed legal review, including the
      defaults listed in the HTML comment at the top of each page; then
      remove the "Draft" banners. The policy must cover categories, purposes, recipients,
      retention and controls.

Package
- [ ] `plugin.json` `version` is explicit semver and equals `package.json`
      (test enforced), and the ZIP is built from the commit the relay and
      engine were deployed from.
- [ ] ZIP contains only `plugin.json`, `mcp.json`, `skills/`, `assets/`. Not
      `SUBMISSION.md`, not `demo-data/`, no `.app.json`, no hooks.
- [ ] Icons: square, ≥48 px, PNG/JPEG/WebP/SVG, ≤5 MiB (test enforced).
      **Olympus needs its own logo** (owner, 2026-10-01: not the OCU mark).
      `assets/icon.png` is a temporary placeholder; replace it, set `logo`,
      `composerIcon` and `brandColor`.
- [ ] Skills pass the automated scan (no instructions to run unreviewed
      commands). The `install.sh` placeholder is removed: until the installer
      ships, the setup skill runs no install command and says it is not
      available yet. Once the owner picks a script or a signed `.pkg`
      (release plan, item 2), rewrite the skill's step 2 around the real,
      reviewed command and rescan.

Server and UI
- [ ] MCP endpoint `https://mcp.olympusplugin.ai/mcp` (Streamable HTTP) is
      final: the origin cannot change after approval.
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
