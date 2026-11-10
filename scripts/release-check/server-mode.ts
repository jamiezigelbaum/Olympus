/**
 * The Mac server-mode leg of the release check (#778), on the throwaway Mac VM after every other leg: the parts of the dashboard's
 * server-mode switch (#751, #777) that hands-on testing on test-mac found broken and the rest of the check never reached.
 *
 *   1. Server mode on, then off, the way the dashboard's Save sends it (POST /dashboard/engine/computer-use from a local control
 *      session, as the Engine card's switch does). The product's own helper then runs its administrator request
 *      (`osascript … with administrator privileges`). Nobody is at the VM to type a password, so a stand-in answers that prompt:
 *      before the switch, root (through `sudo -n`) sets the system.privilege.admin right to `allow`, so the product's unmodified
 *      osascript runs its script as root without a dialog. The stand-in is checked first (osascript must come back as uid 0) and
 *      the right is put back as it was at the end. After each switch: the daemon plist (/Library/LaunchDaemons, root:wheel 0644,
 *      UserName the owner), the per-user LaunchAgent removed (on) or back (off), exactly one engine running under the expected
 *      launchd domain, and /dashboard.json answering with the new setting.
 *   2. With server mode on, the VM restarts (`sudo -n shutdown -r now` in the guest). The wait is bounded and polls: the machine must
 *      come back with a new boot time and the owner's desktop session, and the engine must answer from the system domain, with no
 *      second engine in the owner's login domain.
 *   3. An agent on a second, standard account: the leg creates the account and, as the dashboard's "Agent on another account of this
 *      computer" does, a loopback key. Run as that account, the key initializes the MCP endpoint and lists its tools, a request with
 *      no key gets 401, and once the key is revoked it is refused (a second key keeps the listener open, so the refusal is the
 *      revoked key's, not a closed port). The keys are kept on the machine and never come back to the harness.
 *
 * Before any of it, the candidate gets the published, signed Olympus Engine helper, as the site's installer gives it: the release
 * check installs a local candidate bundle with no helper (the signed, notarized zip is built only on the release Mac), and the
 * product refuses server mode without one. Inside the VM the leg reads the helper pins from the live installer
 * (https://olympusplugin.ai/install.sh), downloads that zip from the site's releases, checks its SHA-256 and size, unpacks it with ditto and
 * runs the candidate's own `olympus engine install-helper --from` with the pinned team id, then needs `engine status` to report the
 * helper installed and in use. A helper already in use is kept. If the helper cannot be installed, `server-mode.helper` fails with
 * the reason and the switch and restart are skipped; the second account still runs.
 *
 * Linux has no server mode: the leg reports one skip there. Every step is a bash script run through the driver's `exec` as the VM's
 * test user (who has passwordless sudo on the Tart image), plus the in-machine agent's `dashboard-json`. Waits take a clock seam so
 * the tests never wait on the real one.
 */
import type { CheckResult } from './report.ts';
import { parseRpc } from './live-accounts.ts';

export const SERVER_MODE_BOUNDS = {
  /** From Save to the helper's final result and a dashboard that answers again. */
  switchMs: 5 * 60_000,
  /** From the restart request to a machine that answers with the owner's desktop session up. */
  restartMs: 10 * 60_000,
  /** From a machine that is back to an engine that answers. */
  engineMs: 5 * 60_000,
  pollMs: 5_000,
};

/** The helper's own final words (engine-service.ts runMacServerModeChange). */
export const SERVER_MODE_DONE = {
  on: 'Olympus will start by itself once the disk is unlocked.',
  off: 'Olympus will run while this account is signed in.',
} as const;

const LABEL = 'ai.olympusplugin.engine';
export const DAEMON_PLIST = `/Library/LaunchDaemons/${LABEL}.plist`;
const ORIGIN = 'http://127.0.0.1:8010';
/** The second account. Fixed: the machine is thrown away after the run, and a leftover from a retry is removed first. */
export const SECOND_ACCOUNT = 'rcagent';
const SECOND_DIR = '$HOME/rc/second-account';
/** The site's Mac installer: its MACOS_HELPER_* pins name the published, signed helper (scripts/install-macos.sh). */
export const PUBLISHED_INSTALLER = 'https://olympusplugin.ai/install.sh';
const RELEASE_BASE = 'https://olympusplugin.ai/releases';
/** What `engine status` shows once the helper is installed and the engine starts through it (install-macos.sh's own test). */
export const HELPER_IN_USE = '"helper":{"installed":true,"in_use":true';

export interface ServerModeHost {
  os: 'linux' | 'macos';
  exec(script: string, timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string; timedOut?: boolean }>;
  /** The in-machine agent's `dashboard-json`: the dashboard's own /dashboard.json, as the owner's page reads it. */
  dashboard(): Promise<{ status: number; body: string } | undefined>;
}

export interface ServerModeClock { now(): number; sleep(ms: number): Promise<void> }

const realClock: ServerModeClock = { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };

// ---------------------------------------------------------------------------
// Scripts. Each starts with a marker line naming its step, so a log (and a test's stand-in machine) can tell them apart.

const marker = (step: string): string => `# rc-server-mode: ${step}\n`;

const PRELUDE = `set -u
emit() { printf '%s\\t%s\\n' "$1" "$2"; }
`;

/**
 * A local control session (what the unlocked dashboard page holds), then one POST from it; the response body goes to $out.
 * The local mint needs the owner's proof first (#1153): a session the owner's worker token opens, as the launch link does.
 * The token stays in this shell; nothing prints it or the cookies.
 */
