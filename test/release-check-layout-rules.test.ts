// The layout rules: what the page measures about its own look, how a screen's findings become a check (advisory until the rules
// qualify), and how a qualification run scores them against the bugs planted for them. The rules themselves need a browser's layout;
// a qualification run in the real test browser is their proof. Here the page script must at least run and return findings.

import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { LAYOUT_RULES, LAYOUT_RULES_BLOCKING, layoutChecks, layoutFindings, layoutQualificationCheck, layoutRulesScript, scoreLayoutRules, type LayoutFinding } from '../scripts/release-check/layout-rules.ts';
import { PLANTS } from '../scripts/release-check/reviewer-plants.ts';

const finding = (rule: LayoutFinding['rule'], where = 'button "Connect" at 10,20'): LayoutFinding => ({ rule, what: `a ${rule} problem`, where });

describe('layout rules', () => {
  test('the page script runs in a page and returns a list', () => {
    const window = new Window({ url: 'http://127.0.0.1:8010/dashboard' });
    window.document.body.innerHTML = '<main><h1>Olympus</h1><p>Gmail</p><p>Not connected</p><button>Connect</button><button>Connect</button></main>';
    const found = new Function('window', 'document', 'getComputedStyle', 'scrollX', 'scrollY', `return ${layoutRulesScript()};`)(window, window.document, window.getComputedStyle.bind(window), 0, 0);
    expect(Array.isArray(found)).toBe(true);
  });

  test('findings from every frame are kept, anything malformed is dropped', () => {
    const long = 'x'.repeat(400);
    const frames = [
      [finding('monospace-text'), { rule: 'taste', what: 'x', where: 'y' }, { rule: 'faint-text', what: 3, where: 'y' }, null],
      'no such frame',
      [{ rule: 'clipped-text', what: long, where: 'h2 "Sources"' }],
    ];
    const kept = layoutFindings(frames);
    expect(kept.map((item) => item.rule)).toEqual(['monospace-text', 'clipped-text']);
    expect(kept[1]!.what.length).toBe(300);
  });

  test('a screen with a finding warns while the rules are advisory and fails once they block; a clean one passes', () => {
    expect(LAYOUT_RULES_BLOCKING).toBe(false);
    const screens = [{ name: 'keys-1280-dark', layout: [finding('misaligned-controls')] }, { name: 'ask-390-light', layout: [] }, { name: 'not-measured' }];
    const advisory = layoutChecks(screens);
    expect(advisory.map((check) => [check.id, check.status])).toEqual([['layout.keys-1280-dark', 'warn'], ['layout.ask-390-light', 'pass']]);
    expect(advisory[0]!.title).toContain('advisory');
    expect(advisory[0]!.detail).toContain('misaligned-controls: a misaligned-controls problem — button "Connect" at 10,20');
    expect(layoutChecks(screens, true).map((check) => check.status)).toEqual(['fail', 'pass']);
  });

  test('every look bug a qualification plants is a layout rule\'s', () => {
    const rules = new Set(PLANTS.map((plant) => plant.kind).filter((kind) => (LAYOUT_RULES as readonly string[]).includes(kind)));
    expect([...rules].sort()).toEqual([...LAYOUT_RULES].sort());
  });

  const picture = (plant: string | null, kind: string | null, layout?: LayoutFinding[]) => ({ picture: `keys-1280-dark/${plant ?? 'clean'}.png`, plant, kind, ...(layout ? { layout } : {}) });

  test('the rules qualify when every planted bug is caught by its rule and nothing is found where nothing was planted', () => {
    const score = scoreLayoutRules([
      picture(null, null, []),
      picture('font-monospace', 'monospace-text', [finding('monospace-text')]),
      picture('button-misaligned', 'misaligned-controls', [finding('misaligned-controls'), finding('faint-text')]),
      // A reviewer's bug and a picture the rules never measured are not theirs to score.
      picture('developer-words', 'words', []),
      picture('label-clipped', 'clipped-text'),
    ]);
    expect(score.qualified).toBe(true);
    expect(score.perPlant).toEqual([
      { plant: 'font-monospace', rule: 'monospace-text', looked: 1, found: 1 },
      { plant: 'button-misaligned', rule: 'misaligned-controls', looked: 1, found: 1 },
    ]);
    expect(layoutQualificationCheck(score)).toMatchObject({ id: 'layout.qualification', status: 'pass', detail: 'font-monospace: 1/1, button-misaligned: 1/1' });
  });

  test('a missed bug, a finding of another rule, or a finding on a clean picture keeps them from qualifying, and says so', () => {
    const score = scoreLayoutRules([
      picture(null, null, [finding('overlapping-text', 'p "Ready" / p "Gmail"')]),
      picture('text-overlap', 'overlapping-text', [finding('clipped-text')]),
    ]);
    expect(score.qualified).toBe(false);
    expect(score.clean).toEqual([{ picture: 'keys-1280-dark/clean.png', ...finding('overlapping-text', 'p "Ready" / p "Gmail"') }]);
    const check = layoutQualificationCheck(score);
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('missed: text-overlap (overlapping-text) found on 0 of 1');
    expect(check.detail).toContain('on pictures with nothing planted: keys-1280-dark/clean.png: overlapping-text');
    expect(layoutQualificationCheck(scoreLayoutRules([picture(null, null, [])]))).toMatchObject({ status: 'fail', detail: 'no planted picture was measured' });
  });
});
