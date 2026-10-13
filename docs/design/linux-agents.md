# Linux agent connections (AGENTS, rc.7)

This is the engine/dashboard part of landing-plan row 5 in
[linux-engine-service.md](linux-engine-service.md), authorized separately while
OpenAI reviews the existing package. It publishes no bundle or listing. Row 4
(OPENER) owns the Unix socket, ownership checks and browser/SSH transport.
No Linux end-to-end qualification is claimed before those tracks integrate.

| Agent | Path | Linux status | What changed |
|---|---|---|---|
| ChatGPT | Relay registration → pinned client → local consent → PKCE token | Handler fixture passes; socket and real client pending OPENER | Host-aware dashboard and consent/refusal wording |
| Claude | Same relay flow, `/mcp` surface | Same | Desktop/headless steps |
| Grok | Same relay flow, `/mcp` surface | Same | Desktop/headless steps |
| Grok Bot / Cursor | Cursor cloud callback pinned by #296 | Registration and approval fixtures; real client pending | Linux picker includes each; shared identity stays “Grok Bot or Cursor” |
| Grok API | Owner tunnel → dashboard key → bearer MCP | Key custody fixture; real tunnel pending | Linux tunnel guidance; relay still refuses keys |
| Claude Code / Codex | Linux installer `~/.local/bin/olympus serve` → stdio MCP | Linux container launcher and tools/list fixture; SVC config and OPENER worker transport pending | Correct installer name; no OpenClaw dependency for standalone path |
| Other | Owner tunnel → registered OAuth client + pairing code, or key | Handler and key fixtures; owner-only transport pending OPENER | Owner-tunnel steps include headless handoff |

## Integration seam

`AgentConnectHost` in `src/workers/dashboard/agents.ts` accepts injected
`platform`, `headless`, and `approvalHandoff: () => string | undefined`.
`DashboardPageOptions.agentConnectHost` passes it through the actual Agents
page. OPENER must supply current, validated desktop readiness and the exact
owner SSH socket-forward command, with the actual socket and configured target.
The callback is presentation only: it must not create a tunnel, approve a
client, or be treated as proof of ownership. Undefined on a headless host
shows “not ready”; AGENTS invents no UID, socket path, target or TCP fallback.
Mac ignores the handoff and preserves its original bytes. The default host
mode uses the existing `resolveServerMode`; OPENER must override it when the
systemd manager knows more than the process environment.

The current handler's direct-loopback predicate is NOT owner authentication
on Linux. OPENER must enforce the owner-only socket boundary for both relay
and owner-tunnel approvals, adapt peer/Host/cookie handling, and prove second-UID
rejection. Handler fixtures here inject a loopback peer solely to test existing
OAuth mechanics and host copy; they do not prove that boundary. The owner
socket transport must land before Linux approval is enabled for release.

## Audit: Mac assumptions and platform-neutral paths

Line references below identify the audited source (refresh after integration).

- Dashboard local prompt/manual path: `src/workers/dashboard/agents.ts:132`,
  `:337`; fixed on Linux. OpenClaw comparison in the intro at `:175`; fixed.
- Dashboard relay approval at `:77`, `:87`, `:98` assumes a colocated browser;
  Linux headless uses `approvalStep` at `:323`. Linux-only Grok Bot/Cursor
  choices preserve the old Mac picker byte for byte.
- Engine approval `src/workers/remote-oauth/handler.ts:280` checks loopback
  peer/Host, not UID. Socket adaptation belongs to OPENER. Its refusal and
  registration messages (`:283`, `:581`) now select “this computer” on Linux.
- Consent `src/workers/remote-oauth/consent-page.ts:209`, `:211`, `:221`
  names the host; fixed by injected platform. Demo copy remains frozen.
- Relay `connect-relay/server/authorize-bridge.ts:52`, `:56`, `:63`, `:81`,
  `:82`, `:89` assumes local TCP/browser and says Mac. Frozen/deferred to
  integrated transport and post-review relay copy; no host identity exists
  here from which to choose Linux versus Mac without protocol work.
  `connect-relay/server/response-policy.ts:87` also admits only the configured
  loopback TCP browser origin; OPENER must keep its forwarded origin aligned.
- Engine relay client `connect-relay/client/relay-client.ts:123`, `:493`
  validates a loopback HTTP target and fetches it directly; OPENER owns Unix
  socket dispatch without relaxing relay rejection on approval requests.
- Relay offline/not-connected/auth challenge copy:
  `connect-relay/server/relay-mcp.ts:45`, `:46`, `:174`;
  timeout/interruption `connect-relay/server/session.ts:383`, `:384`;
  busy/offline pages `connect-relay/server/relay.ts:472`, `:667`, `:687`.
  Deferred: preserving Mac bytes requires verified host context at the relay.
