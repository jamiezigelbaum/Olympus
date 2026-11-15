import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundleWhatsAppBridgeName, whatsappBridgeCheck } from '../scripts/release-check/helper-files.ts';

const OLD = 'olympus-whatsapp-bridge-0123456789abcdef';
const NEW = 'olympus-whatsapp-bridge-fedcba9876543210';

function bundle(installer: string, pin: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'rc-helper-files-'));
  writeFileSync(join(dir, installer), `#!/bin/sh\nOLYMPUS_VERSION=1.0.0\nWHATSAPP_BRIDGE_NAME=${pin}\n`);
  return dir;
}

describe('an install has its own version\'s WhatsApp bridge', () => {
  test('the bundle\'s pinned bridge is read from any platform\'s installer; none is no bridge', () => {
    expect(bundleWhatsAppBridgeName(bundle('install-linux.sh', NEW))).toBe(NEW);
    expect(bundleWhatsAppBridgeName(bundle('install.sh', NEW))).toBe(NEW);
    expect(bundleWhatsAppBridgeName(bundle('install-linux.sh', 'none'))).toBeUndefined();
    expect(bundleWhatsAppBridgeName(mkdtempSync(join(tmpdir(), 'rc-helper-files-')))).toBeUndefined();
  });

  test('a bundle without a bridge, or an install without this version\'s, fails and says which', () => {
    expect(whatsappBridgeCheck({ id: 'install.whatsapp-bridge', expected: NEW, installed: [NEW] }).status).toBe('pass');
    expect(whatsappBridgeCheck({ id: 'install.whatsapp-bridge', expected: undefined, installed: [] }).detail).toContain('ships no WhatsApp bridge');
    expect(whatsappBridgeCheck({ id: 'install.whatsapp-bridge', expected: NEW, installed: undefined }).status).toBe('fail');
    // Sparta 2026-11-15: the update changed the fingerprint and left only the earlier release's bridge.
    const kept = whatsappBridgeCheck({ id: 'upgrade.whatsapp-bridge', expected: NEW, installed: [OLD], before: { expected: OLD, installed: [OLD] } });
    expect(kept.status).toBe('fail');
    expect(kept.detail).toBe(`${NEW} is not installed (found: ${OLD}); before the update ${OLD} was`);
  });
});
