/**
 * The release check's restore leg (#1065), as the owner's 1.5 plan states it: a backup made on one computer, restored into an empty
 * install on a clean one, brings back the sources, the owner's rules and the stores, judgments included; sign-ins never travel.
 *
 * The leg (run.ts prepareRestore and finishRestore) walks two journeys (journeys.ts): `backup-for-restore` on the first machine, then a second machine
 * is provisioned fresh with the candidate and `restore-clean-machine` is walked there. Between them the install's state is read on
 * each side (machine-agent.ts `snapshot-state`, as the upgrade leg reads it) and compared here. Everything here is a pure function
 * over the two snapshots, so every rule is tested without a machine.
 */
import { isDeepStrictEqual } from 'node:util';
import type { CheckResult } from './report.ts';
import { compareItems, differingPaths, itemChange, type StateSnapshot } from './upgrade.ts';

/** Where the leg puts the first machine's backup on the clean machine, for the restore journey. */
export const RESTORE_BACKUP_PATH = '~/rc/restore/release-check.olympusbackup';
/** Where the backup journey writes its backup on the first machine. */
export const RESTORE_BACKUP_FOLDER = '~/rc/restore';
/** The backup's passphrase: a fixed test value for a throwaway machine's synthetic test life, not a secret. */
export const RESTORE_PASSPHRASE = 'release check passphrase for a throwaway machine';

function check(id: string, title: string, ok: boolean, detail: string): CheckResult {
  return { id, title, status: ok ? 'pass' : 'fail', detail };
}

/** The stores the items live in: one per connected source account. */
const storesOf = (snapshot: StateSnapshot): string[] => [...new Set((snapshot.items ?? []).map((row) => row.store))].sort();

/**
 * What the restore must have brought back, comparing the first machine when its backup was made with the clean machine after the
 * restore and an engine start. The agent connection and the relay identity are the clean machine's own and are not compared.
 */
export function evaluateRestore(before: StateSnapshot, after: StateSnapshot): CheckResult[] {
  const checks: CheckResult[] = [];
  checks.push(check('restore.engine-running', 'The engine runs on the clean machine after the restore', after.engineState === 'running', `engine state ${after.engineState ?? 'unknown'}`));

  const wasStores = storesOf(before);
  const nowStores = storesOf(after);
  const lostStores = wasStores.filter((store) => !nowStores.includes(store));
  checks.push(check(
    'restore.sources',
    'Every source the first machine held is back on the clean machine',
    wasStores.length > 0 && lostStores.length === 0,
    wasStores.length === 0 ? 'the first machine held no source to restore' : lostStores.length === 0 ? `${nowStores.length} store(s): ${nowStores.join(', ')}` : `missing: ${lostStores.join(', ')}`,
  ));

  const lostRules = before.tierRuleIds.filter((id) => !after.tierRuleIds.includes(id));
  checks.push(check(
    'restore.owner-rules',
    'The owner\'s rules came back',
    before.tierRuleIds.length > 0 && lostRules.length === 0,
    before.tierRuleIds.length === 0 ? 'the first machine had no rules to restore' : lostRules.length === 0 ? `${before.tierRuleIds.length} rule(s) back` : `missing: ${lostRules.join(', ')}`,
  ));

  if (before.policy && after.policy) {
    const same = isDeepStrictEqual(before.policy.json, after.policy.json);
    checks.push(check('restore.privacy-settings', 'The owner\'s privacy settings came back as they were', same, same ? 'the privacy policy is the first machine\'s' : `differs at ${differingPaths(before.policy.json, after.policy.json).join(', ')}`));
  } else {
    checks.push(check('restore.privacy-settings', 'The owner\'s privacy settings came back as they were', false, 'the privacy policy could not be read on one of the machines'));
  }

  if (before.items && after.items) {
    const moved = compareItems(before.items, after.items);
    const same = moved.missing.length === 0 && moved.added.length === 0 && moved.changed.length === 0;
    // Each changed item names what changed, and moves still in flight on either side are said, so a move that had not landed
    // is told apart from a judgment that came back different (#1338 follow-up: one item read differently with no field named).
    const row = (items: NonNullable<StateSnapshot['items']>, key: string) => items.find((item) => `${item.store}/${item.id}` === key)!;
    const changed = moved.changed.map((key) => `${key} (${itemChange(row(before.items!, key), row(after.items!, key))})`);
    const inFlight = [before.movesInFlight ? `${before.movesInFlight} move(s) in flight when the backup was made` : '', after.movesInFlight ? `${after.movesInFlight} move(s) in flight after the restore` : ''].filter(Boolean);
    checks.push(check(
      'restore.stores',
      'The stores came back whole: the same items, in the same tiers, with the same content and judgments',
      same && before.items.length > 0,
      (same ? `${after.items.length} stored item(s) identical (tier, content digest, ledger verdicts)` : `missing ${moved.missing.join(', ') || 'none'}; new ${moved.added.join(', ') || 'none'}; changed ${changed.join(', ') || 'none'}`)
        + (inFlight.length ? `; ${inFlight.join('; ')}` : ''),
    ));
  } else {
    checks.push(check('restore.stores', 'The stores came back whole: the same items, in the same tiers, with the same content and judgments', false, `the stored items could not be read (${before.itemsError ?? after.itemsError ?? 'unknown'})`));
  }
  return checks;
}
