# Public flip runbook

Status: canonical for the one-time flip. Delete or archive it once the flip is
done.

Owner decision (2026-09-03): Olympus goes public **as a fresh repository**. The
current private repository is renamed to `olympus-archived` and stays private;
a new **public** repository takes the name `Olympus` and receives a single
squashed commit of `main`. No history crosses over, because the private history
contains the personal data that PRs #120, #134, and #135 scrubbed out of the
current tree.

Read this file top to bottom before running any step. Steps are ordered, and
three of them cannot be undone.

## Roles

- **Anchor** runs everything marked `[anchor]`. All of it is `gh`/`git` from a
  terminal on the development Mac.
- **Owner** runs everything marked `[owner]`: every decision, every step in a
  vendor's web console (GitHub settings the API will not expose to a token,
  Cloudflare), and step 4, which `gh` can do but which should be the owner's
  own keystroke because it is the first irreversible one.

## Parameters

Set these once per shell. Every command below uses them, so nothing in this file
has to be edited before it is pasted.

```sh
export GH_OWNER=<github-login>          # the account that owns both repositories
export REPO=Olympus                     # the public name; unchanged by the flip
export ARCHIVE=olympus-archived         # the renamed private repository
export BASE=~/Code/Olympus              # the base clone on this Mac
export BUILD=/tmp/olympus-public-build  # throwaway build tree for the squash
export PRIVATE_HOST=<ssh-alias>         # the private runtime host
export HOST_CHECKOUT='~/.openclaw/plugin-src/Olympus'
```

## What actually changes, and what does not

The public repository keeps the **name** `Olympus`. That is load-bearing, and it
is why most of the fleet needs no edit at all:

| Unchanged because the name is unchanged | Changed because the repository identity is new |
|---|---|
| `git@github.com:$GH_OWNER/$REPO.git` — every remote URL | Deploy keys (do not transfer) |
| `--repo $GH_OWNER/Olympus` in the private-ops scripts | Branch protection and required checks |
| ClawHub spec `clawhub:olympus` | Repository secrets/variables (there are none today) |
| The release-qualification plan's install commands | Relay hosting — a new Cloudflare Pages project bound to the new repo |
| The relay callback `https://auth.olympusplugin.ai/oauth/callback/` (Cloudflare, not GitHub) | Issues, PRs, Actions runs, and every URL that names one |
| `config/critical-review.json` reviewer login | Commit SHAs — the squash creates a new root |

**The one trap.** Renaming `Olympus` → `olympus-archived` makes GitHub serve a
redirect from the old path. Creating a new repository with the name `Olympus`
**destroys that redirect**. From that moment every historical
`github.com/$GH_OWNER/Olympus/pull/N`, `/issues/N`, `/actions/runs/N`, and
`/commit/<sha>` link resolves against the *new* repository and 404s. Anything
that must stay resolvable has to be rewritten to `$GH_OWNER/olympus-archived`
(step 14).

---

## 1. Quiet point `[anchor]` — reversible

Do not start while anything is in flight. All four must hold.

```sh
gh pr list  -R "$GH_OWNER/$REPO" --state open          # must be empty
gh run list -R "$GH_OWNER/$REPO" --branch main --limit 1 \
  --json headSha,conclusion,status
git -C "$BASE" fetch origin && git -C "$BASE" rev-parse origin/main
```

- **No open PRs.** #136 and #137 are already merged; what matters is that
  nothing is open *now*. An open PR does not survive the flip; see step 16 for
  carrying one over.
- **Exact-main CI green.** The `verify` run for the exact `origin/main` SHA must
  be `completed` / `success`. A green PR head is not the receipt.
- **The private host is not mid-refresh.** Confirm with the operator lane that no
  runtime refresh, X drop-in refresh, or connector-store install is running
  against `$HOST_CHECKOUT`. A refresh that starts during steps 3–11 fetches from
  a repository that is being renamed underneath it.
- **No unpushed work in any worktree on this Mac.**

```sh
git -C "$BASE" worktree list | awk '{print $1}' | while read -r tree; do
  status=$(git -C "$tree" status --porcelain)
  [ -n "$status" ] && printf '%s\n%s\n\n' "$tree" "$status"
done
```

Record the exact SHA you are flipping. Everything below refers to it:

```sh
FLIP_SHA=$(git -C "$BASE" rev-parse origin/main); echo "$FLIP_SHA"
```

