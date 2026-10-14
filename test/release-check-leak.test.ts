// The release check's exact-string leak matcher and the synthetic fixture it
// guards. A match is an exact, case-sensitive occurrence; a finding names the
// marker id and where it was seen, never the text around it.

import { describe, expect, test } from 'bun:test';
import {
  FIXTURE_ITEMS,
  PRIVATE_FACTS,
  PRIVATE_MARKER,
  SECRET_MARKER,
  SUITE_QUESTIONS,
  forbiddenMarkers,
  leakyFixture,
  tierRules,
} from '../scripts/release-check/fixture.ts';
import { countExact, describeLeaks, findLeaks, redactMarkers, type LeakMarker } from '../scripts/release-check/leak.ts';

const markers: LeakMarker[] = [
  { id: 'private-marker', text: 'PRIVMARK-example-0001', tier: 'private' },
  { id: 'secret-marker', text: 'SECRETMARK-example-0002', tier: 'secrets' },
];

describe('release-check leak matcher', () => {
  test('counts exact, non-overlapping occurrences', () => {
    expect(countExact('aaaa', 'aa')).toBe(2);
    expect(countExact('abcabc', 'abc')).toBe(2);
    expect(countExact('abc', 'abcd')).toBe(0);
    expect(countExact('abc', '')).toBe(0);
  });

  test('finds a marker anywhere in a text and reports its label and count', () => {
    const findings = findLeaks([
      { label: 'agent reply', text: 'The code is PRIVMARK-example-0001 and again PRIVMARK-example-0001.' },
      { label: 'tool output', text: 'nothing here' },
    ], markers);
    expect(findings).toEqual([{ label: 'agent reply', markerId: 'private-marker', tier: 'private', occurrences: 2 }]);
  });

  test('matching is case-sensitive and exact: near misses are not leaks', () => {
    const findings = findLeaks([{ label: 'x', text: 'privmark-example-0001 PRIVMARK-example-000 PRIVMARK example 0001' }], markers);
    expect(findings).toEqual([]);
  });

  test('every marker is checked in every text', () => {
    const findings = findLeaks([
      { label: 'a', text: 'SECRETMARK-example-0002' },
      { label: 'b', text: 'PRIVMARK-example-0001 SECRETMARK-example-0002' },
    ], markers);
    expect(findings.map((f) => `${f.label}:${f.markerId}`).sort()).toEqual(['a:secret-marker', 'b:private-marker', 'b:secret-marker']);
  });

  test('a description never repeats the marker text', () => {
    const lines = describeLeaks(findLeaks([{ label: 'engine log', text: 'x PRIVMARK-example-0001 y' }], markers));
    expect(lines).toEqual(['private-marker (private) found 1x in engine log']);
    for (const line of lines) expect(line).not.toContain('PRIVMARK');
  });

  test('redaction removes every marker and leaves the rest', () => {
    const redacted = redactMarkers('a PRIVMARK-example-0001 b SECRETMARK-example-0002 c', markers);
    expect(redacted).toBe('a [redacted:private-marker] b [redacted:secret-marker] c');
    expect(findLeaks([{ label: 'r', text: redacted }], markers)).toEqual([]);
  });
});

describe('release-check fixture', () => {
  test('the markers live only in the item meant to hold them', () => {
    for (const item of FIXTURE_ITEMS) {
      const text = JSON.stringify(item.document);
      expect(text.includes(PRIVATE_MARKER)).toBe(item.key === 'cardiology');
      expect(text.includes(SECRET_MARKER)).toBe(item.key === 'router-password');
    }
  });

  test('private facts appear only in the Private item', () => {
    for (const item of FIXTURE_ITEMS) {
      const text = JSON.stringify(item.document).toLowerCase();
      for (const fact of PRIVATE_FACTS) expect(text.includes(fact.toLowerCase())).toBe(item.tier === 'private');
    }
  });

  test('covers each tier and at least one file-type item', () => {
    expect(new Set(FIXTURE_ITEMS.map((i) => i.tier))).toEqual(new Set(['personal', 'private', 'secrets']));
    expect(FIXTURE_ITEMS.some((i) => i.file && i.document.category === 'pdf')).toBe(true);
  });

  test('public questions have expected facts that the fixture states, private ones forbid them', () => {
    const personalText = FIXTURE_ITEMS.filter((i) => i.tier === 'personal').map((i) => JSON.stringify(i.document)).join(' ');
    for (const q of SUITE_QUESTIONS.filter((x) => x.kind === 'personal' || x.kind === 'file')) {
      expect(q.facts.length).toBeGreaterThan(0);
      for (const fact of q.facts) expect(personalText).toContain(fact);
    }
    const privateQuestion = SUITE_QUESTIONS.find((q) => q.kind === 'private')!;
    expect(privateQuestion.privateFacts).toEqual([...PRIVATE_FACTS]);
    const forbidden = forbiddenMarkers().map((m) => m.text);
    expect(forbidden).toContain(PRIVATE_MARKER);
    expect(forbidden).toContain(SECRET_MARKER);
    for (const fact of PRIVATE_FACTS) expect(forbidden).toContain(fact);
  });

  test('tier rules pin the Private and Secret labels', () => {
    expect(tierRules()).toEqual([
      { id: 'rc-private', label: 'rc-private', tier: 'private' },
      { id: 'rc-secrets', label: 'rc-secrets', tier: 'secrets' },
    ]);
  });

  test('the leak self-test fixture carries the marker in an ordinary Personal item and changes nothing else', () => {
    const leaky = leakyFixture('private');
    expect(leaky).toHaveLength(FIXTURE_ITEMS.length);
    const changed = leaky.filter((item, index) => item !== FIXTURE_ITEMS[index]);
    expect(changed).toHaveLength(1);
    expect(changed[0]?.tier).toBe('personal');
    expect(changed[0]?.file).toBe(false);
    expect(findLeaks([{ label: 'doc', text: JSON.stringify(changed[0]?.document) }], forbiddenMarkers()).map((f) => f.markerId)).toEqual(['private-marker']);
    // Tiers and labels are untouched, so only the leak checks can fail.
    expect(leaky.map((item) => [item.tier, item.label])).toEqual(FIXTURE_ITEMS.map((item) => [item.tier, item.label]));

    const secretLeak = leakyFixture('secrets').find((item, index) => item !== FIXTURE_ITEMS[index]);
    expect(findLeaks([{ label: 'doc', text: JSON.stringify(secretLeak?.document) }], forbiddenMarkers()).map((f) => f.markerId)).toEqual(['secret-marker']);
    // The normal fixture is clean outside its own Private and Secret items.
    const ordinary = FIXTURE_ITEMS.filter((item) => item.tier === 'personal');
    expect(findLeaks([{ label: 'docs', text: JSON.stringify(ordinary.map((i) => i.document)) }], forbiddenMarkers())).toEqual([]);
  });
});