- Registration `connect-relay/server/client-registration.ts:49`, `:64`,
  `:132` and engine pins `src/workers/remote-oauth/pinned-clients.ts:47`,
  `:87` are platform-neutral: exact hosted callback pins, Cursor's extra
  loopback registration dropped, reserved Codex web callback refused.
- Source-provider OAuth (not agent OAuth) `src/core/connect.ts:437`, `:1934`
  binds its callback on loopback; `:2500` already chooses `xdg-open` on Linux.
  No Mac-only executable assumption. Headless source OAuth forwarding is an
  OPENER/source-connect integration concern, not a new agent auth path.
- `src/cli.ts:243`, `src/mcp/server.ts:223` dispatch stdio `serve` without
  a Darwin check. `bin/olympus:4` requires ambient Bun in source/plugin
  checkouts; the standalone installer must provide its managed-runtime
  launcher. The test models that launcher, not the installer transaction.
- Local MCP config discovery `src/core/config.ts:354`, `:389` recognizes a
  standalone install from its Mac LaunchAgent (unless ENGINE_HOST is set).
  SVC owns Linux receipt/config discovery. `src/mcp/server.ts:272` reads that
  config; `src/core/email.ts:737` creates a direct HTTP worker transport and
  `src/core/config.ts:336` defaults to loopback TCP. OPENER owns socket access
  for actual tool calls. Listing tools alone does not prove source querying.
- `integrations/agent-skills/ask-olympus/SKILL.md:1` and
  `src/core/agent-instructions.ts:25` already use host-neutral instructions.
- `INSTALL_FOR_AGENTS.md:17`, `:2093`, `:2117` retains Mac standalone wording
  and stale hosted-agent guidance. Deferred: outside engine/dashboard scope.

## Frozen files deliberately avoided

No edits to `chatgpt-plugin/**` (including `plugin.json`,
`skills/olympus-setup/SKILL.md`, `skills/olympus-ask/SKILL.md`),
`connect-relay/server/generated/**`, `connect-relay/server/**`,
`src/workers/chatgpt/**`, or `src/workers/dashboard/chatgpt/**`.
The setup skill has Mac prerequisites at lines 38–42 and approval at 50–52;
the ask skill has Mac copy at 8, 32, 35–36, 45 and 65. Both skills'
`agents/openai.yaml:5` descriptions also say Mac. `chatgpt-plugin/plugin.json`
has Mac description/platform/listing/example/commerce text at 5, 20, 27, 56,
62 and 101; `chatgpt-plugin/SUBMISSION.md` repeats it at 36, 63, 70, 71,
79–80, 113–116, 144, 146, 202, 204 and 207.
`connect-relay/server/generated/chatgpt-tools.json` has Mac text at 43, 113,
272, 603, 647 and 763. These reviewed descriptions remain frozen. The relay's
generated tool descriptions/private panel and demo sign-in text remain unchanged.
`README.md`, `INSTALL_FOR_AGENTS.md`, site/install pages and packaged agent
skills also remain unchanged. Their public Linux update is after review.

## Proof and remaining qualification

Pre-change Mac fixtures captured from `08a2f8bb` cover six remote-access
states and the full consent page/security headers (only random CSP nonce normalized). Linux fixtures cover
all five relay choices through registration, approval, PKCE exchange and
replay rejection, plus Other pairing and bearer key revocation. Separate
Claude Code/Codex fixtures start built `serve` from a home path with spaces,
no OpenClaw and no ambient Bun on PATH, then list real MCP tools.

On Omarchy, complete each real vendor connection and a tool call, desktop and
headless SSH socket approval, wrong-user/replay rejection, and installer
launcher resolution from both coding clients. Verify owner-tunnel keys and
OAuth too. Ubuntu must pass the same capability checks or refuse cleanly;
this track does not qualify a distribution or enable zkAPI. zkAPI stays off.

Remote proof for this track: `bun run build`, `bunx tsc --noEmit -p .`, and
137 tests across `linux-agents`, `linux-agents-serve`,
`dashboard-agent-connections`, `remote-oauth`, `architecture-guard`,
`public-surface-guard`, and `private-ops-disposition` passed. The initial
Linux regressions failed on the original implementation (7 failures; the
Mac fixture passed). No built-in-reasoning installer tests were run.
`canonical_docs` was 47 in this worktree (the local main ref still had 44);
this document adds exactly one, making 48. Integration must add this entry
to the then-current main count, preserving neighbouring tracks' documents.
