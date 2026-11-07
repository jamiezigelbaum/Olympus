// Synthetic ledger rows only; no install data, inference or network.
import { expect, test } from 'bun:test';
import { prefilterTrainingExample, type PrefilterCopy } from '../src/workers/classification/embedding-prefilter.ts';
import { countPrefilterTraining } from '../src/workers/classification/prefilter-training-counts.ts';
import { EMBEDDING_PREFILTER_DIMENSIONS, EMBEDDING_PREFILTER_MODEL_ID } from '../src/workers/classification/embedding-logistic.ts';
import { snifferId } from '../src/workers/classification/sniffer.ts';
import { contentDigestReason, contentJudgeVerdictReason, normalizedContentHash } from '../src/workers/classification/tier-classifier.ts';
import type { TierLedgerRecord } from '../src/workers/classification/tier-ledger.ts';

const lane = { kind: 'local' as const, modelId: 'synthetic-model', profileId: 'fixture' };
const current = snifferId(lane, 'p-current');
const older = snifferId(lane, 'p-older');
const different = snifferId({ ...lane, modelId: 'different-model' }, 'p-older');
const text = 'Synthetic picnic plans for Sunday.';
const digest = contentDigestReason(text);
const vector = new Float32Array(EMBEDDING_PREFILTER_DIMENSIONS); vector[0] = 1;
const copy: PrefilterCopy = {
  chunks: [{ chunkIndex: 0, boundedText: text, embeddingInputHash: 'synthetic-input' }],
  vectors: [{ chunkIndex: 0, modelId: EMBEDDING_PREFILTER_MODEL_ID, contentHash: 'synthetic-input', embedding: new Uint8Array(vector.buffer) }],
};
function row(judge = older, code = 'other:1.00', tier: 'private' | 'secure' = 'private', modern = false): TierLedgerRecord {
  const reason = `content:sniffer:${judge}:${code}`;
  return { provider: 'fixture', accountScope: 'fixture', conversationKey: '', providerItemId: 'fixture', family: 'file',
    metadataTier: 'private', contentTier: tier, generation: 1, decidedBy: 'sniffer',
    reasons: [reason, digest, ...(modern ? [contentJudgeVerdictReason(reason, tier, digest)] : [])],
    engineVersion: 'fixture', mapRevision: 'none', modelId: lane.modelId,
    previousMetadataTier: null, previousContentTier: null, state: 'current', targetMetadataTier: null, targetContentTier: null,
    storedTrustDomain: 'secure_local', storedTrustTier: 'S4', contentRead: true, metadataPending: false,
    contentPending: false, metadataForced: false, metadataFlagged: false, decidedAt: '2026-11-07T00:00:00.000Z', routed: true };
}
const options = { ledger: { getOverride: () => undefined, rejudgeQuestion: () => undefined }, copyFor: () => copy };
function rejected(value: TierLedgerRecord, reason: string) {
  const drops: string[] = [];
  expect(prefilterTrainingExample(value, current, options, value => { drops.push(value); return undefined; })).toBeUndefined();
  expect(drops).toEqual([reason]);
}

for (const modern of [false, true]) for (const tier of ['private', 'secure'] as const)
  test(`older prompt same model accepts ${tier}, modern receipt=${modern}`, () => {
    expect(prefilterTrainingExample(row(older, 'other:1.00', tier, modern), current, { ...options,
      sniffer: { trainingVerdict: () => ({ tier: tier === 'private' ? 'personal' : 'private',
        contentHash: normalizedContentHash(text), decidedAt: '2026-11-06T00:00:00.000Z', ambiguous: false }) },
    }))
      .toMatchObject({ private: tier === 'secure', provenance: modern ? 'judge_receipt' : 'legacy_sniffer' });
  });
