# Olympus: Grok Bot and Cursor marketplace submission

Status: DRAFT 2026-10-15. Test results, and the legal pass on the description
and testing instructions, are still to come. Form:
https://x.ai/bot/marketplace/submit-a-plugin. Publisher terms (Anysphere):
https://cursor.com/marketplace-publisher-terms. Jamie submits, after accepting
the publisher terms, including their indemnity of Anysphere.

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
>    Bot or Cursor. [VERIFY: exact steps in each app]
> 2. The app asks you to sign in and opens a page at mcp.olympusplugin.ai.
>    Choose **Reviewing Olympus? Sign in to the demo**.
> 3. On "Sign in to the Olympus demo", enter the username and password below
>    and choose **Sign in and connect**. No MFA, email code or private network
>    is needed. You return to the app, connected.
> 4. Try these:
>    - "Use Olympus: what did Sam say about renewing my lease?" Olympus
>      returns excerpts from two emails and a lease summary, which the app
>      answers from with citations. [VERIFY]
>    - "Use Olympus: what did we decide about the kitchen renovation
>      budget?" [VERIFY]
>    - "Use Olympus: are my sources indexed?" Shows the demo's sources and
>      their status. [VERIFY]
>    - Private item: "Use Olympus: what does my bank's overdraft notice say?"
>      [VERIFY: what the demo returns for a Private match on this surface]
>    - Secret item: "Use Olympus: what's the admin password for my old
>      router?" Olympus returns nothing usable: Secret items are never sent
>      or answered from. [VERIFY]
>
> The demo belongs to a fictional person, Robin Vale: about 22 sample emails,
> notes and documents covering a lease renewal, a kitchen renovation budget,
> a trip to Lisbon and a book club. Nothing in it is real. Answers can take
> up to a minute.
>
> Username: [from 1Password]  Password: [from 1Password]

## 4. Reviewer demo engine

- Separate from the ChatGPT reviewer demo (`olympus-demo` on olympus-test),
  which stays frozen until OpenAI's review ends; this submission never
  touches it or the pinned `/openai/mcp` listing.
- Host: [pending Jamie's choice].
- Holds only `chatgpt-plugin/demo-data/`, carries the demo marker, and has
  `remote.demoConsent` with an Argon2id hash. Credentials are in 1Password
  only.
- The relay sends Grok Bot or Cursor's demo sign-in to it through
  `RELAY_DEMO_CLIENT_INSTALLS` (PR #416). The ChatGPT reviewer path is unchanged.
- A demo grant on this surface gets only `olympus_search` and
  `source_index_status` (PR #416): no anonymous questions, no answer model, no
  writes.

## 5. Pre-submission checklist

- [ ] PR #416 merged, relay deployed from exact main with
      `connect-relay/deploy/deploy.sh` (its reviewer check passed).
- [ ] Reviewer engine running, seeded, and indexed; tiers match
      `chatgpt-plugin/demo-data/README.md`.
- [ ] End-to-end receipt recorded (§6): Grok Bot and/or Cursor, through the
      demo sign-in, every §3 case.
- [ ] Logo URL serves 200 `image/png` (site deployed).
- [ ] Privacy and terms URLs live; the policy names the apps reviewers will
      use (legal pass).
- [ ] Legal pass (Olympus profile) on §2 and §3 recorded below.
- [ ] Jamie has accepted the publisher terms (indemnity) and ticked "tested
      locally and in-app".

## 6. Receipts

[pending]

## 7. Legal pass (legal-review skill, Olympus profile)

First pass 2026-10-15, on §2 and §3, against origin/main 0510258c plus PR #416
and Cursor's publisher terms. To be re-run on the final §3 once the test
results are filled in.

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

For the privacy policy (not landed here; for the legal workstream):
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
