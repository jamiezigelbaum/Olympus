import { describe, expect, test } from 'bun:test';
import {
  hasForbiddenHostPathLeak,
  runCastorWorkspaceProof,
  type CastorWorkspaceProofTransport,
} from '../scripts/castor-workspace-proof.ts';

// Invented tenant-free fixture values: the proof takes its destination from
// deployment config, and this suite only needs a well-formed gs:// prefix.
const FIXTURE_BUCKET_URI = 'gs://fixture-trading-books-rag';
const FIXTURE_DESTINATION_URI = `${FIXTURE_BUCKET_URI}/olympus-castor-workspace-proof`;

describe('Castor Workspace operational proof', () => {
  test('passes the bounded worker happy path without exposing shell or host paths', async () => {
    const seen: string[] = [];
    const transport: CastorWorkspaceProofTransport = async (request) => {
      seen.push(request.action);
      const policy = {
        castor_workspace_delegated: true,
        shell_exposed_to_agent: false,
        absolute_path_exposed: false,
      };
      if (request.action === 'health') {
        return {
          status: 200,
          body: {
            kind: 'castor_workspace_health',
            configured: true,
            roots: [{ root_id: 'castor_workspace', allowed_gcs_prefixes: [FIXTURE_BUCKET_URI] }],
            policy,
          },
        };
      }
      if (request.action === 'write') {
        return {
          status: 200,
          body: {
            kind: 'castor_workspace_write',
            root_id: request.root_id,
            relative_path: request.relative_path,
            bytes_written: request.content?.length ?? 0,
            policy,
          },
        };
      }
      if (request.action === 'read') {
        return {
          status: 200,
          body: {
            kind: 'castor_workspace_read',
            root_id: request.root_id,
            relative_path: request.relative_path,
            content: `Olympus Castor Workspace proof proof-run\n`,
            content_encoding: 'utf8',
            policy,
          },
        };
      }
      if (request.action === 'list' && request.relative_path?.startsWith('/')) {
        return {
          status: 400,
          body: { error: { code: 'absolute_path_denied', message: 'Use relative paths.' }, policy },
        };
      }
      if (request.action === 'list' && request.relative_path?.startsWith('..')) {
        return {
          status: 400,
          body: { error: { code: 'path_traversal_denied', message: 'relative_path may not contain traversal.' }, policy },
        };
      }
      if (request.action === 'list') {
        return {
          status: 200,
          body: {
            kind: 'castor_workspace_list',
            root_id: request.root_id,
            relative_path: request.relative_path,
            entries: [{ relative_path: `${request.relative_path}/proof.txt`, name: 'proof.txt', kind: 'file' }],
            policy,
          },
        };
      }
      if (request.action === 'export_gcs') {
        return {
          status: 200,
          body: {
            kind: 'castor_workspace_export_gcs',
            root_id: request.root_id,
            relative_path: request.relative_path,
            destination_uri: request.destination_uri,
            dry_run: true,
            files: 1,
            bytes: 43,
            policy,
          },
        };
      }
      return {
        status: 200,
        body: {
          kind: 'castor_workspace_delete',
          root_id: request.root_id,
          relative_path: request.relative_path,
          recursive: true,
          policy,
        },
      };
    };

    const report = await runCastorWorkspaceProof({
      baseUrl: 'http://worker.test/v1',
      runId: 'proof-run',
      destinationUri: FIXTURE_DESTINATION_URI,
      transport,
    });

    expect(report.status).toBe('pass');
    expect(report.summary).toEqual({
      health: true,
      write_read_list_delete: true,
      gcs_dry_run: true,
      absolute_path_denied: true,
      traversal_denied: true,
      cleanup: true,
    });
    expect(report.safety).toEqual({
      castor_workspace_delegated: true,
      shell_exposed_to_agent: false,
      absolute_path_exposed: false,
      host_path_leak_detected: false,
    });
    expect(seen).toEqual(['health', 'write', 'read', 'list', 'export_gcs', 'list', 'list', 'delete']);
    expect(JSON.stringify(report)).not.toContain('/Users/');
    expect(JSON.stringify(report)).not.toContain('/tmp/');
  });

  test('attaches worker bearer auth to direct HTTP transport when configured', async () => {
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.OLYMPUS_WORKER_AUTH_TOKEN;
    const headers: Array<string | null> = [];
    process.env.OLYMPUS_WORKER_AUTH_TOKEN = ' castor-workspace-secret ';
    globalThis.fetch = (async (_url, init) => {
      headers.push(new Headers(init?.headers).get('authorization'));
      const request = JSON.parse(String(init?.body ?? '{}')) as { action?: string; relative_path?: string };
      return jsonResponse(castorResponseFor(request), request.action === 'list' && request.relative_path?.startsWith('/') ? 400 : request.action === 'list' && request.relative_path?.startsWith('..') ? 400 : 200);
    }) as typeof fetch;
    try {
      await runCastorWorkspaceProof({
        baseUrl: 'http://worker.test/v1',
        runId: 'proof-run',
        destinationUri: FIXTURE_DESTINATION_URI,
      });
    } finally {
      globalThis.fetch = originalFetch;
      if (originalToken === undefined) {
        delete process.env.OLYMPUS_WORKER_AUTH_TOKEN;
      } else {
        process.env.OLYMPUS_WORKER_AUTH_TOKEN = originalToken;
      }
    }

    expect(headers).toHaveLength(8);
    expect(headers.every((header) => header === 'Bearer castor-workspace-secret')).toBe(true);
  });

  test('fails when the worker leaks host path fields', async () => {
    const transport: CastorWorkspaceProofTransport = async () => ({
      status: 200,
      body: {
        kind: 'castor_workspace_health',
        configured: true,
        roots: [{ root_id: 'castor_workspace' }],
        absolute_path: '/Users/owner/Castor Workspace',
        policy: {
          castor_workspace_delegated: true,
          shell_exposed_to_agent: false,
          absolute_path_exposed: false,
        },
      },
    });

    const report = await runCastorWorkspaceProof({
      baseUrl: 'http://worker.test/v1',
      runId: 'leak-proof',
      destinationUri: FIXTURE_DESTINATION_URI,
      transport,
    });

    expect(report.status).toBe('fail');
    expect(report.safety.host_path_leak_detected).toBe(true);
    expect(report.steps[0]!.detail).toContain('forbidden host path field');
    expect(hasForbiddenHostPathLeak({ nested: { filesystem_path: '/Users/owner/file.txt' } })).toBe(true);
  });
});

