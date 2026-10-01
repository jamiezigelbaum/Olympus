# Olympus: ChatGPT directory submission kit

Status: draft, 2026-10-01. Publisher: **Open Coordination Unlimited, Inc.**
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
| Developer name | Open Coordination Unlimited, Inc. (see checklist: `plugin.json` still says the owner's personal name) | ≤80 |
| Category | Productivity | fixed list |
| Website | https://olympusplugin.ai | HTTPS |
| Support | https://olympusplugin.ai/support | HTTPS |
| Privacy policy | https://olympusplugin.ai/privacy | HTTPS |
| Terms of service | https://olympusplugin.ai/terms | HTTPS |
| Support email | support@olympusplugin.ai | |

### Long description (proposed; ≤4000)

> Olympus is a private knowledge engine that runs on your Mac. It indexes the
> sources you choose, starting with files and notes on your Mac and then
> accounts you already have such as Gmail, Google Drive and Dropbox, and
> answers your questions in ChatGPT with citations to your own items.
>
> Your index stays on your Mac. Olympus labels every item Public, Personal,
> Private or Secret. ChatGPT only ever receives answers and excerpts built
> from Public and Personal items; Private items are answered on your Mac or
> withheld, and Secrets such as passwords are never read by any model.
>
> ChatGPT reaches your Mac through one secure connection that you approve with
> a click on the Mac itself: no Olympus account, no password. The Olympus
> dashboard in the ChatGPT sidebar shows what is connected, how far indexing
> has got and anything that needs you.
>
> Olympus is read-only. It never sends mail, edits files or changes anything
> in your accounts. Requires a Mac that is awake and online when you ask.

The current `longDescription` in `plugin.json` says the same without the tier
paragraph or the read-only sentence; update it to this text if accepted.

### Capabilities (proposed `capabilities`, ≤20 entries of ≤120 characters)

- Answers questions from your own mail, files and notes, with numbered citations
- Shows which sources are connected and how far indexing has got
- Keeps Private and Secret items out of ChatGPT; they stay on your Mac
- Read-only: never sends, edits or deletes anything

(`plugin.json` has `["Read"]` today.)

### Default prompts (current, ≤3 of ≤128 characters)

- Ask Olympus what I decided about the budget last month.
- Use Olympus to find what Sam sent me about the lease.
- Show my Olympus dashboard.

### Tools (all `readOnlyHint: true`, `destructiveHint: false`, `openWorldHint: false`)

| Tool | Purpose | Auth |
|---|---|---|
| `olympus_dashboard` | Sidebar dashboard (`ui://olympus/dashboard`); install/offline states | noauth + oauth2 |
| `source_index_status` | One-line status per source | oauth2 |
| `source_answer` | Answer a question with citations; may return a `job_id` | oauth2 |
| `source_answer_result` | Collect a pending answer by `job_id` | oauth2 |

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
> Secret (fake router recovery codes) so you can see that Olympus withholds
> them. Nothing in the demo is real.
>
> Answers can take up to a minute. If ChatGPT gets `status: "working"`, it
> calls `source_answer_result` to collect the answer.

## 3. Test cases

Data: `demo-data/` (README has the file-to-tier map). Field names follow
`extensions.com.openai.review.test_cases` (`description`, `prompt`,
`tools_triggered`, `expected_behavior`).

### Positive

**P1. Lease renewal (mail + document)**
- Prompt: `What did Sam say about renewing my lease?`
- Tools: `source_answer` (then `source_answer_result` if working)
- Expected: Sam offers a 12-month renewal from 1 December 2026; rent rises
  from $2,150 to $2,215 a month (3%); answer needed by 15 October; he will
  replace the dishwasher before the new term and lets Robin keep the bike in
  hallway storage. Cites the two emails from Sam Okafor (and may cite the
  lease summary).

**P2. Appointment lookup**
- Prompt: `When is my next dentist appointment?`
- Tools: `source_answer`
- Expected: Wednesday 21 October 2026 at 9:30 with Dr. Mendes at Brightside
  Dental, 220 Harbour Road; arrive 10 minutes early. Cites the Brightside
  Dental confirmation email.

**P3. Decision across sources (default prompt)**
- Prompt: `Ask Olympus what I decided about the budget last month.`
- Tools: `source_answer`
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

**N1. Private items are withheld**
- Prompt: `What did my blood test results say?`
- Tools: `source_answer`
- Expected: Olympus withholds the answer: either the fixed answer "Olympus
  can answer this only from private items, which stay on your Mac." or a
  not-found answer with the fixed note "Some matching items are private and
  stay on your Mac." ChatGPT relays that the answer stays on the Mac. No
  result values, no clinic or doctor name, no item titles and no citations
  for the Private items reach the conversation.

**N2. No actions on the user's behalf**
- Prompt: `Email Sam and tell him I accept the lease renewal.`
- Tools: none from Olympus (it may use `source_answer` only to look up the
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
| 7 | 65-78 s | N1 lab results | Fixed "stays on your Mac" sentence; caption: "Private and Secret items never go to ChatGPT." |
| 8 | 78-88 s | End card | olympusplugin.ai · Privacy · Support |

Upload unlisted; paste the URL as `demo_recording_url` in the form.

## 5. Pre-submission checklist

Identity and listing
- [ ] Developer name matches the verified organization exactly: Open
      Coordination Unlimited, Inc. `plugin.json` still has the owner's personal
      name in `author.name` and `interface.developerName`
      (`test/chatgpt-plugin-package.test.ts` pins `author.name`). Owner to
      decide; unverified names are rejected.
- [ ] Submitter has org owner or Apps Management Write (`api.apps.write`).
- [ ] Website, support, privacy and terms URLs are live over HTTPS
      (`site/`, deployed with `site/deploy/deploy.sh`).
- [ ] Privacy policy and terms have passed legal review: remove the "Draft"
      banners and resolve every `[CONFIRM]` in `site/privacy/` and
      `site/terms/`. The policy must cover categories, purposes, recipients,
      retention and controls.

Package
- [ ] `plugin.json` `version` is explicit semver and equals `package.json`
      (test enforced), and the ZIP is built from the commit the relay and
      engine were deployed from.
- [ ] ZIP contains only `plugin.json`, `mcp.json`, `skills/`, `assets/`. Not
      `SUBMISSION.md`, not `demo-data/`, no `.app.json`, no hooks.
- [ ] Icons: square, ≥48 px, PNG/JPEG/WebP/SVG, ≤5 MiB (test enforced).
      Confirm we own the artwork: `assets/icon.png` looks like a platform
      emoji; replace it with original art if so. Consider `composerIconDark`
      / `logoDark`.
- [ ] Skills pass the automated scan (no instructions to run unreviewed
      commands; the setup skill's `install.sh` placeholder must be replaced by
      the signed installer or removed before submission).

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
      linking, OAuth prompt on `source_answer`, PKCE S256, `resource` echoed.
- [ ] Works on desktop and mobile ChatGPT (dashboard included).

Reviewer demo
- [ ] Demo engine holds only `demo-data/`, carries the demo marker, and has
      `remote.demoConsent` with an Argon2id hash; credentials stored in
      1Password and entered in the form only.
- [ ] Sign-in works immediately with no MFA, email code, magic link or
      private network.
- [ ] Each intended tier in `demo-data/README.md` is confirmed on the demo
      engine, especially the Private items behind N1.
- [ ] All 5 positive and 3 negative cases pass on the demo engine through the
      relay, from a fresh ChatGPT account.
- [ ] Demo video recorded last, from the tested dashboard.

Policy
- [ ] Guidelines reread for: restricted data (Olympus never sends Private or
      Secret items, but users' sources may contain such data), data
      minimization, "unofficial connector" wording (Olympus is a knowledge
      engine; its own read access to Gmail/Drive uses the user's own OAuth
      grants), suitability for ages 13-17, and local-execution products.
- [ ] Release notes written.
