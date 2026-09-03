import { describe, expect, test } from 'bun:test';
import { defaultConfig } from '../src/core/config.ts';
import { DirectHttpFileDeliveryTransport, FileDeliveryClient } from '../src/core/file-delivery.ts';

describe('FileDeliveryClient', () => {
  test('reports disabled file delivery without reaching the network', async () => {
    const config = defaultConfig();
    const client = new FileDeliveryClient(
      config,
      new DirectHttpFileDeliveryTransport(async () => {
        throw new Error('network should not be called');
      }),
    );

    await expect(client.health()).resolves.toMatchObject({
      reachable: false,
      configured: false,
      policy: {
        bounded_file_delivery: true,
        shell_used: false,
        absolute_path_exposed: false,
      },
    });
  });

  test('sends bounded delivery requests to the configured worker', async () => {
    const config = defaultConfig();
    config.fileDelivery.enabled = true;
    config.fileDelivery.baseUrl = 'http://xanthos-delivery.test/v1';
    const requests: Request[] = [];
    const client = new FileDeliveryClient(
      config,
      new DirectHttpFileDeliveryTransport(async (input, init) => {
        requests.push(new Request(input, init));
        return jsonResponse({
          kind: 'file_delivery_result',
          delivery_id: 'delivery-1',
          root_id: 'olympus_smoke',
          relative_path: 'notes/test.md',
          bytes_written: 11,
          content_sha256: 'hash-1',
          write_mode: 'create_new',
          created_at: '2026-05-20T12:00:00.000Z',
          approval_status: 'not_required',
          audit_ref: 'file_delivery:delivery-1',
          policy: {
            bounded_file_delivery: true,
            shell_used: false,
            absolute_path_exposed: false,
          },
        });
      }),
    );

    const result = await client.deliver({
      rootId: 'olympus_smoke',
      relativePath: 'notes/test.md',
      content: 'hello world',
      contentEncoding: 'utf8',
      writeMode: 'create_new',
      trustDomain: 'internal',
      sourceProvenance: 'Owner request',
      idempotencyKey: 'request-1',
      actorId: 'castor',
      sessionId: 'session-1',
      modelProvider: 'olympus-local',
      modelId: 'qwen-local',
    });

    expect(result).toMatchObject({
      kind: 'file_delivery_result',
      root_id: 'olympus_smoke',
      relative_path: 'notes/test.md',
      policy: {
        bounded_file_delivery: true,
        shell_used: false,
        absolute_path_exposed: false,
      },
    });
    expect(requests[0]?.url).toBe('http://xanthos-delivery.test/v1/file/deliver');
    expect(await requests[0]?.json()).toEqual({
      root_id: 'olympus_smoke',
      relative_path: 'notes/test.md',
      content: 'hello world',
      content_encoding: 'utf8',
      write_mode: 'create_new',
      trust_domain: 'internal',
      source_provenance: 'Owner request',
      idempotency_key: 'request-1',
      actor_id: 'castor',
      session_id: 'session-1',
      model_provider: 'olympus-local',
      model_id: 'qwen-local',
    });
  });

  test('rejects worker responses that expose concrete host paths', async () => {
    const config = defaultConfig();
    config.fileDelivery.enabled = true;
    const client = new FileDeliveryClient(
      config,
      new DirectHttpFileDeliveryTransport(async () => jsonResponse({
        kind: 'file_delivery_result',
        delivery_id: 'delivery-1',
        root_id: 'olympus_smoke',
        relative_path: 'notes/test.md',
        target_path: '/Users/owner/private/file.md',
        bytes_written: 11,
        content_sha256: 'hash-1',
        write_mode: 'create_new',
        created_at: '2026-05-20T12:00:00.000Z',
        approval_status: 'not_required',
        audit_ref: 'file_delivery:delivery-1',
        policy: {
          bounded_file_delivery: true,
          shell_used: false,
          absolute_path_exposed: false,
        },
      })),
    );

    await expect(client.deliver({
      rootId: 'olympus_smoke',
      relativePath: 'notes/test.md',
      content: 'hello world',
      writeMode: 'create_new',
      trustDomain: 'internal',
      idempotencyKey: 'request-1',
    })).rejects.toThrow('forbidden host path field "target_path"');
  });
});

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
