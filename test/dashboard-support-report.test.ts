import { DASHBOARD_UNLOCK_HEADER } from '../src/core/dashboard-launch.ts';
import { expect, test } from 'bun:test';
import { ownerLocalMint, ownerUnlockKey } from './helpers/owner-local-mint.ts';
import { sourceSupportDetails, systemSupportReport } from '../src/workers/dashboard/source-failure.ts';
import { renderDashboardHelpPage } from '../src/workers/dashboard/pages/local.ts';

const account = 'Mark Alexander +15551234567 mark@example.test /Users/mark/SecretNotebook FamilyChat TaxFolder';
test('copied support details never include account content, titles, or home paths', () => {
  const report = systemSupportReport({
    version: '1.3.1', os: 'darwin', osVersion: '25.1.0', host: 'standalone', engine: 'running',
    model: 'failed', remote: 'on', downloads: { search: 'downloading', transcription: account },
    sources: [{ sourceId: 'whatsapp.personal.messages', state: 'Failing', failure: 'timeout', ref: '0123456789abcdef' },
      { sourceId: account, state: account, failure: account, ref: account }],
    logs: [`olympus-worker: [olympus:source-scheduler] task_failed error_kind=timeout error_hash=0123456789abcdef message=${account}`, account, `[olympus] ${account}`],
  });
  for (const secret of ['Mark', 'Alexander', '15551234567', 'mark', '@', '/Users/', 'SecretNotebook', 'FamilyChat', 'TaxFolder']) expect(report).not.toContain(secret);
  expect(report).toContain('timeout');
  expect(report).toContain('25.1.0');
  expect(report).toContain('task_failed');
  expect(report).toContain('Search model: downloading');
  expect(report).toContain('Transcription model: unknown');
  const planted = systemSupportReport({ version: account, os: account, osVersion: account, host: account, engine: account, model: account, remote: account, sources: [], logs: [] });
  expect(planted).not.toContain('mark');
  expect(sourceSupportDetails({ sourceId: 'dropbox.files', state: 'Needs you', failure: account, ref: account })).not.toContain('mark');
});
test('Help offers a content-free report with the shared copy control', () => {
  const html = renderDashboardHelpPage({ systemReport: 'Olympus 1.3.1\nEngine: running', controlSessionCsrfToken: 'csrf' });
  expect(html).toContain('Copy system report');
  expect(html).toContain('data-copy-target="#system-report"');
  expect(html).toContain('no names');
});

test('the Help route is reachable, and only locally opened controls get a system report', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createSovereigntyEngine, loadSovereigntyPreset } = await import('../src/core/sovereignty.ts');
  const { createEmailSourceWorker } = await import('../src/workers/engine/index.ts');
  const { withWorkerBearerAuth } = await import('../src/workers/http.ts');
  const { recordRequestPeer } = await import('../src/core/request-peer.ts');
  const dir = mkdtempSync(join(tmpdir(), 'support-report-'));
  let reads = 0;
  let sourcesReadable = true;
  const worker = createEmailSourceWorker({
    sourceIndexStatus: { status: async () => { if (!sourcesReadable) throw new Error(account); return { kind: 'source_index_status', generated_at: new Date().toISOString(), corpora: [], policy: {} } as any; } },
    sourceDashboard: { secretStore: { label: 'memory', get: async () => undefined, getSync: () => undefined, set: async () => {}, delete: async () => {}, list: async () => [] }, registryPath: join(dir, 'handles.json'), sovereigntyEngine: createSovereigntyEngine(loadSovereigntyPreset('local-only')),
      systemReport: () => { reads++; return { version: '1.3.1', os: 'linux', osVersion: '6.8.0', host: 'standalone', engine: 'running', model: 'ready', remote: 'off', logs: [] }; },
    },
  });
  const fetch = withWorkerBearerAuth(worker.fetch, { authToken: 'worker-secret' });
  const origin = 'http://127.0.0.1:8010';
  try {
    const locked = await fetch(new Request(origin + '/dashboard?help', { headers: { Authorization: 'Bearer worker-secret' } }));
    expect(locked.status).toBe(200);
    expect(await locked.text()).not.toContain('id="system-report"');
    expect(reads).toBe(0);
    const session = await ownerLocalMint(fetch, origin, 'worker-secret');
    const request = new Request(origin + '/dashboard?help', { headers: { [DASHBOARD_UNLOCK_HEADER]: await ownerUnlockKey(fetch, origin, 'worker-secret'), Cookie: session.headers.get('set-cookie')!.split(';')[0]! } });
    recordRequestPeer(request, '127.0.0.1');
    const response = await fetch(request);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('id="system-report"');
    expect(reads).toBe(1);
    sourcesReadable = false;
    const broken = new Request(origin + '/dashboard?help', { headers: { [DASHBOARD_UNLOCK_HEADER]: await ownerUnlockKey(fetch, origin, 'worker-secret'), Cookie: session.headers.get('set-cookie')!.split(';')[0]! } });
    recordRequestPeer(broken, '127.0.0.1');
    const fallback = await fetch(broken);
    expect(fallback.status).toBe(200);
    const report = await fallback.text();
    expect(report).toContain('Source states: unavailable');
    expect(report).toContain('id="system-report"');
    expect(report).not.toContain('SecretNotebook');
  } finally { worker.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a source that needs its owner says what it needs, as a closed code', () => {
  const details = sourceSupportDetails({ sourceId: 'dropbox.files', state: 'Needs you', need: 'answer_readiness' });
  expect(details).toContain('Failure: none');
  expect(details).toContain('Needs: answer_readiness');
  expect(sourceSupportDetails({ sourceId: 'dropbox.files', state: 'Needs you', need: account })).toContain('Needs: unknown');
  expect(sourceSupportDetails({ sourceId: 'dropbox.files', state: 'Fresh' })).not.toContain('Needs:');
});
