import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  aggregateBundledCreditUsage,
  buildBalanceReport,
  fetchVeniceCreditStatus,
  formatTextReport,
  reconcileProviderPauseFile,
} from '../scripts/venice-credit-status.ts';

const fixture = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'venice-bundled-usage.json'), 'utf8')) as {
  balance: Record<string, unknown>;
  usage: Record<string, unknown>[];
};

describe('Venice credit status monitor', () => {
  test('fetches the documented paged usage ledger and aggregates the real bundled-credit pool', async () => {
    const seenUrls: string[] = [];
    const report = await fetchVeniceCreditStatus({
      env: { OLYMPUS_SOURCE_INDEX_VENICE_API_KEY: 'secret-token' },
      now: new Date('2026-07-10T12:00:00.000Z'),
      fetchImpl: async (url, init) => {
        seenUrls.push(String(url));
        expect(init?.headers).toMatchObject({
          authorization: 'Bearer secret-token',
          accept: 'application/json',
        });
        if (String(url).endsWith('/billing/balance')) return Response.json(fixture.balance);
        const parsed = new URL(String(url));
        expect(parsed.pathname).toBe('/api/v1/billing/usage');
        expect(parsed.searchParams.get('currency')).toBe('BUNDLED_CREDITS');
        expect(parsed.searchParams.get('startDate')).toBe('2026-06-24T12:00:00.000Z');
        expect(parsed.searchParams.get('endDate')).toBe('2026-07-10T12:00:00.000Z');
        expect(parsed.searchParams.get('limit')).toBe('500');
        expect(parsed.searchParams.get('sortOrder')).toBe('desc');
        const page = Number(parsed.searchParams.get('page'));
        return Response.json({
          data: page === 1 ? fixture.usage.slice(0, 4) : fixture.usage.slice(4),
          pagination: { page, totalPages: 2, total: fixture.usage.length, limit: 500 },
        });
      },
    });

    expect(seenUrls).toHaveLength(3);
    expect(report).toMatchObject({
      kind: 'venice_credit_status',
      status: 'ok',
      can_consume: true,
      consumption_currency: 'BUNDLED_CREDITS',
      balances: { usd: 0 },
      bundled_credits_usage: {
        endpoint: 'billing/usage',
        currency: 'BUNDLED_CREDITS',
        status: 'ok',
        pages_fetched: 2,
        entries_scanned: 7,
        trailing_24h: {
          spend: 37.75,
          entry_count: 4,
          by_sku_family: {
            vision_extraction: { spend: 32.5, entry_count: 2 },
            secure_answers: { spend: 4.25, entry_count: 1 },
            other: { spend: 1, entry_count: 1 },
          },
        },
        current_billing_cycle: {
          derivation: 'bundled_credit_allocation',
          start_at: '2026-07-01T00:00:00.000Z',
          spend: 137.75,
          entry_count: 5,
        },
      },
      policy: {
        pause_authority: 'billing/balance.canConsume',
      },
      actions: [],
    });
    expect(JSON.stringify(report)).not.toContain('secret-token');
  });

  test('reports a trailing window but leaves the billing cycle unavailable without ledger evidence', () => {
    const usage = aggregateBundledCreditUsage([
      {
        timestamp: '2026-07-10T11:00:00.000Z',
        sku: 'e2ee-glm-5-output-mtoken',
        amount: -2,
        currency: 'BUNDLED_CREDITS',
        notes: 'API Inference',
      },
    ], new Date('2026-07-10T12:00:00.000Z'));

    expect(usage.trailing_24h?.spend).toBe(2);
    expect(usage.current_billing_cycle).toBeNull();
    expect(usage.cycle_derivation).toBe('unavailable');
  });

  test('keeps balance canConsume as pause authority when the USD side pool is empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-venice-credit-'));
    const pauseFile = join(dir, 'venice-paused.json');
    const report = buildBalanceReport(new Date('2026-07-10T12:00:00.000Z'), {
      canConsume: true,
      consumptionCurrency: 'BUNDLED_CREDITS',
      balances: { usd: 0, diem: null },
    }, aggregateBundledCreditUsage(fixture.usage, new Date('2026-07-10T12:00:00.000Z')));

    expect(report.status).toBe('ok');
    expect(reconcileProviderPauseFile(pauseFile, report)).toBe('left');
    expect(existsSync(pauseFile)).toBe(false);

    writeFileSync(pauseFile, '{"kind":"venice"}\n');
    expect(reconcileProviderPauseFile(pauseFile, report)).toBe('cleared');
    expect(existsSync(pauseFile)).toBe(false);
  });

  test('treats canConsume=false as credit exhausted and writes the pause marker', () => {
    const report = buildBalanceReport(new Date('2026-06-23T20:30:00.000Z'), {
      canConsume: false,
      consumptionCurrency: 'BUNDLED_CREDITS',
      balances: { usd: 0, diem: 0 },
    });
    const dir = mkdtempSync(join(tmpdir(), 'olympus-venice-credit-'));
    const pauseFile = join(dir, 'venice-paused.json');

    expect(report.status).toBe('credit_exhausted');
    expect(reconcileProviderPauseFile(pauseFile, report)).toBe('written');
    expect(JSON.parse(readFileSync(pauseFile, 'utf8'))).toMatchObject({
      active: true,
      kind: 'venice',
      reason: 'provider_credit_exhausted',
    });
  });

  test('does not let a usage-ledger 402 override healthy balance canConsume', async () => {
    const report = await fetchVeniceCreditStatus({
      env: { VENICE_API_KEY: 'secret-token' },
      now: new Date('2026-07-10T12:00:00.000Z'),
      fetchImpl: async (url) => String(url).endsWith('/billing/balance')
        ? Response.json(fixture.balance)
        : new Response('{}', { status: 402 }),
    });
    const pauseFile = join(mkdtempSync(join(tmpdir(), 'olympus-venice-credit-')), 'venice-paused.json');

    expect(report).toMatchObject({
      status: 'ok',
      can_consume: true,
      bundled_credits_usage: {
        status: 'unavailable',
        error_kind: 'venice_billing_usage_http_402',
      },
    });
    expect(report.actions.join('\n')).toContain('canConsume remains the pause authority');
    expect(reconcileProviderPauseFile(pauseFile, report)).toBe('left');
    expect(existsSync(pauseFile)).toBe(false);
  });

  test('formats bundled-credit spend for the operator text surface', () => {
    const report = buildBalanceReport(
      new Date('2026-07-10T12:00:00.000Z'),
      fixture.balance,
      aggregateBundledCreditUsage(fixture.usage, new Date('2026-07-10T12:00:00.000Z'), 2),
    );
    expect(formatTextReport(report)).toBe(
      'venice_credit_status=ok can_consume=true currency=BUNDLED_CREDITS usd=0.00 diem=n/a bundled_24h=37.7500 vision_24h=32.5000 secure_24h=4.2500 bundled_cycle=137.7500 cycle_start=2026-07-01T00:00:00.000Z',
    );
  });

  test('classifies missing keys and balance HTTP errors safely', async () => {
    const missing = await fetchVeniceCreditStatus({ env: {}, now: new Date('2026-06-23T20:30:00.000Z') });
    expect(missing).toMatchObject({
      status: 'not_configured',
      error_kind: 'venice_billing_api_key_missing',
    });

    const exhausted = await fetchVeniceCreditStatus({
      env: { VENICE_API_KEY: 'secret-token' },
      now: new Date('2026-06-23T20:30:00.000Z'),
      fetchImpl: async () => new Response('{}', { status: 402 }),
    });
    expect(exhausted).toMatchObject({
      status: 'credit_exhausted',
      can_consume: false,
      error_kind: 'venice_billing_http_402',
    });
  });
});
