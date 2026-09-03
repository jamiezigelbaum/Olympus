// The durable-outbound SDK is host-provided, so its absence is a runtime
// outage, not a malformed request. Classifying it as HTTP 400 sends the
// operator after the payload shape while the delivery retries and dead-letters.

import { describe, expect, test } from 'bun:test';
import { handleSourceWatchDeliveryGatewayRequest } from '../src/native-plugin.ts';

const BODY = JSON.stringify({
  route: {
    ownerId: 'owner:hash',
    kind: 'openclaw_channel',
    targetId: 'telegram:12345',
    accountId: 'castor',
  },
  downstream_idempotency_key: 'c'.repeat(64),
  payload: {
    headline: 'Olympus watch matched newly indexed evidence.',
    watch_id: 'watch-sdk-outage',
    corpus_id: 'internal.telegram.messages',
    query_text: 'pineapple',
    watch_mode: 'one_shot',
    match_count: 1,
    items: [{
      local_item_id: 'message-1',
      source_version: '2026-07-22T09:50:00.000Z',
      matched_at: '2026-07-22T10:00:00.000Z',
    }],
  },
});

describe('watch delivery gateway when the OpenClaw durable SDK is unavailable', () => {
  test('reports the outage as a runtime failure, not an invalid request', async () => {
    // No injected sender: the handler falls through to the host SDK import,
    // which this build does not carry.
    const result = await handleSourceWatchDeliveryGatewayRequest({
      method: 'POST',
      authorization: 'Bearer shared-worker-token',
      body: BODY,
      authToken: 'shared-worker-token',
      openClawConfig: {},
    });

    expect(result).toMatchObject({
      status: 503,
      body: { status: 'failed', error_kind: 'openclaw_sdk_unavailable' },
    });
  });

  test('a send that throws records a bounded cause instead of discarding it', async () => {
    const result = await handleSourceWatchDeliveryGatewayRequest({
      method: 'POST',
      authorization: 'Bearer shared-worker-token',
      body: BODY,
      authToken: 'shared-worker-token',
      openClawConfig: {},
      sendDurableMessageBatch: async () => {
        throw new Error('channel transport refused the batch');
      },
    });

    expect(result).toMatchObject({
      status: 200,
      body: { status: 'failed', error_kind: 'openclaw_send_failed' },
    });
    expect(JSON.stringify(result.body)).not.toContain('channel transport refused');
  });
});
