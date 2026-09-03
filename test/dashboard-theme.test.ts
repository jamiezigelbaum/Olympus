import { describe, expect, test } from 'bun:test';
import {
  DASHBOARD_STATUS_COLORS,
  DASHBOARD_THEME_CSS,
  DASHBOARD_THEME_TOKENS,
} from '../src/workers/dashboard/theme.ts';
import {
  DASHBOARD_LANE_CSS,
  attentionRow,
  backgroundRow,
  connectorSheet,
  laneRow,
  pageShell,
  progressBar,
  setupRow,
  sourceCard,
} from '../src/workers/dashboard/components.ts';
import {
  DASHBOARD_STATUS_ORDER,
  DASHBOARD_STATUS_PRESENTATION,
  type DashboardStatus,
} from '../src/workers/dashboard/vocabulary.ts';

// The Calm Field palette, copied off the mockup's :root block rather than off
// the token object, so a drifted value fails here instead of agreeing with
// itself.
const MOCKUP_TOKENS: Array<[string, string]> = [
  ['--bg', '#101014'],
  ['--panel', '#15161A'],
  ['--panel2', '#17181D'],
  ['--line', '#26272C'],
  ['--line2', '#1E1F24'],
  ['--t1', '#ECECEA'],
  ['--t2', '#B9BAC0'],
  ['--t3', '#7C7E86'],
  ['--t4', '#55575E'],
  ['--good', '#4E9468'],
  ['--warn', '#B08430'],
  ['--run', '#8F7BD8'],
  ['--bad', '#C4574D'],
  ['--off', '#6B6E76'],
  ['--warn-bg', '#1B1913'],
  ['--warn-line', '#4A3D22'],
  ['--link', '#8FA8E8'],
  ['--link-line', '#3A5AA8'],
];

describe('dashboard theme tokens', () => {
  test('publishes every Calm Field token at the mockup value', () => {
    for (const [name, value] of MOCKUP_TOKENS) {
      expect(DASHBOARD_THEME_CSS).toContain(`${name}: ${value};`);
    }
  });

  test('keeps the token object and the stylesheet on the same values', () => {
    for (const value of Object.values(DASHBOARD_THEME_TOKENS)) {
      expect(DASHBOARD_THEME_CSS).toContain(value);
    }
  });

  test('colors every status word from a token', () => {
    const tokenValues = new Set<string>(Object.values(DASHBOARD_THEME_TOKENS));
    for (const status of DASHBOARD_STATUS_ORDER) {
      const color = DASHBOARD_STATUS_COLORS[status];
      expect(tokenValues.has(color)).toBe(true);
    }
  });

  test('agrees with the vocabulary about which token colors which status', () => {
    for (const status of DASHBOARD_STATUS_ORDER) {
      const presentation = DASHBOARD_STATUS_PRESENTATION[status];
      const token = DASHBOARD_THEME_TOKENS[presentation.colorToken];
      expect(DASHBOARD_STATUS_COLORS[status]).toBe(token);
    }
  });

  test('covers exactly the six status words', () => {
    expect(Object.keys(DASHBOARD_STATUS_COLORS).sort()).toEqual(
      ([...DASHBOARD_STATUS_ORDER] as DashboardStatus[]).sort(),
    );
  });
});

describe('dashboard stylesheet', () => {
  test('carries the classes the three pages are built from', () => {
    // Rule openers, not bare substrings: '.card {' cannot pass on '.cards',
    // and '.no {' cannot pass on any word containing "no".
    for (const rule of [
      '.frame {',
      '.page {',
      '.top {',
      '.brand {',
      '.meta {',
      '.sect {',
      '.sect.attn {',
      '.dot {',
      '.attncard {',
      '.attncard.plain {',
      '.attncard .grow {',
      '.attncard .name {',
      '.btn {',
      '.btn.primary {',
      '.cards {',
      '.card {',
      // The whole card is the link now, so the rule that carries the link
      // treatment is the card's own, not one on the name inside it.
      'a.card.cardlink {',
      'a.attncard.rowzone {',
      '.rowlink {',
      '.hint {',
      '.bar {',
      '.foot {',
      '.kpis {',
      '.kpi {',
      '.dsect {',
      '.setrow {',
      '.setrow.noblurb {',
      '.setrow .name {',
      '.setrow .blurb {',
      '.sheet {',
      '.sheet.on {',
      '.promptbox {',
    ]) {
      expect(DASHBOARD_THEME_CSS).toContain(rule);
    }
  });

  test('drops the mockup scaffolding and the sections that have no data behind them', () => {
    // .mocknav/.mocktab switch between the three mockup views; .feed styles
    // the activity feed, which has no event stream behind it anywhere in the
    // view model. The run strip and the checks tip DID land (detail renders
    // them from last_run/schedule), so their selectors live in the sheet now.
    for (const selector of ['.mocknav', '.mocktab', '.feed', '.setcards']) {
      expect(DASHBOARD_THEME_CSS).not.toContain(selector);
    }
    for (const rule of ['.bigstrip {', '.bigstrip i {', '.stripcap {', '.tip {', '.tip .h {', '.ok {', '.no {']) {
      expect(DASHBOARD_THEME_CSS).toContain(rule);
    }
  });

  test('every class the components emit has a rule to land on', () => {
    // The drift this pins: a component emitting a class no stylesheet styles
    // (the old a.cardlink), or a rule pointing at markup nothing emits.
    const css = DASHBOARD_THEME_CSS + DASHBOARD_LANE_CSS;
    const samples = [
      pageShell({ title: 'Olympus', crumb: 'Gmail', meta: 'Working', body: '' }),
      sourceCard({ label: 'Gmail', status: 'Working', subLine: 'indexing', fraction: 0.5, href: '/dashboard?source=g' }),
      attentionRow({
        label: 'Dropbox',
        why: 'reauth required',
        attention: false,
        barPercent: 8,
        action: { label: 'Connect', kind: 'api_key', source: 'readwise' },
      }),
      setupRow({ label: 'Readwise', blurb: '', action: { label: 'Connect', kind: 'api_key', source: 'readwise' } }),
      setupRow({ label: 'Something else', blurb: 'Build it', action: { label: 'Build', kind: 'none', sheet: 'x' } }),
      connectorSheet({ id: 'x', heading: 'h', intro: 'i', promptText: 'p', copyButtonLabel: 'Copy' }),
      laneRow({ name: 'Syncs', facts: 'all on schedule', percent: 50, strip: [{ tone: 'good', label: 'Gmail' }], stripLabel: 'runs' }),
      backgroundRow({ href: '/dashboard?background', label: 'Background', lines: [{ name: 'Embeddings', facts: '50%', percent: 50 }] }),
      progressBar({ percent: 8, label: '8 percent' }),
    ].join('\n');
    const classes = new Set(
      [...samples.matchAll(/class="([^"]+)"/g)].flatMap((match) => (match[1] ?? '').split(/\s+/)),
    );
    expect(classes.size).toBeGreaterThan(10);
    for (const token of classes) {
      expect(`${token}: ${new RegExp(`\\.${token}(?![\\w-])`).test(css)}`).toBe(`${token}: true`);
    }
  });

  test('is balanced, so an inlined <style> cannot swallow the page', () => {
    const opens = [...DASHBOARD_THEME_CSS].filter((character) => character === '{').length;
    const closes = [...DASHBOARD_THEME_CSS].filter((character) => character === '}').length;
    expect(opens).toBe(closes);
    expect(DASHBOARD_THEME_CSS).not.toContain('</style');
  });
});
