/** Frozen full-message judge evaluation. It deliberately does not measure queue/placement latency. */
import { createHash } from 'node:crypto';
import type { AnalystModel } from '../../src/core/analyst.ts';
import { buildSnifferBatchPrompt, parseSnifferBatchResponse, SNIFFER_SYSTEM_PROMPT,
  snifferMaterialCarriesSecret, snifferMaterialLooksLikeInjection, snifferPromptVersions, snifferTierKey,
} from '../../src/workers/classification/sniffer.ts';
import fixture from './fixtures/inbox-onboarding.json';

export const inboxFixture = fixture;
export type InboxSplit = 'dev' | 'held-out' | 'all';
export function inboxMaterial(item: typeof fixture.items[number]): string {
  const e = item.email;
  // Inert, impossible-to-use synthetic credential; never stored in the fixture as a credential literal.
  const credential = ['pass', 'word', ' = ', 'inert-eval-only-credential'].join('');
  return `From: ${e.from_}\nTo: ${e.to}\nDate: ${e.date}\nSubject: ${e.subject}\n\n${e.body}`.replaceAll('{{CREDENTIAL}}', credential);
}

/** Scripted responses frozen BEFORE the fix. This measures wiring, never model accuracy. */
export function createInboxReplayModel(): AnalystModel {
  const responses = new Map(fixture.items.map(item => [inboxMaterial(item), item.fakeJudgment]));
  return { async complete(request) {
    const items = request.prompt.split('\n').filter(line => line.startsWith('{"i":')).map(line => JSON.parse(line))
      .filter(item => typeof item.i === 'number');
    if (items.length !== 1) throw new Error('Inbox judge must isolate every item.');
    const answer = responses.get(items[0].document);
    if (!answer) throw new Error('Unrecognized synthetic message.');
    return { modelId: 'inbox-scripted-v1', text: JSON.stringify({ verdicts: [{ i: 1, ...answer }] }) };
  } };
}

export async function runInboxEval(options: { model: AnalystModel; modelId: string; split?: InboxSplit }) {
  const items = fixture.items.filter(item => !options.split || options.split === 'all' || item.split === options.split);
  const results: Array<{ id: string; split: string; expected: string; actual: string; milliseconds: number; dispatches: number }> = [];
  let secretDispatches = 0;
  for (const item of items) {
    const start = performance.now();
    const material = inboxMaterial(item);
    let actual: string;
    let dispatches = 0;
    if (snifferMaterialCarriesSecret(material)) actual = 'secrets';
    else if (snifferMaterialLooksLikeInjection(material)) actual = 'secure';
    else {
      dispatches++;
      if (item.label === 'secrets') secretDispatches++;
      const response = await options.model.complete({ system: SNIFFER_SYSTEM_PROMPT,
        prompt: buildSnifferBatchPrompt('content', [{ i: 1, material }], fixture.privacyProfile.description), localOnly: true });
      const verdict = parseSnifferBatchResponse(response.text, new Set([1])).get(1);
      actual = verdict ? snifferTierKey(verdict) : 'unresolved';
    }
    results.push({ id: item.id, split: item.split, expected: item.label, actual, milliseconds: performance.now() - start, dispatches });
  }
  const ratio = (n: number, d: number) => d ? n / d : 0;
  const metrics = (rows: typeof results) => {
    const count = (label: string, actual: boolean) => rows.filter(row => (actual ? row.actual : row.expected) === label).length;
    const correct = (label: string) => rows.filter(row => row.expected === label && row.actual === label).length;
    return { cases: rows.length, correct: rows.filter(row => row.expected === row.actual).length,
      privatePrecision: ratio(correct('secure'), count('secure', true)), privateRecall: ratio(correct('secure'), count('secure', false)),
      personalRecall: ratio(correct('private'), count('private', false)), secretRecall: ratio(correct('secrets'), count('secrets', false)),
      unresolved: count('unresolved', true) };
  };
  return { modelId: options.modelId, policyVersion: createHash('sha256').update(JSON.stringify(fixture.privacyProfile)).digest('hex'),
    promptVersion: snifferPromptVersions(fixture.privacyProfile.description).cache,
    ...metrics(results), splits: { dev: metrics(results.filter(row => row.split === 'dev')), heldOut: metrics(results.filter(row => row.split === 'held-out')) },
    secretDispatches, calls: results.reduce((n, row) => n + row.dispatches, 0),
    mistakes: results.filter(row => row.actual !== row.expected), results };
}
