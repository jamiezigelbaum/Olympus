import { existsSync, readFileSync } from 'node:fs';
import { withFileLeaseSync } from '../../core/file-lease.ts';
import { writePrivateFileAtomicSync } from '../../core/atomic-file.ts';
import { JudgeCloudStopped } from './sniffer.ts';
import { dirname, join } from 'node:path';
import { resolveClassificationLedgerPath } from '../classification-ledger.ts';
import type { AnalystModel } from '../../core/analyst.ts';
import type { OpenAIAnalystFetch } from '../../core/analyst-openai.ts';
import { normalizeVeniceAnalystModelId } from '../../core/venice-models.ts';

export { JudgeCloudStopped } from './sniffer.ts';

/**
 * Venice's default privacy judge (#1252, owner decision 2026-11-10): the
 * model that measured best on the owner's labels (#883, the 5 Nov set), not
 * the model the owner picked for Private answers. A Venice profile declared
 * with purpose "classification" still wins. Private tier, temperature 0 (#1237).
 */
export const DEFAULT_VENICE_JUDGE_MODEL = 'deepseek-v4-flash-0731';

// USD per million tokens. One dated authority for both setup and dispatch.
// https://github.com/veniceai/api-docs/blob/main/models/text.mdx
export const JUDGE_PRICE_DATE = '2026-11-10';
export const JUDGE_PRICES: Readonly<Record<string, { input: number; output: number }>> = Object.freeze({
  'deepseek-v4-flash-0731': { input: 0.13, output: 0.26 },
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
/** #891's simulation on the owner's labels: the cautious 4B held about 16% of items Private. */
export const SECOND_ROUND_HELD_ASSUMPTION = 0.16;
/** What this install measured itself (judge-second-round.ts); absent until there are enough samples. */
export interface JudgeObserved { localItemsPerMinute?: number; heldFraction?: number }
export function judgeArchiveEstimate(count: number, model: string, observed: JudgeObserved = {}) {
  const items = Math.max(0, Math.trunc(count));
  const shortHours = items / LOCAL_JUDGE_MEASUREMENT.shortPerMinute / 60;
  const longHours = items / LOCAL_JUDGE_MEASUREMENT.longPerMinute / 60;
  const measuredHours = observed.localItemsPerMinute ? items / observed.localItemsPerMinute / 60 : undefined;
  const price = JUDGE_PRICES[normalizeVeniceAnalystModelId(model)];
  const cloudDollars = price ? items * (VENICE_JUDGE_ESTIMATE.inputTokensPerItem * price.input + VENICE_JUDGE_ESTIMATE.outputTokensPerItem * price.output) / 1_000_000 : null;
  const heldFraction = observed.heldFraction ?? SECOND_ROUND_HELD_ASSUMPTION;
  const secondRoundItems = Math.ceil(items * heldFraction);
  return { items, shortHours, longHours, localNights: (measuredHours ?? shortHours) / JUDGE_NIGHT_HOURS,
    ...(measuredHours !== undefined ? { measuredHours, measuredPerMinute: observed.localItemsPerMinute! } : {}),
    recommended: (measuredHours ?? shortHours) > JUDGE_RECOMMENDATION_NIGHTS * JUDGE_NIGHT_HOURS ? 'venice' as const : 'local' as const,
    cloudHours: items / VENICE_JUDGE_ESTIMATE.itemsPerMinute / 60,
    cloudDollars,
    secondRound: { items: secondRoundItems, heldFraction, observed: observed.heldFraction !== undefined,
      hours: secondRoundItems / VENICE_JUDGE_ESTIMATE.itemsPerMinute / 60,
      dollars: cloudDollars === null ? null : items === 0 ? 0 : cloudDollars * secondRoundItems / items } };
}
/** With no estimate to go on, the limit starts small; the owner can raise it. */
export const JUDGE_DEFAULT_CAP_FLOOR_DOLLARS = 5;
/** The limit a Venice choice starts with when the owner has not set one: the estimate plus 25%, rounded up to the dollar. */
export function judgeDefaultCapDollars(estimateDollars: number | null): number {
  return estimateDollars === null ? JUDGE_DEFAULT_CAP_FLOOR_DOLLARS : Math.max(1, Math.ceil(estimateDollars * 1.25));
}
/** Whether a choice sends anything to Venice. */
export function judgeChoiceUsesVenice(choice: JudgeChoice): boolean { return choice !== 'local'; }
/** local: the free judge on this computer. local-then-venice: it judges everything, and Venice
 * double-checks only what it held Private (#891). venice: Venice judges everything. */
export type JudgeChoice = 'local' | 'local-then-venice' | 'venice';
export const JUDGE_CHOICES: readonly JudgeChoice[] = ['local', 'local-then-venice', 'venice'];

export interface JudgeSpendingStatus {
  choice: JudgeChoice; capDollars: number; spentDollars: number; remainingDollars: number;
  stop: 'cap' | 'payment' | 'storage' | null;
  /** Approved before limits existed: keeps judging, no cap, until the owner sets one. */
  uncapped?: boolean;
  upgradeNote?: boolean;
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
interface BudgetRow { choice: JudgeChoice; cap: number; spent: number; stop: 'cap' | 'payment' | null; uncapped?: true; noted?: true }
function statusFromRow(row: BudgetRow): JudgeSpendingStatus {
  if (!row || !JUDGE_CHOICES.includes(row.choice) || !Number.isSafeInteger(row.cap) || !Number.isSafeInteger(row.spent) || row.cap < 0 || row.spent < 0 || ![null, 'cap', 'payment'].includes(row.stop) || ![undefined, true].includes(row.uncapped)) throw new Error('The saved judge budget cannot be read. Cloud judging is stopped.');
  return { choice: row.choice, capDollars: row.cap / 1_000_000, spentDollars: row.spent / 1_000_000,
    remainingDollars: Math.max(0, row.cap - row.spent) / 1_000_000, stop: row.stop, ...(row.uncapped ? { uncapped: true } : {}) };
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
  choose(choice: JudgeChoice, capDollars: number): void {
    const cap = judgeCapMicros(capDollars);
    this.change(row => { row.choice = choice; row.cap = cap; row.stop = null; delete row.uncapped; delete row.noted; });
  }
  /** Upgrade only: an approval given before this record existed was the owner's
   * opt-in. Any later saved choice exists as a file, so this never overrides it. */
  adoptExistingApproval(): void {
    withFileLeaseSync(this.path, () => {
      if (existsSync(this.path)) return;
      writePrivateFileAtomicSync(this.path, `${JSON.stringify({ choice: 'venice', cap: 0, spent: 0, stop: null, uncapped: true } satisfies BudgetRow)}\n`);
    });
  }
  hasRecord(): boolean { return existsSync(this.path); }
  /** True once, for the page that shows the note. */
  takeUpgradeNote(): boolean {
    if (!this.status().uncapped) return false;
    return this.change(row => { const show = row.uncapped === true && !row.noted; if (show) row.noted = true; return show; });
  }
  lowerCap(capDollars: number): void {
    const cap = judgeCapMicros(capDollars);
    this.change(row => { row.cap = Math.min(row.cap, cap); if (!row.stop && row.spent >= row.cap) row.stop = 'cap'; });
  }
  private reserve(cost: number): void {
    const stopped = this.change(row => {
      if (!judgeChoiceUsesVenice(row.choice)) return 'opt_in' as const;
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
      // No limit set yet: exactly the calls this install made before limits existed.
      if (this.status().uncapped) return fetchImpl(url, init);
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
