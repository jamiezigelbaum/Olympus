import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../src/core/config.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { openRemoteConnectionStore, type RemoteConnectionStore } from '../src/core/remote-connections.ts';
import { recordReleaseManifest } from '../src/core/release-manifest.ts';
import { handleMcpCallTool } from '../src/mcp/server.ts';
import { createRemoteOpenApiHandler } from '../src/workers/remote-openapi.ts';

let dir: string;
let connections: RemoteConnectionStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'olympus-operation-access-recheck-'));
  connections = openRemoteConnectionStore(join(dir, 'connections.sqlite'));
});

afterEach(() => {
  connections.close();
  rmSync(dir, { recursive: true, force: true });
});

for (const surface of ['MCP', 'OpenAPI'] as const) {
  describe(`${surface} operation access after asynchronous release work`, () => {
    for (const stage of ['release', 'settle', 'final release'] as const) {
      for (const failure of ['revoked', 'unavailable'] as const) {
        test(`${failure} during ${stage}: only a refusal leaves`, async () => {
          const { connection, token } = connections.create('Remote test');
          let resume!: () => void;
          const held = new Promise<void>((resolve) => { resume = resolve; });
          let reached!: () => void;
          const started = new Promise<void>((resolve) => { reached = resolve; });
          let unavailable = false;
          let releases = 0;
          let settles = 0;
          const holdAt = async (at: typeof stage) => {
            if (stage !== at) return;
            reached();
            await held;
          };
          const ctx: OperationContext = {
            config: defaultConfig(),
            delphi: {} as OperationContext['delphi'],
            email: { sourceAnswer: async () => {
              recordReleaseManifest({ inputs: [], constraints: { secureDerivativeDefault: 'approval', includeSecureLocalContent: false } });
              return { answer: 'handler answer must never leave', evidence: [] };
            } } as unknown as OperationContext['email'],
            releaseCheck: {
              inputs: () => [],
              inputsOffThread: async () => {
                releases += 1;
                await holdAt(releases === 1 ? 'release' : 'final release');
                return [];
              },
              secureDerivativeDefault: () => 'approval',
            },
            remotePrivatePart: { start: () => ({ settle: async () => {
              settles += 1;
              await holdAt('settle');
              return false;
            } }) },
          };
          const store = () => {
            if (unavailable) throw new Error('credential store unreadable');
            return connections;
          };
          const pending = surface === 'MCP'
            ? handleMcpCallTool({ params: { name: 'source_answer', arguments: { question: 'q' } } }, () => ctx, 'remote',
              () => store().verifyToken(token).ok ? 'active' : 'revoked')
            : createRemoteOpenApiHandler({ connections: store, makeOperationContext: () => ctx })(new Request('http://worker.test/api/v1/tools/source_answer', {
              method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'q' }),
            }));
          try {
            await started;
            if (failure === 'revoked') connections.revoke(connection.id);
            else unavailable = true;
            resume();
            const result = await pending;
            const expected = failure === 'revoked'
              ? { error: 'invalid_token', message: 'The connection token is not valid or has been revoked.' }
              : { error: 'remote_connections_unavailable', message: 'Olympus could not check the connection token. Try again later.' };
            if (result instanceof Response) {
              expect(result.status).toBe(failure === 'revoked' ? 401 : 503);
              expect(await result.json()).toEqual(expected);
            } else {
              expect(result).toEqual({ isError: true, content: [{ type: 'text', text: JSON.stringify(expected, null, 2) }] });
            }
            // An early refusal must also stop the later waits and local recording step.
            expect(releases).toBe(stage === 'final release' ? 2 : 1);
            expect(settles).toBe(stage === 'release' ? 0 : 1);
          } finally {
            resume();
          }
        });
      }
    }
  });
}
