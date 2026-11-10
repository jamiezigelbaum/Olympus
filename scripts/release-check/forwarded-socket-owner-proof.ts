/**
 * Linux only: the owner socket alone does not unlock the dashboard's local
 * controls (#1188).
 *
 * `olympus remote open` forwards the worker's owner socket to a loopback port
 * on the client computer, one socket connection per TCP connection, so a
 * request any account there sends through that forward reaches the engine as
 * a plain socket request. The check sends exactly that request (over the
 * socket, the forward's Host and Origin, no bearer, no cookie) and expects a
 * refusal. It then opens the page the way the owner's remote opening link
 * does (a remote-purpose launch ticket the bearer mints, redeemed by the
 * browser) and checks that page still unlocks. Nothing it prints carries a
 * token, ticket or cookie, only HTTP status codes.
 */
import type { Machine } from './machine.ts';
import type { CheckResult } from './report.ts';

const ENGINE = 'http://127.0.0.1:8010';
const ID = 'linux.forwarded-socket-owner-proof';
const TITLE = 'A request through the forwarded owner socket cannot unlock the dashboard controls without the owner\'s session';

/**
 * One script, run as the owner. Prints two `name=status` lines:
 * - `forward_bare`: the mint as a browser behind the forward sends it, with no session (expect 401)
 * - `owner_page`: the page the owner's remote opening link opened, unlocking (expect 200)
 */
export function forwardedSocketOwnerProofScript(): string {
  return `set -euo pipefail
socket="\${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/olympus/worker.sock"
jar="$(mktemp -d)"
cleanup() { rm -rf "$jar"; }
trap cleanup EXIT HUP INT TERM
req=(/usr/bin/curl -sS --max-time 10 --unix-socket "$socket" -H 'Origin: ${ENGINE}')
echo "forward_bare=$("\${req[@]}" -o /dev/null -w '%{http_code}' -X POST '${ENGINE}/dashboard/control/session/local')"
token="$("$HOME/.local/bin/olympus" dashboard token)"
"\${req[@]}" -o "$jar/minted" -X POST -H "Authorization: Bearer $token" '${ENGINE}/dashboard/control/launch?purpose=remote'
unset token
ticket="$(sed -n 's/.*"ticket":"\\([A-Za-z0-9_-]*\\)".*/\\1/p' "$jar/minted")"
rm -f "$jar/minted"
printf '{"ticket":"%s"}' "$ticket" > "$jar/body"
unset ticket
"\${req[@]}" -o /dev/null -c "$jar/owner" -X POST -H 'Content-Type: application/json' --data-binary @"$jar/body" '${ENGINE}/dashboard/control/launch/redeem'
echo "owner_page=$("\${req[@]}" -o /dev/null -w '%{http_code}' -b "$jar/owner" -X POST '${ENGINE}/dashboard/control/session/local')"
`;
}

/** Reads the script's output. Anything unreadable fails: the check never passes on a missing answer. */
export function evaluateForwardedSocketOwnerProof(code: number, stdout: string): CheckResult {
  const statuses = Object.fromEntries(stdout.split('\n').map((line) => line.trim().match(/^(forward_bare|owner_page)=(\d{3})$/)).filter((m): m is RegExpMatchArray => !!m).map((m) => [m[1]!, Number(m[2])]));
  const seen = `through the forward with no session ${statuses.forward_bare ?? '?'}, owner's opened page ${statuses.owner_page ?? '?'}`;
  if (code !== 0 || statuses.forward_bare === undefined || statuses.owner_page === undefined) {
    return { id: ID, title: TITLE, status: 'fail', detail: `the check did not finish (exit ${code}): ${seen}` };
  }
  if (statuses.forward_bare !== 401 && statuses.forward_bare !== 403) return { id: ID, title: TITLE, status: 'fail', detail: `a request with no owner session was not refused: ${seen}` };
  if (statuses.owner_page !== 200) return { id: ID, title: TITLE, status: 'fail', detail: `the owner's opened page could not unlock: ${seen}` };
  return { id: ID, title: TITLE, status: 'pass', detail: seen };
}

export async function checkForwardedSocketOwnerProof(machine: Machine): Promise<CheckResult> {
  if (machine.os !== 'linux') return { id: ID, title: TITLE, status: 'skip', detail: 'Only Linux has an owner socket to forward; the Mac leg covers its local unlock.' };
  try {
    const result = await machine.exec(forwardedSocketOwnerProofScript(), { timeoutMs: 60_000 });
    return evaluateForwardedSocketOwnerProof(result.code, result.stdout);
  } catch (error) {
    return { ...evaluateForwardedSocketOwnerProof(1, ''), detail: `the check could not run: ${error instanceof Error ? error.message : String(error)}` };
  }
}
