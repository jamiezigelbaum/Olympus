// A registry that lists Telegram and WhatsApp as `legacy`: what an install from before messaging
// accounts had folders has, and what a test needs to exercise the paths that were always there
// (a fresh home would place both in their account folders).

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { sourceRegistryPath } from '../../src/core/source-registry.ts';

export const MESSAGING_SOURCE_IDS = ['telegram.messages', 'whatsapp.personal.messages'] as const;

export function pinMessagingLegacy(env: Record<string, string | undefined>): void {
  const path = sourceRegistryPath(env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({
    schema: 1,
    accounts: MESSAGING_SOURCE_IDS.map((source_id) => ({
      source_id,
      slot: '1',
      state: 'active',
      layout: 'legacy',
      corpus_ids: [],
      created_at: '2026-10-01T00:00:00.000Z',
    })),
  })}\n`);
}
