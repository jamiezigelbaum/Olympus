import type { AnalystBackend } from './answer-types.ts';

export type SecureAnalystPoolSelection = 'explicit_order' | 'health_latency';

export interface SecureAnalystPoolMember {
  id: string;
  backend: AnalystBackend;
}

export interface SecureAnalystPoolPlan<T extends SecureAnalystPoolMember> {
  dispatch: T[];
  breakerSkipped: T[];
}

export interface SecureAnalystPoolStateOptions {
  failureThreshold?: number;
  cooldownMs?: number;
  now?: () => number;
}

export interface SecureAnalystPoolBudgetOptions {
  sloMs?: number;
  reserveMs?: number;
  trustedAnalystTimeoutMs: number;
  localAnalystTimeoutMs: number;
}

export const DEFAULT_SECURE_ANALYST_POOL_SLO_MS = 60_000;
export const DEFAULT_SECURE_ANALYST_POOL_RESERVE_MS = 1_000;
export const DEFAULT_SECURE_ANALYST_POOL_FAILURE_THRESHOLD = 2;
export const DEFAULT_SECURE_ANALYST_POOL_COOLDOWN_MS = 30_000;
export const DEFAULT_SECURE_ANALYST_POOL_LAST_LEG_TIMEOUT_MS = 180_000;
export const MIN_SECURE_ANALYST_POOL_LAST_LEG_TIMEOUT_MS = 30_000;
export const MAX_SECURE_ANALYST_POOL_LAST_LEG_TIMEOUT_MS = 240_000;
export const SECURE_ANALYST_POOL_LAST_LEG_TIMEOUT_ENV =
  'OLYMPUS_SOURCE_ANSWER_LAST_LEG_TIMEOUT_MS';

interface MemberHealth {
  consecutiveFailures: number;
  cooldownUntilMs: number;
  recentLatencyMs?: number;
}

// Worker-local state only: no content, questions, answers, source identifiers,
// or errors are retained. Pool members are keyed solely by configured profile
// id and trust-domain pool id.
export class SecureAnalystPoolState {
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly health = new Map<string, MemberHealth>();
  private readonly tieBreakCursor = new Map<string, number>();

  constructor(options: SecureAnalystPoolStateOptions = {}) {
    this.failureThreshold = positiveInteger(
      options.failureThreshold,
      DEFAULT_SECURE_ANALYST_POOL_FAILURE_THRESHOLD,
    );
    this.cooldownMs = nonNegativeInteger(
      options.cooldownMs,
      DEFAULT_SECURE_ANALYST_POOL_COOLDOWN_MS,
    );
    this.now = options.now ?? Date.now;
  }

  plan<T extends SecureAnalystPoolMember>(
    poolId: string,
    members: readonly T[],
    selection: SecureAnalystPoolSelection,
  ): SecureAnalystPoolPlan<T> {
    const nowMs = this.now();
    const dispatch: T[] = [];
    const breakerSkipped: T[] = [];
    for (const member of members) {
      const health = this.memberHealth(poolId, member.id);
      if (
        health.consecutiveFailures >= this.failureThreshold
        && nowMs < health.cooldownUntilMs
      ) {
        breakerSkipped.push(member);
        continue;
      }
      if (
        health.consecutiveFailures >= this.failureThreshold
        && nowMs >= health.cooldownUntilMs
      ) {
        // Cooldown expiry closes the breaker for a bounded half-open attempt.
        health.consecutiveFailures = 0;
        health.cooldownUntilMs = 0;
      }
      dispatch.push(member);
    }

    if (selection === 'explicit_order' || dispatch.length < 2) {
      return { dispatch, breakerSkipped };
    }

    const canonical = [...dispatch].sort((left, right) => left.id.localeCompare(right.id));
    const cursor = (this.tieBreakCursor.get(poolId) ?? 0) % canonical.length;
    this.tieBreakCursor.set(poolId, cursor + 1);
    const tieRank = new Map(
      canonical.map((member, index) => [
        member.id,
        (index - cursor + canonical.length) % canonical.length,
      ]),
    );
    dispatch.sort((left, right) => {
      const leftHealth = this.memberHealth(poolId, left.id);
      const rightHealth = this.memberHealth(poolId, right.id);
      if (leftHealth.consecutiveFailures !== rightHealth.consecutiveFailures) {
        return leftHealth.consecutiveFailures - rightHealth.consecutiveFailures;
      }
      // Unknown members get one exploration turn before known latency wins.
      const leftLatency = leftHealth.recentLatencyMs ?? -1;
      const rightLatency = rightHealth.recentLatencyMs ?? -1;
      if (leftLatency !== rightLatency) return leftLatency - rightLatency;
      return (tieRank.get(left.id) ?? 0) - (tieRank.get(right.id) ?? 0);
    });
    return { dispatch, breakerSkipped };
  }

