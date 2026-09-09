# Olympus Skill Resolver

This is the dispatcher. Skills are the implementation. If OpenClaw has already
loaded the skill body into context, follow it. If the body is not loaded, use
this resolver plus the tool descriptions; do not read skill files with bash,
shell, OpenClaw exec, local file reads, or session logs in ordinary calling-assistant
sessions.

## Local Model Usage

| Trigger | Skill |
| --- | --- |
| User asks for Argus, the local model lane, local model, local-only reasoning, or private lane reasoning | `skills/ask-argus/SKILL.md` |
| The task involves sensitive content that should not go to ordinary cloud models | `skills/ask-argus/SKILL.md` |
| A cheap local synthesis pass is enough and latency is acceptable | `skills/ask-argus/SKILL.md` |
| User asks Argus to use Venice or names any Venice model for sensitive source reasoning | `skills/ask-argus/SKILL.md` and `skills/ask-sources/SKILL.md` |

## Email And Source Search Usage

| Trigger | Skill |
| --- | --- |
| User asks to search, summarize, inspect, or answer questions about Gmail/email | `skills/ask-sources/SKILL.md` |
| Raw email should stay out of ordinary cloud-model context | `skills/ask-sources/SKILL.md` |
| The calling assistant needs an answer from email rather than raw message bodies | `skills/ask-sources/SKILL.md` |
| User asks to search Telegram, X/Twitter bookmarks, saved/bookmarked tweets/posts, Readwise, Drive/Docs, Dropbox, or another Olympus-indexed source | `skills/ask-sources/SKILL.md` |
| User asks to rank, count, or analyze the top posters/senders in an indexed chat | `skills/ask-sources/SKILL.md` |
| User asks for unified source search or source-index search | `skills/ask-sources/SKILL.md` |
| The calling assistant needs evidence from approved internal or public-safe corpora | `skills/ask-sources/SKILL.md` |
| The calling assistant needs private/personal source evidence across email, Dropbox, or protected Telegram | `skills/ask-sources/SKILL.md` |

Source answers may report automatic local self-heal status when incomplete
Dropbox text is being re-ingested; follow `skills/ask-sources/SKILL.md`.
For private/personal source questions, use one `source_answer` call with
`include_secure_local: true` and omit `corpus_id` unless the user explicitly
named a source or selected a prior result. Do not route legal, financial,
medical, tax, or similar private topics to Dropbox by assumption.

## OpenClaw Runtime Updates

| Trigger | Skill |
| --- | --- |
| User asks to update OpenClaw behavior, Castor routing, installed Olympus, source-tool behavior, a skill, or the resolver | `skills/update-openclaw-runtime/SKILL.md` |
| A live Castor/Argus result differs from local repo expectations | `skills/update-openclaw-runtime/SKILL.md` |
| A source tool chooses the wrong lane because live assistant context may be stale | `skills/update-openclaw-runtime/SKILL.md` |

Before any live runtime config, secret, workspace, service, gateway, or plugin
install mutation, the update skill must use the OpenClaw system-change protocol:
read canonical `docs/ops/OPENCLAW_CHANGE_PROTOCOL.md` first (packaged relative
to the update skill at `../../docs/ops/OPENCLAW_CHANGE_PROTOCOL.md`). If the
canonical file or the sanctioned restart wrapper is missing, fail closed.

<!-- OPENCLAW_PROTOCOL_NORMATIVE_SHA256: 9c49536d15699b634439a40f6cf3368d83de80f0524ca239f63de70a702282ce -->

