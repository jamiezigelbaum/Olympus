/** XDG application registration; caller holds the engine lifecycle lock. */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { writePrivateFileAtomicSync, removeFileDurablySync } from './atomic-file.ts';
import { assertLinuxManagedPath, createLinuxPrivateDirectory, readLinuxEngineReceipt, type LinuxEngineLayout } from './linux-engine-layout.ts';
import type { EngineExec } from './engine-service.ts';

const ID = 'ai.olympusplugin.Olympus';
/** The launcher icon; the bar widget keeps its own simple mark. */
export const LINUX_APP_ICON = 'assets/app-icon.png';
export function linuxDesktopEntryPaths(layout: LinuxEngineLayout) {
  return {
    desktop: join(layout.dataHome, 'applications', `${ID}.desktop`),
    icon: join(layout.dataHome, 'icons/hicolor/512x512/apps', `${ID}.png`),
  };
}
export function renderLinuxDesktopEntry(launcher: string): string {
  // Exec is ASCII; '=' is forbidden in the executable. Field expansion inside
  // quoted arguments is undefined, so refuse '%' instead of relying on '%%'.
  if (!isAbsolute(launcher) || /[^\x20-\x7e]|[=%]/.test(launcher)) {
    throw new Error('The Olympus launcher needs an absolute ASCII path without control characters, percent or equals signs.');
  }
  // Command quoting is decoded AFTER the desktop string escape layer.
  const quoted = launcher.replace(/["`$\\]/g, '\\$&').replace(/\\/g, '\\\\');
  return `[Desktop Entry]\nType=Application\nName=Olympus\nComment=Open your Olympus dashboard\nExec="${quoted}" dashboard\nIcon=${ID}\nTerminal=false\nCategories=Utility;\nX-Olympus-Managed=true\n`;
}
export function isManagedLinuxDesktopEntry(text: string): boolean {
  const groups = text.split(/^\[/m);
  const entry = groups.filter(group => group.startsWith('Desktop Entry]'));
  return entry.length === 1 && entry[0]!.split(/\r?\n/).filter(line => line.startsWith('X-Olympus-Managed=')).join('\n') === 'X-Olympus-Managed=true';
}
const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
export function preflightLinuxDesktopEntry(layout: LinuxEngineLayout): void {
  const icon = linuxDesktopEntryPaths(layout).icon;
  const artifact = readLinuxEngineReceipt(layout.receiptPath)?.machineArtifacts.find(item => item.path === icon && item.kind === 'file');
  assertLinuxDesktopEntryOwnership(layout, artifact ? [artifact.sha256] : []);
}
/** Recovery may accept only the journal's old or newly published icon bytes. */
export function assertLinuxDesktopEntryOwnership(layout: LinuxEngineLayout, iconDigests: readonly string[]): void {
  renderLinuxDesktopEntry(layout.launcherPath);
  const paths = linuxDesktopEntryPaths(layout);
  for (const path of Object.values(paths)) {
    assertLinuxManagedPath(path);
    if (existsSync(path) && lstatSync(path).nlink !== 1) throw new Error(`${path} is linked elsewhere and was retained.`);
  }
  if (existsSync(paths.desktop) && !isManagedLinuxDesktopEntry(readFileSync(paths.desktop, 'utf8'))) {
    throw new Error(`${paths.desktop} is your own launcher and was retained. Move it aside to let Olympus create its launcher.`);
  }
  if (existsSync(paths.icon)) {
    if (!iconDigests.includes(digest(paths.icon))) throw new Error(`${paths.icon} is not an unchanged Olympus icon and was retained.`);
  }
}
const runCache: EngineExec = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 3_000 });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
};
export function refreshLinuxDesktopCaches(layout: LinuxEngineLayout, exec: EngineExec = runCache): void {
  // Cache tools are optional, and their failure must not fail a lifecycle operation.
  for (const [command, args] of [
    ['update-desktop-database', [join(layout.dataHome, 'applications')]],
    ['gtk-update-icon-cache', ['--force', '--ignore-theme-index', join(layout.dataHome, 'icons/hicolor')]],
  ] as const) { try { exec(command, [...args]); } catch { /* optional desktop tool */ } }
}
export function writeLinuxDesktopEntry(layout: LinuxEngineLayout, packageRoot: string, exec?: EngineExec): void {
  preflightLinuxDesktopEntry(layout);
  const paths = linuxDesktopEntryPaths(layout);
  const icon = readFileSync(join(packageRoot, LINUX_APP_ICON));
  for (const path of Object.values(paths)) createLinuxPrivateDirectory(dirname(path));
  writePrivateFileAtomicSync(paths.icon, icon);
  writePrivateFileAtomicSync(paths.desktop, renderLinuxDesktopEntry(layout.launcherPath));
  refreshLinuxDesktopCaches(layout, exec);
}
export function removeLinuxDesktopEntry(layout: LinuxEngineLayout, exec?: EngineExec): void {
  preflightLinuxDesktopEntry(layout);
  for (const path of Object.values(linuxDesktopEntryPaths(layout))) if (existsSync(path)) removeFileDurablySync(path);
  refreshLinuxDesktopCaches(layout, exec);
}
export function linuxDesktopEntryStatus(layout: LinuxEngineLayout): { present: boolean; path: string } {
  const paths = linuxDesktopEntryPaths(layout);
  try {
    preflightLinuxDesktopEntry(layout);
    return { present: existsSync(paths.icon) && readFileSync(paths.desktop, 'utf8') === renderLinuxDesktopEntry(layout.launcherPath), path: paths.desktop };
  } catch { return { present: false, path: paths.desktop }; }
}