  recordSuccess(poolId: string, memberId: string, elapsedMs: number): void {
    const health = this.memberHealth(poolId, memberId);
    health.consecutiveFailures = 0;
    health.cooldownUntilMs = 0;
    const latencyMs = nonNegativeInteger(elapsedMs, 0);
    health.recentLatencyMs = health.recentLatencyMs === undefined
      ? latencyMs
      : Math.round(health.recentLatencyMs * 0.7 + latencyMs * 0.3);
  }

  recordFailure(poolId: string, memberId: string): void {
    const health = this.memberHealth(poolId, memberId);
    health.consecutiveFailures += 1;
    if (health.consecutiveFailures >= this.failureThreshold) {
      health.cooldownUntilMs = this.now() + this.cooldownMs;
    }
  }

  private memberHealth(poolId: string, memberId: string): MemberHealth {
    const key = `${poolId}\u0000${memberId}`;
    const existing = this.health.get(key);
    if (existing) return existing;
    const created: MemberHealth = { consecutiveFailures: 0, cooldownUntilMs: 0 };
    this.health.set(key, created);
    return created;
  }
}

// Every secure-pool member receives an equal share before backend-specific
// safety ceilings are applied. These remain the non-final sprint budgets; the
// dispatcher replaces only the last available leg with its completion budget.
export function deriveSecureAnalystPoolLegBudgets<T extends SecureAnalystPoolMember>(
  members: readonly T[],
  options: SecureAnalystPoolBudgetOptions,
): Map<string, number> {
  const result = new Map<string, number>();
  if (members.length === 0) return result;
  const sloMs = positiveInteger(options.sloMs, DEFAULT_SECURE_ANALYST_POOL_SLO_MS);
  const reserveMs = Math.min(
    Math.max(1, nonNegativeInteger(options.reserveMs, DEFAULT_SECURE_ANALYST_POOL_RESERVE_MS)),
    Math.max(1, sloMs - 1),
  );
  const poolBudgetMs = Math.max(1, sloMs - reserveMs);
  const baseShareMs = Math.max(1, Math.floor(poolBudgetMs / members.length));
  let remainderMs = Math.max(0, poolBudgetMs - baseShareMs * members.length);
  for (const member of members) {
    const fairShareMs = baseShareMs + (remainderMs > 0 ? 1 : 0);
    remainderMs = Math.max(0, remainderMs - 1);
    const backendCeilingMs = member.backend === 'local'
      ? options.localAnalystTimeoutMs
      : member.backend === 'venice'
        ? options.trustedAnalystTimeoutMs
        : fairShareMs;
    const budgetMs = Number.isFinite(backendCeilingMs) && backendCeilingMs > 0
      ? Math.min(fairShareMs, Math.floor(backendCeilingMs))
      : fairShareMs;
    result.set(member.id, Math.max(1, budgetMs));
  }
  return result;
}

export function parseSecureAnalystPoolLastLegTimeoutMs(
  value: string | undefined,
  name = SECURE_ANALYST_POOL_LAST_LEG_TIMEOUT_ENV,
): number {
  if (value === undefined || value.trim().length === 0) {
    return DEFAULT_SECURE_ANALYST_POOL_LAST_LEG_TIMEOUT_MS;
  }
  const parsed = Number(value);
  if (
    !Number.isInteger(parsed)
    || parsed < MIN_SECURE_ANALYST_POOL_LAST_LEG_TIMEOUT_MS
    || parsed > MAX_SECURE_ANALYST_POOL_LAST_LEG_TIMEOUT_MS
  ) {
    throw new Error(
      `${name} must be an integer from ${MIN_SECURE_ANALYST_POOL_LAST_LEG_TIMEOUT_MS} ` +
      `through ${MAX_SECURE_ANALYST_POOL_LAST_LEG_TIMEOUT_MS} milliseconds.`,
    );
  }
  return parsed;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(1, Math.floor(value));
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return fallback;
  return Math.max(0, Math.floor(value));
}