## 2. Owner-identifier scan of the whole tree `[anchor]` — reversible, and the real gate

`scripts/release-artifact.ts` only ever scanned the 29 files in the published
tarball. The flip publishes **every tracked file**. `scripts/public-flip-scan.ts`
applies the same patterns to everything `git ls-files` reports, and splits the
result by severity:

- **`identity`** — a real person, mailbox, machine, cloud tenant, or key
  material. Blocking. Must be zero, or explicitly sanctioned in
  `SANCTIONED_HITS` with a written reason.
- **`private-surface`** — names of private operations, runtime markers, and
  operational protocols. These are kept out of the *package* by the positive
  release catalog, but the files carrying them are ordinary tracked files that
  the flip decision publishes. Reported, never blocking.

```sh
git -C "$BASE" checkout main && git -C "$BASE" pull --ff-only
cd "$BASE"
bun scripts/public-flip-scan.ts          # must exit 0
bun scripts/public-flip-scan.ts --all    # every sanctioned and surface hit, with reasons
```

The scan reads **every** tracked file, including the two WhatsApp connector
sources that hold a NUL byte in a string literal — a "skip binaries" heuristic
would have excluded real published source from the only check standing between
it and a public remote. Any tracked path it cannot open at all is printed under
`UNREAD` and must be inspected by hand; an unread file is an unreviewed file,
and the flip publishes it either way.

Make the gate structural rather than a habit. Everywhere this runbook pushes,
chain it so the push cannot happen without the scan passing:

```sh
bun scripts/public-flip-scan.ts && git push -u origin main
```

**Do not push until this exits 0.** A leak pushed to a public remote is public
forever: forks, the events API, and third-party mirrors copy objects within
minutes, and deleting the repository does not retract them.

### The identifiers that are allowed to survive

Every one of these is already an owner decision recorded in PR #120, #134, or
#135, and each is a row in `SANCTIONED_HITS` with its reason:

1. **`LICENSE` copyright line** — exempted in `scannableText()`, so it produces
   no hit at all. Only that exact line, and only in `LICENSE`.