test.each(['private', 'secure'] as const)('older-prompt content verdict bound to this copy still accepts %s', tier => {
  expect(prefilterTrainingExample(row(older, 'other:1.00', tier), current, {
    ...options, sniffer: { trainingVerdict: () => ({ tier: tier === 'private' ? 'personal' : 'private',
      contentHash: normalizedContentHash(text), decidedAt: '2026-11-06T00:00:00.000Z', ambiguous: false }) },
  })).toMatchObject({ private: tier === 'secure', provenance: 'legacy_sniffer' });
});
test.each([false, true])('queued lowering trains the final Personal verdict, modern=%s', modern => {
  const moving = { ...row(older, 'other:1.00', 'private', modern), state: 'moving' as const,
    contentTier: 'secure' as const, targetMetadataTier: 'private' as const, targetContentTier: 'private' as const };
  expect(prefilterTrainingExample(moving, current, { ...options,
    sniffer: { trainingVerdict: () => ({ tier: 'personal', contentHash: normalizedContentHash(text),
      decidedAt: '2026-11-06T00:00:00.000Z', ambiguous: false }) },
  })).toMatchObject({ private: false });
});
test('pending judgment cannot supply a label even with old verdict receipts', () => {
  rejected({ ...row(older, 'other:1.00', 'private', true), state: 'pending', contentPending: true }, 'not_current');
  rejected({ ...row(older, 'other:1.00', 'private', true), state: 'moving', contentPending: true,
    targetMetadataTier: 'private', targetContentTier: 'private' }, 'content_pending');
});
test('moving row with an extra raiser never trains', () => {
  const value = { ...row(older, 'other:1.00', 'private', true), state: 'moving' as const,
    contentTier: 'secure' as const, targetMetadataTier: 'private' as const, targetContentTier: 'private' as const };
  value.reasons.push('content:own_record:health');
  rejected(value, 'content_reason_unknown');
});
test('moving targets need a matching verdict and may not involve Secrets', () => {
  rejected({ ...row(older, 'other:1.00', 'secure', true), state: 'moving',
    targetMetadataTier: 'private', targetContentTier: 'private' }, 'verdict_missing');
  rejected({ ...row(older, 'other:1.00', 'private', true), state: 'moving', contentTier: 'secrets',
    targetMetadataTier: 'private', targetContentTier: 'private' }, 'content_tier');
  rejected({ ...row(older, 'other:1.00', 'private', true), state: 'moving',
    targetMetadataTier: null, targetContentTier: null }, 'metadata_tier');
});
test('different model is rejected, even with a matching modern receipt and digest', () => {
  for (const modern of [false, true]) rejected(row(different, 'other:1.00', 'private', modern), 'judge_model_mismatch');
});
test('a different decision mode is a different model identity', () => {
  rejected(row(snifferId({ ...lane, snifferMode: 'decision' }, 'p-older')), 'judge_model_mismatch');
});
test('malformed sniffer identities cannot supply a label', () => {
  rejected(row('synthetic-judge'), 'judge_id_invalid');
  rejected(row(`${older}0`), 'judge_id_invalid');
});
test.each(['fail_safe:missing_question', 'rule:duplicate_model:other:1.00', 'unresolved:0.00', 'injection:fixture:0.00', 'undecided'])
  ('unsafe content code never trains: %s', code => rejected(row(older, code), 'judge_code_unsafe'));
test('metadata-only verdict never labels body, even with an exact body digest', () => {
  const value = row();
  value.reasons[0] = value.reasons[0]!.replace('content:sniffer:', 'metadata:sniffer:');
  rejected(value, 'judge_missing');
});
test('copy digest mismatch never trains a same-model legacy label', () => {
  const value = row(); value.reasons[1] = contentDigestReason('Changed body');
  rejected(value, 'digest_missing');
});
test.each(['content:rule:fixture', 'content:detector:financial:iban', 'content:secret:fixture', 'content:own_record:health',
  'metadata:owner_rule:fixture', 'metadata:floor:fixture', 'metadata:secret:fixture', 'override:tier:secure'])
  ('extra raiser never trains: %s', extra => {
    const value = row(); value.reasons.push(extra);
    rejected(value, extra.startsWith('content:') ? 'content_reason_unknown'
      : extra.startsWith('override:') ? 'override_reason' : extra.split(':').slice(0, 2).join('_'));
  });
