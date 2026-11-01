# Olympus: ChatGPT directory submission kit

Status: 1.0.0-rc.3 approved and published 2026-10-27. Listing update for
1.3.0 prepared 2026-11-01: crowned-mountain icon and clay brand colours, the
tagline "A private second brain" (#628, from the site and README), the softer Secrets wording,
Evernote and Mac files in the long description, and new release notes. The
tool surface on `/openai/mcp` stays pinned to the approved listing
(`connect-relay/server/directory/approved.ts`): engines through 1.3.0 serve
that pinned copy themselves, so re-pinning needs an engine release first.

Earlier: package complete 2026-10-10 (directory endpoint `/openai/mcp`, review
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
| Short description | A private second brain | ≤30 (22) |
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
> 1. Add the Olympus plugin and start a new chat. Type @Olympus, choose it,
>    and ask "What did Sam say about renewing my lease?" (or open Settings >
>    Apps > Olympus > Connect).
> 2. ChatGPT asks you to connect Olympus and opens a sign-in page at
>    mcp.olympusplugin.ai.
> 3. On that page, choose **"Reviewing Olympus? Sign in to the demo"**.
> 4. On "Sign in to the Olympus demo", enter the username and password from
>    this form and choose **Sign in and connect**. No MFA, email code or
>    private network is needed.
> 5. You return to ChatGPT, connected. Try the test cases below.
>
> The demo belongs to a fictional person, Robin Vale: about 22 sample emails,
> notes and documents covering a lease renewal, a kitchen renovation budget, a
> trip to Lisbon and a book club. A few items are
> deliberately Private (a bank notice, an insurance claim, tax notes) or
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
> Olympus never sends what it recognizes as a Secret (passwords, recovery
> codes, keys) to any model or answers from it. Labels are automatic and can
> be wrong. The plugin does not ask users for sensitive data, OCU keeps no
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
| 5 | 45-55 s | P2 budget question | Answer pulling note + email |
| 6 | 55-65 s | Sidebar dashboard (P4) | Sources ready, indexing complete |
| 7 | 65-78 s | P3 bank overdraft notice | Short ChatGPT reply; the private answer panel opens under it with the answer and "Not sent to ChatGPT"; caption: "Private answers appear only in this panel. Secrets are never answered." |
| 8 | 78-88 s | End card | olympusplugin.ai · Privacy · Support |

Recorded 2026-10-11 as one unedited take (about 3½ minutes, real waits kept; the developer-mode "CSP off" badge is left as ChatGPT shows it). Link-shared Drive file in `plugin.json` `review.demo_recording_url`.

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
      `assets/icon.png` is the crowned mountain (`assets/app-icon.png`,
      512 px), replacing the green mountain mark for the 1.3.0 listing
      update (2026-11-01); `brandColor` #8f5a43, `brandColorDark` #b27e65
      (the site's clay).
- [ ] Skills pass the automated scan. The scan flagged the setup skill's
      `curl | sh` line (2026-10-11: "may download or execute code outside
      the reviewed package"), so the skill now sends the user to
      https://olympusplugin.ai/install/ and shows no commands.
- [x] `mcp.json` declares `auth: {type: "oauth", client: {mode: "dcr"},
      registrationUrl: "https://mcp.olympusplugin.ai/connect/register"}`.
      The portal's Connect (2026-10-11) flips a CIMD-only server to
      "pre-defined client" before it has loaded the server's OAuth metadata,
      then refuses it for lacking a client ID; a `provided` clientId in
      mcp.json was dropped on upload. DCR is what the portal completes. The
      relay answers registration itself, without state, only for ChatGPT
      return addresses, with the ChatGPT client every engine already pins
      (connect-relay/server/client-registration.ts).
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
- Freeze (owner rule, 2026-10-12): once submitted, the demo engine is not
  changed until OpenAI's review ends. No engine or plugin updates, config or
  data edits, reinstalls or restarts, and releases skip it. Ask the owner
  before touching it; update it only after the review result.
- 2026-11-01: OpenAI's review was over, so with the owner's go the demo
  engine moved from 1.0.0-rc.3 to the 1.3.0 release (OpenClaw 2026.9.5
  unchanged). The upgrade needed three fixes on the host, kept as they are
  now (#734): `OLYMPUS_ENGINE_HOST=1` deleted from worker.env,
  `sovereignty.json` moved unchanged from `~/.olympus/` to
  `~/.config/olympus/`, and the secret store's `secret-backend.json` written
  as `file`. Before-upgrade backups: `~/releases/backup-20261101-pre-1.3.0`
  on the host. Live check through the relay as ChatGPT's client: sign-in,
  token, the pinned tools, the lease question and the Private and Secret
  refusals all passed. The policy files are unchanged and nothing is waiting
  for the privacy choice. 1.3's tier re-check moved `docs/garden-bylaws.md`
  to Private as a precaution (5 Private, was 4); the owner set it back to
  Personal the same day (4 Private, as before).
- 2026-11-01, anonymous answers on the demo after 1.3.0 (#734): the
  zkapi-clientd went from 0.1.6-olympus2 to 0.1.6-olympus4 through
  `olympus zkapi install-tools` (the wallet in `~/.config/zkapi-clientd` is
  unchanged). The owner installed the root-owned helper
  `/usr/local/libexec/olympus/zkapi-confine` and the AppArmor profile
  `/etc/apparmor.d/olympus-zkapi-confine` (undo as root:
  `apparmor_parser -R` on the profile, then delete both files), and recorded the six statements at
  version 8 in `sovereignty.json` (previous copy: `sovereignty.json.pre-ack-v8`).
  OpenClaw Labs "Custom plugin UI" is on, but the dashboard still can't
  reach the worker on this host (#735). `olympus doctor` reports the zkAPI
  route ready; no paid question has been run. The zkAPI note was funded on
  2026-10-11 and expires about 2026-11-10; renewing it means withdrawing and
  making a new deposit, after which the `fundingDate` in `sovereignty.json`
  needs the new date.
- The relay keeps shipping while the demo engine is frozen. The directory
  endpoint serves the submitted listing, not the current engine's
  (`connect-relay/server/directory/approved.ts`); CI holds the relay's
  reviewer-path answers to the submitted relay's and connects the submitted
  engine's relay client to it (`connect-relay/test/reviewer-path.test.ts`);
  `connect-relay/deploy/deploy.sh` walks the reviewer path live before and
  after each deploy and rolls back on a failure
  (`connect-relay/deploy/reviewer-check.ts`). Engines serve the same pinned
  listing on `/openai/mcp` once connected (tool calls run the current code;
  `src/workers/chatgpt/directory-surface.ts`), and CI holds the current
  handlers to the submitted schemas and runs the submitted pages against
  current results (`test/chatgpt-directory-approved.test.ts`). A new
  submission replaces the pinned listing from the submitted commit, together
  with its digests and the golden recording.
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
- [x] Demo video recorded last, from the tested dashboard.

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
