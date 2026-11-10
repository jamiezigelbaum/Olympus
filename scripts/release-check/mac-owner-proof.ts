/**
 * Mac only: the dashboard's local unlock answers the owner, never another
 * account on the same Mac (#1153).
 *
 * The machine's test user is the owner and has `sudo -n` (the same stand-in the
 * server-mode legs use for the admin prompt). The check adds a standard,
 * non-admin account, asks the engine for a local control session as that
 * account, and removes the account again on every exit. It then checks the
 * owner's own path still works: the page the owner's token opens unlocks.
 * Nothing it prints carries a token or a cookie, only HTTP status codes.
 */
import type { Machine } from './machine.ts';
import type { CheckResult } from './report.ts';

export const MAC_OWNER_PROOF_ACCOUNT = 'olyother';
const ENGINE = 'http://127.0.0.1:8010';
const MINT = `${ENGINE}/dashboard/control/session/local`;

/**
 * One script, run as the owner. Prints three `name=status` lines:
 * - `other`: the mint from the second account, with no session (expect 403 or 401)
 * - `owner_bare`: the same request from the owner with no session (expect 401)
 * - `owner_page`: the owner's opened page unlocking (expect 200)
 */
export function macOwnerProofScript(account = MAC_OWNER_PROOF_ACCOUNT): string {
  return `set -euo pipefail
account=${account}
jar="$(mktemp -d)"
cleanup() {
  rm -rf "$jar"
  sudo -n /usr/sbin/sysadminctl -deleteUser "$account" >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM
if id "$account" >/dev/null 2>&1; then sudo -n /usr/sbin/sysadminctl -deleteUser "$account" >/dev/null 2>&1 || true; fi
# A standard account, not an administrator, with a random password nobody keeps.
sudo -n /usr/sbin/sysadminctl -addUser "$account" -fullName "Olympus release check" -password "$(/usr/bin/openssl rand -hex 24)" >/dev/null 2>&1
id "$account" >/dev/null
mint=(/usr/bin/curl -sS -o /dev/null -w '%{http_code}' --max-time 10 -X POST -H 'Origin: ${ENGINE}' '${MINT}')
# sudo keeps the caller's cwd; the owner's home is not the other account's to enter.
echo "other=$(cd / && sudo -n -u "$account" "\${mint[@]}")"
echo "owner_bare=$("\${mint[@]}")"
token="$("$HOME/.local/bin/olympus" dashboard token)"
/usr/bin/curl -sS -o /dev/null --max-time 10 -c "$jar/owner" -X POST -H 'Origin: ${ENGINE}' -H "Authorization: Bearer $token" '${ENGINE}/dashboard/control/session'
unset token
echo "owner_page=$(/usr/bin/curl -sS -o /dev/null -w '%{http_code}' --max-time 10 -b "$jar/owner" -X POST -H 'Origin: ${ENGINE}' '${MINT}')"
`;
}

/** Reads the script's output. Anything unreadable fails: the check never passes on a missing answer. */
export function evaluateMacOwnerProof(code: number, stdout: string): CheckResult {
  const id = 'mac.local-mint-owner-proof';
  const title = 'Another account on this Mac cannot unlock the owner\'s dashboard controls';
  const statuses = Object.fromEntries(stdout.split('\n').map((line) => line.trim().match(/^(other|owner_bare|owner_page)=(\d{3})$/)).filter((m): m is RegExpMatchArray => !!m).map((m) => [m[1]!, Number(m[2])]));
  const seen = `second account ${statuses.other ?? '?'}, owner without a session ${statuses.owner_bare ?? '?'}, owner's opened page ${statuses.owner_page ?? '?'}`;
  if (code !== 0 || statuses.other === undefined || statuses.owner_bare === undefined || statuses.owner_page === undefined) {
    return { id, title, status: 'fail', detail: `the check did not finish (exit ${code}): ${seen}` };
  }
  const refused = (status: number) => status === 401 || status === 403;
  if (!refused(statuses.other)) return { id, title, status: 'fail', detail: `the second account was not refused: ${seen}` };
  if (!refused(statuses.owner_bare)) return { id, title, status: 'fail', detail: `a request with no owner proof was not refused: ${seen}` };
  if (statuses.owner_page !== 200) return { id, title, status: 'fail', detail: `the owner's opened page could not unlock: ${seen}` };
  return { id, title, status: 'pass', detail: seen };
}

export async function checkMacOwnerProof(machine: Machine): Promise<CheckResult> {
  if (machine.os !== 'macos') {
    return { id: 'mac.local-mint-owner-proof', title: 'Another account on this Mac cannot unlock the owner\'s dashboard controls', status: 'skip', detail: 'Linux proves the owner with its owner socket.' };
  }
  try {
    const result = await machine.exec(macOwnerProofScript(), { timeoutMs: 120_000 });
    return evaluateMacOwnerProof(result.code, result.stdout);
  } catch (error) {
    return { ...evaluateMacOwnerProof(1, ''), detail: `the check could not run: ${error instanceof Error ? error.message : String(error)}` };
  }
}
