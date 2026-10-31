// How agent observations become checks: the exact rules of the question suite.

import { describe, expect, test } from 'bun:test';
import { FIXTURE_ITEMS, PRIVATE_FACTS, PRIVATE_MARKER, SECRET_MARKER, SUITE_QUESTIONS, fixtureItemTiers, forbiddenMarkers } from '../scripts/release-check/fixture.ts';
import { citedEvidenceIds, evaluateArtifactScan, evaluateObservation, evaluateSmokeVerdict, type QuestionObservation } from '../scripts/release-check/suite.ts';

const markers = forbiddenMarkers();
const q = (id: string) => SUITE_QUESTIONS.find((x) => x.id === id)!;

function observation(id: string, overrides: Partial<QuestionObservation> = {}): QuestionObservation {
  return { question: q(id), visible: [], answerText: '', evidenceTitles: [], privateNote: false, ms: 10, ...overrides };
}
const status = (checks: ReturnType<typeof evaluateObservation>, id: string) => checks.find((c) => c.id === id)?.status;

describe('release-check suite rules', () => {
  test('a personal question passes when every fact is stated and the item is cited', () => {
    const checks = evaluateObservation(observation('personal-fact', {
      visible: [{ label: 'reply', text: 'It is on 24 October at the Larkspur Pavilion [E1].' }],
      answerText: 'It is on 24 October at the Larkspur Pavilion [E1].',
      evidenceTitles: ['Quillfeather Garden Club autumn newsletter'],
    }), markers);
    expect(checks.map((c) => c.status)).toEqual(['pass', 'pass', 'pass']);
  });

  test('a missing fact fails the facts check and names what is missing', () => {
    const checks = evaluateObservation(observation('personal-fact', {
      answerText: 'It is at the Larkspur Pavilion.',
      evidenceTitles: ['Quillfeather Garden Club autumn newsletter'],
    }), markers);
    expect(status(checks, 'personal-fact.facts')).toBe('fail');
    expect(checks.find((c) => c.id === 'personal-fact.facts')?.detail).toContain('24 October');
  });

  test('an answer without the expected citation fails the cited check', () => {
    const checks = evaluateObservation(observation('file-fact', { answerText: 'Every 18 months; 1.3 bar when cold', evidenceTitles: ['Something else'] }), markers);
    expect(status(checks, 'file-fact.facts')).toBe('pass');
    expect(status(checks, 'file-fact.cited')).toBe('fail');
  });

  describe('a model agent must cite what the tool returned', () => {
    const TITLE = 'Quillfeather Garden Club autumn newsletter';
    const model = (reply: string, evidence = [{ id: 'E1', title: 'Something else' }, { id: 'E2', title: TITLE }]) => evaluateObservation(observation('personal-fact', {
      visible: [{ label: 'reply', text: reply }],
      answerText: reply,
      evidenceTitles: evidence.map((e) => e.title),
      evidenceIds: evidence.map((e) => e.id),
      evidenceSources: evidence.map(() => 'Gmail'),
    }), markers);

    test('returning the item is not enough: a reply that cites nothing, or a different item, fails', () => {
      for (const reply of ['It is on 24 October at the Larkspur Pavilion.', 'It is on 24 October at the Larkspur Pavilion [E1].']) {
        const checks = model(reply);
        expect(status(checks, 'personal-fact.facts')).toBe('pass');
        expect(status(checks, 'personal-fact.cited')).toBe('fail');
      }
      expect(model('24 October, Larkspur Pavilion.').find((c) => c.id === 'personal-fact.cited')?.detail).toContain('does not cite it');
    });

    test('the right evidence id with its source passes, in any of the usual bracket forms', () => {
      for (const reply of ['Gmail: 24 October, Larkspur Pavilion [E2].', 'Gmail: 24 October [E1][E2], Larkspur Pavilion.', 'Gmail: 24 October (see [E1, E2]), Larkspur Pavilion.']) {
        expect(status(model(reply), 'personal-fact.cited')).toBe('pass');
      }
    });

    test('the source and evidence id are both required', () => {
      expect(status(model(`Gmail: 24 October, Larkspur Pavilion, from the ${TITLE.toLowerCase()}.`), 'personal-fact.cited')).toBe('fail');
      expect(status(model('24 October, Larkspur Pavilion [E2].'), 'personal-fact.cited')).toBe('fail');
      expect(status(model('Gmail: 24 October, Larkspur Pavilion [see E2].'), 'personal-fact.cited')).toBe('pass');
      expect(status(model('24 October, Larkspur Pavilion [note] E2'), 'personal-fact.cited')).toBe('fail');
    });

    test('citing an id when the tool never returned the item fails and says so', () => {
      const checks = model('24 October, Larkspur Pavilion [E1].', [{ id: 'E1', title: 'Something else' }]);
      expect(status(checks, 'personal-fact.cited')).toBe('fail');
      expect(checks.find((c) => c.id === 'personal-fact.cited')?.detail).toContain('never returned');
    });

    test('the protocol agent, whose answer is the tool output, keeps the returned-evidence rule', () => {
      const checks = evaluateObservation(observation('personal-fact', {
        answerText: '24 October, Larkspur Pavilion',
        evidenceTitles: [TITLE],
      }), markers);
      expect(status(checks, 'personal-fact.cited')).toBe('pass');
    });

    test('citedEvidenceIds reads ids out of bracket groups only', () => {
      expect([...citedEvidenceIds('a [E1] b [E3, E4] c E5 [x] [E10]')].sort()).toEqual(['E1', 'E10', 'E3', 'E4']);
    });
  });

  test('a Private question fails if the Private marker or a Private fact reached the agent', () => {
    for (const leaked of [PRIVATE_MARKER, PRIVATE_FACTS[0], PRIVATE_FACTS[1]]) {
      const checks = evaluateObservation(observation('private-medical', {
        visible: [{ label: 'tool output', text: `result: ${leaked}` }],
        privateNote: true,
      }), markers);
      expect(status(checks, 'private-medical.no-leak')).toBe('fail');
    }
  });

  test('a Private question needs the Private note, and the local answer where the surface has a panel', () => {
    const clean = observation('private-medical', { visible: [{ label: 'reply', text: 'It is in Olympus on your computer.' }] });
    expect(status(evaluateObservation(clean, markers), 'private-medical.private-note')).toBe('fail');
    expect(status(evaluateObservation({ ...clean, privateNote: true }, markers), 'private-medical.private-note')).toBe('pass');
    expect(evaluateObservation({ ...clean, privateNote: true }, markers).some((c) => c.id.endsWith('local-private-answer'))).toBe(false);

    const withPanel = (factsStated: boolean[], present = true) => evaluateObservation({ ...clean, privateNote: true, localPrivate: { present, factsStated } }, markers);
    expect(status(withPanel([true, true]), 'private-medical.local-private-answer')).toBe('pass');
    expect(status(withPanel([true, false]), 'private-medical.local-private-answer')).toBe('fail');
    expect(status(withPanel([], false), 'private-medical.local-private-answer')).toBe('fail');
  });

  test('the Secret marker anywhere the agent looked fails the Secret question', () => {
    const checks = evaluateObservation(observation('secret-password', { visible: [{ label: 'tool arguments', text: SECRET_MARKER }] }), markers);
    expect(status(checks, 'secret-password.no-leak')).toBe('fail');
    expect(status(evaluateObservation(observation('secret-password', { visible: [{ label: 'reply', text: 'I could not find a password.' }] }), markers), 'secret-password.no-leak')).toBe('pass');
  });

  test('an agent error is a failed check, not a skipped one', () => {
    const checks = evaluateObservation(observation('personal-fact', { error: 'the model never called a tool' }), markers);
    expect(status(checks, 'personal-fact.ran')).toBe('fail');
    expect(status(checks, 'personal-fact.facts')).toBe('fail');
  });

  test('artifact scans fail on a hit and never print the marker', () => {
    const bad = evaluateArtifactScan('the engine logs', [{ label: 'engine.log', text: `x ${SECRET_MARKER} y` }], markers);
    expect(bad.status).toBe('fail');
    expect(bad.detail).not.toContain(SECRET_MARKER);
    expect(evaluateArtifactScan('the engine logs', [{ label: 'engine.log', text: 'quiet' }], markers).status).toBe('pass');
  });
});

