import { approveClassifier, isClassifierApproved, readClassificationLedger, revokeClassifier } from '../classification-ledger.ts';
import type { TierSnifferRuntime } from './built-in-sniffer.ts';
import type { SnifferLane } from './sniffer-lane.ts';
import { JudgeSpending, judgeCapMicros, JUDGE_PRICES } from './judge-spending.ts';
import { normalizeVeniceAnalystModelId } from '../../core/venice-models.ts';

/** Existing installs are never re-asked: an exact approval already on the ledger,
 * with no spending record yet, is the owner's opt-in. New choices stay local. */
export async function adoptExistingCloudApproval(spending: JudgeSpending, cloud: TierSnifferRuntime, ledgerPath: string, promptVersion: string): Promise<void> {
  if (cloud.source === 'off' || cloud.lane.kind !== 'venice' || spending.hasRecord()) return;
  const { entries } = await readClassificationLedger(ledgerPath);
  if (isClassifierApproved(entries, { lane: cloud.lane.kind, profileId: cloud.lane.profileId, modelId: cloud.lane.modelId, promptVersion })) spending.adoptExistingApproval();
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
}) {
  const cloud = options.cloud;
  return {
    status: () => ({ ...options.spending.status(),
      cloudModel: cloud.source === 'off' ? null : cloud.lane.modelId,
      cloudAvailable: cloud.source !== 'off' && Boolean(JUDGE_PRICES[normalizeVeniceAnalystModelId(cloud.lane.modelId)]),
    }),
    pageStatus() { return { ...this.status(), upgradeNote: options.spending.takeUpgradeNote() }; },
    async save(choice: 'local' | 'venice', capDollars: number): Promise<{ ok: true; status_message: string }> {
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
      if (current.choice === 'venice' && capDollars < current.capDollars) options.spending.lowerCap(capDollars);
      if (cloud.source === 'off') throw new Error('Set up an allowed Venice model in Private answers first.');
      if (!JUDGE_PRICES[normalizeVeniceAnalystModelId(cloud.lane.modelId)]) throw new Error('A listed price is needed before this model can judge in the cloud.');
      if (!options.credentialReady(cloud.lane)) throw new Error('Add your own Venice API key in Keys first.');
      await approveClassifier(options.ledgerPath, cloud.lane, options.promptVersion(),
        'Owner opted in on this computer: Venice reads every item, including Private items; E2EE is not available yet.');
      const fallback = options.local();
      if (fallback.source !== 'off') await approveClassifier(options.ledgerPath, fallback.lane, options.promptVersion(),
        'Owner chose cloud judging with free local judging when the spending limit stops cloud calls.');
      options.spending.choose('venice', capDollars);
      return { ok: true, status_message: options.requestReload() ? 'Choice saved. Olympus is applying it.' : 'Choice saved. Restart Olympus to resume or change privacy judging. A lower spending limit blocks further calls immediately.' };
    },
  };
}
