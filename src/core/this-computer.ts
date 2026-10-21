import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { writePrivateFileAtomicSync } from './atomic-file.ts';
import { withFileLeaseSync } from './file-lease.ts';
import { fileScopeSourceCapability, getFileScopeSource } from './file-scope-sources.ts';
import type { SourceScopeConnectedHandle } from './source-scope-approval.ts';

/**
 * Sources without an account ("this computer").
 *
 * Such a source has no credential, so nothing in the credential broker or the
 * handle registry knows it. Its connection is a record here, next to the
 * handle registry: the source ids connected on this computer and a random
 * per-install machine id. Scope approval sees each connected source as a
 * synthetic handle whose provider account id is that machine id, so the
 * existing account-generation logic applies unchanged: a reinstall (new machine
 * id), a copy of the data to another computer (different machine id on the
 * next install), a disconnect or a reconnect all produce a different
 * generation, and every saved selection resets fail-closed.
 *
 * The machine id is random, generated once, and never derived from hardware
 * serials, the user name or any other machine property.
 *
 * The state directory can be copied or restored onto another computer, taking
 * this record with it. So the record also keeps a host binding: a digest of the
 * operating system's own install identity (macOS IOPlatformUUID, Linux
 * /etc/machine-id) salted with the machine id. The identity itself is never
 * stored. On a host whose identity does not match, the record counts as absent:
 * nothing is connected, and the next connect starts a new machine id.
 */

interface PersistedThisComputerState {
  version: 1;
  machine_id: string;
  /** sha256(machine_id + ':' + host identity); absent where the host has none. */
  host_binding?: string;
  sources: Array<{ source_id: string; connected_at: string }>;
}

const MACHINE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The operating system's install identity, or undefined where there is none. */
export type HostIdentity = () => string | undefined;

let cachedSystemHostIdentity: { value: string | undefined } | undefined;

export const systemHostIdentity: HostIdentity = () => {
  if (cachedSystemHostIdentity) return cachedSystemHostIdentity.value;
  let value: string | undefined;
  try {
    if (process.platform === 'darwin') {
      const result = spawnSync('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8', timeout: 5_000 });
      value = /"IOPlatformUUID" = "([0-9A-Fa-f-]{36})"/.exec(result.stdout ?? '')?.[1];
    } else if (process.platform === 'linux') {
      for (const path of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
        const id = existsSync(path) ? readFileSync(path, 'utf8').trim() : '';
        if (/^[0-9a-f]{32}$/.test(id)) {
          value = id;
          break;
        }
      }
    }
  } catch {
    value = undefined;
  }
  cachedSystemHostIdentity = { value };
  return value;
};

function hostBinding(machineId: string, hostIdentity: HostIdentity): string | undefined {
  const identity = hostIdentity();
  return identity ? createHash('sha256').update(`${machineId}:${identity}`).digest('hex') : undefined;
}

/** The record as it applies on this host: undefined when it belongs to another. */
function readStateForHost(path: string, hostIdentity: HostIdentity): PersistedThisComputerState | undefined {
  const state = readState(path);
  if (!state) return undefined;
  const expected = hostBinding(state.machine_id, hostIdentity);
  // A record bound to a host must match this one; an unbound record (made
  // where the host had no identity) is accepted only where there still is none.
  if (state.host_binding !== expected) return undefined;
  return state;
}

export function defaultThisComputerStatePath(handleRegistryPath: string): string {
  return join(dirname(handleRegistryPath), 'this-computer.json');
}

