import { telegramPythonExecutable } from './messaging-runtime.ts';
import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { writePrivateFileAtomicSync } from './atomic-file.ts';
import { createDefaultSecretStore, type SecretStore } from './secret-store.ts';
import type { MessagingPairingConnectedResult, MessagingProducerLaunch, MessagingPairingSource } from './messaging-pairing.ts';
import {
  defaultHandleRegistryPath,
  readConnectedHandleRegistry,
  type ConnectedCredentialHandle,
} from '../workers/credential-broker/connected-handles.ts';

export interface MessagingCaptureGrant {
  version: 1;
  source: MessagingPairingSource;
  handle: string;
  sessionPath: string;
  producer: Pick<MessagingProducerLaunch, 'source' | 'env' | 'secretEnvironment'>;
  grantedAt: string;
}

export function defaultMessagingCaptureGrantPath(
  source: MessagingPairingSource,
  registryPath = defaultHandleRegistryPath(),
): string {
  return join(dirname(registryPath), `messaging-capture.${source}.json`);
}

export function saveMessagingCaptureGrant(input: {
  path: string;
  pairing: MessagingPairingConnectedResult;
  now?: Date;
}): MessagingCaptureGrant {
  const handle = input.pairing.handles[0];
  if (!handle) throw new Error('A connected messaging handle is required before capture can be granted.');
  const grant: MessagingCaptureGrant = {
    version: 1,
    source: input.pairing.source as MessagingPairingSource,
    handle,
    sessionPath: input.pairing.sessionPath,
    producer: {
      source: input.pairing.producer.source,
      env: input.pairing.producer.env,
      secretEnvironment: input.pairing.producer.secretEnvironment,
    },
    grantedAt: (input.now ?? new Date()).toISOString(),
  };
  writePrivateFileAtomicSync(input.path, `${JSON.stringify(grant, null, 2)}\n`);
  return grant;
}

export function revokeMessagingCaptureGrant(path: string): void {
  rmSync(path, { force: true });
}

export interface CaptureChild {
  exited: Promise<number>;
  kill(signal?: NodeJS.Signals): void;
}

export type SpawnCapture = (input: {
  executable: string;
  args: readonly string[];
  env: Record<string, string>;
}) => CaptureChild;

export interface MessagingCaptureStatus {
  source?: MessagingPairingSource;
  state: 'running' | 'stopped' | 'blocked';
  reason?: 'grant_missing' | 'grant_invalid' | 'handle_unavailable' | 'session_missing' | 'secret_missing';
}

/** One worker-owned child at a time; callers reconcile on boot and grant/handle changes. */
export class MessagingCaptureSupervisor {
  private child: CaptureChild | undefined;
  private fingerprint: string | undefined;
  private generation = 0;

  constructor(private readonly options: {
    source: MessagingPairingSource;
    registryPath?: string;
    grantPath?: string;
    secretStore?: SecretStore;
    spawn?: SpawnCapture;
    baseEnv?: Record<string, string | undefined>;
    packageRoot?: string;
    pythonExecutable?: string;
    whatsappBridgePath?: string;
    stopTimeoutMs?: number;
  }) {}

  async reconcile(): Promise<MessagingCaptureStatus> {
    const generation = ++this.generation;
    const registryPath = this.options.registryPath ?? defaultHandleRegistryPath();
    const grantPath = this.options.grantPath ?? defaultMessagingCaptureGrantPath(this.options.source, registryPath);
    const grantRead = readGrant(grantPath);
    if (grantRead.kind !== 'valid') {
      await this.stop();
      return { state: grantRead.kind === 'missing' ? 'stopped' : 'blocked', reason: grantRead.kind === 'missing' ? 'grant_missing' : 'grant_invalid' };
    }
    const grant = grantRead.grant;
    if (grant.source !== this.options.source) {
      await this.stop();
      return { state: 'blocked', reason: 'grant_invalid' };
    }
    const handle = readConnectedHandleRegistry(registryPath).handles.find((candidate) => candidate.handle === grant.handle);
    if (!handleAllowsCapture(handle, grant.source)) {
      await this.stop();
      return { source: grant.source, state: 'stopped', reason: 'handle_unavailable' };
    }
    if (!sessionExists(grant)) {
      await this.stop();
      return { source: grant.source, state: 'blocked', reason: 'session_missing' };
    }
    const childEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries({ ...process.env, ...(this.options.baseEnv ?? {}), ...grant.producer.env })) {
      if (value !== undefined) childEnv[key] = value;
    }
    const secrets = this.options.secretStore ?? createDefaultSecretStore();
    for (const mapping of grant.producer.secretEnvironment) {
      const value = await secrets.get(mapping.secretKey);
      if (!value) {
        await this.stop();
        return { source: grant.source, state: 'blocked', reason: 'secret_missing' };
      }
      childEnv[mapping.env] = value;
    }
    if (generation !== this.generation) return { source: grant.source, state: 'stopped', reason: 'grant_missing' };
    const nextFingerprint = JSON.stringify(grant);
    if (this.child && this.fingerprint === nextFingerprint) return { source: grant.source, state: 'running' };
    await this.stop();
    if (generation !== this.generation - 1) return { source: grant.source, state: 'stopped', reason: 'grant_missing' };
    const spawn = this.options.spawn ?? spawnCapture;
    const launch = resolveCurrentLaunch(this.options, grant.source);
    const child = spawn({ executable: launch.executable, args: launch.args, env: childEnv });
    this.child = child;
    this.fingerprint = nextFingerprint;
    void child.exited.then(() => {
      if (this.child === child) {
        this.child = undefined;
        this.fingerprint = undefined;
      }
    }, () => {
      if (this.child === child) {
        this.child = undefined;
        this.fingerprint = undefined;
      }
    });
    return { source: grant.source, state: 'running' };
  }

  async stop(): Promise<void> {
    this.generation += 1;
    const child = this.child;
    if (!child) return;
    child.kill('SIGTERM');
    const timeoutMs = this.options.stopTimeoutMs ?? 5_000;
    if (!await observeChildExit(child, timeoutMs)) {
      child.kill('SIGKILL');
      if (!await observeChildExit(child, timeoutMs)) {
        // Keep `child` and its fingerprint: Unpair must retain custody and may
        // retry stop, but it must not delete a session or key files while the
        // producer can still be running against them.
        throw new Error('Messaging capture did not exit after SIGKILL; session custody is retained.');
      }
    }
    if (this.child === child) {
      this.child = undefined;
      this.fingerprint = undefined;
    }
  }
}

