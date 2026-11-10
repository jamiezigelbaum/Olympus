import { approveClassifier, isClassifierApproved, readClassificationLedger, revokeClassifier } from '../classification-ledger.ts';
import { resolveTierSnifferRuntime, type TierSnifferRuntime } from './built-in-sniffer.ts';
import type { SnifferLane } from './sniffer-lane.ts';
import { JudgeSpending, judgeCapMicros, judgeChoiceUsesVenice, JUDGE_PRICES, type JudgeChoice, type JudgeObserved } from './judge-spending.ts';
import { SecondRoundSweep } from './judge-second-round.ts';
import { normalizeVeniceAnalystModelId } from '../../core/venice-models.ts';

/** Existing installs are never re-asked: when the lane this install would use
 * without any saved choice is Venice, and that exact lane is approved, the
 * approval is the owner's opt-in. An old Venice approval on an install that
 * now judges locally is not: it stays local. New choices stay local too. */
export async function adoptExistingCloudApproval(spending: JudgeSpending, input: Parameters<typeof resolveTierSnifferRuntime>[0], ledgerPath: string, promptVersion: string): Promise<void> {
  if (spending.hasRecord()) return;
  const active = resolveTierSnifferRuntime(input);
  if (active.source === 'off' || active.lane.kind !== 'venice') return;
  const { entries } = await readClassificationLedger(ledgerPath);
  if (isClassifierApproved(entries, { lane: active.lane.kind, profileId: active.lane.profileId, modelId: active.lane.modelId, promptVersion })) spending.adoptExistingApproval();
}

/** The local screen uses the CLI's exact-model approval ledger. Opting out
 * takes effect before any optional local-model approval or worker reload. */
export function createJudgeSetup(options: {
  spending: JudgeSpending;
  cloud: TierSnifferRuntime;
  local: () => TierSnifferRuntime;
  ledgerPath: string;
  promptVersion: () => string;
  credentialReady: (lane: SnifferLane) => boolean;
  requestReload: () => boolean;
  /** What the local judge measured on this install, for the estimates (judge-second-round.ts). */
  observed?: () => JudgeObserved;
  /** The second round's sweep cursor: a new choice of the second round starts it over. */
  secondRoundStatePath?: string;
}) {
  const cloud = options.cloud;
  const status = () => ({ ...options.spending.status(),
    cloudModel: cloud.source === 'off' ? null : cloud.lane.modelId,
    cloudAvailable: cloud.source !== 'off' && Boolean(JUDGE_PRICES[normalizeVeniceAnalystModelId(cloud.lane.modelId)]),
    observed: options.observed?.() ?? {},
  });
  return {
    status,
    pageStatus: () => ({ ...status(), upgradeNote: options.spending.takeUpgradeNote() }),
    async save(choice: JudgeChoice, capDollars: number): Promise<{ ok: true; status_message: string }> {
      judgeCapMicros(capDollars);
      if (choice === 'local') {
        const unreadable = options.spending.status().stop === 'storage';
        if (!unreadable) options.spending.choose('local', capDollars); // Immediately closes the dispatch gate.
        // A corrupt record already blocks every send. Withdraw cloud consent
        // independently so restoring that record cannot restore this approval.
        if (cloud.source !== 'off') await revokeClassifier(options.ledgerPath, cloud.lane, options.promptVersion(), 'Owner chose local judging on this computer.');
        const local = options.local();
        if (local.source === 'off') {
          options.requestReload();
          return { ok: true, status_message: 'Cloud judging is off. Remaining items stay Private until a local judge is available.' };
        }
        try {
          await approveClassifier(options.ledgerPath, local.lane, options.promptVersion(), 'Owner chose free local privacy judging on this computer.');
        } catch {
          options.requestReload();
          return { ok: true, status_message: 'Cloud judging is off. The local judge approval could not be saved; check the classification ledger before continuing.' };
        }
        return { ok: true, status_message: options.requestReload() ? 'Cloud judging is off. Olympus is applying local judging.' : 'Cloud judging is off. Restart Olympus to start local judging.' };
      }
      const current = options.spending.status();
      if (judgeChoiceUsesVenice(current.choice) && capDollars < current.capDollars) options.spending.lowerCap(capDollars);
      if (cloud.source === 'off') throw new Error('Set up an allowed Venice model in Private answers first.');
      if (!JUDGE_PRICES[normalizeVeniceAnalystModelId(cloud.lane.modelId)]) throw new Error('A listed price is needed before this model can judge in the cloud.');
      if (!options.credentialReady(cloud.lane)) throw new Error('Add your own Venice API key in Keys first.');
      const fallback = options.local();
      if (choice === 'local-then-venice' && fallback.source === 'off') throw new Error('The double-check needs the judge on this computer first. Choose Venice sorts everything instead.');
      await approveClassifier(options.ledgerPath, cloud.lane, options.promptVersion(), choice === 'local-then-venice'
        ? 'Owner opted in on this computer: Venice re-reads only the items the local judge held Private, the items most likely to be Private; E2EE is not available yet.'
        : 'Owner opted in on this computer: Venice reads every item, including Private items; E2EE is not available yet.');
      if (fallback.source !== 'off') await approveClassifier(options.ledgerPath, fallback.lane, options.promptVersion(), choice === 'local-then-venice'
        ? 'Owner chose free local judging on this computer, double-checked by Venice.'
        : 'Owner chose cloud judging with free local judging when the spending limit stops cloud calls.');
      // A new choice of the second round re-asks everything held so far, and so does resuming after a
      // cap or payment stop: what the stop left gets its turn, and what Venice already kept Private is skipped.
      // A new limit with no stop continues where it was.
      if (choice === 'local-then-venice' && (current.choice !== 'local-then-venice' || current.stop) && options.secondRoundStatePath) SecondRoundSweep.reset(options.secondRoundStatePath);
      options.spending.choose(choice, capDollars);
      return { ok: true, status_message: options.requestReload() ? 'Choice saved. Olympus is applying it.' : 'Choice saved. Restart Olympus to resume or change privacy judging. A lower spending limit blocks further calls immediately.' };
    },
  };
}