const CONTROL_POST = `control_post() {
  local h b j cookie csrf token
  h=$(mktemp); b=$(mktemp); j=$(mktemp)
  token=$("$HOME/.local/bin/olympus" dashboard token 2>/dev/null) || token=''
  code=$(curl -sS --max-time 30 -c "$j" -o /dev/null -w '%{http_code}' -X POST -H "origin: ${ORIGIN}" -H "Authorization: Bearer $token" "${ORIGIN}/dashboard/control/session" 2>/dev/null) || code=000
  unset token
  if [ "$code" != 200 ]; then rm -f "$h" "$b" "$j"; code="owner-session-$code"; return 1; fi
  code=$(curl -sS --max-time 30 -b "$j" -D "$h" -o "$b" -w '%{http_code}' -X POST -H "origin: ${ORIGIN}" "${ORIGIN}/dashboard/control/session/local" 2>/dev/null) || code=000
  rm -f "$j"
  if [ "$code" != 200 ]; then rm -f "$h" "$b"; code="session-$code"; return 1; fi
  cookie=$(tr -d '\\r' < "$h" | awk 'tolower($1)=="set-cookie:" { v=$2; sub(/;.*/, "", v); printf "%s%s", sep, v; sep="; " }')
  csrf=$(sed -n 's/.*"csrf_token" *: *"\\([^"]*\\)".*/\\1/p' "$b" | head -1)
  rm -f "$h" "$b"
  out=$(mktemp)
  code=$(curl -sS --max-time 60 -o "$out" -w '%{http_code}' -X POST -H "origin: ${ORIGIN}" -H "cookie: $cookie" -H "x-olympus-csrf: $csrf" -H 'content-type: application/json' --data "$2" "${ORIGIN}$1" 2>/dev/null) || code=000
}
`;

/**
 * Gives the installed candidate the published helper, as install-macos.sh does: pins from the live installer, the zip checked
 * against them, unpacked with ditto, `engine install-helper --from` with the pinned team. Emits `helper.fail` with the reason and
 * stops at the first thing that goes wrong; a helper already in use is kept (`helper.already 1`).
 */
export function helperScript(): string {
  return marker('helper') + PRELUDE + `support="$HOME/Library/Application Support/Olympus"
bun="$support/runtime/bun"; cli="$support/app/dist/cli.js"
fail() { emit helper.fail "$1"; [ -n "\${work:-}" ] && rm -rf "$work"; exit 0; }
in_use() { "$bun" "$cli" engine status </dev/null 2>/dev/null | tr -d '[:space:]' | grep -Fq '${HELPER_IN_USE}'; }
[ -x "$bun" ] && [ -f "$cli" ] || fail "Olympus is not installed at $support (no runtime/bun or app/dist/cli.js)"
if in_use; then emit helper.already 1; exit 0; fi
work=$(mktemp -d /tmp/rc-helper.XXXXXX) || fail 'a work folder could not be made'
code=$(curl -sS --proto '=https' --tlsv1.2 --max-time 60 --retry 3 -o "$work/install.sh" -w '%{http_code}' ${PUBLISHED_INSTALLER} 2>/dev/null) || code="\${code:-000}"
[ "$code" = 200 ] && [ -s "$work/install.sh" ] || fail "${PUBLISHED_INSTALLER} answered $code"
pin() { sed -n "s/^$1=\\([^[:space:]]*\\)[[:space:]]*$/\\1/p" "$work/install.sh" | head -1; }
version=$(pin OLYMPUS_VERSION); name=$(pin MACOS_HELPER_NAME); sha=$(pin MACOS_HELPER_SHA256); bytes=$(pin MACOS_HELPER_BYTES); team=$(pin MACOS_HELPER_TEAM_ID)
[ "$name" = none ] && fail "${PUBLISHED_INSTALLER} (Olympus $version) pins no helper (MACOS_HELPER_NAME=none)"
printf '%s' "$version" | grep -Eq '^[0-9A-Za-z.+-]+$' || fail "${PUBLISHED_INSTALLER} has no usable OLYMPUS_VERSION ($version)"
printf '%s' "$name" | grep -Eq '^olympus-engine-helper-[0-9a-f]{16}[.]zip$' || fail "${PUBLISHED_INSTALLER} has no usable MACOS_HELPER_NAME ($name)"
printf '%s' "$sha" | grep -Eq '^[0-9a-f]{64}$' || fail "${PUBLISHED_INSTALLER} has no usable MACOS_HELPER_SHA256"
printf '%s' "$team" | grep -Eq '^[A-Z0-9]{10}$' || fail "${PUBLISHED_INSTALLER} has no usable MACOS_HELPER_TEAM_ID ($team)"
case "$bytes" in ''|*[!0-9]*|0) fail "${PUBLISHED_INSTALLER} has no usable MACOS_HELPER_BYTES ($bytes)" ;; esac
emit helper.name "$name"; emit helper.version "$version"; emit helper.team "$team"
url="${RELEASE_BASE}/$version/$name"
code=$(curl -sS --proto '=https' --tlsv1.2 --max-time 300 --retry 3 -o "$work/helper.zip" -w '%{http_code}' "$url" 2>/dev/null) || code="\${code:-000}"
[ "$code" = 200 ] || fail "$url answered $code"
got_sha=$(shasum -a 256 "$work/helper.zip" | awk '{print $1}'); got_bytes=$(wc -c < "$work/helper.zip" | tr -d ' ')
[ "$got_sha" = "$sha" ] || fail "$name has SHA-256 $got_sha, not the pinned $sha"
[ "$got_bytes" = "$bytes" ] || fail "$name is $got_bytes bytes, not the pinned $bytes"
mkdir "$work/helper"
ditto -x -k "$work/helper.zip" "$work/helper" && [ -d "$work/helper/Olympus Engine.app" ] || fail "$name did not unpack to Olympus Engine.app (ditto -x -k)"
OLYMPUS_MACOS_HELPER_TEAM_ID="$team" "$bun" "$cli" engine install-helper --from "$work/helper/Olympus Engine.app" </dev/null > "$work/install.out" 2>&1
rc=$?
emit helper.install.code "$rc"
emit helper.install.out "$(tr -d '\\n\\t' < "$work/install.out" | tail -c 400)"
if in_use; then emit helper.in_use 1; else emit helper.in_use 0; fi
rm -rf "$work"
exit 0
`;
}

/** Saves the right as it is, sets it to allow, and checks that osascript's administrator request now runs as root with no dialog. */
export function standInInstallScript(): string {
  return marker('stand-in-install') + PRELUDE + `mkdir -p "$HOME/rc"
if [ ! -s "$HOME/rc/auth-admin.plist" ]; then
  sudo -n /usr/bin/security authorizationdb read system.privilege.admin > "$HOME/rc/auth-admin.plist" 2>/dev/null; emit saved $?
else emit saved 0; fi
sudo -n /usr/bin/security authorizationdb write system.privilege.admin allow >/dev/null 2>&1; emit allowed $?
emit uid "$(/usr/bin/osascript -e 'do shell script "/usr/bin/id -u" with administrator privileges' 2>&1 | tr -d '\\n' | head -c 200)"
`;
}

