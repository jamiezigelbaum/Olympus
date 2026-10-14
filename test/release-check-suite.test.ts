// How agent observations become checks: the exact rules of the question suite.

import { describe, expect, test } from 'bun:test';
import { PRIVATE_FACTS, PRIVATE_MARKER, SECRET_MARKER, SUITE_QUESTIONS, forbiddenMarkers } from '../scripts/release-check/fixture.ts';
import { evaluateArtifactScan, evaluateObservation, type QuestionObservation } from '../scripts/release-check/suite.ts';

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
    const checks = evaluateObservation(observation('file-fact', { answerText: '1,284.50 EUR due 15 November 2026', evidenceTitles: ['Something else'] }), markers);
    expect(status(checks, 'file-fact.facts')).toBe('pass');
    expect(status(checks, 'file-fact.cited')).toBe('fail');
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
