/**
 * Opening the Mac's privacy page for Full Disk Access and showing the helper
 * app in Finder so the person can drag it into the list (Apple does not let an
 * app turn this on for itself). Called once, when the person has just chosen
 * the whole computer; nothing else in Olympus opens System Settings.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ENGINE_HELPER_APP_NAME } from '../../core/engine-service.ts';
import { FULL_DISK_ACCESS_URL } from './mac-permissions.ts';

export function helperAppPathForHome(home: string = homedir()): string {
  return join(home, 'Library', 'Application Support', 'Olympus', ENGINE_HELPER_APP_NAME);
}

export function revealHelperAndOpenFullDiskAccess(deps: {
  run?: (command: string, args: string[]) => void;
  exists?: (path: string) => boolean;
  helperApp?: string;
} = {}): void {
  const run = deps.run ?? ((command, args) => { spawn(command, args, { stdio: 'ignore', detached: true }).unref(); });
  const helper = deps.helperApp ?? helperAppPathForHome();
  if ((deps.exists ?? existsSync)(helper)) run('/usr/bin/open', ['-R', helper]);
  run('/usr/bin/open', [FULL_DISK_ACCESS_URL]);
}