/** Puts the right back as it was before the leg. */
export function standInRemoveScript(): string {
  return marker('stand-in-remove') + PRELUDE + `if [ -s "$HOME/rc/auth-admin.plist" ]; then
  sudo -n /usr/bin/security authorizationdb write system.privilege.admin < "$HOME/rc/auth-admin.plist" >/dev/null 2>&1; emit restored $?
  rm -f "$HOME/rc/auth-admin.plist"
else emit restored none; fi
`;
}

/** The dashboard's Save on the Engine card: choice server (on) or everyday (off). */
export function saveScript(enable: boolean): string {
  return marker(`save-${enable ? 'on' : 'off'}`) + PRELUDE + CONTROL_POST + `control_post /dashboard/engine/computer-use '{"choice":"${enable ? 'server' : 'everyday'}"}'
emit save.code "$code"
[ -f "\${out:-}" ] && emit save.body "$(tr -d '\\n\\t' < "$out" | head -c 600)" && rm -f "$out"
`;
}

/** Everything a switch changes, as tab-separated lines. */
export function stateScript(): string {
  return marker('state') + PRELUDE + `uid=$(id -u)
emit user "$(id -un)"
emit uid "$uid"
daemon=${DAEMON_PLIST}
if [ -e "$daemon" ]; then
  emit daemon.present 1
  emit daemon.owner "$(stat -f '%Su:%Sg' "$daemon")"
  emit daemon.mode "$(stat -f '%Lp' "$daemon")"
  emit daemon.username "$(/usr/bin/plutil -extract UserName raw -o - "$daemon" 2>/dev/null)"
else emit daemon.present 0; fi
if [ -e "$HOME/Library/LaunchAgents/${LABEL}.plist" ]; then emit agent.present 1; else emit agent.present 0; fi
for domain in system "gui/$uid"; do
  key=system; [ "$domain" = system ] || key=gui
  text=$(launchctl print "$domain/${LABEL}" 2>/dev/null); rc=$?
  emit "$key.code" "$rc"
  emit "$key.state" "$(printf '%s\\n' "$text" | awk -F' = ' '/^\\tstate = / { print $2; exit }')"
  emit "$key.pid" "$(printf '%s\\n' "$text" | awk -F' = ' '/^\\tpid = / { print $2; exit }')"
done
ps -axww -o user=,pid=,ppid=,command= | awk 'index($0, "__engine" "-run") { print "engine\\t" $0 }'
result="$HOME/.olympus/server-mode-result.json"
[ -f "$result" ] && emit result "$(tr -d '\\n\\t' < "$result")"
exit 0
`;
}

/** The boot time, the console user and whether the owner's desktop (login) domain is up. */
export function bootScript(): string {
  return marker('boot') + PRELUDE + `emit boot "$(sysctl -n kern.boottime | sed -n 's/.*sec = \\([0-9]*\\).*/\\1/p')"
emit console "$(stat -f %Su /dev/console)"
emit user "$(id -un)"
launchctl print "gui/$(id -u)" >/dev/null 2>&1; emit gui $?
`;
}

/** Restarts the guest a moment after this script returns, so the exec itself ends cleanly. */
export function restartScript(): string {
  return marker('restart') + PRELUDE + `sudo -n /usr/bin/true || { emit restart no-sudo; exit 1; }
sudo -n /usr/bin/nohup /bin/sh -c '/bin/sleep 3; /sbin/shutdown -r now' </dev/null >/dev/null 2>&1 &
emit restart requested
`;
}

const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'release-check-second-account', version: '1' } } };
const LIST = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };

/** Runs as the second account: an MCP request with the header file (or none), its status and its body (base64) emitted under a prefix. */
const AS_AGENT = `as_agent() {
  sudo -n -u ${SECOND_ACCOUNT} /bin/bash -s -- "$@" <<'AGENT'
url=$1; header=$2; shift 2
emit() { printf '%s\\t%s\\n' "$1" "$2"; }
emit whoami "$(id -un)"
call() {
  local prefix=$1 with=$2 body=$3 out code
  out=$(mktemp /tmp/rc-agent-call.XXXXXX)
  if [ -n "$with" ]; then
    code=$(curl -sS --max-time 60 -o "$out" -w '%{http_code}' -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -H @"$with" --data "$body" "$url" 2>/dev/null) || code=000
  else
    code=$(curl -sS --max-time 60 -o "$out" -w '%{http_code}' -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' --data "$body" "$url" 2>/dev/null) || code=000
  fi
  emit "$prefix.code" "$code"
  emit "$prefix.body" "$(head -c 200000 "$out" | base64 | tr -d '\\n')"
  rm -f "$out"
}
while [ "$#" -ge 3 ]; do
  case "$2" in key) with=$header ;; *) with= ;; esac
  call "$1" "$with" "$3"
  shift 3
done
AGENT
}
`;

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/** Makes the standard account and two loopback keys from the dashboard (the agent's and a keeper), then asks as that account. */
export function secondAccountScript(): string {
  return marker('second-account') + PRELUDE + CONTROL_POST + AS_AGENT + `name=${SECOND_ACCOUNT}
dir="${SECOND_DIR}"
rm -rf "$dir"; mkdir -p "$dir"; chmod 700 "$dir"
if id -u "$name" >/dev/null 2>&1; then sudo -n /usr/sbin/sysadminctl -deleteUser "$name" >/dev/null 2>&1; fi
pw=$(/usr/bin/openssl rand -hex 16)
sudo -n /usr/sbin/sysadminctl -addUser "$name" -fullName 'Release check agent' -password "$pw" >/dev/null 2>&1; emit user.add $?
unset pw
emit user.uid "$(id -u "$name" 2>/dev/null)"
if /usr/sbin/dseditgroup -o checkmember -m "$name" admin >/dev/null 2>&1; then emit user.admin 1; else emit user.admin 0; fi
for which in key keeper; do
  control_post /dashboard/agents/keys "{\\"name\\":\\"Release check $which\\",\\"agent\\":\\"other\\",\\"route\\":\\"loopback\\"}"
  emit "$which.code" "$code"
  if [ -f "\${out:-}" ]; then
    (umask 077; sed -n 's/.*"token" *: *"\\([^"]*\\)".*/\\1/p' "$out" | head -1 > "$dir/$which.token")
    emit "$which.id" "$(tr -d '\\n' < "$out" | sed -n 's/.*"connection" *: *{[^}]*"id" *: *"\\([a-f0-9]*\\)".*/\\1/p')"
    emit "$which.url" "$(sed -n 's/.*"mcp_url" *: *"\\([^"]*\\)".*/\\1/p' "$out" | head -1)"
    if [ -s "$dir/$which.token" ]; then emit "$which.token" 1; else emit "$which.token" 0; fi
    rm -f "$out"
  fi
done
# The agent's own copy of its key, readable only by that account.
stage=$(sudo -n /usr/bin/mktemp -d /private/tmp/rc-agent.XXXXXXXX)
emit stage "$stage"
printf 'authorization: Bearer %s\\n' "$(cat "$dir/key.token")" | sudo -n /usr/bin/tee "$stage/header" >/dev/null
sudo -n /usr/sbin/chown -R "$name" "$stage"; sudo -n /bin/chmod 700 "$stage"; sudo -n /bin/chmod 600 "$stage/header"
`;
}

