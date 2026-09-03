import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const DEFAULT_BASE_URL = 'https://api.venice.ai/api/v1';
const DEFAULT_TIMEOUT_MS = 15_000;
const USAGE_PAGE_LIMIT = 500;
const USAGE_LOOKBACK_DAYS = 16;
const BUNDLED_CREDITS = 'BUNDLED_CREDITS';

export type VeniceCreditMonitorStatus =
  | 'ok'
  | 'credit_exhausted'
  | 'not_configured'
  | 'auth_failed'
  | 'rate_limited'
  | 'unavailable';

export type VeniceSkuFamily = 'vision_extraction' | 'secure_answers' | 'other';

export interface VeniceUsageAggregate {
  start_at: string;
  end_at: string;
  spend: number;
  entry_count: number;
  by_sku_family: Record<VeniceSkuFamily, { spend: number; entry_count: number }>;
}

export interface VeniceBundledCreditUsage {
  endpoint: 'billing/usage';
  currency: 'BUNDLED_CREDITS';
  status: 'ok' | 'unavailable';
  pages_fetched: number;
  entries_scanned: number;
  trailing_24h: VeniceUsageAggregate | null;
  current_billing_cycle: (VeniceUsageAggregate & {
    derivation: 'bundled_credit_allocation';
  }) | null;
  cycle_derivation: 'bundled_credit_allocation' | 'unavailable';
  error_kind?: string;
  error_message?: string;
}

export interface VeniceCreditStatusReport {
  kind: 'venice_credit_status';
  generated_at: string;
  provider: 'venice';
  endpoint: 'billing/balance';
  usage_endpoint: 'billing/usage';
  status: VeniceCreditMonitorStatus;
  can_consume: boolean | null;
  consumption_currency: string | null;
  balances: Record<string, number>;
  diem_epoch_allocation: number | null;
  bundled_credits_usage: VeniceBundledCreditUsage;
  error_kind?: string;
  error_message?: string;
  policy: {
    api_key_exposed: false;
    source_text_returned: false;
    billing_probe_only: true;
    pause_authority: 'billing/balance.canConsume';
  };
  actions: string[];
}

interface VeniceBalanceResponse {
  canConsume?: unknown;
  consumptionCurrency?: unknown;
  balances?: unknown;
  diemEpochAllocation?: unknown;
}

interface VeniceUsageEntry {
  timestamp?: unknown;
  sku?: unknown;
  amount?: unknown;
  currency?: unknown;
  notes?: unknown;
}

interface VeniceUsageResponse {
  data?: unknown;
  pagination?: {
    page?: unknown;
    totalPages?: unknown;
  };
}

type VeniceCreditFetch = (url: string, init: RequestInit) => Promise<Response>;

interface FetchVeniceCreditStatusOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: VeniceCreditFetch;
  now?: Date;
  baseUrl?: string;
  timeoutMs?: number;
}

interface UsageLedgerResult {
  usage: VeniceBundledCreditUsage;
  entries: VeniceUsageEntry[];
}

