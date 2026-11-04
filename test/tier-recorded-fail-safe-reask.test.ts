// A re-listed item whose content was settled fail-safe Private only because
// its question went missing was never judged: the listing asks the sniffer
// again instead of reusing that settlement as if it were a verdict. An item
// the sniffer really judged keeps its recorded verdict. Synthetic data.
import { expect, test } from 'bun:test';
import { contentDigestReason, TIER_CLASSIFIER_VERSION, type TierSniffer, type TierSnifferRequest } from '../src/workers/classification/tier-classifier.ts';
import type { TierLedgerRecord } from '../src/workers/classification/tier-ledger.ts';
import { recordedContentVerdictSniffer } from '../src/workers/connector-store/tier-placement.ts';

const TEXT = 'See you at the allotment on Saturday.';
const NAMES = 'content:names:test';

function record(code: string): TierLedgerRecord {
  return {
    state: 'current', contentPending: false, contentRead: true, contentTier: 'secure', metadataTier: 'private',
    engineVersion: TIER_CLASSIFIER_VERSION, mapRevision: 'none',
    reasons: [contentDigestReason(TEXT), NAMES, `content:sniffer:lane-1:${code}`],
  } as unknown as TierLedgerRecord;
}

function asking(): { sniffer: TierSniffer; asked: TierSnifferRequest[] } {
  const asked: TierSnifferRequest[] = [];
  return { asked, sniffer: { id: 'lane-1', judge: (request) => { asked.push(request); return { verdict: 'undecided', queued: true }; } } };
}

test('a fail-safe missing-question settlement is asked again on the next listing', () => {
  const { sniffer, asked } = asking();
  const wrapped = recordedContentVerdictSniffer(sniffer, record('fail_safe:missing_question'), TEXT, NAMES);
  expect(wrapped.judge({ pass: 'content', material: TEXT, mapRevision: 'none', flags: [] } as unknown as TierSnifferRequest))
    .toEqual({ verdict: 'undecided', queued: true });
  expect(asked).toHaveLength(1);
});

test('a real recorded verdict still answers the unchanged listing', () => {
  const { sniffer, asked } = asking();
  const wrapped = recordedContentVerdictSniffer(sniffer, record('medical:0.91'), TEXT, NAMES);
  expect(wrapped.judge({ pass: 'content', material: TEXT, mapRevision: 'none', flags: [] } as unknown as TierSnifferRequest))
    .toEqual({ verdict: 'decided', tier: 'secure', code: 'medical:0.91' });
  expect(asked).toHaveLength(0);
});
