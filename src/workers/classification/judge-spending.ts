import { readFileSync } from 'node:fs';
import { withFileLeaseSync } from '../../core/file-lease.ts';
import { writePrivateFileAtomicSync } from '../../core/atomic-file.ts';
import { JudgeCloudStopped } from './sniffer.ts';
import { dirname, join } from 'node:path';
import { resolveClassificationLedgerPath } from '../classification-ledger.ts';
import type { AnalystModel } from '../../core/analyst.ts';
import type { OpenAIAnalystFetch } from '../../core/analyst-openai.ts';
import { normalizeVeniceAnalystModelId } from '../../core/venice-models.ts';

export { JudgeCloudStopped } from './sniffer.ts';

// USD per million tokens. One dated authority for both setup and dispatch.
// https://github.com/veniceai/api-docs/blob/main/models/text.mdx
export const JUDGE_PRICE_DATE = '2026-11-06';
export const JUDGE_PRICES: Readonly<Record<string, { input: number; output: number }>> = Object.freeze({
  'qwen3-6-35b-a3b': { input: 0.10, output: 1.00 },
  'kimi-k3': { input: 3.75, output: 18.75 },
  'zai-org-glm-5-2': { input: 1.40, output: 4.40 },
  'grok-4-3': { input: 1.42, output: 2.83 },
  'grok-4-5': { input: 2.27, output: 6.80 },
});
export const LOCAL_JUDGE_MEASUREMENT = { date: '2026-11-06', computer: 'M1, 16 GB', model: '4B judge', shortPerMinute: 67, longPerMinute: 6 } as const;
export const JUDGE_NIGHT_HOURS = 8;
export const JUDGE_RECOMMENDATION_NIGHTS = 14;
// Count alone cannot establish the length mix. Show the measured short/long range,
// and recommend cloud only when even short items exceed two weeks of nights.
export const VENICE_JUDGE_ESTIMATE = { date: '2026-11-06', itemsPerMinute: 190, inputTokensPerItem: 800, outputTokensPerItem: 80 } as const;
export function judgeArchiveEstimate(count: number, model: string) {
  const items = Math.max(0, Math.trunc(count));
  const shortHours = items / LOCAL_JUDGE_MEASUREMENT.shortPerMinute / 60;
  const longHours = items / LOCAL_JUDGE_MEASUREMENT.longPerMinute / 60;
  const price = JUDGE_PRICES[normalizeVeniceAnalystModelId(model)];
  return { items, shortHours, longHours, localNights: shortHours / JUDGE_NIGHT_HOURS,
    recommended: shortHours > JUDGE_RECOMMENDATION_NIGHTS * JUDGE_NIGHT_HOURS ? 'venice' as const : 'local' as const,
    cloudHours: items / VENICE_JUDGE_ESTIMATE.itemsPerMinute / 60,
    cloudDollars: price ? items * (VENICE_JUDGE_ESTIMATE.inputTokensPerItem * price.input + VENICE_JUDGE_ESTIMATE.outputTokensPerItem * price.output) / 1_000_000 : null };
}

export interface JudgeSpendingStatus {
  choice: 'local' | 'venice'; capDollars: number; spentDollars: number; remainingDollars: number;
  stop: 'cap' | 'payment' | 'storage' | null;
}
export function judgeSpendingPath(env: Record<string, string | undefined>): string {
  return join(dirname(resolveClassificationLedgerPath(env)), 'judge-spending.json');
}
export function readJudgeSpending(path: string): JudgeSpendingStatus {
  try { return statusFromRow(readBudgetRow(path)); }
  catch { return { choice: 'local', capDollars: 0, spentDollars: 0, remainingDollars: 0, stop: 'storage' }; }
}
function readBudgetRow(path: string): BudgetRow {
  try { const row = JSON.parse(readFileSync(path, 'utf8')) as BudgetRow; statusFromRow(row); return row; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { choice: 'local', cap: 0, spent: 0, stop: null };
    throw new Error('The saved judge budget cannot be read. Restore the spending record or fix its file permissions; cloud judging is off.');
  }
}
interface BudgetRow { choice: 'local' | 'venice'; cap: number; spent: number; stop: 'cap' | 'payment' | null }
function statusFromRow(row: BudgetRow): JudgeSpendingStatus {
  if (!row || !['local', 'venice'].includes(row.choice) || !Number.isSafeInteger(row.cap) || !Number.isSafeInteger(row.spent) || row.cap < 0 || row.spent < 0 || ![null, 'cap', 'payment'].includes(row.stop)) throw new Error('The saved judge budget cannot be read. Cloud judging is stopped.');
  return { choice: row.choice, capDollars: row.cap / 1_000_000, spentDollars: row.spent / 1_000_000,
    remainingDollars: Math.max(0, row.cap - row.spent) / 1_000_000, stop: row.stop };
}
/** Reuse the existing kernel file lease and atomic, fsynced private-file writer.
 * They serialize reservations across processes without a new store/sidecar owner.
 * A crash or unknown transport outcome retains its reservation, never a free retry. */