Use `openclaw docs <query>` and/or gateway `config.schema.lookup` first; mutate
config only through `openclaw config set|unset` or gateway `config.patch`;
validate with
`openclaw config validate && openclaw doctor --lint --severity-min error --non-interactive`;
run `openclaw secrets audit --check --allow-exec` when secrets/providers
changed; restart only through `scripts/ops/openclaw-safe-restart.sh`; accept
boot proof only when systemd supplies a complete active MainPID / InvocationID /
ActiveEnterTimestamp identity, the Gateway HTTP port returns a successful
status to a bounded loopback request, and any exact
`[gateway] http server listening (N plugins…)` line
exists in that InvocationID's journal. Journal text is corroboration, not the
load-bearing verdict; in-process code can duplicate it, so no ordering or
timestamp selection proves boot. Olympus runtime resume performs this check
read-only and delegates Gateway recovery to the platform lane. It is
single-owner, always excludes canonical `openclaw-gateway.service`, and fails
closed when abort identity is unavailable. Binding the successful loopback
responder to the unit is operational corroboration, not socket attestation.
Abort publication linearizes at its durable no-clobber generation link before
a bounded commit-barrier wait (one second by default, validated maximum five);
the refresh crash-durably publishes systemd hold conditions before lifecycle
mutation and daemon-reload, including parent fsyncs for every component of a
new user-unit path, so the link immediately refuses new activation jobs while
an absent or empty hold directory remains activation-safe. One shared activity
classifier trusts only `active`/0, `inactive`/3, or `failed`/3; abort cleanup
separately requires stop success and a trusted-inactive result. Timeout leaves
the hold published.
Successful removal of the empty hold directory is resume's commit point when no
newer generation exists, but a success verdict also requires its
parent-directory fsync. Commit-ready means the recorded unit set was fully
processed even if a lifecycle call failed. A commit-ready crash recovery is
cleanup-only and never repeats lifecycle calls. A newer unclaimed generation
cannot gate old cleanup: it remains untouched for the next invocation while
the current one refuses with exit 75. Marker, record, lock, recovery-link, and
temporary-file custody stays on the private host's local ext4 filesystem. The Gateway
proof is operational corroboration, not socket
attestation (gateway boot only — the plugin list names HTTP-route plugins;
verify a specific plugin with
`openclaw plugins inspect <name>` → `Status: loaded`).
On failure, collect `openclaw gateway stability --bundle latest` and
recover values from the `config set` `.bak.*` rotation through blessed config
operations. Never substitute a direct gateway/systemd restart or automated
doctor repair. Test one real item before any batch.

## Disambiguation

- Default to ordinary calling-assistant reasoning unless a trigger fires.
- Use the skill to choose `fast` versus `deep`.
- If Argus is unavailable, fail transparently and tell the user what did not
  run locally.
- If private email evidence is unavailable through `source_answer`, do not fall
  back to cloud-visible email access unless the user explicitly approves that
  posture.
- If source-index tools are unavailable, do not fall back to raw shell,
  `sqlite3`, local database files, or provider CLIs in ordinary calling-assistant
  sessions.
- Secure source reasoning normally leaves `analyst_provider` unset so the
  deployment-approved pool selects by health/latency or follows an explicit
  configured order. If the owner explicitly constrains the request to Venice,
  use `source_answer` with `analyst_provider: venice` plus the exact requested
  `analyst_model` when provided. An `e2ee-*` secure-answer id is typed-refused
  until local key handling exists. This does not authorize broad raw
  secure-local export; the calling assistant receives the bounded
  OPSEC-scanned answer.
- For ordinary source questions, do not inspect `skills/ask-sources/SKILL.md`
  with bash or file tools. Route directly to `source_answer`,
  `source_index_search`, and `source_index_status`; those tools are the
  runtime contract.
- For named Telegram groups, pass the human title/name as `chat_scope` (for
  example `ClawRyderz`) so Olympus resolves the indexed conversation metadata.
  Do not infer `conversation_id` from messages that merely mention the group
  name.
- For X/Twitter bookmarks, saved tweets, or saved posts, `xurl` is not the
  search lane. Use `skills/ask-sources/SKILL.md` and
  `internal.x.bookmarks`; the calling assistant may receive bounded bookmark
  passages and metadata because the corpus is `S1`/`internal`, but
  connector-store results currently omit X/Twitter URLs. Reserve `xurl` for public
  post reads/searches or explicit current-account X actions. Do not use
  `xurl read` to enrich bookmark candidates unless the user explicitly asks to
  inspect a specific public X URL or post ID they provide.
- When changing any OpenClaw-facing behavior, update the resolver, skill body,
  manifest, live installed extension, workspace `AGENTS.md`/`TOOLS.md` context,
  and run a natural OpenClaw agent smoke before declaring the live issue fixed.
