/** The small, fixed privilege boundary for the standalone Mac engine. No user-supplied paths or plist cross it. */
import { lstatSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { userInfo } from 'node:os';
import { OperationError } from './operation-error.ts';
import type { EngineExec, EngineServiceOptions } from './engine-service.ts';

export const MAC_ENGINE_DAEMON_PLIST = '/Library/LaunchDaemons/ai.olympusplugin.engine.plist';
export type MacEngineManager = 'agent' | 'daemon';

export function validateMacEngineOwner(userName: string, uid: number): void {
  if (!/^[a-z_][a-z0-9._-]{0,31}$/i.test(userName) || userName === 'root'
    || !Number.isSafeInteger(uid) || uid <= 0 || uid > 2_147_483_647) {
    throw new OperationError('invalid_params', 'Olympus could not confirm the account it runs as. Nothing was changed.');
  }
}

/** Each account recognizes only its own daemon. A different account's daemon is never adopted. */
export function macEngineManager(home: string, daemonPath = MAC_ENGINE_DAEMON_PLIST): MacEngineManager {
  let stat;
  try { stat = lstatSync(daemonPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'agent';
    throw new OperationError('config_error', 'The Olympus server setting could not be read. Open this Mac with Screen Sharing and try again.');
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new OperationError('config_error', 'The Olympus server setting could not be read safely. Update Olympus before trying again.');
  const text = readFileSync(daemonPath, 'utf8');
  if (daemonPath === MAC_ENGINE_DAEMON_PLIST && (stat.uid !== 0 || (stat.mode & 0o777) !== 0o644)) {
    throw new OperationError('config_error', 'The Olympus server setting has unexpected permissions. Update Olympus before trying again.');
  }
  const configuredHome = /<key>HOME<\/key>\s*<string>([^<]+)<\/string>/.exec(text)?.[1];
  const decodedHome = configuredHome?.replaceAll('&apos;', "'").replaceAll('&#39;', "'").replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
  return /<key>UserName<\/key>\s*<string>[^<]+<\/string>/.test(text) && decodedHome === home ? 'daemon' : 'agent';
}

/**
 * This code is embedded literally in the administrator dialog. The ONLY arguments are
 * the account name and numeric uid. Even those are checked again against the system
 * account database. The daemon always runs the standard installed helper as that user.
 * plutil receives values as arguments: paths and names never become shell or XML code.
 */
export function macServerModeScript(enable: boolean): string {
  const common = `set -eu
[ "$#" = 2 ] || exit 64
owner=$1
owner_uid=$2
case "$owner" in ''|root|[!a-zA-Z_]*|*[!a-zA-Z0-9._-]*) exit 64 ;; esac
[ "\${#owner}" -le 32 ] || exit 64
case "$owner_uid" in ''|*[!0-9]*) exit 64 ;; esac
[ "$owner_uid" -gt 0 ] && [ "$owner_uid" -le 2147483647 ] || exit 64
[ "$(/usr/bin/id -u "$owner")" = "$owner_uid" ] || exit 64
[ "$(/usr/bin/id -u)" = 0 ] || exit 77
daemon=/Library/LaunchDaemons/ai.olympusplugin.engine.plist
target=system/ai.olympusplugin.engine
if [ -e "$daemon" ] || [ -L "$daemon" ]; then
  [ -f "$daemon" ] && [ ! -L "$daemon" ] || exit 65
  [ "$(/usr/bin/plutil -extract UserName raw -o - "$daemon")" = "$owner" ] || exit 65
fi
`;
  if (!enable) return common + `printed=0
/bin/launchctl print "$target" >/dev/null 2>&1 || printed=$?
case "$printed" in
  0) /bin/launchctl bootout "$target" ;;
  113|3) ;;
  *) exit 75 ;;
esac
n=0
while :; do
  printed=0
  /bin/launchctl print "$target" >/dev/null 2>&1 || printed=$?
  case "$printed" in 113|3) break ;; 0) ;; *) exit 75 ;; esac
  n=$((n + 1)); [ "$n" -lt 120 ] || exit 75
  /bin/sleep 0.25
done
/bin/rm -f "$daemon"
`;
  return common + `[ ! -e "$daemon" ] || exit 65
record=$(/usr/bin/dscl . -read "/Users/$owner" NFSHomeDirectory)
home=\${record#NFSHomeDirectory: }
case "$home" in /*) ;; *) exit 65 ;; esac
case "$home" in *'
'*) exit 65 ;; esac
group=$(/usr/bin/id -gn "$owner")
support="$home/Library/Application Support/Olympus"
helper="$support/Olympus Engine.app/Contents/MacOS/OlympusEngineHost"
runtime="$support/runtime/bun"
entry="$support/app/dist/cli.js"
[ -x "$helper" ] && [ -x "$runtime" ] && [ -f "$entry" ] || exit 66
# The temporary plist is created by root in a root-owned directory, never read
# from a path supplied by the caller. It is not executable.
tmp=$(/usr/bin/mktemp /Library/LaunchDaemons/.olympus-engine.XXXXXXXX)
trap '/bin/rm -f "$tmp"' EXIT
printf '%s\\n' '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict/></plist>' > "$tmp"
/usr/bin/plutil -insert Label -string ai.olympusplugin.engine "$tmp"
/usr/bin/plutil -insert UserName -string "$owner" "$tmp"
/usr/bin/plutil -insert GroupName -string "$group" "$tmp"
/usr/bin/plutil -insert ProgramArguments -xml '<array/>' "$tmp"
/usr/bin/plutil -insert ProgramArguments.0 -string "$helper" "$tmp"
/usr/bin/plutil -insert ProgramArguments.1 -string "$runtime" "$tmp"
/usr/bin/plutil -insert ProgramArguments.2 -string --no-env-file "$tmp"
/usr/bin/plutil -insert ProgramArguments.3 -string "$entry" "$tmp"
/usr/bin/plutil -insert ProgramArguments.4 -string __engine-run "$tmp"
/usr/bin/plutil -insert AssociatedBundleIdentifiers -xml '<array><string>ai.olympusplugin.engine-host</string></array>' "$tmp"
/usr/bin/plutil -insert WorkingDirectory -string "$support/app" "$tmp"
/usr/bin/plutil -insert EnvironmentVariables -xml '<dict/>' "$tmp"
/usr/bin/plutil -insert EnvironmentVariables.HOME -string "$home" "$tmp"
/usr/bin/plutil -insert EnvironmentVariables.PATH -string "$support/runtime:/usr/bin:/bin:/usr/sbin:/sbin" "$tmp"
/usr/bin/plutil -insert EnvironmentVariables.OLYMPUS_ENGINE_HOST -string 1 "$tmp"
/usr/bin/plutil -insert RunAtLoad -bool YES "$tmp"
/usr/bin/plutil -insert KeepAlive -xml '<dict><key>SuccessfulExit</key><false/></dict>' "$tmp"
/usr/bin/plutil -insert ThrottleInterval -integer 30 "$tmp"
/usr/bin/plutil -insert StandardOutPath -string "$home/Library/Logs/Olympus/engine.log" "$tmp"
/usr/bin/plutil -insert StandardErrorPath -string "$home/Library/Logs/Olympus/engine.err" "$tmp"
/usr/sbin/chown root:wheel "$tmp"
/bin/chmod 0644 "$tmp"
/bin/mv "$tmp" "$daemon"
if ! /bin/launchctl bootstrap system "$daemon"; then
  /bin/rm -f "$daemon"
  exit 75
fi
`;
}

const quoteShell = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
/**
 * The account this process runs as. Bun reports "unknown" when USER is unset,
 * as it is for the detached dashboard helper, so fall back to the uid's name.
 */
export function currentMacUserName(
  uid: number,
  reported: string = userInfo().username,
  lookup: (uid: number) => string = uid => execFileSync('/usr/bin/id', ['-un', String(uid)], { encoding: 'utf8', timeout: 5_000 }).trim(),
): string {
  if (reported && reported !== 'unknown') return reported;
  try { return lookup(uid); } catch { return reported; }
}

export function authorizeMacServerMode(enable: boolean, options: EngineServiceOptions, exec: EngineExec): void {
  const uid = options.uid ?? process.getuid?.() ?? -1;
  const userName = options.userName ?? currentMacUserName(uid);
  validateMacEngineOwner(userName, uid);
  const command = `/bin/sh -c ${quoteShell(macServerModeScript(enable))} olympus ${quoteShell(userName)} ${quoteShell(String(uid))}`;
  // No path, environment value, log text, or caller-provided plist enters this program.
  const script = `do shell script "${command.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}" with administrator privileges`;
  const result = exec('osascript', ['-e', script]);
  if (result.status !== 0) {
    if (/(-128|user cancel)/i.test(result.stderr)) throw new OperationError('config_error', 'The administrator request was cancelled. Nothing was changed.');
    throw new OperationError('config_error', 'Your Mac could not change the Olympus server setting. Open System Settings and check that administrator approval is available, then try again.');
  }
}
