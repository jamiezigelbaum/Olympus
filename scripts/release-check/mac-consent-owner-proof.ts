/**
 * Mac only: approving an app connection on the engine's loopback consent page
 * needs the owner, not just an account on the same Mac (#1186).
 *
 * The machine's test user is the owner and has `sudo -n`, the same stand-in
 * mac-owner-proof.ts uses. The check registers a loopback client with the
 * engine, then:
 * - as a standard second account it opens the approval page, keeps the page's
 *   consent cookie and posts Connect to the form's action and to the page's
 *   own path, with no dashboard session;
 * - as the owner it opens a dashboard control session with the owner's token
 *   (what `olympus dashboard` does), opens the same page and posts Connect.
 * The account is removed again on every exit. Nothing it prints carries a
 * token, a cookie or a code: only HTTP status codes and yes/no flags.
 *
 * The page is served in relay mode only, so the check runs when the run has a
 * relay (the machine is connected through it by then).
 */
import type { Machine } from './machine.ts';
import type { CheckResult } from './report.ts';

export const MAC_CONSENT_PROOF_ACCOUNT = 'olyconsent';
const ENGINE = 'http://127.0.0.1:8010';
const REDIRECT = 'http://127.0.0.1:43123/callback';
const ID = 'mac.consent-owner-proof';
const TITLE = 'Another account on this Mac cannot approve an app connection; the owner can';
/** The owner check's own page (consent-page.ts): every earlier check passed and only the owner proof was missing. */
const REFUSAL = 'Open the Olympus dashboard in this browser first';

/**
 * One script, run as the owner. Prints:
 * - `page`: the approval page as the second account (expect 200) and `form=yes` when it had a form to post;
 * - `other_form` / `other_form_refused`: Connect from the second account to the form's action (expect 401 or 403, and the owner check's page);
 * - `other_page`: the same post to `/connect/authorize` (expect 401 or 403);
 * - `owner` / `owner_code`: Connect from the owner's browser session (expect 303 to the redirect with a code).
 */
export function macConsentOwnerProofScript(account = MAC_CONSENT_PROOF_ACCOUNT): string {
  const query = `response_type=code&client_id=$client&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=$challenge&code_challenge_method=S256&state=rc`;
  return `set -euo pipefail
account=${account}
jar="$(mktemp -d)"
shared="$(mktemp -d /tmp/olyconsent.XXXXXX)"
cleanup() {
  rm -rf "$jar" "$shared"
  sudo -n /usr/sbin/sysadminctl -deleteUser "$account" >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM
if id "$account" >/dev/null 2>&1; then sudo -n /usr/sbin/sysadminctl -deleteUser "$account" >/dev/null 2>&1 || true; fi
# A standard account, not an administrator, with a random password nobody keeps.
sudo -n /usr/sbin/sysadminctl -addUser "$account" -fullName "Olympus release check" -password "$(/usr/bin/openssl rand -hex 24)" >/dev/null 2>&1
id "$account" >/dev/null
chmod 777 "$shared"
verifier="$(/usr/bin/openssl rand -hex 32)"
challenge="$(printf '%s' "$verifier" | /usr/bin/openssl dgst -sha256 -binary | /usr/bin/base64 | tr '+/' '-_' | tr -d '=')"
client="$(/usr/bin/curl -sS --max-time 10 -X POST -H 'Content-Type: application/json' -d '{"client_name":"Olympus release check","redirect_uris":["${REDIRECT}"]}' '${ENGINE}/connect/register' | /usr/bin/sed -n 's/.*"client_id":"\\([^"]*\\)".*/\\1/p')"
test -n "$client"
query="${query}"
as_other() { (cd / && sudo -n -u "$account" "$@"); }
field() { /usr/bin/sed -n "s/.*$1.*/\\\\1/p" "$2" | head -1; }
nav=(-H 'Sec-Fetch-Site: same-origin' -H 'Sec-Fetch-Mode: navigate' -H 'Sec-Fetch-Dest: document' -H 'Origin: null' -H 'Content-Type: application/x-www-form-urlencoded')
# The second account: the page and its consent cookie, then Connect with no dashboard session.
echo "page=$(as_other /usr/bin/curl -sS -o "$shared/page.html" -w '%{http_code}' --max-time 10 -c "$shared/c" -b "$shared/c" "${ENGINE}/connect/authorize?$query")"
action="$(field '<form method="post" action="\\([^"]*\\)"' "$shared/page.html")"
rid="$(field 'name="request_id" value="\\([^"]*\\)"' "$shared/page.html")"
csrf="$(field 'name="csrf" value="\\([^"]*\\)"' "$shared/page.html")"
if [ -n "$action" ] && [ -n "$rid" ] && [ -n "$csrf" ]; then echo "form=yes"; else echo "form=no"; exit 0; fi
body="request_id=$rid&csrf=$csrf&action=approve"
echo "other_form=$(as_other /usr/bin/curl -sS -o "$shared/form.html" -w '%{http_code}' --max-time 10 -b "$shared/c" "\${nav[@]}" -X POST --data "$body" "${ENGINE}$action")"
if grep -q '${REFUSAL}' "$shared/form.html"; then echo "other_form_refused=yes"; else echo "other_form_refused=no"; fi
echo "other_page=$(as_other /usr/bin/curl -sS -o /dev/null -w '%{http_code}' --max-time 10 -b "$shared/c" "\${nav[@]}" -X POST --data "$body" '${ENGINE}/connect/authorize')"
# The owner: a dashboard control session as \`olympus dashboard\` opens one, then the same page and Connect.
token="$("$HOME/.local/bin/olympus" dashboard token)"
/usr/bin/curl -sS -o /dev/null --max-time 10 -c "$jar/owner" -X POST -H 'Origin: ${ENGINE}' -H "Authorization: Bearer $token" '${ENGINE}/dashboard/control/session'
unset token
/usr/bin/curl -sS -o "$jar/page.html" --max-time 10 -c "$jar/owner" -b "$jar/owner" "${ENGINE}/connect/authorize?$query"
action="$(field '<form method="post" action="\\([^"]*\\)"' "$jar/page.html")"
rid="$(field 'name="request_id" value="\\([^"]*\\)"' "$jar/page.html")"
csrf="$(field 'name="csrf" value="\\([^"]*\\)"' "$jar/page.html")"
answer="$(/usr/bin/curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 10 -b "$jar/owner" "\${nav[@]}" -X POST --data "request_id=$rid&csrf=$csrf&action=approve" "${ENGINE}$action")"
echo "owner=\${answer%% *}"
case "$answer" in *'${REDIRECT}'*code=*) echo "owner_code=yes" ;; *) echo "owner_code=no" ;; esac
`;
}