function readState(path: string): PersistedThisComputerState | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    if (
      record.version !== 1
      || typeof record.machine_id !== 'string' || !MACHINE_ID_PATTERN.test(record.machine_id)
      || !Array.isArray(record.sources)
      || (record.host_binding !== undefined
        && (typeof record.host_binding !== 'string' || !/^[a-f0-9]{64}$/.test(record.host_binding)))
    ) return undefined;
    const sources: PersistedThisComputerState['sources'] = [];
    for (const entry of record.sources) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
      const source = entry as Record<string, unknown>;
      if (
        typeof source.source_id !== 'string'
        || typeof source.connected_at !== 'string' || !Number.isFinite(Date.parse(source.connected_at))
      ) return undefined;
      sources.push({ source_id: source.source_id, connected_at: source.connected_at });
    }
    return {
      version: 1,
      machine_id: record.machine_id,
      ...(typeof record.host_binding === 'string' ? { host_binding: record.host_binding } : {}),
      sources,
    };
  } catch {
    return undefined;
  }
}

function writeState(path: string, state: PersistedThisComputerState): void {
  writePrivateFileAtomicSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * The synthetic handles for every connected `this_computer` source. A missing,
 * unreadable or malformed record yields none: nothing is connected, so every
 * dependent approval reads as not connected.
 */
export function readThisComputerHandles(
  handleRegistryPath: string,
  hostIdentity: HostIdentity = systemHostIdentity,
): SourceScopeConnectedHandle[] {
  const state = readStateForHost(defaultThisComputerStatePath(handleRegistryPath), hostIdentity);
  if (!state) return [];
  const handles: SourceScopeConnectedHandle[] = [];
  for (const entry of state.sources) {
    const definition = getFileScopeSource(entry.source_id);
    if (!definition || definition.account !== 'this_computer') continue;
    handles.push({
      handle: `${definition.sourceId}.this_computer`,
      provider: definition.provider,
      allowedCapabilities: [fileScopeSourceCapability(definition)],
      connectedAt: entry.connected_at,
      accountRole: 'this_computer',
      providerAccountId: state.machine_id,
      thisComputer: true,
    });
  }
  return handles;
}

/**
 * Connects a `this_computer` source. Idempotent: connecting an already
 * connected source keeps its connection time, so its approval survives. The
 * machine id is created on the first connect and then kept.
 */
export function connectThisComputerSource(
  handleRegistryPath: string,
  sourceId: string,
  now: Date = new Date(),
  hostIdentity: HostIdentity = systemHostIdentity,
): void {
  const definition = getFileScopeSource(sourceId);
  if (!definition || definition.account !== 'this_computer') {
    throw new Error(`${sourceId} is not a source that binds to this computer.`);
  }
  const path = defaultThisComputerStatePath(handleRegistryPath);
  withFileLeaseSync(path, (lease) => {
    // A record that cannot be read, or that belongs to another host, is
    // replaced with a new machine id: every generation changes, which only
    // ever resets selections.
    const current = readStateForHost(path, hostIdentity) ?? (() => {
      const machineId = randomUUID();
      const binding = hostBinding(machineId, hostIdentity);
      return {
        version: 1 as const,
        machine_id: machineId,
        ...(binding ? { host_binding: binding } : {}),
        sources: [],
      };
    })();
    if (current.sources.some((entry) => entry.source_id === sourceId)) return;
    const next: PersistedThisComputerState = {
      ...current,
      sources: [...current.sources, { source_id: sourceId, connected_at: now.toISOString() }],
    };
    lease.commit(() => writeState(path, next));
  });
}

/** Disconnects a `this_computer` source. The machine id is kept. Returns whether it was connected. */
export function disconnectThisComputerSource(
  handleRegistryPath: string,
  sourceId: string,
  hostIdentity: HostIdentity = systemHostIdentity,
): boolean {
  const path = defaultThisComputerStatePath(handleRegistryPath);
  if (!existsSync(path)) return false;
  return withFileLeaseSync(path, (lease) => {
    const current = readStateForHost(path, hostIdentity);
    if (!current || !current.sources.some((entry) => entry.source_id === sourceId)) return false;
    lease.commit(() => writeState(path, {
      ...current,
      sources: current.sources.filter((entry) => entry.source_id !== sourceId),
    }));
    return true;
  });
}