/** The second account's requests: with its key (initialize, then the tool list) and with none. */
export function secondAccountAskScript(url: string, stage: string): string {
  return marker('second-account-ask') + PRELUDE + AS_AGENT + `as_agent ${shellQuote(url)} ${shellQuote(`${stage}/header`)} \\
  key.init key ${shellQuote(JSON.stringify(INIT))} \\
  key.tools key ${shellQuote(JSON.stringify(LIST))} \\
  nokey none ${shellQuote(JSON.stringify(INIT))}
`;
}

/** Revokes the agent's key from the dashboard, then asks with it again as the second account. */
export function secondAccountRevokeScript(url: string, stage: string, connectionId: string): string {
  return marker('second-account-revoke') + PRELUDE + CONTROL_POST + AS_AGENT + `control_post /dashboard/agents/revoke ${shellQuote(JSON.stringify({ connection_id: connectionId }))}
emit revoke.code "$code"
[ -f "\${out:-}" ] && rm -f "$out"
as_agent ${shellQuote(url)} ${shellQuote(`${stage}/header`)} revoked key ${shellQuote(JSON.stringify(INIT))}
`;
}

/** Revokes the keeper, removes the agent's files and the account. */
export function secondAccountCleanupScript(keeperId: string | undefined, stage: string | undefined): string {
  const revoke = keeperId && /^[a-f0-9]{18}$/.test(keeperId)
    ? `control_post /dashboard/agents/revoke ${shellQuote(JSON.stringify({ connection_id: keeperId }))}; emit keeper.revoke "$code"; [ -f "\${out:-}" ] && rm -f "$out"\n`
    : '';
  const removeStage = stage && /^\/private\/tmp\/rc-agent\.[A-Za-z0-9]+$/.test(stage) ? `sudo -n /bin/rm -rf ${shellQuote(stage)}\n` : '';
  return marker('second-account-cleanup') + PRELUDE + CONTROL_POST + revoke + removeStage + `rm -rf "${SECOND_DIR}"
if id -u ${SECOND_ACCOUNT} >/dev/null 2>&1; then sudo -n /usr/sbin/sysadminctl -deleteUser ${SECOND_ACCOUNT} >/dev/null 2>&1; emit user.delete $?; fi
exit 0
`;
}

// ---------------------------------------------------------------------------
// Parsing

/** Tab-separated `key value` lines; `engine` lines repeat, so every value is kept in order. */
export function parseLines(stdout: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const line of stdout.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab <= 0) continue;
    const key = line.slice(0, tab);
    out.set(key, [...(out.get(key) ?? []), line.slice(tab + 1)]);
  }
  return out;
}
const first = (lines: Map<string, string[]>, key: string): string | undefined => lines.get(key)?.[0];
const int = (value: string | undefined): number | undefined => (value !== undefined && /^\d+$/.test(value.trim()) ? Number(value.trim()) : undefined);

export interface LaunchdJob { code: number; state?: string; pid?: number }
export interface EngineProcess { user: string; pid: number; ppid: number; command: string }

export interface ServerModeState {
  user: string;
  uid?: number;
  daemon: { present: boolean; owner?: string; mode?: string; userName?: string };
  launchAgent: boolean;
  system: LaunchdJob;
  gui: LaunchdJob;
  /** The engine processes themselves: the Olympus Engine helper that starts each one is left out. */
  engines: EngineProcess[];
  result?: { pending?: boolean; message?: string };
}

export function parseState(stdout: string): ServerModeState | undefined {
  const lines = parseLines(stdout);
  const user = first(lines, 'user');
  if (!user) return undefined;
  const job = (key: string): LaunchdJob => {
    const state = first(lines, `${key}.state`);
    const pid = int(first(lines, `${key}.pid`));
    return { code: int(first(lines, `${key}.code`)) ?? -1, ...(state ? { state } : {}), ...(pid !== undefined ? { pid } : {}) };
  };
  const engines = (lines.get('engine') ?? []).flatMap((line): EngineProcess[] => {
    const match = /^\s*(\S+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match || match[4]!.includes('OlympusEngineHost')) return [];
    return [{ user: match[1]!, pid: Number(match[2]), ppid: Number(match[3]), command: match[4]! }];
  });
  let result: ServerModeState['result'];
  const raw = first(lines, 'result');
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      result = { ...(typeof parsed.pending === 'boolean' ? { pending: parsed.pending } : {}), ...(typeof parsed.message === 'string' ? { message: parsed.message } : {}) };
    } catch { result = {}; }
  }
  const uid = int(first(lines, 'uid'));
  return {
    user,
    ...(uid !== undefined ? { uid } : {}),
    daemon: first(lines, 'daemon.present') === '1'
      ? { present: true, owner: first(lines, 'daemon.owner') ?? '', mode: first(lines, 'daemon.mode') ?? '', userName: first(lines, 'daemon.username') ?? '' }
      : { present: false },
    launchAgent: first(lines, 'agent.present') === '1',
    system: job('system'),
    gui: job('gui'),
    engines,
    ...(result ? { result } : {}),
  };
}

