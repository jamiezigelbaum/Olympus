// The record of the process groups a supervised child starts outside its own
// (descendant-groups.ts): identity is the leader's pid and its /proc start
// time, checked again right before every signal, never a command line.
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { descendantGroupsRecorder, procIdentity, stopRecordedDescendantGroups } from '../src/core/descendant-groups.ts';

/** A /proc/<pid>/stat line: pid (comm) state ppid pgrp ... field 22 = starttime. */
function stat(pid: number, pgrp: number, starttime: number, comm = 'python3') {
  const fields = ['S', '1', String(pgrp), String(pgrp), '0', '-1', '4194560', ...Array.from({ length: 12 }, () => '0'), String(starttime), '0', '0'];
  return `${pid} (${comm}) ${fields.join(' ')}\n`;
}

function host(initial: Record<number, string>) {
  const table = new Map(Object.entries(initial).map(([pid, line]) => [Number(pid), line]));
  const signals: Array<[number, string]> = [];
  return {
    table,
    signals,
    read: (pid: number) => table.get(pid),
    kill: (pid: number, signal: NodeJS.Signals) => { signals.push([pid, signal]); },
  };
}

function recordFile() {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-descendants-'));
  return { path: join(dir, 'descendants.json'), done: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('the identity of a recorded group', () => {
  test('is its process group and start time, whatever the command name holds', () => {
    expect(procIdentity(42, () => stat(42, 42, 987654, 'odd ) name (x'))).toEqual({ pgid: 42, starttime: '987654' });
    expect(procIdentity(42, () => undefined)).toBeUndefined();
  });
});

describe('stopping what a dead child left running', () => {
  test('an interpreter-launched command is stopped: its command line is never compared', async () => {
    const file = recordFile();
    try {
      const fake = host({ 300: stat(300, 300, 5000, 'python3'), 999: stat(999, 999, 1, 'bun') });
      descendantGroupsRecorder(file.path, fake.read, 999).spawned(300);
      fake.table.delete(999); // The child that recorded it died.
      // Still running after its parent died: SIGTERM, then (still there) SIGKILL.
      const stopped = await stopRecordedDescendantGroups(file.path, { read: fake.read, kill: fake.kill, delay: async () => {}, graceMs: 100 });
      expect(stopped).toBe(1);
      expect(fake.signals).toEqual([[-300, 'SIGTERM'], [-300, 'SIGKILL']]);
      expect(existsSync(file.path)).toBe(false);
    } finally { file.done(); }
  });

  test('a group that ends on SIGTERM gets no SIGKILL', async () => {
    const file = recordFile();
    try {
      const fake = host({ 300: stat(300, 300, 5000), 999: stat(999, 999, 1, 'bun') });
      descendantGroupsRecorder(file.path, fake.read, 999).spawned(300);
      fake.table.delete(999);
      const kill = (pid: number, signal: NodeJS.Signals) => { fake.kill(pid, signal); fake.table.delete(300); };
      await stopRecordedDescendantGroups(file.path, { read: fake.read, kill, delay: async () => {}, graceMs: 100 });
      expect(fake.signals).toEqual([[-300, 'SIGTERM']]);
    } finally { file.done(); }
  });

  test('a recycled pid (another start time), a process no longer leading its group, or one gone is never signalled', async () => {
    const file = recordFile();
    try {
      const recorded = host({ 300: stat(300, 300, 5000), 301: stat(301, 301, 6000), 302: stat(302, 302, 7000) });
      const recorder = descendantGroupsRecorder(file.path, { ...recorded, read: (pid: number) => pid === 999 ? stat(999, 999, 1) : recorded.read(pid) }.read, 999);
      recorder.spawned(300);
      recorder.spawned(301);
      recorder.spawned(302);
      const now = host({ 300: stat(300, 300, 9999), 301: stat(301, 77, 6000) });
      expect(await stopRecordedDescendantGroups(file.path, { read: now.read, kill: now.kill, delay: async () => {}, graceMs: 100 })).toBe(0);
      expect(now.signals).toEqual([]);
    } finally { file.done(); }
  });

  test('a command that finished is no longer recorded', async () => {
    const file = recordFile();
    try {
      const fake = host({ 300: stat(300, 300, 5000), 999: stat(999, 999, 1, 'bun') });
      const recorder = descendantGroupsRecorder(file.path, fake.read, 999);
      recorder.spawned(300);
      expect(existsSync(file.path)).toBe(true);
      recorder.stopped(300);
      expect(existsSync(file.path)).toBe(false);
      expect(await stopRecordedDescendantGroups(file.path, { read: fake.read, kill: fake.kill })).toBe(0);
      expect(fake.signals).toEqual([]);
    } finally { file.done(); }
  });
});

describe('a record whose owner is still running', () => {
  // Another supervisor starting (olympus worker run beside the running
  // service) must not take a live worker's commands for leftovers.
  test('is left alone: nothing is signalled and the record stays', async () => {
    const file = recordFile();
    try {
      const fake = host({ 300: stat(300, 300, 5000), 999: stat(999, 999, 1234, 'bun') });
      descendantGroupsRecorder(file.path, fake.read, 999).spawned(300);
      expect(await stopRecordedDescendantGroups(file.path, { read: fake.read, kill: fake.kill, delay: async () => {}, graceMs: 100 })).toBe(0);
      expect(fake.signals).toEqual([]);
      expect(existsSync(file.path)).toBe(true);
      // Once the owner is gone (or its pid now belongs to another process), they are leftovers.
      fake.table.set(999, stat(999, 999, 4321, 'bun'));
      expect(await stopRecordedDescendantGroups(file.path, { read: fake.read, kill: fake.kill, delay: async () => {}, graceMs: 100 })).toBe(1);
    } finally { file.done(); }
  });
});
