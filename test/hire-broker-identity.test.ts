import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

import {
  CounterpartyIdentityResolver,
  HttpAgentCardResolver,
  ReadOnlyErc8004IdentityVerifier,
  type FetchLike,
} from '../src/workers/hire-broker/identity.ts';

const ENDPOINT = 'https://expert.example/a2a';

describe('Hire Broker counterparty identity', () => {
  test('hashes the live card and marks a listing without an identity claim as unverified', async () => {
    const card = { name: 'Fixture', url: ENDPOINT, capabilities: { streaming: false } };
    const resolver = new CounterpartyIdentityResolver(
      new HttpAgentCardResolver(async () => Response.json(card)),
      { verify: async () => { throw new Error('must not verify'); } },
    );
    const candidate = await resolver.resolve({ name: 'Fixture', endpoint: ENDPOINT });
    expect(candidate.identity).toEqual({ status: 'unverified_identity' });
    expect(candidate.agentCardHash).toMatch(/^[a-f0-9]{64}$/);
  });

  test('refuses when the live card declares a different endpoint', async () => {
    const resolver = new CounterpartyIdentityResolver(
      new HttpAgentCardResolver(async () => Response.json({ url: 'https://imposter.example/a2a' })),
      { verify: async () => { throw new Error('must not verify'); } },
    );
    await expect(resolver.resolve({ name: 'Fixture', endpoint: ENDPOINT }))
      .rejects.toMatchObject({ code: 'identity_mismatch' });
  });

  test('resolves read-only registry owner and token URI and matches its A2A endpoint', async () => {
    const tokenURI = `data:application/json,${encodeURIComponent(JSON.stringify({
      services: [{ name: 'A2A', endpoint: ENDPOINT }],
    }))}`;
    const calls: Array<{ method: string; body?: string }> = [];
    const fetchImpl: FetchLike = async (_input, init) => {
      calls.push({ method: init?.method ?? 'GET', body: String(init?.body ?? '') });
      const request = JSON.parse(String(init?.body)) as { params: [{ data: string }] };
      const selector = request.params[0].data.slice(2, 10);
      if (selector === 'de99f157') return rpcResult(uintWord(1n));
      if (selector === '6352211e') return rpcResult(`0x${'0'.repeat(24)}1234567890abcdef1234567890abcdef12345678`);
      if (selector === 'c87b56dd') return rpcResult(abiString(tokenURI));
      throw new Error('unexpected selector');
    };
    const verifier = new ReadOnlyErc8004IdentityVerifier(fetchImpl);
    const result = await verifier.verify({ chain: 'base', agentId: '42' }, ENDPOINT);

    expect(result).toMatchObject({
      status: 'verified',
      chain: 'base',
      agentId: '42',
      owner: '0x1234567890abcdef1234567890abcdef12345678',
      tokenURI,
      registeredEndpoint: ENDPOINT,
    });
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.method === 'POST')).toBe(true);
    expect(calls.every((call) => call.body?.includes('eth_call'))).toBe(true);
  });

  test('refuses a registered-card endpoint mismatch', async () => {
    const tokenURI = `data:application/json,${encodeURIComponent(JSON.stringify({
      services: [{ name: 'A2A', endpoint: 'https://imposter.example/a2a' }],
    }))}`;
    const verifier = new ReadOnlyErc8004IdentityVerifier(registryFetch(tokenURI));
    await expect(verifier.verify({ chain: 'ethereum', agentId: '7' }, ENDPOINT))
      .rejects.toMatchObject({ code: 'identity_mismatch' });
  });

  test('refuses an RPC failure instead of assuming identity', async () => {
    const verifier = new ReadOnlyErc8004IdentityVerifier(async () => {
      throw new Error('offline');
    });
    await expect(verifier.verify({ chain: 'arbitrum', agentId: '7' }, ENDPOINT))
      .rejects.toMatchObject({ code: 'identity_verification_failed' });
  });

  test('refuses loopback and private fetch targets by default', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error('network must not run');
    };
    await expect(new HttpAgentCardResolver(fetchImpl).resolve('http://127.0.0.1:9000/a2a'))
      .rejects.toMatchObject({ code: 'identity_verification_failed' });
  });

  test('refuses every spelling of a loopback or private fetch target', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error('network must not run');
    };
    const refused = [
      'http://0.0.0.0:8030/v1',
      'http://[::]:8030/v1',
      'http://[::1]:8030/v1',
      'http://[::ffff:127.0.0.1]:8030/v1',
      'http://[fd00::1]:8030/v1',
      'http://[fe80::1]:8030/v1',
      // Integer and octal IPv4 forms are normalized to a dotted quad by URL
      // parsing before the guard reads the hostname; pinned so a hand-rolled
      // hostname reader never replaces it.
      'http://2130706433:8010/v1',
      'http://0177.0.0.1:8010/v1',
    ];
    for (const endpoint of refused) {
      await expect(new HttpAgentCardResolver(fetchImpl).resolve(endpoint), endpoint)
        .rejects.toMatchObject({ code: 'identity_verification_failed' });
    }
  });

  test('a hostname that merely starts like a ULA is still fetched', async () => {
    const endpoint = 'https://fd-experts.example/a2a';
    const resolved = await new HttpAgentCardResolver(async () => Response.json({ url: endpoint }))
      .resolve(endpoint);
    expect(resolved.declaredEndpoint).toBe(endpoint);
  });

  test('refuses a counterparty tokenURI naming a loopback host before it is fetched', async () => {
    const tokenURI = 'http://[::1]:8030/registration.json';
    const rpc = registryFetch(tokenURI);
    let cardFetches = 0;
    const fetchImpl: FetchLike = async (input, init) => {
      if ((init?.method ?? 'GET') !== 'POST') {
        cardFetches += 1;
        return Response.json({ services: [{ name: 'A2A', endpoint: ENDPOINT }] });
      }
      return rpc(input, init);
    };
    const verifier = new ReadOnlyErc8004IdentityVerifier(fetchImpl);
    await expect(verifier.verify({ chain: 'ethereum', agentId: '7' }, ENDPOINT))
      .rejects.toMatchObject({ code: 'identity_verification_failed' });
    expect(cardFetches).toBe(0);
  });

  test('card hash is stable across JSON key order', async () => {
    const first = { name: 'Fixture', url: ENDPOINT };
    const second = { url: ENDPOINT, name: 'Fixture' };
    const firstResult = await new HttpAgentCardResolver(async () => Response.json(first)).resolve(ENDPOINT);
    const secondResult = await new HttpAgentCardResolver(async () => Response.json(second)).resolve(ENDPOINT);
    expect(firstResult.cardHash).toBe(secondResult.cardHash);
    expect(firstResult.cardHash).not.toBe(createHash('sha256').update(JSON.stringify(first)).digest('base64'));
  });
});

function registryFetch(tokenURI: string): FetchLike {
  return async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { params: [{ data: string }] };
    const selector = request.params[0].data.slice(2, 10);
    if (selector === 'de99f157') return rpcResult(uintWord(1n));
    if (selector === '6352211e') return rpcResult(`0x${'0'.repeat(24)}1234567890abcdef1234567890abcdef12345678`);
    return rpcResult(abiString(tokenURI));
  };
}

function rpcResult(result: string): Response {
  return Response.json({ jsonrpc: '2.0', id: 1, result });
}

function uintWord(value: bigint): string {
  return `0x${value.toString(16).padStart(64, '0')}`;
}

function abiString(value: string): string {
  const data = Buffer.from(value, 'utf8').toString('hex');
  const padded = data.padEnd(Math.ceil(data.length / 64) * 64, '0');
  return `0x${(32).toString(16).padStart(64, '0')}${Buffer.byteLength(value, 'utf8').toString(16).padStart(64, '0')}${padded}`;
}
