import { expect, test } from 'bun:test';
import { firstEvidenceMs, observeAsk, qualifyAskCheck, qualifyPrivacyCheck, QUALIFY_QUESTION } from '../scripts/release-check/qualify.ts';

test('the Ask must answer with both the known facts and the fixture citation', () => {
  const body = { ok: true, status: 'answered', answer: QUALIFY_QUESTION.facts.join(', '), citations: [{ title: QUALIFY_QUESTION.citedTitle }] };
  expect(qualifyAskCheck(observeAsk(200, body, 150)).status).toBe('pass');
  expect(qualifyAskCheck(observeAsk(200, { ...body, citations: [] }, 150)).status).toBe('fail');
  expect(qualifyAskCheck(observeAsk(200, body, 6_000, 10_000)).status).toBe('pass');
  expect(qualifyAskCheck(observeAsk(200, body, 26_000, 10_001))).toMatchObject({
    status: 'warn', ms: 26_000, detail: expect.stringContaining('first evidence (engine retrieval) 10001 ms (over 10 s) · whole answer 26000 ms (target about 20 s, over)'),
  });
  expect(qualifyAskCheck(observeAsk(200, { ...body, citations: [] }, 6_000, 10_001)).status).toBe('fail');
  expect(qualifyAskCheck(observeAsk(200, body, 150)).detail).toContain('no streaming in 1.5');
  expect(qualifyAskCheck().status).toBe('fail');
});

test('first evidence needs one retrieval receipt with candidates', () => {
  const receipt = '[local-answer] retrieval latency_ms=5001 candidates=2 searched=fixture skipped=-';
  expect(firstEvidenceMs(`unrelated log line\n${receipt}\n`)).toBe(5_001);
  expect(firstEvidenceMs(receipt.replace('candidates=2', 'candidates=0'))).toBeUndefined();
  expect(firstEvidenceMs(`${receipt}\n${receipt}`)).toBeUndefined();
  expect(firstEvidenceMs('unrelated log line')).toBeUndefined();
});

test('privacy qualification gates acknowledgement separately from completion and requires withholding across restart', () => {
  const receipt = { ackMs: 1_000, finishMs: 3_000, withheldAfterAck: true, withheldAfterRestart: true, ownerChoiceAfterRestart: true };
  expect(qualifyPrivacyCheck(receipt)).toMatchObject({ status: 'pass', detail: expect.stringContaining('Acknowledged 1000 ms · finished 3000 ms') });
  expect(qualifyPrivacyCheck({ ...receipt, ackMs: 1_001 }).status).toBe('fail');
  expect(qualifyPrivacyCheck({ ...receipt, withheldAfterRestart: false }).status).toBe('fail');
  expect(qualifyPrivacyCheck({ ackMs: 700 }).status).toBe('fail');
});
