import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { runGoogleBootstrap, type GoogleBootstrapExec } from '../src/core/google-bootstrap.ts';

describe('olympus connect google-bootstrap', () => {
  test('emits action_required remedy when gcloud is absent', async () => {
    const result = await runGoogleBootstrap({
      which: async () => undefined,
      exec: async () => {
        throw new Error('must not run gcloud');
      },
    });

    expect(result).toMatchObject({
      ok: true,
      source: 'google-bootstrap',
      checkpoints: [{
        step: 'gcloud_present',
        status: 'action_required',
      }],
    });
    expect(JSON.stringify(result.checkpoints[0]?.remedy)).toContain('cloud.google.com/sdk/docs/install-sdk');
  });

  test('stops at authenticated checkpoint with exact gcloud auth login remedy', async () => {
    const calls: string[] = [];
    const result = await runGoogleBootstrap({
      which: async () => '/usr/bin/gcloud',
      exec: async (command, args) => {
        calls.push([command, ...args].join(' '));
        return { status: 0, stdout: '', stderr: '' };
      },
    });

    expect(calls).toEqual(['gcloud auth list --filter=status:ACTIVE --format=value(account)']);
    expect(result.checkpoints).toEqual([
      expect.objectContaining({ step: 'gcloud_present', status: 'ok' }),
      expect.objectContaining({ step: 'gcloud_authenticated', status: 'action_required', remedy: 'gcloud auth login' }),
    ]);
  });

  test('creates project, enables APIs, and returns console deep links', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-google-bootstrap-test-'));
    const calls: string[] = [];
    try {
      const result = await runGoogleBootstrap({
        which: async () => '/usr/bin/gcloud',
        statePath: join(dir, 'google-bootstrap.json'),
        suffix: 'abc12345',
        exec: fakeGcloud(calls, { projectExists: false, enabledApis: [] }),
      });

      expect(calls).toContain('gcloud projects create olympus-abc12345');
      expect(calls).toContain('gcloud services enable gmail.googleapis.com drive.googleapis.com docs.googleapis.com --project olympus-abc12345');
      expect(result.projectId).toBe('olympus-abc12345');
      expect(result.checkpoints.map((checkpoint) => checkpoint.step)).toEqual([
        'gcloud_present',
        'gcloud_authenticated',
        'project_ready',
        'apis_enabled',
        'console_steps_remaining',
      ]);
      const consoleStep = result.checkpoints.at(-1);
      expect(consoleStep).toMatchObject({ status: 'action_required' });
      expect(JSON.stringify(consoleStep?.remedy)).toContain('https://console.cloud.google.com/auth/overview?project=olympus-abc12345');
      expect(JSON.stringify(consoleStep?.remedy)).toContain('/apis/credentials/oauthclient?project=olympus-abc12345');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('reuses the prior project id from state and skips already-enabled APIs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-google-bootstrap-reuse-test-'));
    const statePath = join(dir, 'google-bootstrap.json');
    await Bun.write(statePath, JSON.stringify({ projectId: 'olympus-reused1' }));
    const calls: string[] = [];
    try {
      const result = await runGoogleBootstrap({
        which: async () => '/usr/bin/gcloud',
        statePath,
        exec: fakeGcloud(calls, {
          projectExists: true,
          enabledApis: ['gmail.googleapis.com', 'drive.googleapis.com', 'docs.googleapis.com'],
        }),
      });

      expect(result.projectId).toBe('olympus-reused1');
      expect(calls).toContain('gcloud projects describe olympus-reused1 --format=json');
      expect(calls.some((call) => call.includes('projects create'))).toBe(false);
      expect(calls.some((call) => call.includes('services enable'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function fakeGcloud(calls: string[], options: {
  projectExists: boolean;
  enabledApis: string[];
}): GoogleBootstrapExec {
  return async (command, args) => {
    calls.push([command, ...args].join(' '));
    if (args[0] === 'auth') return { status: 0, stdout: 'owner@example.com\n', stderr: '' };
    if (args[0] === 'projects' && args[1] === 'describe') {
      return options.projectExists
        ? { status: 0, stdout: '{}', stderr: '' }
        : { status: 1, stdout: '', stderr: 'not found' };
    }
    if (args[0] === 'projects' && args[1] === 'create') return { status: 0, stdout: '{}', stderr: '' };
    if (args[0] === 'services' && args[1] === 'list') {
      return { status: 0, stdout: `${options.enabledApis.join('\n')}\n`, stderr: '' };
    }
    if (args[0] === 'services' && args[1] === 'enable') return { status: 0, stdout: '', stderr: '' };
    throw new Error(`unexpected gcloud call: ${command} ${args.join(' ')}`);
  };
}