/** The server-mode setting /dashboard.json shows, wherever the view puts it. */
export function dashboardServerMode(body: unknown): { enabled: boolean; pending?: boolean } | undefined {
  const seen = new Set<unknown>();
  const walk = (value: unknown): { enabled: boolean; pending?: boolean } | undefined => {
    if (!value || typeof value !== 'object' || seen.has(value)) return undefined;
    seen.add(value);
    const record = value as Record<string, unknown>;
    const mode = record.engine_server_mode as Record<string, unknown> | undefined;
    if (mode && typeof mode === 'object' && typeof mode.enabled === 'boolean') {
      return { enabled: mode.enabled, ...(typeof mode.pending === 'boolean' ? { pending: mode.pending } : {}) };
    }
    for (const child of Object.values(record)) {
      const found = walk(child);
      if (found) return found;
    }
    return undefined;
  };
  return walk(body);
}

export interface DashboardView { status: number; ok: boolean; detail: string; serverMode?: { enabled: boolean; pending?: boolean } }

export function dashboardView(answer: { status: number; body: string } | undefined): DashboardView {
  if (!answer) return { status: 0, ok: false, detail: 'the in-machine agent gave no answer' };
  let body: unknown;
  try { body = JSON.parse(answer.body); } catch { return { status: answer.status, ok: false, detail: `answered ${answer.status} with a body that is not JSON` }; }
  const record = (body ?? {}) as Record<string, unknown>;
  const error = record.error as { code?: unknown; message?: unknown } | string | undefined;
  if (answer.status !== 200 || record.ok === false || error) {
    const why = typeof error === 'string' ? error : error ? `${String(error.code ?? '')} ${String(error.message ?? '')}`.trim() : '';
    return { status: answer.status, ok: false, detail: `answered ${answer.status}${why ? `: ${why.slice(0, 200)}` : ''}` };
  }
  const serverMode = dashboardServerMode(body);
  return { status: 200, ok: true, detail: 'answered 200', ...(serverMode ? { serverMode } : {}) };
}

// ---------------------------------------------------------------------------
// Checks

const check = (id: string, title: string, problems: string[], passDetail: string): CheckResult => ({
  id, title, status: problems.length === 0 ? 'pass' : 'fail', detail: problems.length === 0 ? passDetail : problems.join('; '),
});
const skipped = (id: string, title: string, why: string): CheckResult => ({ id, title, status: 'skip', detail: why });

/** The launchd domain the engine belongs to in each mode, and the one that must hold no engine. */
function domains(enable: boolean): { want: 'system' | 'gui'; not: 'system' | 'gui'; words: string } {
  return enable ? { want: 'system', not: 'gui', words: 'the system domain' } : { want: 'gui', not: 'system', words: "the owner's login domain" };
}

/** Exactly one engine, the owner's, started by the expected launchd job; the other domain holds none. */
export function oneEngineProblems(state: ServerModeState, enable: boolean): string[] {
  const problems: string[] = [];
  const { want, not, words } = domains(enable);
  const job = state[want];
  if (job.code !== 0) problems.push(`${want === 'system' ? 'system' : 'gui'}/${LABEL} is not loaded (launchctl print exited ${job.code})`);
  else if (job.state && job.state !== 'running') problems.push(`the engine job in ${words} is ${job.state}, not running`);
  if (state[not].code === 0) problems.push(`an engine job is also loaded in ${not === 'system' ? 'the system domain' : "the owner's login domain"}`);
  if (state.engines.length !== 1) problems.push(`${state.engines.length} engine processes are running, not 1${state.engines.length > 1 ? ` (pids ${state.engines.map((e) => e.pid).join(', ')})` : ''}`);
  for (const engine of state.engines) {
    if (engine.user !== state.user) problems.push(`engine ${engine.pid} runs as ${engine.user}, not ${state.user}`);
  }
  if (state.engines.length === 1 && job.pid !== undefined) {
    const engine = state.engines[0]!;
    if (engine.pid !== job.pid && engine.ppid !== job.pid) problems.push(`engine ${engine.pid} was not started by the job in ${words} (pid ${job.pid})`);
  }
  return problems;
}

/** The checks after one switch, read once the helper is done and the dashboard answers. */
export function switchChecks(enable: boolean, observed: { state?: ServerModeState; dashboard: DashboardView; finished: { ok: boolean; detail: string } }): CheckResult[] {
  const prefix = `server-mode.${enable ? 'on' : 'off'}`;
  const out: CheckResult[] = [];
  out.push(check(`${prefix}.finished`, `Server mode ${enable ? 'on' : 'off'}: Save went through the administrator step and the change finished`,
    observed.finished.ok ? [] : [observed.finished.detail], observed.finished.detail));
  const state = observed.state;
  if (!state) {
    for (const [id, title] of [['daemon-plist', 'the daemon plist'], ['launch-agent', 'the LaunchAgent'], ['one-engine', 'exactly one engine']] as const) {
      out.push({ id: `${prefix}.${id}`, title: `Server mode ${enable ? 'on' : 'off'}: ${title}`, status: 'fail', detail: 'the machine state could not be read' });
    }
  } else {
    const plist: string[] = [];
    if (enable) {
      if (!state.daemon.present) plist.push(`${DAEMON_PLIST} is missing`);
      else {
        if (state.daemon.owner !== 'root:wheel') plist.push(`owned by ${state.daemon.owner || 'nobody'}, not root:wheel`);
        if (state.daemon.mode !== '644') plist.push(`mode ${state.daemon.mode || '?'}, not 0644`);
        if (state.daemon.userName !== state.user) plist.push(`UserName is "${state.daemon.userName ?? ''}", not ${state.user}`);
      }
    } else if (state.daemon.present) plist.push(`${DAEMON_PLIST} is still there`);
    out.push(check(`${prefix}.daemon-plist`, enable ? 'Server mode on: the daemon plist is root:wheel 0644 and runs as the owner' : 'Server mode off: the daemon plist is gone',
      plist, enable ? `root:wheel 0644, UserName ${state.user}` : 'no daemon plist'));
    out.push(check(`${prefix}.launch-agent`, enable ? "Server mode on: the owner's LaunchAgent is removed" : "Server mode off: the owner's LaunchAgent is back",
      state.launchAgent === !enable ? [] : [enable ? 'the LaunchAgent plist is still there' : 'the LaunchAgent plist is missing'],
      enable ? 'no LaunchAgent plist' : 'LaunchAgent plist present'));
    const engines = oneEngineProblems(state, enable);
    out.push(check(`${prefix}.one-engine`, `Server mode ${enable ? 'on' : 'off'}: exactly one engine runs, in ${domains(enable).words}`,
      engines, `engine ${state.engines[0]?.pid ?? '?'} as ${state.user}, in ${domains(enable).words}`));
  }
  const dash: string[] = [];
  if (!observed.dashboard.ok) dash.push(`/dashboard.json ${observed.dashboard.detail}`);
  else if (!observed.dashboard.serverMode) dash.push('/dashboard.json has no server-mode setting');
  else if (observed.dashboard.serverMode.enabled !== enable) dash.push(`/dashboard.json shows server mode ${observed.dashboard.serverMode.enabled ? 'on' : 'off'}`);
  out.push(check(`${prefix}.dashboard`, `Server mode ${enable ? 'on' : 'off'}: /dashboard.json answers and shows the setting`, dash, `answered 200 with server mode ${enable ? 'on' : 'off'}`));
  return out;
}