test('unread content never trains', () => rejected({ ...row(), contentRead: false }, 'content_unread'));
test('a names-only cached Private answer cannot explain a legacy Private content tier', () => {
  const drops: string[] = [];
  expect(prefilterTrainingExample({ ...row(older, 'other:1.00', 'secure'), previousMetadataTier: 'secure' }, current, {
    ...options, sniffer: { trainingVerdict: () => ({ tier: 'private', decidedAt: '2026-11-06T00:00:00.000Z', ambiguous: false }) },
  }, reason => { drops.push(reason); return undefined; })).toBeUndefined();
  expect(drops).toEqual(['legacy_verdict_content']);
});
test.each(['private', 'secure'] as const)('legacy content-pass labels without a cached hash are rejected in either class: %s', tier => {
  const drops: string[] = [];
  expect(prefilterTrainingExample(row(older, 'other:1.00', tier), current, {
    ...options, sniffer: { trainingVerdict: () => ({ tier: tier === 'private' ? 'personal' : 'private',
      decidedAt: '2026-11-06T00:00:00.000Z', ambiguous: false }) },
  }, reason => { drops.push(reason); return undefined; })).toBeUndefined();
  expect(drops).toEqual(['legacy_verdict_content']);
});
test('a retained metadata raise cannot train after its cache is removed', () => {
  rejected({ ...row(older, 'other:1.00', 'secure'), previousMetadataTier: 'secure' }, 'legacy_store_missing');
});
test('counts share acceptance and report numeric model-mismatch rejections only', () => {
  let read = false;
  const counts = countPrefilterTraining({ ...options, judge: current,
    sniffer: { trainingVerdict: subject => ({ tier: subject.providerItemId === 'private-label' ? 'private' : 'personal',
      contentHash: normalizedContentHash(text), decidedAt: '2026-11-06T00:00:00.000Z', ambiguous: false }) }, ledger: { ...options.ledger,
    listItemWindow: () => { if (read) return []; read = true; return [row(), { ...row(older, 'personal_record:1.00', 'secure'), providerItemId: 'private-label' }, row(different)]; },
  } });
  expect(counts).toMatchObject({ rows_read: 3, examples: { personal: 1, private: 1 },
    per_source: { other: { personal: 1, private: 1 } },
    provenance: { judge_receipt: 0, legacy_sniffer: 2 }, rejections: { judge_model_mismatch: 1 } });
  expect(Object.values(counts.rejections).reduce((a, b) => a + b, 0)).toBe(1);
  expect(JSON.stringify(counts)).not.toMatch(/synthetic|fixture|p-older|p-current/);
});

test('missing legacy evidence is an explainable counts-only rejection', () => {
  let read = false;
  const counts = countPrefilterTraining({ ...options, judge: current,
    sniffer: { trainingVerdict: () => undefined }, ledger: { ...options.ledger,
      listItemWindow: () => { if (read) return []; read = true; return [row()]; },
    } });
  expect(counts).toMatchObject({ rows_read: 1, examples: { personal: 0, private: 0 },
    rejections: { legacy_verdict_missing: 1 } });
  expect(JSON.stringify(counts)).not.toMatch(/synthetic|fixture|p-older|p-current/);
});

test('per-source class counts use final judge labels and do not expose arbitrary provider names', () => {
  let read = false;
  const counts = countPrefilterTraining({ ...options, judge: current, ledger: { ...options.ledger,
    listItemWindow: () => {
      if (read) return []; read = true;
      return [{ ...row(older, 'other:1.00', 'private', true), provider: 'telegram', state: 'moving',
        contentTier: 'secure', targetMetadataTier: 'private', targetContentTier: 'private' },
        { ...row(older, 'other:1.00', 'secure', true), provider: 'telegram' },
        { ...row(older, 'other:1.00', 'private', true), provider: 'whatsapp' },
        { ...row(older, 'other:1.00', 'private', true), provider: 'owner-specific-provider' }];
    },
  } });
  expect(counts.per_source).toEqual({ telegram: { personal: 1, private: 1 },
    whatsapp: { personal: 1, private: 0 }, other: { personal: 1, private: 0 } });
  expect(JSON.stringify(counts)).not.toContain('owner-specific-provider');
});