2. **The governance corpus id** (`src/core/domain-expert.ts:588`; it embeds the
   owner's first name) — also `skills/governance-research/SKILL.md`,
   `test/domain-expert-worker.test.ts`, and `test/operations.test.ts`. It is also
   the live Vertex RAG *display name*, so renaming it means renaming the live
   corpus.
3. **Embedding-ledger approver enum value** — `src/workers/embedding-ledger.ts`,
   `src/workers/embedding-ledger-observer.ts`,
   `src/workers/dashboard/pages/embedding-ledger.ts`,
   `scripts/dashboard-preview.ts`, `test/embedding-ledger.test.ts`, and the
   compiled copies in `dist/cli.js`. It is the value already written into the
   append-only ledger; the rendered string is neutral.
4. **`config/critical-review.json` reviewer login** — plus
   `test/critical-review-workflow.test.ts`, which pins it. Changing it breaks
   the required `critical-review` context.
5. **Real GitHub URLs naming the private ops repository** —
   `config/private-ops-disposition.json`,
   `config/private-ops-live-attestation.json`,
   `scripts/private-ops-disposition.ts`, `docs/V0_4_BASELINE.md`. The CI
   receipts have to stay resolvable.

Four narrower classes are also sanctioned, each row by row: the scanners' own
ban patterns (a guard has to spell out what it bans), the forbidden-string
tripwires in `test/pkm-doctrine.test.ts`, `test/lifecycle.test.ts`,
`test/release-artifact.test.ts`, `test/source-skill-runtime-context.test.ts`,
and the two dashboard tests that assert the owner's Dropbox root never renders;
the reserved-domain `example.com` Gmail fixture; and the neutral fixture values
the scrub PRs introduced (`/Users/owner/`, `/home/private/`, the
`olympus-fixture-project` service account, invented bucket names).

### If the scan reports blockers

It currently does. Treat the blocking list as the fourth scrub, not as scan
noise — the first three scrubs grepped for the owner's name and home path only,
so they could not see these. Two classes:

- **The private host alias**, spread across docs, config, scripts, skills,
  `src/`, and tests.
- **Real cloud tenant identifiers** — a Google Cloud project id in
  `src/core/domain-expert.ts` and in test fixtures, a second project id, real
  GCS bucket names, service-account addresses built on the real project, and
  Vertex corpus resource names carrying a real project number and corpus id.
- **The owner's full name and handle** in `docs/ops/OAUTH_RELAY.md`, which
  arrived with #137 after the three scrubs had run.

**The scan output is the authoritative list — do not work from a count written
down here.** Run it and read what it prints; this prose goes stale the moment
anything merges.

For each hit: neutralise it, or add a `SANCTIONED_HITS` row saying why it is
publishable. Land that as its own PR before step 3. Only the owner can decide
which of these is acceptable in public.

**On the scanner naming what it sanctions.** `scripts/public-flip-scan.ts`
spells out a few of the literals it allows, because an allowlist that cannot
name what it allows is not auditable. That is acceptable only because the same
strings already sit in the negative-guard tests (`pkm-doctrine`, `lifecycle`,
`release-artifact`, `source-skill-runtime-context`) that assert the packaged
output never contains them — the scanner adds no disclosure those tests did not
already carry. It is not a licence to add more.

## 3. Freeze `[anchor]` + `[owner]` — reversible until step 4

Announce the freeze in the operator lane. From here to step 11 nobody merges to
`main`, nobody refreshes the private host, and no session pushes a branch.

## 4. Rename the private repository `[owner]` — **IRREVERSIBLE IN PRACTICE**

`gh` can do it, but the owner should run it so the confirmation is theirs:

```sh
gh repo rename "$ARCHIVE" -R "$GH_OWNER/$REPO" --yes
gh repo view "$GH_OWNER/$ARCHIVE" --json name,visibility
```

The archived repository stays **private**, keeps every issue, PR, run, review,
and the complete history, and keeps its branch protection.

You can rename it back only until step 5 creates a repository holding the old
name. After that the name is taken.

## 5. Create the new repository — **private for now** `[anchor]` — reversible

Created private on purpose. Everything through step 10 happens behind that
wall, so the whole tree can be pushed, built, tested, and proved by CI *before*
any of it is disclosed. Publishing is one deliberate step (11), taken only after
those proofs pass.

```sh
gh repo create "$GH_OWNER/$REPO" --private \
  --description "Sovereignty-aware OpenClaw source answers across seven personal data providers." \
  --disable-wiki
gh repo edit "$GH_OWNER/$REPO" \
  --enable-issues --enable-squash-merge \
  --enable-merge-commit=false --enable-rebase-merge=false \
  --delete-branch-on-merge
gh repo view "$GH_OWNER/$REPO" --json visibility   # must say PRIVATE
```

Creating a repository with this name is what destroys the rename redirect
(see the trap above), so from here the historical links are already broken. The
repository itself is empty and private; nothing is disclosed.

## 6. Build the squashed tree `[anchor]` — reversible (local only)

Build in a throwaway clone so no old objects are reachable from the branch you
push, and so the base clone is untouched.

```sh
rm -rf "$BUILD"
git clone --no-tags "git@github.com:$GH_OWNER/$ARCHIVE.git" "$BUILD"
cd "$BUILD"
git checkout "$FLIP_SHA"
test -f LICENSE || { echo 'LICENSE missing — stop'; exit 1; }

git checkout --orphan public-main         # keeps the index, drops every parent
git commit -m "Olympus v0.4.0

Initial public source drop of the Olympus OpenClaw plugin.

History is intentionally omitted. The pre-publication history contains
personal data that was removed from the tree in three scrubs, and
rewriting it was judged less trustworthy than starting from a clean
root. The complete private history is retained in a private archive
repository.

Released under the MIT license; see LICENSE."
git branch -M main
git log --oneline                          # exactly one commit, no parents
git rev-parse main^ 2>/dev/null && echo 'HAS A PARENT — stop' || echo 'root commit, good'
```

This is the only squash Olympus ever performs. See **History is never lost**
below for the rule that governs any later rewrite.

Prove the squashed tree is byte-identical to the audited one, then scan it
again — the scan in step 2 ran against the base clone, and this is the tree that
actually gets published:

```sh
git diff --stat "$FLIP_SHA" main          # must print nothing
bun install --frozen-lockfile
bun scripts/public-flip-scan.ts           # must exit 0
```

## 7. Push `main` to the private repository `[anchor]` — reversible

Still private. This is not the disclosure — step 11 is.

```sh
git remote remove origin
git remote add origin "git@github.com:$GH_OWNER/$REPO.git"
git push -u origin main
```

`main` only. **Do not** use `--mirror`, `--all`, or `--tags`. The three
`archive/*` tags point into the old history; pushing one would drag the entire
private history into the new repository.

```sh
git ls-remote --heads --tags origin       # expect exactly one line: refs/heads/main
gh repo view "$GH_OWNER/$REPO" --json visibility   # still PRIVATE
```

## 8. Branch protection and required checks `[anchor]` — reversible

The exact contexts, copied from the archived repository's protection and
matching the job names in `.github/workflows/verify.yml` plus the status context
in `config/critical-review.json`:

| Context | Source |
|---|---|
| `static checks` | `verify.yml` job `static` |
| `fast tests` | `verify.yml` job `fast` |
| `deploy tests 1/3` | `verify.yml` job `deploy`, shard 1 |
| `deploy tests 2/3` | `verify.yml` job `deploy`, shard 2 |
| `deploy tests 3/3` | `verify.yml` job `deploy`, shard 3 |
| `Go bridge tests` | `verify.yml` job `go` |
| `critical-review` | commit status written by `critical-review.yml` |

`hermetic-go.yml` is a weekly schedule and is deliberately **not** required.

```sh
gh api -X PUT "repos/$GH_OWNER/$REPO/branches/main/protection" \
  --input - <<'JSON'
{
  "required_status_checks": {
    "strict": false,
    "contexts": [
      "critical-review",
      "static checks",
      "fast tests",
      "deploy tests 1/3",
      "deploy tests 2/3",
      "deploy tests 3/3",
      "Go bridge tests"
    ]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
gh api "repos/$GH_OWNER/$REPO/branches/main/protection" \
  --jq '.required_status_checks.contexts'
```

`enforce_admins: false` matches the archived repository: admin rights stay a
recovery capability, per `docs/ENGINEERING_PROCESS.md`.

## 9. Secrets and variables `[anchor]` — reversible

Enumerated from the workflow files: **the workflows need none.**

- `critical-review.yml` uses only `secrets.GITHUB_TOKEN`, which GitHub provides.
- `verify.yml` uses no secret at all.
- `hermetic-go.yml` uses no secret at all.
- The archived repository has zero secrets and zero variables
  (`gh secret list`, `gh variable list` — both empty). Nothing to copy.

One value is *optional* and is not a secret:

- **`OLYMPUS_GOOGLE_PILOT_CLIENT_ID`** — the publisher-owned Google Desktop
  OAuth client id, read by `scripts/release-artifact-ci.ts` and
  `scripts/release-artifact.ts`. Today no workflow sets it, so the `static
  checks` lane proves the *fail-closed refusal* instead of building the
  artifact. Setting it (as a repository **variable**, and wiring it into the
  `static` job's env) flips that lane to building and uploading a real release
  tarball on every push. A Google Desktop client id is a public identifier and
  carries no secret, but do not add it as a side effect of the flip — it is a
  release decision, and it changes what CI publishes.

## 10. Prove it before publishing `[anchor]` — reversible, and the last gate

Everything here runs against the **private** repository. Every one of these
can still be fixed by force-pushing a corrected root or deleting the
repository outright, because nothing has been disclosed yet.

From a genuinely fresh clone, not the build tree:

```sh
rm -rf /tmp/olympus-verify
git clone "git@github.com:$GH_OWNER/$REPO.git" /tmp/olympus-verify
cd /tmp/olympus-verify
git log --oneline                     # one commit
git rev-parse main^ 2>/dev/null && echo 'HAS A PARENT — stop' || echo 'root commit, good'
bun install --frozen-lockfile
bun run typecheck
bun scripts/test-lane.ts fast
bun run dist:check
OLYMPUS_GOOGLE_PILOT_CLIENT_ID=<publisher-client-id> bun scripts/release-artifact.ts
bun scripts/public-flip-scan.ts       # must exit 0 — this is what gates step 11
```

Then prove CI on the new repository, which is the only thing that proves the
required contexts are wired correctly. A private repository runs Actions on the
same runners, so this is a real receipt, not a rehearsal:

```sh
cd /tmp/olympus-verify
git checkout -b flip/ci-smoke
# make one trivial, honest change — e.g. add this runbook's follow-ups to a doc
git commit -am "Prove CI on the new repository"
git push -u origin flip/ci-smoke
gh pr create -R "$GH_OWNER/$REPO" --fill
gh pr checks -R "$GH_OWNER/$REPO" <pr-number> --watch
```

All seven required contexts must report. `critical-review` reports `success`
("Standard change") or `pending` ("exact-head review required") depending on the
paths touched — pending is a correct result, not a failure. If a context never
appears, the name in step 8 does not match the job name; fix the protection, not
the workflow.

Merge or close the smoke PR and delete its branch before step 11.

**Do not continue to step 11 until every line above passed**, in particular a
`bun scripts/public-flip-scan.ts` that exits 0 on the freshly cloned tree.

## 11. Make the repository public `[anchor]` — **IRREVERSIBLE (this is the disclosure)**

Everything up to here is recoverable. This is not.

```sh
gh repo view "$GH_OWNER/$REPO" --json visibility          # PRIVATE, one last look
gh repo edit "$GH_OWNER/$REPO" --visibility public \
  --accept-visibility-change-consequences
gh repo view "$GH_OWNER/$REPO" --json visibility,description,isTemplate
gh api "repos/$GH_OWNER/$REPO" --jq '.private, .fork, .has_wiki'
```

The moment this returns, the objects are world-readable and third parties begin
copying them. Deleting the repository afterwards does not retract anything.

**Public-repository differences that only start now.** Fork pull requests become
possible, so re-read `critical-review.yml`'s `permissions` block and set
Settings → Actions → *Require approval for first-time contributors*. Branch
protection and required checks were configured in step 8 and are unaffected.

## 12. Host the OAuth relay on Cloudflare Pages `[owner]` — reversible

The relay is **not** on GitHub Pages. It is served from the owner's Cloudflare
account at `https://auth.olympusplugin.ai/oauth/callback/`, on the
`olympusplugin.ai` domain the owner already holds there. Do not enable GitHub
Pages on the new repository.

Browser-only, after the repository is public (step 11). Cloudflare Pages can
read a private repository perfectly well, so this ordering is a choice, not a
constraint: the relay is a public endpoint and there is no reason to stand it up
before the repository it serves is public.

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** →
   **Connect to Git**.
2. Select the new `$GH_OWNER/$REPO` repository. Authorise the Cloudflare GitHub
   app for it if prompted.
3. Production branch: **`main`**. Build command: **none**. Build output
   directory: **`relay`**.
4. Deploy, then **Custom domains** → add **`auth.olympusplugin.ai`**. Cloudflare
   manages the DNS record and the certificate because the zone is on the same
   account.

Verify:

```sh
curl -sSI https://auth.olympusplugin.ai/oauth/callback/ | head -1
```

Then register `https://auth.olympusplugin.ai/oauth/callback/` as the redirect
URI with Google, Dropbox, and X. `docs/ops/OAUTH_RELAY.md` owns the state format
and origin rules; only the host changes, not the contract.

**No GitHub Pages workflow to worry about.** `.github/workflows/pages.yml` was
deleted when #137 merged, so nothing in the repository publishes to
`github.io` and nothing fails for want of Pages being enabled. That also
disposes of the `github.io` public-suffix question #137 raised about Google's
authorized domains: the relay's host is `auth.olympusplugin.ai`, an ordinary
registrable domain.

## 13. Re-point the private host `[owner]` + `[anchor]` — reversible

The URLs do not change. The **deploy keys do not transfer** — they are per
repository, and the archived repository keeps them.

1. `[owner]` On the archived repository, Settings → Deploy keys: there are three
   (a retired rehearsal key, the host read-only key, and the host write-lane
   key, the last one writable). Copy the public key text for the two that are
   still in use.
2. `[owner]` On the new public repository, Settings → Deploy keys → Add deploy
   key, once per key, preserving the read-only / write flag exactly. The
   write-lane key is the only one with write access, and `main` stays protected,
   so it still cannot push to `main`.
3. `[anchor]` Prove the host can still fetch and that its checkout is unmoved.
   The remote URL is unchanged, so nothing has to be edited — but the objects
   the host has locally are from the old history and share no ancestor with the
   new root:

```sh
ssh "$PRIVATE_HOST" "cd $HOST_CHECKOUT && git remote -v && git fetch origin && \
  git rev-parse HEAD origin/main"
```

`git pull --ff-only` **will fail** there: unrelated histories. Re-point the
checkout instead of forcing a merge:

```sh
ssh "$PRIVATE_HOST" "cd $HOST_CHECKOUT && git checkout -- dist/cli.js 2>/dev/null; \
  git fetch origin && git reset --hard origin/main && git rev-parse HEAD"
```

Then follow `docs/ops/OPENCLAW_CHANGE_PROTOCOL.md` for anything that restarts a
service. The runtime extension checkout under `~/.openclaw/extensions/` needs the
same treatment if it is a separate clone. Do not run this while the host is
mid-refresh (step 1).

## 14. Re-point references `[anchor]` — reversible

The slug is unchanged, so **no remote URL, no `REPO_SLUG` default, and no
`--repo` argument needs editing** — in this repository, in the private ops
repository, or on the host. What breaks is every link to a *historical* PR,
issue, run, or commit.

In the private ops repository:

```sh
grep -rn "github.com/$GH_OWNER/$REPO/\(pull\|issues\|actions\|commit\|tree\|blob\)/" \
  ~/Code/olympus-ops
```

Rewrite each of those to `.../$ARCHIVE/...`. Leave alone: `MIGRATION_STATUS.md`'s
source-repository line, the deploy-key settings link, and the `--repo`/
`REPO_SLUG` occurrences in `scripts/ops/` — those name the live repository and
are still correct.

In this repository:

- `config/critical-review.json` — unchanged; the login is the same account.
- `config/private-ops-disposition.json`,
  `config/private-ops-live-attestation.json`,
  `scripts/private-ops-disposition.ts` — unchanged; they point at the private
  ops repository, which is not being renamed.
- `docs/V0_4_BASELINE.md` — unchanged for the same reason.
- `README.md` badges are static shields images with no repository URL, and
  `README.md` / `docs/QUICKSTART.md` are guarded by the
  `config/dashboard-design-review.json` receipt. **Do not edit either during the
  flip.**
- `package.json` has **no** `repository` field today. Adding one is optional. It
  would land in the packaged `package.json`
  (`writePackagedPackageJson` keeps every field it does not explicitly delete),
  so it needs a `bun scripts/release-artifact.ts` run and a
  `test/release-artifact.test.ts` pass, and `package.json` is on the
  `criticalExact` list. Do it as its own PR after the flip, never inside it.
- The release-qualification plan (`docs/V0_4_RELEASE.md` Slice 3D/3F,
  `scripts/release-qualification-harness.ts`) installs from the built tarball
  and from `clawhub:olympus`. Neither names the repository URL, so both are
  unchanged.

Open issues do not transfer. `gh issue list -R "$GH_OWNER/$ARCHIVE"` currently
returns several; each one is an owner decision — re-file it publicly (rewriting
any private detail), or leave it in the archive and reference it there.

## 15. Local clones and worktrees on this Mac `[anchor]` — reversible

The base clone's `origin` URL still resolves, but its objects are the old
history. Re-point it deliberately:

```sh
git -C "$BASE" remote -v                      # origin + the ops remote
git -C "$BASE" fetch origin --prune
git -C "$BASE" rev-parse origin/main          # the new root SHA
git -C "$BASE" status --porcelain             # must be clean
git -C "$BASE" checkout main
git -C "$BASE" reset --hard origin/main
```

The `ops` remote points at the private ops repository and is untouched.

If you would rather keep the old objects reachable for a while, add the archive
as a second remote instead of deleting anything:

```sh
git -C "$BASE" remote add archive "git@github.com:$GH_OWNER/$ARCHIVE.git"
git -C "$BASE" fetch archive
```

## 16. In-flight worktrees, and carrying an open PR over

**Every branch on this Mac is based on the old root.** After the flip they share
no commit with the new `main`, so `git rebase`, `git merge`, and a PR against the
new repository all fail with "unrelated histories". There is no fix that
preserves the branch commits — carry the *diff*, not the branch.

Inventory first (run this before step 4, while the old remote is still the only
one you need):

```sh
git -C "$BASE" worktree list
git -C "$BASE" for-each-ref --format='%(refname:short) %(upstream:short)' refs/heads
```

For each branch with work worth keeping:

```sh
# 1. Before the flip: capture the diff against the exact flip SHA.
git -C /private/tmp/<worktree> diff "$FLIP_SHA" > /tmp/<branch>.patch
#    Or, if the branch is a clean series you want to keep as commits:
git -C /private/tmp/<worktree> format-patch "$FLIP_SHA" -o /tmp/<branch>-patches

# 2. After the flip: re-create it on the new root.
cd "$BASE" && git fetch origin
git worktree add -b <branch> /private/tmp/<worktree>-v2 origin/main
cd /private/tmp/<worktree>-v2
git apply /tmp/<branch>.patch          # or: git am /tmp/<branch>-patches/*.patch
git add -p && git commit
git push -u origin <branch>
gh pr create -R "$GH_OWNER/$REPO" --fill
```

Write the patch files somewhere durable, not into a session scratchpad.

For an **open PR** at flip time: prefer merging it before step 4 — that is why
step 1 requires zero open PRs. If one genuinely cannot merge, save its diff as
above, close it on the archived repository with a comment naming where it went,
and open the replacement on the public repository. PR review threads do not
transfer; copy anything load-bearing into the new PR body.

Prune the worktrees that hold nothing worth carrying — most of the `codex/*`
trees on this Mac are already merged or abandoned:

```sh
git -C "$BASE" worktree prune
git -C "$BASE" worktree list            # confirm what is left
```

## History is never lost

The squash happens **once**, here, and only to leave the pre-scrub history in the
private archive. It is not a habit.

After the flip the public repository's history is clean and is **never squashed
as a matter of course**. Pull requests are squash-merged individually, the way
`docs/ENGINEERING_PROCESS.md` already requires; that is the only squashing that
happens from then on.

If a history rewrite is ever wanted later — for any reason — the mandatory first
step is to mirror the full unsquashed public history into the private archive
repository, and verify it landed, **before** touching anything:

```sh
git -C "$BASE" remote add archive "git@github.com:$GH_OWNER/$ARCHIVE.git"  # if absent
git -C "$BASE" fetch origin --prune --tags
git -C "$BASE" push archive "origin/main:refs/heads/public-history-$(date +%F)"
git -C "$BASE" push archive --tags

# Verify it landed before rewriting anything.
git -C "$BASE" ls-remote --heads archive "public-history-*"
[ "$(git -C "$BASE" rev-parse origin/main)" = \
  "$(git -C "$BASE" ls-remote archive "refs/heads/public-history-$(date +%F)" | cut -f1)" ] \
  && echo 'mirrored' || echo 'NOT MIRRORED — stop'
```

Only after `mirrored` may a rewrite proceed. The archive is private and holds
everything, so the cost of that mirror is one push and the benefit is that no
rewrite can ever destroy the record.

## Rollback

**The archived repository is untouched by every step above.** It keeps the full
history, all issues, all PRs, all runs, and its branch protection. That is the
rollback.

Because the new repository stays private until step 11, **everything before that
step is genuinely recoverable** — including the push.

| Point of failure | Recovery |
|---|---|
| Before step 4 | Nothing happened. Stop. |
| After the rename (4), before the create (5) | `gh repo rename "$REPO" -R "$GH_OWNER/$ARCHIVE" --yes`. Fully reversed. |
| After the create (5), before the push (7) | `gh repo delete "$GH_OWNER/$REPO" --yes`, then rename the archive back. Nothing was disclosed. |
| After the push (7), before publishing (11) | The same: delete the private repository, rename the archive back. The objects only ever reached a private remote. A smaller fix — a bad root commit, a missed scrub — is a corrected orphan commit force-pushed over it, still private. |
| After publishing (11) | **The source is public and cannot be retracted.** Deleting the repository does not un-publish objects that were fetched, forked, or mirrored. Development can still return to the archived repository — rename the public one out of the way, rename the archive back — but treat the disclosure as permanent and handle it as an incident, not a rollback. |
| A blocker found after publishing | Scrub it in the public repository *and* assume the old value is already copied. Rotate anything rotatable: that is the response to a leaked identifier, not a revert. |

The asymmetry is the whole reason step 2 gates step 11, and the whole reason
step 5 creates the repository private.

## Follow-ups after the flip

- `olympusplugin.ai` is the future home of the project site, documentation, and
  downloads. Nothing in the repository points at it yet; when it does, the links
  go there rather than to a `github.io` path.
- Optional `repository` field in `package.json` — its own PR (step 14).
- Decide which archived issues to re-file publicly (step 14).
- Add a `SECURITY.md` and issue templates; a public repository gets
  unsolicited reports.
- Delete or archive this runbook once every step has run.