/** The helper step's check: installed and in use, or why not. */
export function helperCheck(lines: Map<string, string[]>, exec: { code: number; stderr: string; timedOut?: boolean }): CheckResult {
  const title = 'The candidate has the published, signed Olympus Engine helper and the engine starts through it (as install.sh gives it)';
  const id = 'server-mode.helper';
  if (first(lines, 'helper.already') === '1') return check(id, title, [], 'a helper was already installed and in use');
  const problems: string[] = [];
  const failed = first(lines, 'helper.fail');
  if (failed) problems.push(failed);
  else if (exec.timedOut) problems.push('the helper step did not finish in time');
  else if (!first(lines, 'helper.install.code')) problems.push(`the helper step ended without a result (exit ${exec.code}${exec.stderr.trim() ? `: ${exec.stderr.trim().slice(0, 200)}` : ''})`);
  else {
    const code = first(lines, 'helper.install.code');
    const said = first(lines, 'helper.install.out') ?? '';
    if (code !== '0') problems.push(`olympus engine install-helper exited ${code}${said ? `: ${said.slice(0, 300)}` : ''}`);
    if (first(lines, 'helper.in_use') !== '1') problems.push('engine status does not report the helper installed and in use');
  }
  return check(id, title, problems, `${first(lines, 'helper.name') ?? 'the helper'} from Olympus ${first(lines, 'helper.version') ?? '?'} (team ${first(lines, 'helper.team') ?? '?'}) installed and in use`);
}

export interface RestartObservation {
  requested: { ok: boolean; detail: string };
  back: { ok: boolean; detail: string; ms?: number };
  state?: ServerModeState;
  dashboard?: DashboardView;
}

export function restartChecks(observed: RestartObservation): CheckResult[] {
  const out: CheckResult[] = [];
  const back = observed.requested.ok ? observed.back : { ok: false, detail: `the restart was not requested: ${observed.requested.detail}` };
  out.push(check('server-mode.restart.back', 'With server mode on, the Mac restarts and comes back with its desktop session', back.ok ? [] : [back.detail], back.detail));
  if (!back.ok) {
    out.push({ id: 'server-mode.restart.system-domain', title: 'After the restart, the engine answers from the system domain', status: 'fail', detail: 'the machine did not come back' });
    return out;
  }
  const problems: string[] = [];
  if (!observed.state) problems.push('the machine state could not be read');
  else {
    problems.push(...oneEngineProblems(observed.state, true));
    if (observed.state.launchAgent) problems.push('the LaunchAgent plist came back');
  }
  if (!observed.dashboard?.ok) problems.push(`/dashboard.json ${observed.dashboard?.detail ?? 'was not read'}`);
  else if (observed.dashboard.serverMode && !observed.dashboard.serverMode.enabled) problems.push('/dashboard.json shows server mode off');
  out.push(check('server-mode.restart.system-domain', 'After the restart, the engine answers from the system domain', problems,
    `engine ${observed.state?.engines[0]?.pid ?? '?'} in the system domain; /dashboard.json answered 200`));
  return out;
}

export interface SecondAccountObservation {
  setup?: Map<string, string[]>;
  ask?: Map<string, string[]>;
  revoke?: Map<string, string[]>;
  error?: string;
}

const decode = (value: string | undefined): string => (value ? Buffer.from(value, 'base64').toString('utf8') : '');
const rpcOf = (text: string): any => { try { return parseRpc(text); } catch { return undefined; } };