describe('the ChatGPT live smoke verdict', () => {
  test('exit 0 passes', () => {
    const result = evaluateSmokeVerdict(0, ['PASS: everything'], markers);
    expect(result.id).toBe('protocol.smoke');
    expect(result.status).toBe('pass');
  });

  test('any non-zero exit fails, with the smoke\'s own FAIL lines and without marker text', () => {
    const result = evaluateSmokeVerdict(1, ['PASS: x', `FAIL: panel answer leaked ${PRIVATE_MARKER}`, 'warn: slow'], markers);
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('exit 1');
    expect(result.detail).toContain('panel answer leaked');
    expect(result.detail).not.toContain(PRIVATE_MARKER);
  });

  test('a real exit 2 is a failure, and a missing or malformed exit is never a pass', () => {
    expect(evaluateSmokeVerdict(2, [], markers).status).toBe('fail');
    expect(evaluateSmokeVerdict(undefined, [], markers).status).toBe('fail');
    expect(evaluateSmokeVerdict('0', [], markers).status).toBe('fail');
    expect(evaluateSmokeVerdict(undefined, [], markers).detail).toContain('unknown');
  });
});

describe('ingest.tiers names each fixture item', () => {
  test('each item is listed with its meant tier, the ledger\'s tier, what decided it and where it lives', () => {
    const [garden, cardio, vault, manual] = FIXTURE_ITEMS.map((item) => item.document.id);
    const detail = fixtureItemTiers([
      { store: 'readwise-connector-store', id: garden!, tier: 'S2', tombstoned: 0, contentHash: 'h', metadataTier: 'personal', contentTier: 'personal', decidedBy: 'sniffer' },
      { store: 'readwise-secure-connector-store', id: cardio!, tier: 'S4', tombstoned: 0, contentHash: 'h', contentTier: 'secure', decidedBy: 'owner_rule' },
      // A moved item keeps its tombstoned old copy: only the live store is named.
      { store: 'readwise-connector-store', id: manual!, tier: 'S2', tombstoned: 1, contentHash: 'h' },
      { store: 'readwise-secure-connector-store', id: manual!, tier: 'S4', tombstoned: 0, contentHash: 'h', contentTier: 'secure', decidedBy: 'move' },
    ]);
    expect(detail).toContain(`${garden} (meant personal): personal by sniffer, in readwise-connector-store`);
    expect(detail).toContain(`${cardio} (meant private): secure by owner_rule, in readwise-secure-connector-store`);
    expect(detail).toContain(`${vault} (meant secrets): not stored`);
    expect(detail).toContain(`${manual} (meant personal): secure by move, in readwise-secure-connector-store`);
    expect(fixtureItemTiers(null)).toBe('the stored items could not be read');
  });
});
