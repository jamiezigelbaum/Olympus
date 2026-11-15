/**
 * The helpers an install's capture launches are there for its own version (Sparta 2026-11-15: a main build changed the WhatsApp
 * bridge fingerprint and shipped no bridge, so capture spawned a missing file for days). The installer bundle pins the bridge it
 * places (WHATSAPP_BRIDGE_NAME); the machine agent's `helper-files` lists the bridges installed where capture looks first.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CheckResult } from './report.ts';

/** The WhatsApp bridge an installer bundle pins, or undefined when it ships none (`none`, or no installer that names one). */
export function bundleWhatsAppBridgeName(bundleDir: string): string | undefined {
  for (const installer of ['install-linux.sh', 'install-macos.sh', 'install.sh']) {
    const path = join(bundleDir, installer);
    if (!existsSync(path)) continue;
    const name = /^WHATSAPP_BRIDGE_NAME=(\S+)$/m.exec(readFileSync(path, 'utf8'))?.[1];
    if (name && /^olympus-whatsapp-bridge-[0-9a-f]{16}$/.test(name)) return name;
  }
  return undefined;
}

/**
 * The install has this version's WhatsApp bridge where capture finds it. `installed` undefined: the machine could not be read.
 * `before`, on an update: the bridge the earlier release had, which the update must not leave capture without.
 */
export function whatsappBridgeCheck(input: {
  id: string;
  expected: string | undefined;
  installed: readonly string[] | undefined;
  before?: { expected: string | undefined; installed: readonly string[] | undefined };
}): CheckResult {
  const title = input.before
    ? 'WhatsApp capture that could start before the update can start after it: this version\'s bridge is installed'
    : 'This version\'s WhatsApp bridge is installed where capture and pairing find it, so neither needs Go';
  const fail = (detail: string): CheckResult => ({ id: input.id, title, status: 'fail', detail });
  if (!input.expected) return fail('the installer bundle ships no WhatsApp bridge, so capture on this version needs Go to build one');
  if (!input.installed) return fail('the machine\'s installed bridges could not be read');
  if (!input.installed.includes(input.expected)) {
    const had = input.before?.expected && input.before.installed?.includes(input.before.expected) ? `; before the update ${input.before.expected} was` : '';
    return fail(`${input.expected} is not installed (found: ${input.installed.join(', ') || 'none'})${had}`);
  }
  return { id: input.id, title, status: 'pass', detail: input.expected };
}