export async function fetchVeniceCreditStatus(
  options: FetchVeniceCreditStatusOptions = {},
): Promise<VeniceCreditStatusReport> {
  const env = options.env ?? process.env;
  const generatedAt = options.now ?? new Date();
  const apiKey = veniceApiKeyFromEnv(env);
  if (!apiKey) {
    return buildReport({
      generatedAt,
      status: 'not_configured',
      errorKind: 'venice_billing_api_key_missing',
      errorMessage: 'Venice credit monitor has no API key environment variable configured.',
    });
  }

  const baseUrl = trimTrailingSlash(options.baseUrl ?? env.OLYMPUS_VENICE_CREDIT_STATUS_BASE_URL ?? DEFAULT_BASE_URL);
  const timeoutMs = positiveInt(
    env.OLYMPUS_VENICE_CREDIT_STATUS_TIMEOUT_MS,
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const fetchImpl: VeniceCreditFetch = options.fetchImpl ?? ((url, init) => fetch(url, init));
    const requestInit: RequestInit = {
      method: 'GET',
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: 'application/json',
      },
      signal: controller.signal,
    };
    const response = await fetchImpl(`${baseUrl}/billing/balance`, requestInit);
    if (!response.ok) return buildHttpErrorReport(generatedAt, response.status, 'balance');

    const body = await response.json() as VeniceBalanceResponse;
    const usageResult = await fetchBundledCreditUsage({
      baseUrl,
      generatedAt,
      fetchImpl,
      requestInit,
    });
    return buildBalanceReport(generatedAt, body, usageResult.usage);
  } catch (error) {
    return buildReport({
      generatedAt,
      status: 'unavailable',
      errorKind: 'venice_billing_probe_failed',
      errorMessage: safeErrorMessage(error),
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBundledCreditUsage(input: {
  baseUrl: string;
  generatedAt: Date;
  fetchImpl: VeniceCreditFetch;
  requestInit: RequestInit;
}): Promise<UsageLedgerResult> {
  const lookbackStart = new Date(input.generatedAt.getTime() - USAGE_LOOKBACK_DAYS * 24 * 60 * 60 * 1_000);
  const entries: VeniceUsageEntry[] = [];
  let page = 1;
  let totalPages = 1;
  try {
    do {
      const url = new URL(`${input.baseUrl}/billing/usage`);
      url.searchParams.set('currency', BUNDLED_CREDITS);
      url.searchParams.set('startDate', lookbackStart.toISOString());
      url.searchParams.set('endDate', input.generatedAt.toISOString());
      url.searchParams.set('limit', String(USAGE_PAGE_LIMIT));
      url.searchParams.set('page', String(page));
      url.searchParams.set('sortOrder', 'desc');
      const response = await input.fetchImpl(url.toString(), input.requestInit);
      if (!response.ok) {
        return {
          entries: [],
          usage: unavailableUsage(
            `venice_billing_usage_http_${response.status}`,
            `Venice billing usage returned HTTP ${response.status}.`,
            page - 1,
          ),
        };
      }
      const body = await response.json() as VeniceUsageResponse;
      if (!Array.isArray(body.data)) {
        return {
          entries: [],
          usage: unavailableUsage('venice_billing_usage_invalid_response', 'Venice billing usage returned no data array.', page),
        };
      }
      entries.push(...body.data.filter(isRecord));
      totalPages = positiveNumber(body.pagination?.totalPages) ?? page;
      page += 1;
    } while (page <= totalPages);

    return {
      entries,
      usage: aggregateBundledCreditUsage(entries, input.generatedAt, page - 1),
    };
  } catch (error) {
    return {
      entries: [],
      usage: unavailableUsage('venice_billing_usage_probe_failed', safeErrorMessage(error), page - 1),
    };
  }
}

export function aggregateBundledCreditUsage(
  entries: VeniceUsageEntry[],
  generatedAt: Date,
  pagesFetched = 1,
): VeniceBundledCreditUsage {
  const bundledEntries = entries.filter((entry) => normalizedString(entry.currency)?.toUpperCase() === BUNDLED_CREDITS);
  const trailingStart = new Date(generatedAt.getTime() - 24 * 60 * 60 * 1_000);
  const allocation = bundledEntries
    .filter(isBundledCreditAllocation)
    .map((entry) => ({ entry, timestamp: dateValue(entry.timestamp) }))
    .filter((value): value is { entry: VeniceUsageEntry; timestamp: Date } => value.timestamp !== null)
    .sort((left, right) => right.timestamp.getTime() - left.timestamp.getTime())[0];
  const cycle = allocation
    ? {
        ...aggregateUsageWindow(bundledEntries, allocation.timestamp, generatedAt),
        derivation: 'bundled_credit_allocation' as const,
      }
    : null;
  return {
    endpoint: 'billing/usage',
    currency: BUNDLED_CREDITS,
    status: 'ok',
    pages_fetched: pagesFetched,
    entries_scanned: entries.length,
    trailing_24h: aggregateUsageWindow(bundledEntries, trailingStart, generatedAt),
    current_billing_cycle: cycle,
    cycle_derivation: cycle ? 'bundled_credit_allocation' : 'unavailable',
  };
}

function aggregateUsageWindow(entries: VeniceUsageEntry[], start: Date, end: Date): VeniceUsageAggregate {
  const aggregate = emptyUsageAggregate(start, end);
  for (const entry of entries) {
    const timestamp = dateValue(entry.timestamp);
    if (!timestamp || timestamp < start || timestamp > end) continue;
    const amount = numberValue(entry.amount);
    if (amount === null || amount >= 0) continue;
    const spend = -amount;
    const family = skuFamily(normalizedString(entry.sku) ?? '');
    aggregate.spend += spend;
    aggregate.entry_count += 1;
    aggregate.by_sku_family[family].spend += spend;
    aggregate.by_sku_family[family].entry_count += 1;
  }
  roundUsageAggregate(aggregate);
  return aggregate;
}

function emptyUsageAggregate(start: Date, end: Date): VeniceUsageAggregate {
  return {
    start_at: start.toISOString(),
    end_at: end.toISOString(),
    spend: 0,
    entry_count: 0,
    by_sku_family: {
      vision_extraction: { spend: 0, entry_count: 0 },
      secure_answers: { spend: 0, entry_count: 0 },
      other: { spend: 0, entry_count: 0 },
    },
  };
}

function roundUsageAggregate(aggregate: VeniceUsageAggregate): void {
  aggregate.spend = roundCreditAmount(aggregate.spend);
  for (const family of Object.values(aggregate.by_sku_family)) family.spend = roundCreditAmount(family.spend);
}

function skuFamily(sku: string): VeniceSkuFamily {
  const normalized = sku.toLowerCase();
  if (normalized.startsWith('grok-4-')) return 'vision_extraction';
  if (normalized.startsWith('e2ee-glm-')) return 'secure_answers';
  return 'other';
}

function isBundledCreditAllocation(entry: VeniceUsageEntry): boolean {
  const amount = numberValue(entry.amount);
  if (amount === null || amount <= 0) return false;
  const notes = normalizedString(entry.notes)?.toLowerCase() ?? '';
  return /allocat|renew|rollover|subscription|credit/.test(notes);
}

export function buildBalanceReport(
  generatedAt: Date,
  body: VeniceBalanceResponse,
  bundledCreditUsage?: VeniceBundledCreditUsage,
): VeniceCreditStatusReport {
  const canConsume = typeof body.canConsume === 'boolean' ? body.canConsume : null;
  const consumptionCurrency = normalizedString(body.consumptionCurrency);
  const balances = normalizeBalances(body.balances);
  const diemEpochAllocation = numberValue(body.diemEpochAllocation);
  return buildReport({
    generatedAt,
    status: canConsume === false ? 'credit_exhausted' : 'ok',
    canConsume,
    consumptionCurrency,
    balances,
    diemEpochAllocation,
    ...(bundledCreditUsage ? { bundledCreditUsage } : {}),
  });
}

function buildHttpErrorReport(generatedAt: Date, status: number, endpoint: 'balance'): VeniceCreditStatusReport {
  if (status === 401 || status === 403) {
    return buildReport({
      generatedAt,
      status: 'auth_failed',
      errorKind: `venice_billing_http_${status}`,
      errorMessage: `Venice billing ${endpoint} rejected the configured API key.`,
    });
  }
  if (status === 402) {
    return buildReport({
      generatedAt,
      status: 'credit_exhausted',
      canConsume: false,
      errorKind: 'venice_billing_http_402',
      errorMessage: `Venice billing ${endpoint} reported credit/payment exhaustion.`,
    });
  }
  if (status === 429) {
    return buildReport({
      generatedAt,
      status: 'rate_limited',
      errorKind: 'venice_billing_http_429',
      errorMessage: `Venice billing ${endpoint} is rate limited.`,
    });
  }
  return buildReport({
    generatedAt,
    status: 'unavailable',
    errorKind: `venice_billing_http_${status}`,
    errorMessage: `Venice billing ${endpoint} returned HTTP ${status}.`,
  });
}

function buildReport(input: {
  generatedAt: Date;
  status: VeniceCreditMonitorStatus;
  canConsume?: boolean | null;
  consumptionCurrency?: string | null;
  balances?: Record<string, number>;
  diemEpochAllocation?: number | null;
  bundledCreditUsage?: VeniceBundledCreditUsage;
  errorKind?: string;
  errorMessage?: string;
}): VeniceCreditStatusReport {
  const report: VeniceCreditStatusReport = {
    kind: 'venice_credit_status',
    generated_at: input.generatedAt.toISOString(),
    provider: 'venice',
    endpoint: 'billing/balance',
    usage_endpoint: 'billing/usage',
    status: input.status,
    can_consume: input.canConsume ?? null,
    consumption_currency: input.consumptionCurrency ?? null,
    balances: input.balances ?? {},
    diem_epoch_allocation: input.diemEpochAllocation ?? null,
    bundled_credits_usage: input.bundledCreditUsage ?? unavailableUsage('venice_billing_usage_not_fetched', 'Venice billing usage was not fetched.'),
    ...(input.errorKind ? { error_kind: input.errorKind } : {}),
    ...(input.errorMessage ? { error_message: input.errorMessage } : {}),
    policy: {
      api_key_exposed: false,
      source_text_returned: false,
      billing_probe_only: true,
      pause_authority: 'billing/balance.canConsume',
    },
    actions: [],
  };
  report.actions = actionsForReport(report);
  return report;
}

function unavailableUsage(errorKind: string, errorMessage: string, pagesFetched = 0): VeniceBundledCreditUsage {
  return {
    endpoint: 'billing/usage',
    currency: BUNDLED_CREDITS,
    status: 'unavailable',
    pages_fetched: pagesFetched,
    entries_scanned: 0,
    trailing_24h: null,
    current_billing_cycle: null,
    cycle_derivation: 'unavailable',
    error_kind: errorKind,
    error_message: errorMessage,
  };
}

function actionsForReport(report: VeniceCreditStatusReport): string[] {
  const actions: string[] = [];
  if (report.status === 'credit_exhausted') {
    actions.push('venice: billing/balance.canConsume is false; keep escalation paused until credits are refilled, then clear the provider pause marker and restart Venice timers.');
  } else if (report.status === 'not_configured') {
    actions.push('venice: credit monitor is not configured; provide OLYMPUS_SOURCE_INDEX_VENICE_API_KEY through the private-host runtime secret wrapper.');
  } else if (report.status === 'auth_failed') {
    actions.push('venice: billing balance rejected the API key; repair the Venice credential before resuming escalation.');
  } else if (report.status === 'rate_limited') {
    actions.push('venice: billing balance probe is rate limited; keep the last known credit state and retry on the next monitor tick.');
  } else if (report.status === 'unavailable') {
    actions.push('venice: billing balance probe is unavailable; keep the last known credit state and retry on the next monitor tick.');
  }
  if (report.status === 'ok' && report.bundled_credits_usage.status === 'unavailable') {
    actions.push('venice: bundled-credit usage is unavailable; canConsume remains the pause authority and usage will retry on the next monitor tick.');
  }
  return actions;
}

function normalizeBalances(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object') return {};
  const output: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const number = numberValue(raw);
    if (number !== null) output[key.toLowerCase()] = number;
  }
  return output;
}

function veniceApiKeyFromEnv(env: Record<string, string | undefined>): string | undefined {
  return firstNonEmptyEnv(env, [
    'OLYMPUS_SOURCE_INDEX_VENICE_API_KEY',
    'OLYMPUS_VENICE_API_KEY',
    'VENICE_API_KEY',
    'API_KEY_VENICE',
  ]);
}

function firstNonEmptyEnv(env: Record<string, string | undefined>, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function normalizedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function positiveNumber(value: unknown): number | null {
  const parsed = numberValue(value);
  return parsed !== null && Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function dateValue(value: unknown): Date | null {
  const raw = normalizedString(value);
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isRecord(value: unknown): value is VeniceUsageEntry {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function roundCreditAmount(value: number): number {
  return Math.round((value + Number.EPSILON) * 1e8) / 1e8;
}

function positiveInt(value: string | undefined, defaultValue: number): number {
  if (value === undefined || value.trim().length === 0) return defaultValue;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : defaultValue;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error && error.message.trim() ? error.message.trim() : 'unknown Venice billing probe failure';
  return message.length > 300 ? `${message.slice(0, 300)}...truncated` : message;
}

function parseArgs(argv: string[]): {
  reportPath?: string;
  pauseFile?: string;
  text: boolean;
} {
  const options: { reportPath?: string; pauseFile?: string; text: boolean } = { text: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const next = () => {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value.`);
      index += 1;
      return value;
    };
    if (arg === '--report') options.reportPath = next();
    else if (arg === '--pause-file') options.pauseFile = next();
    else if (arg === '--text') options.text = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function writeReport(path: string, report: VeniceCreditStatusReport): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
}

function writeProviderPause(path: string, report: VeniceCreditStatusReport): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({
    active: true,
    kind: 'venice',
    reason: 'provider_credit_exhausted',
    error_kind: report.error_kind ?? 'venice_billing_credit_exhausted',
    created_at: report.generated_at,
    message: 'Venice escalation paused because billing/balance.canConsume is false. Refill Venice credits, remove this marker, then restart Venice escalation timers.',
  }, null, 2)}\n`);
}

export function reconcileProviderPauseFile(path: string, report: VeniceCreditStatusReport): 'written' | 'cleared' | 'left' {
  if (report.can_consume === false) {
    writeProviderPause(path, report);
    return 'written';
  }
  if (report.status === 'ok' && report.can_consume === true && isVeniceProviderPauseFile(path)) {
    unlinkSync(path);
    return 'cleared';
  }
  return 'left';
}

function isVeniceProviderPauseFile(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { kind?: unknown };
    return raw.kind === 'venice';
  } catch {
    return false;
  }
}

export function formatTextReport(report: VeniceCreditStatusReport): string {
  const usd = report.balances.usd === undefined ? 'n/a' : report.balances.usd.toFixed(2);
  const diem = report.balances.diem === undefined ? 'n/a' : report.balances.diem.toFixed(2);
  const trailing = report.bundled_credits_usage.trailing_24h;
  const cycle = report.bundled_credits_usage.current_billing_cycle;
  return [
    `venice_credit_status=${report.status}`,
    `can_consume=${report.can_consume ?? 'unknown'}`,
    `currency=${report.consumption_currency ?? 'unknown'}`,
    `usd=${usd}`,
    `diem=${diem}`,
    `bundled_24h=${trailing ? trailing.spend.toFixed(4) : 'unavailable'}`,
    `vision_24h=${trailing ? trailing.by_sku_family.vision_extraction.spend.toFixed(4) : 'unavailable'}`,
    `secure_24h=${trailing ? trailing.by_sku_family.secure_answers.spend.toFixed(4) : 'unavailable'}`,
    `bundled_cycle=${cycle ? cycle.spend.toFixed(4) : 'unavailable'}`,
    `cycle_start=${cycle?.start_at ?? 'unavailable'}`,
  ].join(' ');
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  const report = await fetchVeniceCreditStatus();
  const reportPath = args.reportPath ?? process.env.OLYMPUS_VENICE_CREDIT_STATUS_REPORT_PATH;
  const pauseFile = args.pauseFile ?? process.env.OLYMPUS_VENICE_CREDIT_STATUS_PROVIDER_PAUSE_FILE;
  if (reportPath) writeReport(reportPath, report);
  if (pauseFile) reconcileProviderPauseFile(pauseFile, report);
  console.log(args.text ? formatTextReport(report) : JSON.stringify(report, null, 2));
  if (report.status === 'auth_failed' || report.status === 'unavailable') process.exitCode = 1;
}
