// Retired store-placement sweep. Items are re-judged automatically by content
// on upgrade (#599, #606); a secure store row cannot claim an ordinary copy.
import { resolvedStorePath } from '../src/core/source-placement.ts';

const DEFAULT_BATCH_ITEMS = 1_000;
// Parse historical invocations so old runbooks receive the retirement message.
const DEFAULT_MAX_WINDOWS = 10_000;
const USAGE = 'Usage: bun run telegram:trust-reconcile '
  + '[--internal-db <path>] [--protected-db <path>] [--max-items N] [--max-windows N] [--execute]';

export interface TelegramTrustReconcileCliArgs {
  internalDb: string;
  protectedDb: string;
  maxItems: number;
  maxWindows: number;
  execute: boolean;
}

export function parseTelegramTrustReconcileCliArgs(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
): TelegramTrustReconcileCliArgs {
  let internalDb = resolvedStorePath('telegram.messages', 'internal', env);
  let protectedDb = resolvedStorePath('telegram.messages', 'secure_local', env);
  let maxItems = DEFAULT_BATCH_ITEMS;
  let maxWindows = DEFAULT_MAX_WINDOWS;
  let execute = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    const value = (): string => {
      const next = argv[index + 1]?.trim();
      if (!next) throw new Error(`${flag} requires a value. ${USAGE}`);
      index += 1;
      return next;
    };
    const bounded = (limit: number): number => {
      const parsed = Number(value());
      if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > limit) {
        throw new Error(`${flag} must be an integer between 1 and ${limit.toLocaleString('en-US')}.`);
      }
      return parsed;
    };
    if (flag === '--internal-db') internalDb = value();
    else if (flag === '--protected-db') protectedDb = value();
    else if (flag === '--max-items') maxItems = bounded(10_000);
    else if (flag === '--max-windows') maxWindows = bounded(100_000);
    else if (flag === '--execute') execute = true;
    else throw new Error(`Unknown flag ${flag}. ${USAGE}`);
  }
  return { internalDb, protectedDb, maxItems, maxWindows, execute };
}

export function runTelegramTrustReconcile(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
): never {
  parseTelegramTrustReconcileCliArgs(argv, env);
  throw new Error('Telegram trust reconciliation is retired. Olympus automatically re-judges retired source-prior items by content; store placement is not a privacy rule.');
}

if (import.meta.main) {
  try { runTelegramTrustReconcile(process.argv.slice(2)); }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