export function secondAccountChecks(observed: SecondAccountObservation, owner: string): CheckResult[] {
  const out: CheckResult[] = [];
  const s = observed.setup;
  const userProblems: string[] = [];
  if (!s) userProblems.push(observed.error ?? 'the setup did not run');
  else {
    if (first(s, 'user.add') !== '0') userProblems.push(`sysadminctl -addUser exited ${first(s, 'user.add') ?? '?'}`);
    if (!int(first(s, 'user.uid'))) userProblems.push(`no account named ${SECOND_ACCOUNT} exists`);
    if (first(s, 'user.admin') !== '0') userProblems.push(`${SECOND_ACCOUNT} is an administrator, not a standard account`);
  }
  out.push(check('server-mode.second-account.user', 'A second, standard account exists on the Mac', userProblems, `${SECOND_ACCOUNT}, uid ${s ? first(s, 'user.uid') : '?'}, not an administrator`));
  const keyProblems: string[] = [];
  const url = s ? first(s, 'key.url') ?? '' : '';
  if (s) {
    if (first(s, 'key.code') !== '200') keyProblems.push(`Create key answered ${first(s, 'key.code') ?? 'nothing'}`);
    else {
      if (first(s, 'key.token') !== '1') keyProblems.push('Create key gave no key');
      if (!/^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(url)) keyProblems.push(`Create key gave the address "${url}", not a loopback /mcp address`);
    }
  } else keyProblems.push('the key was not created');
  const a = observed.ask;
  if (keyProblems.length === 0) {
    if (!a) keyProblems.push(observed.error ?? 'the second account did not ask');
    else {
      if (first(a, 'whoami') !== SECOND_ACCOUNT) keyProblems.push(`the requests ran as ${first(a, 'whoami') ?? 'nobody'}, not ${SECOND_ACCOUNT}`);
      if (first(a, 'whoami') === owner) keyProblems.push('the requests ran as the owner');
      const init = rpcOf(decode(first(a, 'key.init.body')));
      if (first(a, 'key.init.code') !== '200' || !init?.result?.serverInfo) keyProblems.push(`initialize with the key answered ${first(a, 'key.init.code') ?? 'nothing'}${init?.error ? `: ${String(init.error.message ?? '')}` : ''}`);
      const tools = rpcOf(decode(first(a, 'key.tools.body')));
      const count = Array.isArray(tools?.result?.tools) ? tools.result.tools.length : 0;
      if (first(a, 'key.tools.code') !== '200' || count === 0) keyProblems.push(`tools/list with the key answered ${first(a, 'key.tools.code') ?? 'nothing'} with ${count} tools`);
    }
  }
  const toolCount = (() => { const t = rpcOf(decode(a ? first(a, 'key.tools.body') : undefined)); return Array.isArray(t?.result?.tools) ? t.result.tools.length : 0; })();
  out.push(check('server-mode.second-account.key-works', "An agent on the second account connects with a key from 'Agent on another account of this computer'", keyProblems,
    `as ${SECOND_ACCOUNT} at ${url}: initialize 200, ${toolCount} tools`));
  const noKey = a ? first(a, 'nokey.code') : undefined;
  out.push(check('server-mode.second-account.no-key', 'A request from the second account with no key gets 401',
    noKey === '401' ? [] : [a ? `answered ${noKey ?? 'nothing'}` : (observed.error ?? 'the request was not made')], 'answered 401'));
  const r = observed.revoke;
  const revoked: string[] = [];
  if (!r) revoked.push(observed.error ?? (keyProblems.length ? 'the key never worked, so revoking it proves nothing' : 'the key was not revoked'));
  else {
    if (first(r, 'revoke.code') !== '200') revoked.push(`Revoke answered ${first(r, 'revoke.code') ?? 'nothing'}`);
    const code = first(r, 'revoked.code');
    if (code === '000') revoked.push('the loopback listener was closed, so the revoked key could not be tried (the keeper key should keep it open)');
    else if (code !== '401' && code !== '403') revoked.push(`the revoked key answered ${code ?? 'nothing'}`);
  }
  out.push(check('server-mode.second-account.revoked', 'A revoked key is refused', revoked, `answered ${r ? first(r, 'revoked.code') : '?'}`));
  return out;
}

// ---------------------------------------------------------------------------
// The leg

interface LegContext { host: ServerModeHost; clock: ServerModeClock; bounds: typeof SERVER_MODE_BOUNDS; log: (line: string) => void }

async function readState(ctx: LegContext): Promise<ServerModeState | undefined> {
  const r = await ctx.host.exec(stateScript(), 60_000);
  return r.code === 0 ? parseState(r.stdout) : undefined;
}

/** Polls `read` until it gives a value or the bound passes; at least one attempt is always made. */
async function until<T>(ctx: LegContext, boundMs: number, read: () => Promise<T | undefined>): Promise<{ value?: T; ms: number }> {
  const started = ctx.clock.now();
  for (;;) {
    let value: T | undefined;
    try { value = await read(); } catch { value = undefined; }
    if (value !== undefined) return { value, ms: ctx.clock.now() - started };
    if (ctx.clock.now() - started >= boundMs) return { ms: ctx.clock.now() - started };
    await ctx.clock.sleep(ctx.bounds.pollMs);
  }
}

async function healthyDashboard(ctx: LegContext, boundMs: number): Promise<DashboardView> {
  let last: DashboardView = { status: 0, ok: false, detail: 'was not read' };
  const got = await until(ctx, boundMs, async () => {
    last = dashboardView(await ctx.host.dashboard());
    return last.ok && last.serverMode?.pending !== true ? last : undefined;
  });
  return got.value ?? last;
}

async function runSwitch(ctx: LegContext, enable: boolean): Promise<CheckResult[]> {
  const saved = parseLines((await ctx.host.exec(saveScript(enable), 120_000)).stdout);
  const code = first(saved, 'save.code');
  let finished: { ok: boolean; detail: string };
  let state: ServerModeState | undefined;
  if (code !== '200') {
    finished = { ok: false, detail: `Save answered ${code ?? 'nothing'}${first(saved, 'save.body') ? `: ${first(saved, 'save.body')!.slice(0, 300)}` : ''}` };
    state = await readState(ctx);
  } else {
    const done = await until(ctx, ctx.bounds.switchMs, async () => {
      const read = await readState(ctx);
      return read?.result && read.result.pending === false ? read : undefined;
    });
    state = done.value ?? await readState(ctx);
    const message = state?.result?.message;
    finished = !done.value
      ? { ok: false, detail: `the change had not finished after ${Math.round(done.ms / 1000)} s${message ? ` (it says: ${message})` : ''}` }
      : message === SERVER_MODE_DONE[enable ? 'on' : 'off']
        ? { ok: true, detail: `finished in ${Math.round(done.ms / 1000)} s: ${message}` }
        : { ok: false, detail: `the change ended with: ${message ?? 'no message'}` };
  }
  const dashboard = await healthyDashboard(ctx, ctx.bounds.engineMs);
  // The engine may still be starting when the result is written: read the state again once the dashboard answers.
  if (dashboard.ok) state = await readState(ctx) ?? state;
  ctx.log(`server-mode ${enable ? 'on' : 'off'}: ${finished.detail}`);
  return switchChecks(enable, { ...(state ? { state } : {}), dashboard, finished });
}

