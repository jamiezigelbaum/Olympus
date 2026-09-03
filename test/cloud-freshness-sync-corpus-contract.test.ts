// Cross-layer guard: every corpus id the host freshness script sends must be
// one the sync route accepts.
//
// This is the test that was missing on 2026-07-25. The freshness script and
// the sync route each had their own green test, on opposite sides of a layer
// boundary, asserting incompatible things about the same corpus id. Nothing
// exercised them together, so a canonical-id rename took the daily Readwise
// sync down for three days without turning anything red.
//
// Both sides are derived, never transcribed:
//   - the script side by EXECUTING config/systemd/user/olympus-cloud-fresh.sh
//     against a recording curl and replaying the request bodies it actually
//     produced, in every ownership phase the script supports;
//   - the route side by POSTing those bodies verbatim at the real worker.
// Nothing here hard-codes a corpus id, so editing the script's list cannot
// leave this guard passing against a stale copy of it.

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  canonicalSourceCorpusId,
  createSourceCorpusRegistry,
} from '../src/core/source-corpus-registry.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';

const CLOUD_SCRIPT = join(import.meta.dir, '..', 'config', 'systemd', 'user', 'olympus-cloud-fresh.sh');
const SYNC_URL = 'http://worker.test/v1/source/index/sync';

// The script guards X ownership behind a switch, so both settings have to run
// or the guard would only ever see one phase's corpus list.
const X_OWNERSHIP_PHASES = ['true', 'false'] as const;

/**
 * Runs the real freshness script with a curl that records the request bodies
 * instead of sending them, and returns every distinct body it produced.
 */
function runFreshnessScriptAndRecordRequestBodies(): string[] {
  const root = mkdtempSync(join(tmpdir(), 'olympus-cloud-fresh-contract-'));
  const bin = join(root, 'bin');
  const capture = join(root, 'requests.txt');
  const authHeader = join(root, 'worker-header');
  mkdirSync(bin);
  writeFileSync(join(bin, 'curl'), `#!/usr/bin/env bash
set -euo pipefail
payload=""
while (( \$# > 0 )); do
  if [[ "\$1" == "--data" ]]; then
    shift
    payload="\$1"
  fi
  shift
done
printf '%s\\n' "\$payload" >> '${capture}'
printf '%s\\n' '{"status":"completed"}'
`);
  // The script's auth-file check uses GNU stat; stub it so this guard runs on
  // any developer machine, not only on the Linux host.
  writeFileSync(join(bin, 'stat'), '#!/usr/bin/env bash\necho 600\n');
  chmodSync(join(bin, 'curl'), 0o755);
  chmodSync(join(bin, 'stat'), 0o755);
  writeFileSync(authHeader, 'Authorization: Bearer worker-token\n', { mode: 0o600 });
  writeFileSync(capture, '');

  for (const includeLegacyX of X_OWNERSHIP_PHASES) {
    Bun.spawnSync(['/bin/bash', CLOUD_SCRIPT], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        OLYMPUS_CLOUD_FRESHNESS_CURL_BIN: join(bin, 'curl'),
        OLYMPUS_CLOUD_FRESHNESS_LOG_PATH: join(root, 'cloud.log'),
        OLYMPUS_CLOUD_FRESHNESS_RETRY_DELAY_SECONDS: '0',
        OLYMPUS_CLOUD_FRESHNESS_INCLUDE_LEGACY_X: includeLegacyX,
        OLYMPUS_WORKER_AUTH_HEADER_FILE: authHeader,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
  }

  const captured = readFileSync(capture, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return [...new Set(captured)];
}

let recordedRequestBodies: string[] | undefined;

function requestBodiesSentByFreshnessScript(): string[] {
  recordedRequestBodies ??= runFreshnessScriptAndRecordRequestBodies();
  return recordedRequestBodies;
}

function corpusIdOfRequestBody(body: string): string {
  const parsed = JSON.parse(body) as Record<string, unknown>;
  const corpusId = parsed.corpus_id;
  if (typeof corpusId !== 'string' || corpusId.length === 0) {
    throw new Error(`Freshness script sent a sync request without a corpus_id: ${body}`);
  }
  return corpusId;
}

describe('cloud freshness script / sync route corpus contract', () => {
  test('allows a synchronous scheduler handoff to finish before curl aborts', () => {
    expect(readFileSync(CLOUD_SCRIPT, 'utf8'))
      .toContain('OLYMPUS_CLOUD_FRESHNESS_CURL_TIMEOUT_SECONDS:-600');
  });

  test('every corpus id the freshness script sends is accepted by the sync route', async () => {
    const requestBodies = requestBodiesSentByFreshnessScript();
    // Fails loudly if the recording harness stops capturing, so the guard can
    // never pass by having observed nothing.
    expect(requestBodies.length).toBeGreaterThan(0);

    // A worker with no sync handlers configured answers 501
    // source_index_sync_not_supported for a syntactically valid corpus whose
    // canonical scheduler lane is absent. A 400 still means the request shape
    // itself was rejected. Registry membership is proved independently below.
    const worker = createEmailSourceWorker({});
    const rejected: string[] = [];
    for (const body of requestBodies) {
      const response = await worker.fetch(new Request(SYNC_URL, {
        method: 'POST',
        body,
        headers: { 'Content-Type': 'application/json' },
      }));
      if (response.status !== 400) continue;
      const payload = await response.json() as { error?: { code?: string; message?: string } };
      rejected.push(`${body} -> 400 ${payload.error?.code ?? ''}: ${payload.error?.message ?? ''}`);
    }

    expect(rejected).toEqual([]);
  }, 60_000);

  test('the registry discriminator rejects an unknown sync corpus id', () => {
    const registry = createSourceCorpusRegistry();
    expect(registry.has('internal.not_a_corpus.nope', 'sync')).toBe(false);
    expect(() => registry.require('internal.not_a_corpus.nope', 'sync'))
      .toThrow('configured sync corpora');
  });

  test('every corpus id the freshness script sends resolves to a sync-capable registry corpus', async () => {
    // The other half of the same contract: the script's ids must also be real
    // registry corpora, so a script edit cannot introduce an id that only the
    // route happens to tolerate.
    const registry = createSourceCorpusRegistry();
    const syncCorpusIds = registry.ids('sync');
    const corpusIds = requestBodiesSentByFreshnessScript().map(corpusIdOfRequestBody);

    expect(corpusIds.length).toBeGreaterThan(0);
    for (const corpusId of corpusIds) {
      expect(syncCorpusIds).toContain(canonicalSourceCorpusId(corpusId));
    }
  }, 60_000);
});
