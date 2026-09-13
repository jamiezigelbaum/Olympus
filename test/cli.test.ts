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
import { describe, expect, spyOn, test } from 'bun:test';
import {
  formatCliFatalError,
  isV04PublicCliInvocation,
  lifecycleRecoverySignalsFromWorkerHttpState,
  parseArgs,
  runDashboardCommand,
  type DashboardCommandDependencies,
} from '../src/cli.ts';
import { dashboardQueryTokenFromWorkerAuthToken } from '../src/core/worker-auth.ts';
import {
  DASHBOARD_LAUNCH_REDEEM_PATH,
  DASHBOARD_LAUNCH_TICKET_FRAGMENT_KEY,
  DashboardLaunchTickets,
} from '../src/core/dashboard-launch.ts';
import { OperationError } from '../src/core/operation-error.ts';
import { withWorkerBearerAuth } from '../src/workers/http.ts';
import { CredentialBrokerError } from '../src/workers/credential-broker/index.ts';
import { operations } from '../src/core/operations.ts';
import { V0_4_PUBLIC_CLI_COMMANDS } from '../src/core/public-surface.ts';

type DashboardFetch = NonNullable<DashboardCommandDependencies['fetchImpl']>;

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

  test('the opening link is minted from the token the worker actually accepts', async () => {
    // `olympus dashboard token` deliberately prefers worker.env over a token
    // remembered in ~/.olympus/config.json, because the service loads its
    // environment from that file. The opening link mints with that same
    // resolution, so a stale config token can never produce a refused request.
    const home = mkdtempSync(join(tmpdir(), 'olympus-dashboard-url-precedence-'));
    const sent: Array<{ url: string; init: RequestInit }> = [];
    try {
      writeWorkerEnv(home, 'token-the-worker-loaded');
      const configPath = join(home, 'config.json');
      writeFileSync(configPath, JSON.stringify({ worker: { authToken: 'stale-config-token' } }));
      const env = withTemporaryEnv({
        HOME: home,
        OLYMPUS_CONFIG: configPath,
        OLYMPUS_EMAIL_BASE_URL: 'http://127.0.0.1:8010/v1',
      });
      try {
        const result = await runDashboardCommand({
          fetchImpl: recordingFetch(sent, () => workerTicketResponse('QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE')),
          openImpl: () => true,
        });

        expect(sent).toHaveLength(1);
        expect(sent[0]?.url).toBe('http://127.0.0.1:8010/dashboard/control/launch');
        expect(sent[0]?.init.method).toBe('POST');
        expect(sent[0]?.init.redirect).toBe('error');
        // The request is authenticated by the token the WORKER accepts, not by
        // the stale one a legacy config remembers, and it names the origin the
        // browser will open so the ticket is redeemable exactly there.
        const headers = new Headers(sent[0]?.init.headers);
        expect(headers.get('Authorization')).toBe('Bearer token-the-worker-loaded');
        expect(headers.get('Origin')).toBe('http://127.0.0.1:8010');

        const opened = new URL(result.url);
        expect(opened.pathname).toBe('/dashboard/launch');
        expect(opened.search).toBe('');
        expect(opened.hash).toBe(
          `#${DASHBOARD_LAUNCH_TICKET_FRAGMENT_KEY}=QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE`,
        );
        expect(result.opened).toBe(true);
        expect(result.url).not.toContain('token-the-worker-loaded');
        expect(result.url).not.toContain('dash_');
      } finally {
        env.restore();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  test('dashboard rejects missing credentials and unsafe worker URLs before sending a bearer', async () => {
    const home = mkdtempSync(join(tmpdir(), 'olympus-dashboard-input-boundaries-'));
    const configPath = join(home, 'missing-config.json');
    const fetcher: DashboardFetch = async () => {
      throw new Error('fetcher must not run for rejected input');
    };
    try {
      for (const input of [
        {
          baseUrl: 'http://127.0.0.1:8010/v1',
          token: undefined,
          message: 'No worker auth token is configured',
        },
        {
          baseUrl: 'file:///tmp/olympus-worker/v1',
          token: 'protocol-test-token',
          message: 'email.baseUrl must be an HTTP(S) URL',
        },
        {
          baseUrl: 'http://reader:secret@127.0.0.1:8010/v1',
          token: 'userinfo-test-token',
          message: 'must not carry embedded credentials',
        },
        {
          baseUrl: 'http://127.0.0.1:8010/another-service/v1',
          token: 'path-test-token',
          message: 'path must be /v1 or the origin root',
        },
      ]) {
        const env = withTemporaryEnv({
          HOME: home,
          OLYMPUS_CONFIG: configPath,
          OLYMPUS_EMAIL_BASE_URL: input.baseUrl,
          OLYMPUS_WORKER_AUTH_TOKEN: input.token,
        });
        try {
          const error = await runDashboardCommand({
            fetchImpl: fetcher,
            openImpl: () => true,
          }).catch((failure: unknown) => failure);
          expect(error).toBeInstanceOf(OperationError);
          expect((error as OperationError).code).toBe('config_error');
          expect((error as Error).message).toContain(input.message);
          expect((error as Error).message).not.toContain(input.token ?? 'missing-token-marker');
        } finally {
          env.restore();
        }
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('dashboard bounds the mint request to ten seconds and suppresses the raw fetch error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-dashboard-fetch-timeout-'));
    const timeoutSpy = spyOn(AbortSignal, 'timeout');
    const rawError = 'transport-secret-that-must-not-surface';
    const token = 'timeout-worker-token';
    const env = withTemporaryEnv({
      HOME: dir,
      OLYMPUS_CONFIG: join(dir, 'missing-config.json'),
      OLYMPUS_EMAIL_BASE_URL: 'http://127.0.0.1:8010/v1',
      OLYMPUS_WORKER_AUTH_TOKEN: token,
    });
    try {
      let requestSignal: AbortSignal | null | undefined;
      const error = await runDashboardCommand({
        fetchImpl: (async (_input, init) => {
          requestSignal = init?.signal;
          throw new Error(rawError);
        }),
        openImpl: () => true,
      }).catch((failure: unknown) => failure);

      expect(timeoutSpy).toHaveBeenCalledWith(10_000);
      expect(requestSignal).toBeInstanceOf(AbortSignal);
      expect(error).toBeInstanceOf(OperationError);
      expect((error as OperationError).code).toBe('email_unreachable');
      expect((error as Error).message).not.toContain(rawError);
      expect((error as Error).message).not.toContain(token);
    } finally {
      timeoutSpy.mockRestore();
      env.restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('dashboard no-open leaves the auth-wrapper ticket fresh and redeemable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-dashboard-no-open-redeemable-'));
    const origin = 'http://127.0.0.1:18010';
    const workerToken = 'no-open-worker-token';
    const tickets = new DashboardLaunchTickets();
    const guardedFetch = withWorkerBearerAuth(
      async () => new Response('unexpected route', { status: 404 }),
      { authToken: workerToken, launchTickets: tickets },
    );
    const fetchImpl: DashboardFetch = async (input, init) => guardedFetch(new Request(input, init));
    const env = withTemporaryEnv({
      HOME: dir,
      OLYMPUS_CONFIG: join(dir, 'missing-config.json'),
      OLYMPUS_EMAIL_BASE_URL: `${origin}/v1`,
      OLYMPUS_WORKER_AUTH_TOKEN: workerToken,
    });
    let openerCalls = 0;
    try {
      const result = await runDashboardCommand({
        fetchImpl,
        noOpen: true,
        openImpl: () => { openerCalls += 1; return true; },
      });
      expect(result.opened).toBe(false);
      expect(openerCalls).toBe(0);
      expect(result.hint).toContain('not opened locally');
      expect(tickets.size).toBe(1);

      const launchUrl = new URL(result.url);
      const ticket = new URLSearchParams(launchUrl.hash.slice(1)).get(DASHBOARD_LAUNCH_TICKET_FRAGMENT_KEY);
      expect(ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const redeem = await guardedFetch(new Request(`${origin}${DASHBOARD_LAUNCH_REDEEM_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: origin },
        body: JSON.stringify({ ticket }),
      }));
      expect(redeem.status).toBe(200);
      expect(tickets.size).toBe(0);
    } finally {
      env.restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('dashboard CLI mints, prints, and opens a bounded launch link without surfacing the bearer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-cli-dashboard-test-'));
    const binDir = join(dir, 'bin');
    const openerLog = join(dir, 'opener.url');
    const workerToken = 'dashboard-worker-secret';
    const ticket = 'QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI';
    const requests: Array<{ method: string | undefined; url: string | undefined; authorization: string | undefined; origin: string | undefined }> = [];
    const server = createServer((request, response) => {
      requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        origin: request.headers.origin,
      });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: true, ticket, expires_in_seconds: 120 }));
    });
    let serverOpen = false;
    try {
      mkdirSync(binDir, { recursive: true });
      const openerScript = ['#!/bin/sh', `printf '%s\\n' "$1" > ${JSON.stringify(openerLog)}`, ''].join('\n');
      for (const opener of ['open', 'xdg-open']) {
        writeFileSync(join(binDir, opener), openerScript);
        chmodSync(join(binDir, opener), 0o755);
      }
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      serverOpen = true;
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing test server address');
      const workerOrigin = `http://127.0.0.1:${address.port}`;
      const cliEnv = {
        HOME: dir,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        OLYMPUS_CONFIG: join(dir, 'missing-config.json'),
        OLYMPUS_EMAIL_BASE_URL: `${workerOrigin}/v1`,
        OLYMPUS_WORKER_AUTH_TOKEN: workerToken,
      };
      const { stdout, stderr } = await runSourceCli(['dashboard'], cliEnv);

      const output = JSON.parse(stdout) as { url: string; opened: boolean; hint: string };
      const expectedUrl = `${workerOrigin}/dashboard/launch#olympus_launch_ticket=${ticket}`;
      expect(requests).toEqual([{
        method: 'POST',
        url: '/dashboard/control/launch',
        authorization: `Bearer ${workerToken}`,
        origin: workerOrigin,
      }]);
      expect(output).toMatchObject({ url: expectedUrl, opened: true });
      expect(output.hint).toContain('single-use 120-second ticket');
      expect(output.hint).toContain('dashboard --read-only');
      expect(readFileSync(openerLog, 'utf8').trim()).toBe(expectedUrl);
      expect(new URL(output.url).search).toBe('');
      expect(output.url).not.toContain('dash_');
      for (const surfaced of [stdout, stderr, readFileSync(openerLog, 'utf8')]) {
        expect(surfaced).not.toContain(workerToken);
      }

      const handoff = await runSourceCli(['dashboard', '--no-open'], cliEnv);
      const handoffOutput = JSON.parse(handoff.stdout) as { url: string; opened: boolean; hint: string };
      expect(handoffOutput).toMatchObject({ url: expectedUrl, opened: false });
      expect(handoffOutput.hint).toContain('not opened locally');
      expect(readFileSync(openerLog, 'utf8').trim()).toBe(expectedUrl);
      expect(requests).toHaveLength(2);

      const help = await runSourceCli(['dashboard', '--help']);
      expect(help.stdout).toContain('Usage: olympus dashboard [--read-only] [--no-open]');
    } finally {
      server.closeAllConnections();
      if (serverOpen) await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test('dashboard refuses on a failed mint instead of silently falling back to the old link', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-cli-bin-dashboard-test-'));
    const workerToken = 'dashboard-bin-worker-secret';
    const openedUrls: string[] = [];
    const targetRequests: string[] = [];
    let responseMode: 'failed' | 'redirect' = 'failed';
    const server = createServer((request, response) => {
      if (request.url === '/redirect-target') targetRequests.push(request.url);
      if (request.url !== '/dashboard/control/launch') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ ok: true, ticket: 'x'.repeat(43) }));
        return;
      }
      if (responseMode === 'redirect') {
        response.writeHead(302, { Location: '/redirect-target' });
        response.end('raw-redirect-body-marker');
        return;
      }
      response.writeHead(503, { 'Content-Type': 'text/plain' });
      response.end(`raw-failure-body-marker:${workerToken}`);
    });
    let serverOpen = false;
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      serverOpen = true;
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing test server address');
      const env = withTemporaryEnv({
        HOME: dir,
        OLYMPUS_CONFIG: join(dir, 'missing-config.json'),
        OLYMPUS_EMAIL_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
        OLYMPUS_WORKER_AUTH_TOKEN: workerToken,
      });
      try {
        // The mint request was never answered at all.
        const unreachable = await runDashboardCommand({
          fetchImpl: async () => { throw new TypeError('fetch failed'); },
          openImpl: (url) => { openedUrls.push(url); return true; },
        }).catch((error: unknown) => error);
        expect(unreachable).toBeInstanceOf(OperationError);
        expect((unreachable as OperationError).code).toBe('email_unreachable');
        expect((unreachable as Error).message).not.toContain(workerToken);

        // A real worker endpoint that refuses the bearer. The body can carry
        // arbitrary server prose, so only the status is safe to surface.
        const refused = await runDashboardCommand({
          openImpl: (url) => { openedUrls.push(url); return true; },
        }).catch((error: unknown) => error);
        expect(refused).toBeInstanceOf(OperationError);
        expect((refused as OperationError).code).toBe('email_unreachable');
        expect((refused as Error).message).toContain('HTTP 503');
        expect((refused as Error).message).not.toContain('raw-failure-body-marker');
        expect((refused as Error).message).not.toContain(workerToken);

        // A real redirect response is rejected by fetch itself. The target is
        // never contacted and the browser is never opened.
        responseMode = 'redirect';
        const redirected = await runDashboardCommand({
          openImpl: (url) => { openedUrls.push(url); return true; },
        }).catch((error: unknown) => error);
        expect(redirected).toBeInstanceOf(OperationError);
        expect((redirected as OperationError).code).toBe('email_unreachable');
        expect((redirected as Error).message).not.toContain('raw-redirect-body-marker');
        expect(targetRequests).toEqual([]);

        // A worker that predates the handoff answers 200 with no ticket; that is
        // a refusal with its own remedy, not a URL to open.
        const legacyWorker = await runDashboardCommand({
          fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
          openImpl: (url) => { openedUrls.push(url); return true; },
        }).catch((error: unknown) => error);
        expect(legacyWorker).toBeInstanceOf(OperationError);
        expect((legacyWorker as OperationError).code).toBe('email_unreachable');
        expect((legacyWorker as Error).message).toContain('without a ticket');

        // Not one of the four failures opened a browser.
        expect(openedUrls).toEqual([]);
      } finally {
        env.restore();
      }
    } finally {
      server.closeAllConnections();
      if (serverOpen) await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test('dashboard --read-only keeps minting the derived view link, named as legacy', async () => {
    // The read-only view link is not deleted, only demoted: it needs no round
    // trip, so an install whose worker is older than the opening handoff can
    // still be viewed, and the reader is told which link they got.
    const dir = mkdtempSync(join(tmpdir(), 'olympus-cli-dashboard-readonly-test-'));
    const binDir = join(dir, 'bin');
    const openerLog = join(dir, 'opener.url');
    try {
      mkdirSync(binDir, { recursive: true });
      const openerScript = ['#!/bin/sh', `printf '%s\\n' "$1" > ${JSON.stringify(openerLog)}`, ''].join('\n');
      for (const opener of ['open', 'xdg-open']) {
        writeFileSync(join(binDir, opener), openerScript);
        chmodSync(join(binDir, opener), 0o755);
      }
      const env = withTemporaryEnv({
        OLYMPUS_CONFIG: join(dir, 'missing-config.json'),
        OLYMPUS_EMAIL_BASE_URL: 'http://127.0.0.1:8010/v1',
        OLYMPUS_WORKER_AUTH_TOKEN: 'read-only-view-worker-token',
      });
      try {
        const { stdout } = await runSourceCli(['dashboard', '--read-only', '--no-open'], {
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          OLYMPUS_CONFIG: join(dir, 'missing-config.json'),
          OLYMPUS_EMAIL_BASE_URL: 'http://127.0.0.1:8010/v1',
          OLYMPUS_WORKER_AUTH_TOKEN: 'read-only-view-worker-token',
        });
        const output = JSON.parse(stdout) as { url: string; opened: boolean; hint: string };
        const expectedToken = dashboardQueryTokenFromWorkerAuthToken('read-only-view-worker-token');
        expect(output.url).toBe(`http://127.0.0.1:8010/dashboard?token=${encodeURIComponent(expectedToken!)}`);
        expect(output.opened).toBe(false);
        expect(output.hint).toContain('read-only view link');
        expect(output.hint).toContain('not opened locally');
        expect(existsSync(openerLog)).toBe(false);
        expect(output.url).not.toContain('read-only-view-worker-token');
      } finally {
        env.restore();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test('--tools-json uses the shared operation exposure policy', async () => {
    const tools = await runToolsJson({});
    const names = tools.map((tool) => tool.name);

    expect(names).toEqual([
      'argus_ping',
      'argus_list_models',
      'argus_complete',
      'source_answer',
      'source_index_status',
      'source_index_search',
      'olympus_doctor',
    ]);
  }, 30_000);

  test('parseArgs accepts explicit false values for boolean flags', () => {
    const sourceSearch = operations.find((operation) => operation.name === 'source_index_search')!;

    expect(parseArgs(sourceSearch, ['fixture', '--corpus-id', 'internal.email', '--include-locators=false']))
      .toEqual({
        query: 'fixture',
        corpus_id: 'internal.email',
        include_locators: false,
      });
    expect(parseArgs(sourceSearch, [
      'fixture',
      '--corpus-id',
      'internal.email',
      '--include-locators',
      'false',
    ])).toEqual({
      query: 'fixture',
      corpus_id: 'internal.email',
      include_locators: false,
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

/**
 * A worker that answers exactly one thing: `POST /dashboard/control/launch`.
 *
 * The round trip is injected rather than served from a listener so the test can
 * observe the method, the path, and the bearer the CLI actually sent — that is
 * the whole point of resolving the token before printing a URL.
 */
function workerTicketResponse(ticket: string): Response {
  return new Response(JSON.stringify({ ok: true, ticket, expires_in_seconds: 120 }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function recordingFetch(
  sent: Array<{ url: string; init: RequestInit }>,
  respond: () => Response,
): DashboardFetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(input), init: init ?? {} });
    return respond();
  };
}

/** Set process.env entries and hand back the exact restore for a `finally`. */
function withTemporaryEnv(values: Record<string, string | undefined>): { restore: () => void } {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return {
    restore: () => {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}
