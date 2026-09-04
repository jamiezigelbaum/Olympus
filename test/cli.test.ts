import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  formatCliFatalError,
  isV04PublicCliInvocation,
  lifecycleRecoverySignalsFromWorkerHttpState,
  parseArgs,
  parseEvalShardExportArgs,
  parseQueuedContentRetargetArgs,
  parseSourceSchedulerUnparkArgs,
  parseTerminalContentRequalifyArgs,
  parseXContentRecoveryArgs,
} from '../src/cli.ts';
import { dashboardQueryTokenFromWorkerAuthToken } from '../src/core/worker-auth.ts';
import { CredentialBrokerError } from '../src/workers/credential-broker/index.ts';
import { operations } from '../src/core/operations.ts';
import { V0_4_PUBLIC_CLI_COMMANDS } from '../src/core/public-surface.ts';

describe('CLI tool surface', () => {
  test('worker status recovery names only sources with something to resume', () => {
    // On a machine with nothing connected, recovery listed partial_sync for
    // three sources and a pairing to finish for two more (clean-install
    // rehearsal, 2026-09-05). Recovery is a list of resumable work.
    const fresh = lifecycleRecoverySignalsFromWorkerHttpState({
      source_dashboard: {
        sources: [
          {
            source_id: 'google_drive.docs',
            configured: false,
            connection: { state: 'not_connected' },
            answer_readiness: { state: 'needs_attention' },
            queue_health: { needs_attention: 2 },
            embedding_lane_state: 'embedding_lane_disabled',
          },
          {
            source_id: 'telegram.messages',
            configured: false,
            connection: { state: 'not_connected' },
            answer_readiness: { state: 'disconnected' },
            queue_health: { needs_attention: 0 },
          },
          {
            source_id: 'whatsapp_personal.messages',
            configured: false,
            connection: { state: 'needs_setup' },
            answer_readiness: { state: 'disconnected' },
            queue_health: { needs_attention: 0 },
          },
        ],
      },
    });
    expect(fresh).toEqual([]);

    // A connected source with real work, and a handshake actually in flight,
    // still report.
    const connected = lifecycleRecoverySignalsFromWorkerHttpState({
      source_dashboard: {
        sources: [
          {
            source_id: 'google_drive.docs',
            configured: true,
            connection: { state: 'synced' },
            answer_readiness: { state: 'needs_attention' },
            queue_health: { needs_attention: 2 },
          },
          {
            source_id: 'gmail.email',
            configured: false,
            connection: { state: 'awaiting_consent' },
            answer_readiness: { state: 'disconnected' },
            queue_health: { needs_attention: 0 },
          },
          {
            source_id: 'telegram.messages',
            configured: false,
            connection: { state: 'reauth_required' },
            answer_readiness: { state: 'needs_attention' },
            queue_health: { needs_attention: 0 },
          },
        ],
      },
    });
    expect(connected).toEqual([
      { kind: 'partial_sync', source_id: 'google_drive.docs' },
      { kind: 'oauth_pending', source_id: 'gmail.email' },
      { kind: 'pairing_pending', source_id: 'telegram.messages' },
      { kind: 'capture_interrupted', source_id: 'telegram.messages' },
    ]);
  });

  test('operator errors preserve typed credential contention and retry guidance', () => {
    const error = new CredentialBrokerError(
      'credential_refresh_busy',
      'Credential handle is already being refreshed by another process.',
      { handle: 'private.handle', capability: 'private.capability' },
    );
    expect(formatCliFatalError(error)).toEqual([
      'Error [credential_refresh_busy]: Credential handle is already being refreshed by another process.',
      'Retryable: retry after 30 seconds.',
    ]);
  });

  test('package bin exposes the full documented CLI surface', async () => {
    const help = await runBin(['--help']);
    expect(help.stdout).toContain('olympus setup --preset');
    expect(help.stdout).toContain('olympus worker install');
    expect(help.stdout).toContain('olympus worker start|stop|restart|status|foreground|upgrade|uninstall');
    expect(help.stdout).toContain('olympus dashboard');
    expect(help.stdout).toContain('olympus doctor');
    expect(help.stdout).toContain('olympus connect google|gmail|google-drive --client-id <id> [--client-secret-stdin] [--redirect-port <port>]');
    expect(help.stdout).toContain('olympus connect dropbox --client-id <id> [--redirect-port <port>]');
    expect(help.stdout).not.toContain('--client-secret <secret>');
    expect(help.stdout).toContain('olympus source answer <question>');
    expect(help.stdout).toContain('olympus data delete');
    expect(help.stdout).toContain('olympus data verify --input <dir>');
    expect(help.stdout).toContain('olympus serve');
    for (const privateCommand of [
      'source index sync',
      'source scheduler',
      'source request-budget',
      'ingestion',
      'calendar',
      'connect x',
      'connect gcp',
      'connect notion',
      'data migrate',
      'x reconcile',
      'x content',
      'xanthos',
      'email search',
      'email index',
      'email ping',
      'email answer',
    ]) {
      expect(help.stdout).not.toContain(privateCommand);
    }

    const sourceHelp = await runBin(['source', 'answer', '--help']);
    expect(sourceHelp.stdout).toContain('Usage: olympus source answer');
    expect(sourceHelp.stdout).toContain('bounded calling-assistant-safe answer');

    const sourceGroupHelp = await runBin(['source', '--help']);
    expect(sourceGroupHelp.stdout).toContain('Usage: olympus source <command>');
    expect(sourceGroupHelp.stdout).toContain('olympus source index search <query> --corpus-id <corpus>');
    expect(sourceGroupHelp.stdout).not.toContain('olympus source scheduler');

    const sourceIndexHelp = await runBin(['source', 'index', '--help']);
    expect(sourceIndexHelp.stdout).toContain('Usage: olympus source index <command>');
    expect(sourceIndexHelp.stdout).toContain('olympus source index status');

    const sovereigntyHelp = await runBin(['sovereignty', '--help']);
    expect(sovereigntyHelp.stdout).toContain('Usage: olympus sovereignty <command>');
    expect(sovereigntyHelp.stdout).toContain('olympus sovereignty init');
  }, 30_000);

  test('the public CLI catalog rejects repository-only commands before dispatch', async () => {
    expect(isV04PublicCliInvocation(['source', 'answer', 'question'])).toBe(true);
    expect(isV04PublicCliInvocation([])).toBe(true);
    expect(isV04PublicCliInvocation(['--version'])).toBe(true);
    expect(isV04PublicCliInvocation(['--tools-json'])).toBe(true);
    expect(isV04PublicCliInvocation(['--tools-json', 'extra'])).toBe(false);
    expect(isV04PublicCliInvocation(['version', 'extra'])).toBe(false);
    expect(isV04PublicCliInvocation(['connect', 'readwise', '--api-key-stdin'])).toBe(true);
    for (const action of ['install', 'start', 'stop', 'restart', 'status', 'foreground', 'upgrade', 'uninstall']) {
      expect(isV04PublicCliInvocation(['worker', action])).toBe(true);
    }
    expect(isV04PublicCliInvocation(['source', 'index', '--help'])).toBe(true);
    expect(isV04PublicCliInvocation(['source', 'index', 'sync'])).toBe(false);
    expect(isV04PublicCliInvocation(['connect', 'x', '--client-id', 'id'])).toBe(false);
    expect(isV04PublicCliInvocation(['connect', 'gcp', '--project', 'p'])).toBe(false);
    expect(isV04PublicCliInvocation(['connect', 'notion', '--api-key-stdin'])).toBe(false);
    expect(isV04PublicCliInvocation(['data', 'migrate', '--dry-run'])).toBe(false);
    expect(isV04PublicCliInvocation(['ingestion', 'status'])).toBe(false);
    expect(isV04PublicCliInvocation(['email', 'ping'])).toBe(false);
    expect(isV04PublicCliInvocation(['email', 'answer', 'question'])).toBe(false);

    for (const command of [
      ['source', 'index', 'sync'],
      ['connect', 'x', '--client-id', 'id'],
      ['connect', 'gcp', '--project', 'p'],
      ['connect', 'notion', '--api-key-stdin'],
      ['data', 'migrate', '--dry-run'],
      ['ingestion', 'status'],
      ['email', 'ping'],
      ['email', 'answer', 'question'],
    ]) {
      const result = await runBinExit(command);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Unknown command:');
    }
  }, 30_000);

  test('every declared public leaf command has non-executing help', async () => {
    for (const command of V0_4_PUBLIC_CLI_COMMANDS) {
      const result = await runBinExit([...command.split(' '), '--help']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(`Usage: olympus ${command}`);
      expect(result.stderr).toBe('');
    }
  }, 30_000);

  test('worker lifecycle refuses command-line secret and managed-path overrides', async () => {
    for (const option of ['--auth-token', '--env-path', '--olympus-bin', '--working-directory']) {
      const result = await runBinExit(['worker', 'install', '--dry-run', option, '/tmp/placeholder']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`Unknown worker install option: ${option}`);
      expect(result.stdout).toBe('');
    }
  }, 30_000);

  test('worker upgrade binds the advertised artifact and uninstall does not advertise a false dry-run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-cli-upgrade-artifact-'));
    const home = join(dir, 'home');
    try {
      mkdirSync(home, { recursive: true });
      const artifact = createCliUpgradeArtifact(dir, '0.4.0');
      const upgraded = await runSourceCli([
        'worker', 'upgrade', '--artifact', artifact.path, '--platform', 'linux', '--home', home, '--dry-run',
      ]);
      expect(JSON.parse(upgraded.stdout)).toMatchObject({
        schema_version: 1,
        action: 'upgrade',
        changed: false,
        upgrade: { artifact_sha256: artifact.sha256, package_version: '0.4.0' },
      });

      const missing = await runSourceCliExit(['worker', 'upgrade', '--platform', 'linux', '--home', home, '--dry-run']);
      expect(missing.code).toBe(1);
      expect(missing.stderr).toContain('requires --artifact <path>');

      const uninstallHelp = await runSourceCli(['worker', 'uninstall', '--help']);
      expect(uninstallHelp.stdout).not.toContain('--dry-run');
      const uninstallDryRun = await runSourceCliExit(['worker', 'uninstall', '--platform', 'linux', '--home', home, '--dry-run']);
      expect(uninstallDryRun.code).toBe(1);
      expect(uninstallDryRun.stderr).toContain('Unknown worker service option: --dry-run');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test('X content recovery CLI stays bounded and inspect-first', () => {
    expect(parseXContentRecoveryArgs([])).toEqual({ execute: false });
    expect(parseXContentRecoveryArgs(['--limit', '9'])).toEqual({
      execute: false,
      limit: 9,
    });
    expect(parseXContentRecoveryArgs(['--execute', '--limit=1'])).toEqual({
      execute: true,
      limit: 1,
    });
    expect(() => parseXContentRecoveryArgs(['--limit', '101']))
      .toThrow('limit must be between 1 and 100');
  });

  test('source delete custody reads the configured credential-handle registry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-cli-custom-handle-registry-'));
    const home = join(dir, 'home');
    const registryPath = join(dir, 'connected-handles.json');
    try {
      mkdirSync(home, { recursive: true });
      writeFileSync(registryPath, JSON.stringify({
        version: 1,
        handles: [{
          handle: 'readwise.personal',
          provider: 'readwise',
          accountRole: 'personal',
          trustDomain: 'internal',
          allowedCapabilities: ['readwise.sync'],
          scopes: ['readwise.export:read', 'readwise.reader:read'],
          tokenSecretRefs: ['store:readwise.personal.token'],
          connectedAt: '2026-08-30T10:00:00.000Z',
        }],
      }));
      const result = await runSourceCli([
        'data',
        'delete',
        '--source',
        'readwise.library',
        '--dry-run',
      ], {
        HOME: home,
        OLYMPUS_CREDENTIAL_HANDLE_REGISTRY_PATH: registryPath,
      });
      expect(JSON.parse(result.stdout)).toMatchObject({
        custody: {
          requirement: 'source_disconnected',
          ready: false,
          observed: 'connected',
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  // A source with no public capability cannot be disconnected, so its delete
  // custody falls through to the worker-inactive requirement — which only the
  // caller can observe. The per-source branch used to omit `workerState`, so
  // the requirement read `unknown` and the delete was refused at every worker
  // state, with remediation guidance the branch could never act on.
  test('per-source delete of a source outside the public capability set observes worker state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-cli-source-delete-worker-custody-'));
    const home = join(dir, 'home');
    const registryPath = join(dir, 'connected-handles.json');
    try {
      const storeDir = join(home, '.local', 'share', 'openclaw', 'olympus');
      const storePath = join(storeDir, 'reflect-notes.sqlite');
      mkdirSync(storeDir, { recursive: true });
      writeFileSync(storePath, 'reflect notes');
      writeFileSync(registryPath, JSON.stringify({ version: 1, handles: [] }));
      // The probe must not depend on the host's service manager (CI runners
      // have no user bus and report `unknown`, which fails custody closed).
      // Shim both managers to the no-unit answer so the observed state is
      // deterministically `missing` on every platform.
      const shimDir = join(dir, 'bin');
      mkdirSync(shimDir, { recursive: true });
      writeFileSync(join(shimDir, 'systemctl'), '#!/bin/sh\necho inactive\nexit 3\n', { mode: 0o755 });
      writeFileSync(join(shimDir, 'launchctl'), '#!/bin/sh\nexit 3\n', { mode: 0o755 });

      const result = await runSourceCliExit([
        'data',
        'delete',
        '--source',
        'reflect.notes',
      ], {
        HOME: home,
        PATH: `${shimDir}:${process.env.PATH ?? ''}`,
        OLYMPUS_CREDENTIAL_HANDLE_REGISTRY_PATH: registryPath,
      });

      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        mode: 'source',
        sourceId: 'reflect.notes',
        custody: { requirement: 'worker_inactive', ready: true, observed: 'missing' },
      });
      expect(existsSync(storePath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test('scheduler unpark parser requires the guarded task identity and reason', () => {
    expect(() => parseSourceSchedulerUnparkArgs([])).toThrow(
      'requires --source, --task, --expected-not-before, and --reason',
    );
    expect(parseSourceSchedulerUnparkArgs([
      '--source', 'gmail.email',
      '--task', 'gmail.email_store_pull',
      '--expected-not-before', '2026-07-30T00:00:00.000Z',
      '--reason', 'incident_probe',
    ])).toEqual({
      source: 'gmail.email',
      task: 'gmail.email_store_pull',
      expectedNotBefore: '2026-07-30T00:00:00.000Z',
      reason: 'incident_probe',
    });
    expect(() => parseSourceSchedulerUnparkArgs([
      '--source', 'gmail.email',
      '--task', 'gmail.email_store_pull',
      '--expected-not-before', '2026-07-30T00:00:00.000Z',
      '--reason', 'incident_probe',
      '--state-db', '/tmp/not-the-scheduler-store.sqlite',
    ])).toThrow('Unknown source scheduler unpark option: --state-db');
    expect(() => parseSourceSchedulerUnparkArgs([
      '--source', 'gmail.email',
      '--task', 'gmail.email_store_pull',
      '--expected-not-before', '2026-07-30T00:00:00.000Z',
      '--reason', 'not safe',
    ])).toThrow('--reason must be a safe categorical token');
  });

  test('queued retarget bare invocation errors because scope is required', () => {
    expect(() => parseQueuedContentRetargetArgs([])).toThrow('requires an explicit --scope');
    expect(parseQueuedContentRetargetArgs([
      '--scope',
      '/1 Projects',
      '--source-kind',
      'local_vlm_pdf',
      '--target-kind',
      'venice_grok45_document',
      '--target-version',
      'grok-4-5',
      '--limit',
      '25',
    ])).toEqual({
      account: 'personal',
      approved_scope_key: 'dropbox.personal:/1 Projects',
      source_extractor_kind: 'local_vlm_pdf',
      target_extractor_kind: 'venice_grok45_document',
      target_extractor_version: 'grok-4-5',
      limit: 25,
      dry_run: true,
    });
  });

  test('terminal requalify parser defaults to dry-run and accepts the bounded admin filters', () => {
    expect(() => parseTerminalContentRequalifyArgs([])).toThrow('requires an explicit --scope');
    expect(parseTerminalContentRequalifyArgs([
      '--scope', '/1 Projects',
      '--source-kind', 'local_ocr_tesseract',
      '--source-version', 'ocr-v1',
      '--statuses', 'failed_terminal,metadata_only',
      '--target-kind', 'local_vlm_pdf',
      '--target-version', '2026-07-16-night-requalify-v1',
      '--limit', '180',
      '--include-superseded',
      '--reason', 'night_champion_vlm_requalify',
    ])).toEqual({
      account: 'personal',
      approved_scope_key: 'dropbox.personal:/1 Projects',
      source_extractor_kind: 'local_ocr_tesseract',
      source_extractor_version: 'ocr-v1',
      source_statuses: ['failed_terminal', 'metadata_only'],
      target_extractor_kind: 'local_vlm_pdf',
      target_extractor_version: '2026-07-16-night-requalify-v1',
      limit: 180,
      include_superseded: true,
      reason: 'night_champion_vlm_requalify',
      dry_run: true,
    });
    expect(() => parseTerminalContentRequalifyArgs([
      '--scope', '/1 Projects',
      '--source-kind', 'local_ocr_tesseract',
      '--statuses', 'failed_terminal,queued',
      '--target-kind', 'local_vlm_pdf',
      '--target-version', 'night-v1',
      '--no-limit',
    ])).toThrow('subset of failed_terminal,metadata_only');
  });

  test('eval shard export parser requires explicit scope, count, and output and defaults dry-run', () => {
    expect(() => parseEvalShardExportArgs([])).toThrow('requires an explicit --scope');
    expect(parseEvalShardExportArgs([
      '--scope', '/1 Projects',
      '--count', '200',
      '--out', '/tmp/vlm-eval',
      '--doc-types', 'pdf,png',
    ])).toEqual({
      account: 'personal',
      approved_scope_key: 'dropbox.personal:/1 Projects',
      count: 200,
      out_dir: '/tmp/vlm-eval',
      doc_types: ['pdf', 'png'],
      dry_run: true,
    });
  });

  test('package bin runs setup and worker dry-run commands from the bundled CLI', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-cli-bin-test-'));
    try {
      const setup = await runBin([
        'setup',
        '--preset',
        'no-sensitive',
        '--yes',
        '--dry-run',
        '--platform',
        'linux',
        '--home',
        dir,
        '--path',
        join(dir, 'sovereignty.json'),
      ]);
      expect(JSON.parse(setup.stdout)).toMatchObject({
        preset: 'no-sensitive',
        sovereignty: { path: join(dir, 'sovereignty.json'), wrote: false },
        worker: {
          install: {
            platform: 'linux',
            wrote_unit: false,
            wrote_env: false,
          },
        },
      });

      const worker = await runBin([
        'worker',
        'install',
        '--dry-run',
        '--platform',
        'linux',
        '--home',
        dir,
      ]);
      expect(JSON.parse(worker.stdout)).toMatchObject({
        schema_version: 1,
        action: 'install',
        platform: 'linux',
        changed: false,
        install: {
          wrote_unit: false,
          wrote_env: false,
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test('worker install generates a token before activating the service', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-cli-worker-install-test-'));
    const binDir = join(dir, 'bin');
    const home = join(dir, 'home');
    const systemctlLog = join(dir, 'systemctl.args');
    try {
      writeFileSync(join(dir, 'placeholder'), '');
      mkdirSync(binDir, { recursive: true });
      mkdirSync(home, { recursive: true });
      writeFileSync(join(binDir, 'systemctl'), [
        '#!/bin/sh',
        `printf "%s\\n" "$*" >> ${JSON.stringify(systemctlLog)}`,
        'case "$*" in',
        `  "--user is-active olympus-worker.service") if [ -f ${JSON.stringify(join(home, '.config', 'systemd', 'user', 'olympus-worker.service'))} ]; then printf "active\\n"; exit 0; else printf "inactive\\n"; exit 3; fi ;;`,
        '  "--user daemon-reload") printf "reloaded\\n" ;;',
        '  "--user enable --now olympus-worker.service") printf "activated\\n" ;;',
        '  *) printf "unexpected systemctl call: %s\\n" "$*" >&2; exit 1 ;;',
        'esac',
        '',
      ].join('\n'));
      chmodSync(join(binDir, 'systemctl'), 0o755);

      const proc = Bun.spawn([
        process.execPath,
        'src/cli.ts',
        'worker',
        'install',
        '--platform',
        'linux',
        '--home',
        home,
      ], {
        cwd: process.cwd(),
        env: { PATH: `${binDir}:${process.env.PATH ?? ''}` },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (code !== 0) throw new Error(stderr || stdout);

      const output = JSON.parse(stdout);
      const env = readFileSync(join(home, '.config', 'olympus', 'worker.env'), 'utf8');
      const token = env.match(/^OLYMPUS_WORKER_AUTH_TOKEN=(.+)$/m)?.[1];

      expect(token).toBeTruthy();
      expect(stdout).not.toContain(token!);
      expect(stderr).not.toContain(token!);
      expect(output).toMatchObject({
        schema_version: 1,
        action: 'install',
        platform: 'linux',
        changed: true,
        install: {
          wrote_unit: true,
          wrote_env: true,
        },
        service_action: {
          command: ['systemctl', '--user', 'enable', '--now', 'olympus-worker.service'],
          stdout: 'reloaded\nactivated\n',
        },
        service: { state: 'active' },
      });
      expect(readFileSync(systemctlLog, 'utf8').trim().split('\n')).toEqual([
        '--user is-active olympus-worker.service',
        '--user daemon-reload',
        '--user enable --now olympus-worker.service',
        '--user is-active olympus-worker.service',
        '--user is-active olympus-worker.service',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test('package bin worker install includes generated-token activation path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-cli-bin-worker-install-test-'));
    const binDir = join(dir, 'bin');
    const home = join(dir, 'home');
    const systemctlLog = join(dir, 'systemctl.args');
    try {
      mkdirSync(binDir, { recursive: true });
      mkdirSync(home, { recursive: true });
      writeFileSync(join(binDir, 'systemctl'), [
        '#!/bin/sh',
        `printf "%s\\n" "$*" >> ${JSON.stringify(systemctlLog)}`,
        'case "$*" in',
        `  "--user is-active olympus-worker.service") if [ -f ${JSON.stringify(join(home, '.config', 'systemd', 'user', 'olympus-worker.service'))} ]; then printf "active\\n"; exit 0; else printf "inactive\\n"; exit 3; fi ;;`,
        '  "--user daemon-reload") printf "reloaded\\n" ;;',
        '  "--user enable --now olympus-worker.service") printf "activated\\n" ;;',
        '  *) printf "unexpected systemctl call: %s\\n" "$*" >&2; exit 1 ;;',
        'esac',
        '',
      ].join('\n'));
      chmodSync(join(binDir, 'systemctl'), 0o755);

      const { stdout, stderr } = await runBin([
        'worker',
        'install',
        '--platform',
        'linux',
        '--home',
        home,
      ], { PATH: `${binDir}:${process.env.PATH ?? ''}` });

      const output = JSON.parse(stdout);
      const env = readFileSync(join(home, '.config', 'olympus', 'worker.env'), 'utf8');
      const token = env.match(/^OLYMPUS_WORKER_AUTH_TOKEN=(.+)$/m)?.[1];

      expect(token).toBeTruthy();
      expect(stdout).not.toContain(token!);
      expect(stderr).not.toContain(token!);
      expect(output.service_action.command).toEqual(['systemctl', '--user', 'enable', '--now', 'olympus-worker.service']);
      expect(output.service_action.stdout).toBe('reloaded\nactivated\n');
      expect(output.service.state).toBe('active');
      expect(readFileSync(systemctlLog, 'utf8').trim().split('\n')).toEqual([
        '--user is-active olympus-worker.service',
        '--user daemon-reload',
        '--user enable --now olympus-worker.service',
        '--user is-active olympus-worker.service',
        '--user is-active olympus-worker.service',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test('worker status includes degraded worker HTTP state and handles offline HTTP gracefully', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-cli-worker-status-test-'));
    const binDir = join(dir, 'bin');
    const home = join(dir, 'home');
    const workerToken = 'worker-status-token';
    const dashboardJsonRequests: string[] = [];
    const server = createServer((request, response) => {
      if (request.url?.endsWith('/dashboard.json')) dashboardJsonRequests.push(request.url);
      if (request.url === '/v1/health') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({
          reachable: true,
          configured: true,
          status: 'degraded',
          degraded_credentials: [{
            display_name: 'Sovereignty embedding profile "gemini-internal"',
            state: 'stopped',
            affected_capabilities: ['embedding'],
          }],
        }));
        return;
      }
      if (request.url === '/v1/source/index/status') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({
          kind: 'source_index_status',
          embedding_lane: { state: 'embedding_lane_disabled', reason: 'embedding_provider_unavailable' },
          degraded_credentials: [{
            display_name: 'Sovereignty embedding profile "gemini-internal"',
            state: 'stopped',
            affected_capabilities: ['embedding'],
          }],
          corpora: [],
        }));
        return;
      }
      // The worker serves the dashboard JSON at its ROOT, beside /dashboard.
      // The old fixture answered /v1/dashboard.json, which is the 404 the real
      // worker returns and the reason worker status reported an unreachable
      // dashboard on every healthy install.
      if (request.url === '/dashboard.json') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({
          kind: 'source_dashboard',
          sources: [
            {
              source_id: 'gmail.email',
              connection: { state: 'awaiting_consent' },
              answer_readiness: { state: 'disconnected' },
              queue_health: { needs_attention: 0 },
            },
            {
              source_id: 'telegram.messages',
              configured: false,
              connection: { state: 'reauth_required' },
              answer_readiness: { state: 'needs_attention' },
              queue_health: { needs_attention: 0 },
            },
            {
              source_id: 'dropbox.files',
              configured: true,
              connection: { state: 'connected' },
              answer_readiness: { state: 'needs_attention' },
              queue_health: { needs_attention: 1 },
              embedding_lane_state: 'embedding_lane_disabled',
            },
            {
              source_id: 'readwise.library',
              configured: false,
              connection: { state: 'not_connected' },
              answer_readiness: { state: 'disconnected' },
              queue_health: { needs_attention: 0 },
            },
          ],
        }));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    let serverOpen = false;
    try {
      mkdirSync(binDir, { recursive: true });
      mkdirSync(home, { recursive: true });
      writeFileSync(join(binDir, 'systemctl'), [
        '#!/bin/sh',
        'case "$*" in',
        '  "--user status olympus-worker.service") printf "active\\n" ;;',
        '  *) printf "unexpected systemctl call: %s\\n" "$*" >&2; exit 1 ;;',
        'esac',
        '',
      ].join('\n'));
      chmodSync(join(binDir, 'systemctl'), 0o755);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      serverOpen = true;
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing test server address');
      const baseUrl = `http://127.0.0.1:${address.port}/v1`;

      const online = await runSourceCli([
        'worker',
        'status',
        '--platform',
        'linux',
        '--home',
        home,
      ], {
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        OLYMPUS_CONFIG: join(dir, 'missing-config.json'),
        OLYMPUS_EMAIL_BASE_URL: baseUrl,
        OLYMPUS_WORKER_AUTH_TOKEN: workerToken,
      });
      const onlineOutput = JSON.parse(online.stdout);
      expect(onlineOutput.worker_http).toMatchObject({
        reachable: true,
        base_url: baseUrl,
        health: {
          status: 'degraded',
          degraded_credentials: [{
            display_name: 'Sovereignty embedding profile "gemini-internal"',
          }],
        },
        source_index_status: {
          embedding_lane: { state: 'embedding_lane_disabled' },
        },
        source_dashboard: { kind: 'source_dashboard' },
      });
      expect(dashboardJsonRequests).toEqual(['/dashboard.json']);
      expect(onlineOutput.recovery).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'oauth_pending', source_id: 'gmail.email', restart_required: false }),
        expect.objectContaining({ kind: 'pairing_pending', source_id: 'telegram.messages', restart_required: false }),
        expect.objectContaining({ kind: 'partial_sync', source_id: 'dropbox.files', restart_required: false }),
        expect.objectContaining({ kind: 'missing_dependency', source_id: 'dropbox.files', restart_required: false }),
      ]));
      // And the unconnected source in the same payload contributes nothing:
      // recovery is a list of work the operator can resume.
      expect(JSON.stringify(onlineOutput.recovery)).not.toContain('readwise.library');

      await new Promise<void>((resolve) => server.close(() => resolve()));
      serverOpen = false;
      const offline = await runSourceCli([
        'worker',
        'status',
        '--platform',
        'linux',
        '--home',
        home,
      ], {
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        OLYMPUS_CONFIG: join(dir, 'missing-config.json'),
        OLYMPUS_EMAIL_BASE_URL: baseUrl,
        OLYMPUS_WORKER_AUTH_TOKEN: workerToken,
      });
      expect(JSON.parse(offline.stdout).worker_http).toMatchObject({
        reachable: false,
        base_url: baseUrl,
      });
    } finally {
      server.closeAllConnections();
      if (serverOpen) await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test('the opened dashboard URL is minted from the token the worker actually accepts', async () => {
    // `olympus dashboard token` deliberately prefers worker.env over a token
    // remembered in ~/.olympus/config.json, because the service loads its
    // environment from that file. `olympus dashboard` derived its dash_ query
    // token config-first, so a stale config token produced a URL the worker
    // refuses while the token command printed the working one.
    const home = mkdtempSync(join(tmpdir(), 'olympus-dashboard-url-precedence-'));
    const binDir = join(home, 'bin');
    const openerLog = join(home, 'opener.url');
    try {
      mkdirSync(binDir, { recursive: true });
      const openerScript = ['#!/bin/sh', `printf "%s\\n" "$1" > ${JSON.stringify(openerLog)}`, ''].join('\n');
      for (const opener of ['open', 'xdg-open']) {
        writeFileSync(join(binDir, opener), openerScript);
        chmodSync(join(binDir, opener), 0o755);
      }
      writeWorkerEnv(home, 'token-the-worker-loaded');
      const configPath = join(home, 'config.json');
      writeFileSync(configPath, JSON.stringify({ worker: { authToken: 'stale-config-token' } }));

      const env = {
        HOME: home,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        OLYMPUS_CONFIG: configPath,
        OLYMPUS_EMAIL_BASE_URL: 'http://127.0.0.1:8010',
      };
      const dashboard = await runSourceCli(['dashboard'], env);
      const printedToken = new URL(JSON.parse(dashboard.stdout).url).searchParams.get('token');
      const workerToken = (await runSourceCli(['dashboard', 'token'], env)).stdout.trim();

      expect(workerToken).toBe('token-the-worker-loaded');
      expect(printedToken).toBe(dashboardQueryTokenFromWorkerAuthToken(workerToken) ?? null);
      expect(printedToken).not.toBe(dashboardQueryTokenFromWorkerAuthToken('stale-config-token') ?? null);
      // The bearer itself is still nowhere in the output or the opened URL.
      expect(dashboard.stdout).not.toContain(workerToken);
      expect(readFileSync(openerLog, 'utf8')).not.toContain(workerToken);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  test('dashboard command does not print or open the worker bearer token', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-cli-dashboard-test-'));
    const binDir = join(dir, 'bin');
    const openerLog = join(dir, 'opener.url');
    const workerToken = 'dashboard-worker-secret';
    try {
      mkdirSync(binDir, { recursive: true });
      const openerScript = [
        '#!/bin/sh',
        `printf "%s\\n" "$1" > ${JSON.stringify(openerLog)}`,
        '',
      ].join('\n');
      writeFileSync(join(binDir, 'open'), openerScript);
      writeFileSync(join(binDir, 'xdg-open'), openerScript);
      chmodSync(join(binDir, 'open'), 0o755);
      chmodSync(join(binDir, 'xdg-open'), 0o755);

      const proc = Bun.spawn([
        process.execPath,
        'src/cli.ts',
        'dashboard',
      ], {
        cwd: process.cwd(),
        env: {
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          OLYMPUS_CONFIG: join(dir, 'missing-config.json'),
          OLYMPUS_EMAIL_BASE_URL: 'http://127.0.0.1:8010',
          OLYMPUS_WORKER_AUTH_TOKEN: workerToken,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (code !== 0) throw new Error(stderr || stdout);

      const output = JSON.parse(stdout);
      const openedUrl = readFileSync(openerLog, 'utf8');

      // The printed URL is the one that works: it carries the derived read-only
      // dash_ view token, which is the only way a browser reaches the HTML.
      expect(output.url).toStartWith('http://127.0.0.1:8010/dashboard?token=dash_');
      expect(output.opened).toBe(true);
      expect(output.hint).toBe(
        'This URL carries the read-only view token, not the worker token;'
        + ' unlocking the controls still needs <rootDir>/bin/olympus dashboard token.',
      );
      expect(output.url).toBe(openedUrl.trim());
      // The shape stays three fields, and the WORKER bearer is still absent:
      // dash_ carries no control authority and is refused by every control route.
      expect(Object.keys(output).sort()).toEqual(['hint', 'opened', 'url']);
      expect(stdout).not.toContain(workerToken);
      expect(stderr).not.toContain(workerToken);
      expect(openedUrl).not.toContain(workerToken);
      expect(openedUrl).toContain('token=dash_');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test('package bin dashboard keeps the worker bearer token out of stdout and opener URL', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-cli-bin-dashboard-test-'));
    const binDir = join(dir, 'bin');
    const openerLog = join(dir, 'opener.url');
    const workerToken = 'dashboard-bin-worker-secret';
    try {
      mkdirSync(binDir, { recursive: true });
      const openerScript = [
        '#!/bin/sh',
        `printf "%s\\n" "$1" > ${JSON.stringify(openerLog)}`,
        '',
      ].join('\n');
      writeFileSync(join(binDir, 'open'), openerScript);
      writeFileSync(join(binDir, 'xdg-open'), openerScript);
      chmodSync(join(binDir, 'open'), 0o755);
      chmodSync(join(binDir, 'xdg-open'), 0o755);

      const { stdout, stderr } = await runBin(['dashboard'], {
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        OLYMPUS_CONFIG: join(dir, 'missing-config.json'),
        OLYMPUS_EMAIL_BASE_URL: 'http://127.0.0.1:8010/v1',
        OLYMPUS_WORKER_AUTH_TOKEN: workerToken,
      });
      const output = JSON.parse(stdout);
      const openedUrl = readFileSync(openerLog, 'utf8');

      expect(output.url).toStartWith('http://127.0.0.1:8010/dashboard?token=dash_');
      expect(output.opened).toBe(true);
      expect(output.hint).toBe(
        'This URL carries the read-only view token, not the worker token;'
        + ' unlocking the controls still needs <rootDir>/bin/olympus dashboard token.',
      );
      expect(output.url).toBe(openedUrl.trim());
      expect(Object.keys(output).sort()).toEqual(['hint', 'opened', 'url']);
      expect(stdout).not.toContain(workerToken);
      expect(stderr).not.toContain(workerToken);
      expect(openedUrl).not.toContain(workerToken);
      expect(openedUrl).toContain('token=dash_');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test('--tools-json uses the shared operation exposure policy', async () => {
    const tools = await runToolsJson({
      email: {
        localPacketsDevEnabled: true,
        indexAdminDevEnabled: true,
        requireLocalActiveModelForPrivateTools: true,
      },
      sourceIndex: {
        answerDevEnabled: true,
      },
    });
    const names = tools.map((tool) => tool.name);

    expect(names).toContain('source_answer');
    expect(names).toContain('source_index_status');
    expect(names).toContain('source_index_search');
    expect(names).not.toContain('xanthos_file_deliver');
    expect(names).not.toContain('castor_workspace');
    expect(names).not.toContain('source_index_sync');
    expect(names).not.toContain('email_search');
    expect(names).not.toContain('email_index_search');
    expect(names).not.toContain('email_index_sync');
    expect(names).not.toContain('email_index_embed');
  }, 30_000);

  test('--tools-json never exposes repository-only file delivery', async () => {
    const tools = await runToolsJson({
      fileDelivery: {
        enabled: true,
        baseUrl: 'http://xanthos-delivery.test/v1',
      },
    });

    expect(tools.map((tool) => tool.name)).not.toContain('xanthos_file_deliver');
  }, 30_000);

  test('--tools-json never exposes repository-only Castor Workspace', async () => {
    const tools = await runToolsJson({
      castorWorkspace: {
        enabled: true,
        baseUrl: 'http://xanthos-workspace.test/v1',
      },
    });

    expect(tools.map((tool) => tool.name)).not.toContain('castor_workspace');
  }, 30_000);

  test('--tools-json never exposes repository-only Domain Expert tools', async () => {
    const tools = await runToolsJson({});

    expect(tools.map((tool) => tool.name)).not.toContain('domain_agent');
    expect(tools.map((tool) => tool.name)).not.toContain('domain_ask');
    expect(tools.map((tool) => tool.name)).not.toContain('domain_doc');

    const enabledTools = await runToolsJson({
      domainExpert: {
        enabled: true,
        liveToolsEnabled: true,
      },
    });
    expect(enabledTools.map((tool) => tool.name)).not.toContain('domain_agent');
    expect(enabledTools.map((tool) => tool.name)).not.toContain('domain_ask');
    expect(enabledTools.map((tool) => tool.name)).not.toContain('domain_doc');
  }, 30_000);

  test('parseArgs accepts explicit false values for boolean flags', () => {
    const domainAgent = operations.find((operation) => operation.name === 'domain_agent')!;

    expect(parseArgs(domainAgent, ['--action', 'bootstrap', '--dry-run=false'])).toEqual({
      action: 'bootstrap',
      dry_run: false,
    });
    expect(parseArgs(domainAgent, ['--action', 'bootstrap', '--dry-run', 'false'])).toEqual({
      action: 'bootstrap',
      dry_run: false,
    });
  });

  test('sovereignty init writes the requested preset file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-cli-sovereignty-test-'));
    const path = join(dir, 'sovereignty.json');
    try {
      const proc = Bun.spawn([
        process.execPath,
        'src/cli.ts',
        'sovereignty',
        'init',
        '--preset',
        'no-sensitive',
        '--path',
        path,
      ], {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? '' },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (code !== 0) throw new Error(stderr || stdout);

      expect(existsSync(path)).toBe(true);
      expect(JSON.parse(stdout)).toMatchObject({ ok: true, preset: 'no-sensitive', schemaVersion: 1 });
      expect(JSON.parse(readFileSync(path, 'utf8')).routes.secure_local.mode).toBe('disabled');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test('connect venice stores pasted keys without echoing secret material', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-cli-connect-venice-test-'));
    const secretPath = join(dir, 'secrets.enc');
    const keyPath = join(dir, 'secrets.key');
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/models') {
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
          data: [{ id: 'e2ee-glm-5-2-p' }],
        }));
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('mock server did not bind');
    const modelsUrl = `http://127.0.0.1:${address.port}/models`;
    try {
      const proc = Bun.spawn([
        process.execPath,
        'src/cli.ts',
        'connect',
        'venice',
        '--api-key-stdin',
        '--secret-store-backend',
        'file',
        '--secret-store-path',
        secretPath,
        '--secret-store-key-path',
        keyPath,
      ], {
        cwd: process.cwd(),
        env: {
          PATH: process.env.PATH ?? '',
          OLYMPUS_CONNECT_VENICE_MODELS_URL: modelsUrl,
        },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      proc.stdin.write('venice-api-key-fixture\n');
      proc.stdin.end();
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (code !== 0) throw new Error(stderr || stdout);

      const output = JSON.parse(stdout);
      expect(output).toMatchObject({
        ok: true,
        source: 'venice',
        handles: [],
        secretRefs: ['store:venice.api_key'],
      });
      expect(`${stdout}\n${stderr}`).not.toContain('venice-api-key-fixture');
      expect(readFileSync(secretPath, 'utf8')).not.toContain('venice-api-key-fixture');
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test('connect telegram records a guided session descriptor without exposing the path in broker output', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-cli-connect-telegram-test-'));
    const registryPath = join(dir, 'handles.json');
    try {
      const proc = Bun.spawn([
        process.execPath,
        'src/cli.ts',
        'connect',
        'telegram',
        '--session-path',
        join(dir, 'telegram.session'),
        '--session-ready',
        '--registry-path',
        registryPath,
        '--secret-store-backend',
        'file',
        '--secret-store-path',
        join(dir, 'secrets.enc'),
        '--secret-store-key-path',
        join(dir, 'secrets.key'),
      ], {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? '' },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (code !== 0) throw new Error(stderr || stdout);

      const output = JSON.parse(stdout);
      expect(output).toMatchObject({
        ok: true,
        source: 'telegram',
        handles: ['telegram.personal'],
        secretRefs: ['store:telegram.personal.session_path'],
      });
      expect(stdout).not.toContain('telegram.session');
      expect(readFileSync(registryPath, 'utf8')).not.toContain('telegram.session');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

async function runToolsJson(config: Record<string, unknown>): Promise<Array<{ name: string }>> {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-cli-test-'));
  const configPath = join(dir, 'config.json');
  try {
    writeFileSync(configPath, JSON.stringify(config));
    const proc = Bun.spawn([process.execPath, 'src/cli.ts', '--tools-json'], {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH ?? '',
        OLYMPUS_CONFIG: configPath,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) {
      throw new Error(`olympus --tools-json failed: ${stderr || stdout}`);
    }
    return JSON.parse(stdout) as Array<{ name: string }>;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function runBin(
  args: string[],
  env: Record<string, string | undefined> = {},
): Promise<{ stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bin/olympus', ...args], {
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? '', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`bin/olympus ${args.join(' ')} failed: ${stderr || stdout}`);
  }
  return { stdout, stderr };
}

async function runBinExit(
  args: string[],
  env: Record<string, string | undefined> = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn(['bin/olympus', ...args], {
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? '', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

async function runSourceCli(
  args: string[],
  env: Record<string, string | undefined> = {},
): Promise<{ stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, 'src/cli.ts', ...args], {
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? '', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`src/cli.ts ${args.join(' ')} failed: ${stderr || stdout}`);
  }
  return { stdout, stderr };
}

async function runSourceCliExit(
  args: string[],
  env: Record<string, string | undefined> = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn([process.execPath, 'src/cli.ts', ...args], {
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? '', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

function createCliUpgradeArtifact(dir: string, version: string): { path: string; sha256: string } {
  const fixture = join(dir, 'artifact-fixture');
  const packageRoot = join(fixture, 'package');
  const path = join(dir, `olympus-${version}.tgz`);
  mkdirSync(join(packageRoot, 'dist'), { recursive: true });
  writeFileSync(join(packageRoot, 'package.json'), `${JSON.stringify({ name: 'olympus', version, type: 'module' })}\n`);
  writeFileSync(join(packageRoot, 'openclaw.plugin.json'), `${JSON.stringify({ id: 'olympus', version })}\n`);
  writeFileSync(join(packageRoot, 'dist', 'cli.js'), `console.log('olympus ${version}');\n`);
  const packed = Bun.spawnSync(['tar', '-czf', path, '-C', fixture, 'package']);
  if (packed.exitCode !== 0) throw new Error(packed.stderr.toString());
  return { path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
}

describe('olympus dashboard token', () => {
  test('prints the worker token alone on stdout, and refuses clearly without one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-dashboard-token-'));
    // HOME is pinned to the temp dir so a real worker.env on the developer's
    // machine can never satisfy the lookup and mask a regression.
    const printed = await runSourceCli(['dashboard', 'token'], {
      HOME: dir,
      OLYMPUS_CONFIG: join(dir, 'missing-config.json'),
      OLYMPUS_WORKER_AUTH_TOKEN: 'worker-token-for-dashboard-unlock',
    });
    expect(printed.stdout).toBe('worker-token-for-dashboard-unlock\n');

    const missing = await runSourceCliExit(['dashboard', 'token'], {
      HOME: dir,
      OLYMPUS_CONFIG: join(dir, 'missing-config.json'),
    });
    expect(missing.code).toBe(1);
    expect(missing.stdout).toBe('');
    expect(missing.stderr).toContain('config_error');
    expect(missing.stderr).toContain('olympus setup');

    // The owner-only worker.env is the file the running worker itself is
    // loaded from, so it answers on its own with no environment variable set.
    const envOnlyHome = mkdtempSync(join(tmpdir(), 'olympus-dashboard-token-envfile-'));
    try {
      writeWorkerEnv(envOnlyHome, 'token-from-worker-env');
      const fromFile = await runSourceCli(['dashboard', 'token'], {
        HOME: envOnlyHome,
        OLYMPUS_CONFIG: join(envOnlyHome, 'missing-config.json'),
      });
      expect(fromFile.stdout).toBe('token-from-worker-env\n');

      // A placeholder is not a token: it must not shadow the real file.
      const placeholder = await runSourceCli(['dashboard', 'token'], {
        HOME: envOnlyHome,
        OLYMPUS_CONFIG: join(envOnlyHome, 'missing-config.json'),
        OLYMPUS_WORKER_AUTH_TOKEN: 'replace-with-generated-token',
      });
      expect(placeholder.stdout).toBe('token-from-worker-env\n');
    } finally {
      rmSync(envOnlyHome, { recursive: true, force: true });
    }

    // Precedence where the two disagree: the worker authenticates from the
    // environment its service loads out of worker.env, so printing the legacy
    // config token would hand the reader a token the worker refuses.
    const conflictHome = mkdtempSync(join(tmpdir(), 'olympus-dashboard-token-conflict-'));
    try {
      writeWorkerEnv(conflictHome, 'B');
      const configPath = join(conflictHome, 'config.json');
      writeFileSync(configPath, JSON.stringify({ worker: { authToken: 'config-token-A' } }));
      const conflict = await runSourceCli(['dashboard', 'token'], {
        HOME: conflictHome,
        OLYMPUS_CONFIG: configPath,
      });
      expect(conflict.stdout).toBe('B\n');
      expect(conflict.stdout).not.toContain('config-token-A');

      // And an explicit environment variable outranks both of them.
      const explicit = await runSourceCli(['dashboard', 'token'], {
        HOME: conflictHome,
        OLYMPUS_CONFIG: configPath,
        OLYMPUS_WORKER_AUTH_TOKEN: 'C',
      });
      expect(explicit.stdout).toBe('C\n');
    } finally {
      rmSync(conflictHome, { recursive: true, force: true });
    }
  }, 30_000);
});

/** The owner-only worker.env the running worker is loaded from: 0600, or ignored. */
function writeWorkerEnv(home: string, token: string): string {
  const path = join(home, '.config', 'olympus', 'worker.env');
  mkdirSync(join(home, '.config', 'olympus'), { recursive: true });
  writeFileSync(path, `OLYMPUS_WORKER_AUTH_TOKEN=${token}\n`);
  chmodSync(path, 0o600);
  return path;
}