async function runRestart(ctx: LegContext): Promise<CheckResult[]> {
  const before = parseLines((await ctx.host.exec(bootScript(), 60_000)).stdout);
  const bootBefore = first(before, 'boot');
  const owner = first(before, 'user');
  const asked = parseLines((await ctx.host.exec(restartScript(), 60_000)).stdout);
  const requested = first(asked, 'restart') === 'requested' && !!bootBefore
    ? { ok: true, detail: 'requested' }
    : { ok: false, detail: !bootBefore ? 'the boot time could not be read' : `the restart answered ${first(asked, 'restart') ?? 'nothing'}` };
  if (!requested.ok) return restartChecks({ requested, back: { ok: false, detail: '' } });
  let lastSeen = 'the machine did not answer';
  const came = await until(ctx, ctx.bounds.restartMs, async () => {
    const r = await ctx.host.exec(bootScript(), 30_000);
    if (r.code !== 0) { lastSeen = 'the machine did not answer'; return undefined; }
    const lines = parseLines(r.stdout);
    const boot = first(lines, 'boot');
    if (!boot || boot === bootBefore) { lastSeen = 'the machine had not restarted yet'; return undefined; }
    if (first(lines, 'console') !== owner || first(lines, 'gui') !== '0') { lastSeen = `restarted, but the desktop session of ${owner} was not up (console ${first(lines, 'console') ?? '?'})`; return undefined; }
    return true;
  });
  const back = came.value
    ? { ok: true, detail: `back in ${Math.round(came.ms / 1000)} s with ${owner} at the desktop`, ms: came.ms }
    : { ok: false, detail: `not back within ${Math.round(ctx.bounds.restartMs / 1000)} s: ${lastSeen}` };
  if (!back.ok) return restartChecks({ requested, back });
  const dashboard = await healthyDashboard(ctx, ctx.bounds.engineMs);
  const state = await readState(ctx);
  return restartChecks({ requested, back, ...(state ? { state } : {}), dashboard });
}

async function runSecondAccount(ctx: LegContext, owner: string): Promise<CheckResult[]> {
  const observed: SecondAccountObservation = {};
  let keeperId: string | undefined;
  let stage: string | undefined;
  try {
    const setup = await ctx.host.exec(secondAccountScript(), 180_000);
    observed.setup = parseLines(setup.stdout);
    keeperId = first(observed.setup, 'keeper.id');
    stage = first(observed.setup, 'stage');
    const url = first(observed.setup, 'key.url') ?? '';
    const keyId = first(observed.setup, 'key.id') ?? '';
    const usable = first(observed.setup, 'key.code') === '200' && /^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(url) && !!stage && /^\/private\/tmp\/rc-agent\.[A-Za-z0-9]+$/.test(stage);
    if (usable) {
      observed.ask = parseLines((await ctx.host.exec(secondAccountAskScript(url, stage!), 180_000)).stdout);
      if (/^[a-f0-9]{18}$/.test(keyId) && first(observed.setup, 'keeper.code') === '200') {
        observed.revoke = parseLines((await ctx.host.exec(secondAccountRevokeScript(url, stage!, keyId), 180_000)).stdout);
      } else if (!/^[a-f0-9]{18}$/.test(keyId)) {
        observed.error = 'Create key gave no connection id to revoke';
      } else {
        observed.error = `the keeper key was not created (answered ${first(observed.setup, 'keeper.code') ?? 'nothing'}), so a revoke would close the listener`;
      }
    }
  } catch (error) {
    observed.error = error instanceof Error ? error.message : String(error);
  } finally {
    try { await ctx.host.exec(secondAccountCleanupScript(keeperId, stage), 180_000); } catch { /* the machine is destroyed after the run */ }
  }
  return secondAccountChecks(observed, owner);
}

/**
 * The whole leg: the helper, the stand-in, on, a restart while on, off, the second account, the stand-in removed. A step whose
 * precondition failed is skipped and says why; the failure that caused it is its own check.
 */
export async function runServerModeLeg(host: ServerModeHost, options: { clock?: ServerModeClock; bounds?: Partial<typeof SERVER_MODE_BOUNDS>; log?: (line: string) => void } = {}): Promise<CheckResult[]> {
  if (host.os !== 'macos') return [skipped('server-mode', 'Mac server mode, a restart with it on, and an agent on a second account', 'server mode is a Mac setting')];
  const ctx: LegContext = { host, clock: options.clock ?? realClock, bounds: { ...SERVER_MODE_BOUNDS, ...options.bounds }, log: options.log ?? (() => undefined) };
  const out: CheckResult[] = [];
  const owner = (parseLines((await host.exec(bootScript(), 60_000)).stdout).get('user') ?? [''])[0]!;
  try {
    const helperRun = await host.exec(helperScript(), 600_000).catch((error: unknown) => ({ code: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) }));
    const helper = helperCheck(parseLines(helperRun.stdout), helperRun);
    out.push(helper);
    ctx.log(`server-mode helper: ${helper.detail}`);
    const stand = parseLines((await host.exec(standInInstallScript(), 120_000)).stdout);
    const standProblems: string[] = [];
    if (first(stand, 'saved') !== '0') standProblems.push('the administrator right could not be saved first (sudo -n security authorizationdb read)');
    if (first(stand, 'allowed') !== '0') standProblems.push('the administrator right could not be set to allow (sudo -n security authorizationdb write)');
    if (first(stand, 'uid') !== '0') standProblems.push(`osascript's administrator request answered "${first(stand, 'uid') ?? ''}", not uid 0`);
    out.push(check('server-mode.stand-in', "The stand-in for the administrator's password (osascript runs as root, no dialog) works on the machine", standProblems,
      'osascript ran its administrator request as root'));
    if (helper.status !== 'pass') {
      out.push(skipped('server-mode.switch', 'Server mode on, a restart, and off', `the Olympus Engine helper is not installed: ${helper.detail}`));
    } else if (standProblems.length === 0) {
      const on = await runSwitch(ctx, true);
      out.push(...on);
      const onFinished = on.find((c) => c.id === 'server-mode.on.finished')?.status === 'pass';
      if (onFinished) out.push(...await runRestart(ctx));
      else out.push(skipped('server-mode.restart', 'With server mode on, the Mac restarts and the engine answers from the system domain', 'server mode did not turn on'));
      out.push(...await runSwitch(ctx, false));
    } else {
      out.push(skipped('server-mode.switch', 'Server mode on, a restart, and off', 'the administrator step has no stand-in on this machine'));
    }
    out.push(...await runSecondAccount(ctx, owner));
  } finally {
    const restored = parseLines((await host.exec(standInRemoveScript(), 60_000).catch(() => ({ code: 1, stdout: '', stderr: '' }))).stdout);
    if (first(restored, 'restored') !== '0' && first(restored, 'restored') !== 'none') {
      out.push({ id: 'server-mode.stand-in.removed', title: "The administrator right was put back as it was", status: 'warn', detail: `security authorizationdb write answered ${first(restored, 'restored') ?? 'nothing'}` });
    }
  }
  return out;
}