/** Reads the script's output. Anything unreadable fails: the check never passes on a missing answer. */
export function evaluateMacConsentOwnerProof(code: number, stdout: string): CheckResult {
  const values = Object.fromEntries(stdout.split('\n').map((line) => line.trim().match(/^(page|form|other_form|other_form_refused|other_page|owner|owner_code)=(\w+)$/)).filter((m): m is RegExpMatchArray => !!m).map((m) => [m[1]!, m[2]!]));
  const seen = `page ${values.page ?? '?'}, second account at the form ${values.other_form ?? '?'} (owner check's page: ${values.other_form_refused ?? '?'}), at /connect/authorize ${values.other_page ?? '?'}, owner ${values.owner ?? '?'} (code: ${values.owner_code ?? '?'})`;
  if (code !== 0) return { id: ID, title: TITLE, status: 'fail', detail: `the check did not finish (exit ${code}): ${seen}` };
  if (values.page !== '200' || values.form !== 'yes') return { id: ID, title: TITLE, status: 'fail', detail: `the approval page did not open with a form for the second account: ${seen}` };
  const refused = (status: string | undefined) => status === '401' || status === '403';
  if (!refused(values.other_form) || values.other_form_refused !== 'yes') return { id: ID, title: TITLE, status: 'fail', detail: `the second account's Connect was not refused by the owner check: ${seen}` };
  if (!refused(values.other_page)) return { id: ID, title: TITLE, status: 'fail', detail: `the second account's Connect at /connect/authorize was not refused: ${seen}` };
  if (values.owner !== '303' || values.owner_code !== 'yes') return { id: ID, title: TITLE, status: 'fail', detail: `the owner's Connect did not approve: ${seen}` };
  return { id: ID, title: TITLE, status: 'pass', detail: seen };
}

export async function checkMacConsentOwnerProof(machine: Machine, relayConfigured: boolean): Promise<CheckResult> {
  if (machine.os !== 'macos') return { id: ID, title: TITLE, status: 'skip', detail: 'Linux proves the owner with its owner socket.' };
  if (!relayConfigured) return { id: ID, title: TITLE, status: 'skip', detail: 'the approval page is served in relay mode, and this run has no relay' };
  try {
    const result = await machine.exec(macConsentOwnerProofScript(), { timeoutMs: 120_000 });
    return evaluateMacConsentOwnerProof(result.code, result.stdout);
  } catch (error) {
    return { ...evaluateMacConsentOwnerProof(1, ''), detail: `the check could not run: ${error instanceof Error ? error.message : String(error)}` };
  }
}