function castorResponseFor(request: { action?: string; relative_path?: string }): unknown {
  const policy = {
    castor_workspace_delegated: true,
    shell_exposed_to_agent: false,
    absolute_path_exposed: false,
  };
  if (request.action === 'health') {
    return {
      kind: 'castor_workspace_health',
      configured: true,
      roots: [{ root_id: 'castor_workspace' }],
      policy,
    };
  }
  if (request.action === 'list' && request.relative_path?.startsWith('/')) {
    return { error: { code: 'absolute_path_denied', message: 'Use relative paths.' }, policy };
  }
  if (request.action === 'list' && request.relative_path?.startsWith('..')) {
    return { error: { code: 'path_traversal_denied', message: 'relative_path may not contain traversal.' }, policy };
  }
  if (request.action === 'write') return { kind: 'castor_workspace_write', relative_path: request.relative_path, policy };
  if (request.action === 'read') return { kind: 'castor_workspace_read', content: 'Olympus Castor Workspace proof proof-run\n', policy };
  if (request.action === 'list') {
    return {
      kind: 'castor_workspace_list',
      entries: [{ relative_path: '__olympus_proof__/proof-run/proof.txt' }],
      policy,
    };
  }
  if (request.action === 'export_gcs') return { kind: 'castor_workspace_export_gcs', dry_run: true, policy };
  return { kind: 'castor_workspace_delete', policy };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