export class JudgeSpending {
  constructor(private readonly path: string) {}
  status(): JudgeSpendingStatus { return readJudgeSpending(this.path); }
  private change<T>(edit: (row: BudgetRow) => T): T {
    return withFileLeaseSync(this.path, () => {
      const row = readBudgetRow(this.path);
      const result = edit(row);
      statusFromRow(row);
      writePrivateFileAtomicSync(this.path, `${JSON.stringify(row)}\n`);
      return result;
    });
  }
  choose(choice: 'local' | 'venice', capDollars: number): void {
    const cap = judgeCapMicros(capDollars);
    this.change(row => { row.choice = choice; row.cap = cap; row.stop = null; });
  }
  lowerCap(capDollars: number): void {
    const cap = judgeCapMicros(capDollars);
    this.change(row => { row.cap = Math.min(row.cap, cap); if (!row.stop && row.spent >= row.cap) row.stop = 'cap'; });
  }
  private reserve(cost: number): void {
    const stopped = this.change(row => {
      if (row.choice !== 'venice') return 'opt_in' as const;
      if (row.stop) return row.stop;
      if (row.spent + cost > row.cap) { row.stop = 'cap'; return row.stop; }
      row.spent += cost;
      return undefined;
    });
    // Use the decision made while holding the lease; a concurrent owner save
    // after its release cannot turn an unreserved call into a permitted one.
    if (stopped) throw new JudgeCloudStopped(stopped);
  }
  /** Wrap only the judge's completion transport, never answers or catalog reads. */
  fetch(fetchImpl: OpenAIAnalystFetch, onStop: () => void = () => {}): OpenAIAnalystFetch {
    return async (url, init) => {
      const body = JSON.parse(String(init.body)) as { model: string; messages: unknown; max_completion_tokens: number };
      const price = JUDGE_PRICES[normalizeVeniceAnalystModelId(body.model)];
      if (!price) throw new JudgeCloudStopped('price');
      // Byte count is a conservative input-token allowance including chat framing.
      // Reserve the full output limit before dispatch, then reconcile provider usage.
      const input = Buffer.byteLength(JSON.stringify(body.messages), 'utf8') + 64;
      const output = body.max_completion_tokens;
      if (!Number.isSafeInteger(output) || output < 0) throw new Error('The judge output allowance is missing.');
      const cost = Math.ceil(input * price.input + output * price.output);
      try { this.reserve(cost); } catch (error) { if (error instanceof JudgeCloudStopped) onStop(); throw error; }
      const response = await fetchImpl(url, init);
      if (response.status === 402) {
        this.change(row => { row.spent -= cost; row.stop = 'payment'; });
        onStop();
        throw new JudgeCloudStopped('payment');
      }
      if ([400, 401, 403, 404, 405, 413, 422, 429].includes(response.status)) {
        // A definite rejection never reached model inference. Unknown outcomes retain their hold.
        this.change(row => { row.spent -= cost; });
      }
      if (response.ok) {
        try {
          const reply = await response.clone().json() as { usage?: { prompt_tokens?: number; completion_tokens?: number } };
          const usage = reply.usage;
          if (usage && Number.isSafeInteger(usage.prompt_tokens) && Number.isSafeInteger(usage.completion_tokens)
            && usage.prompt_tokens! >= 0 && usage.completion_tokens! >= 0) {
            const actual = Math.ceil(usage.prompt_tokens! * price.input + usage.completion_tokens! * price.output);
            this.change(row => {
              row.spent += actual - cost;
              if (row.spent >= row.cap) row.stop = 'cap';
            });
          }
        } catch { /* Unknown usage retains its durable reservation. */ }
      }
      return response;
    };
  }
}

/** Transport adapters sanitize failures. Restore the content-free stop identity
 * outside that boundary so a cap or 402 never counts against an item. */
export function withJudgeSpendingStop(model: AnalystModel, status: () => JudgeSpendingStatus, onStop: () => void = () => {}): AnalystModel {
  return { complete: async request => {
    try { return await model.complete(request); }
    catch (error) {
      const current = status();
      if (current.stop) { onStop(); throw new JudgeCloudStopped(current.stop); }
      if (current.choice === 'local') { onStop(); throw new JudgeCloudStopped('opt_in'); }
      throw error;
    }
  } };
}

export function judgeCapMicros(capDollars: number): number {
  const cap = Math.round(capDollars * 1_000_000);
  if (!Number.isFinite(capDollars) || capDollars < 0 || !Number.isSafeInteger(cap)) throw new Error('Enter a spending limit in dollars.');
  return cap;
}