async function observeChildExit(child: CaptureChild, timeoutMs: number): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const observed = await Promise.race([
    child.exited.then(() => true, () => true),
    new Promise<false>((resolve) => { timeout = setTimeout(() => resolve(false), timeoutMs); }),
  ]);
  if (timeout) clearTimeout(timeout);
  return observed;
}

function readGrant(path: string): { kind: 'missing' } | { kind: 'invalid' } | { kind: 'valid'; grant: MessagingCaptureGrant } {
  if (!existsSync(path)) return { kind: 'missing' };
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = fstatSync(descriptor);
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    if (!info.isFile() || (info.mode & 0o022) !== 0 || (currentUid !== undefined && info.uid !== currentUid)) {
      return { kind: 'invalid' };
    }
    const value = JSON.parse(readFileSync(descriptor, 'utf8')) as MessagingCaptureGrant;
    if (value.version !== 1 || !['telegram', 'whatsapp'].includes(value.source) || !value.handle || !value.sessionPath) return { kind: 'invalid' };
    if (!value.producer || value.producer.source !== value.source || !Array.isArray(value.producer.secretEnvironment)) return { kind: 'invalid' };
    return { kind: 'valid', grant: value };
  } catch {
    return { kind: 'invalid' };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function resolveCurrentLaunch(
  options: {
    packageRoot?: string;
    pythonExecutable?: string;
    whatsappBridgePath?: string;
  },
  source: MessagingPairingSource,
): { executable: string; args: string[] } {
  if (source === 'telegram') {
    const executable = telegramPythonExecutable({ ...(options.pythonExecutable ? { pythonExecutable: options.pythonExecutable } : {}) });
    if (!executable) throw new Error('Python 3 is required to start Telegram capture.');
    const packageRoot = options.packageRoot ?? join(import.meta.dir, '..', '..');
    return { executable, args: [join(packageRoot, 'scripts', 'telegram-telethon-reader.py'), '--gateway'] };
  }
  return {
    executable: options.whatsappBridgePath ?? join(homedir(), '.cache', 'olympus', 'bin', 'olympus-whatsapp-bridge'),
    args: ['--capture-approved'],
  };
}

function handleAllowsCapture(handle: ConnectedCredentialHandle | undefined, source: MessagingPairingSource): boolean {
  if (!handle || handle.backendState?.status === 'reauth_required') return false;
  return source === 'telegram'
    ? handle.provider === 'telegram' && handle.allowedCapabilities.includes('telegram.messages.sync')
    : handle.provider === 'whatsapp_personal' && handle.allowedCapabilities.includes('whatsapp.personal.messages.sync');
}

function sessionExists(grant: MessagingCaptureGrant): boolean {
  return grant.source === 'telegram'
    ? existsSync(`${grant.sessionPath.replace(/\.session$/, '')}.session`)
    : existsSync(join(grant.sessionPath, 'session.db'));
}

function spawnCapture(input: { executable: string; args: readonly string[]; env: Record<string, string> }): CaptureChild {
  const child = Bun.spawn([input.executable, ...input.args], {
    env: input.env,
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  });
  return { exited: child.exited, kill: (signal) => child.kill(signal) };
}
