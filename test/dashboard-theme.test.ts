import { describe, expect, test } from 'bun:test';
import {
  DASHBOARD_CONTRAST_PAIRS,
  DASHBOARD_STATUS_COLORS,
  DASHBOARD_THEME_CSS,
  DASHBOARD_THEME_TOKENS,
  DASHBOARD_TYPE_SCALE,
} from '../src/workers/dashboard/theme.ts';
import {
  AGENT_CONNECT_CSS,
  BACKGROUND_CSS,
  DASHBOARD_NAV_CSS,
  DASHBOARD_POLICY_CSS,
  DASHBOARD_PROGRESS_CSS,
  DISPOSITIONS_CSS,
  MODEL_SETUP_CSS,
  SETUP_JOURNEY_CSS,
} from '../src/workers/dashboard/static-styles.ts';
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

// The palette, written out rather than read off the token object, so a drifted
// value fails here instead of agreeing with itself. Release 3 of the
// 2026-10-01 UX review raised secondary text, warnings and errors to WCAG AA.
const MOCKUP_TOKENS: Array<[string, string]> = [
  ['--bg', '#101014'],
  ['--panel', '#17181D'],
  ['--panel2', '#1B1C22'],
  ['--line', '#30323A'],
  ['--line2', '#24252B'],
  ['--t1', '#ECECEA'],
  ['--t2', '#C9CAD0'],
  ['--t3', '#A9ABB3'],
  ['--t4', '#8C8E97'],
  ['--good', '#6CC08B'],
  ['--warn', '#E3AA45'],
  ['--run', '#AE9EF0'],
  ['--bad', '#F08276'],
  ['--off', '#8C8E97'],
  ['--warn-bg', '#261E10'],
  ['--warn-line', '#8A6A2A'],
  ['--err-bg', '#2B1614'],
  ['--err-line', '#B04A40'],
  ['--link', '#9DB4F0'],
  ['--link-line', '#5A7BD6'],
  ['--accent-fill', '#3E63C8'],
  ['--on-accent', '#FFFFFF'],
  ['--field', '#6A6D77'],
  ['--selected', '#2C4485'],
];

/** WCAG 2.x relative luminance and contrast ratio. */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255)
    .map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe('dashboard contrast (WCAG AA)', () => {
  test('the contrast check itself matches known ratios', () => {
    expect(contrast('#FFFFFF', '#000000')).toBeCloseTo(21, 5);
    expect(contrast('#777777', '#FFFFFF')).toBeCloseTo(4.48, 2);
  });

  test('every text and component colour meets AA on every surface it is painted on', () => {
    const failures = DASHBOARD_CONTRAST_PAIRS
      .map(({ fg, bg, min }) => ({ pair: `${fg} on ${bg}`, ratio: contrast(DASHBOARD_THEME_TOKENS[fg], DASHBOARD_THEME_TOKENS[bg]), min }))
      .filter(({ ratio, min }) => ratio < min)
      .map(({ pair, ratio, min }) => `${pair}: ${ratio.toFixed(2)} < ${min}`);
    expect(failures).toEqual([]);
    expect(DASHBOARD_CONTRAST_PAIRS.length).toBeGreaterThan(40);
  });

  test('the stylesheets paint text only from tokens', () => {
    // A literal colour would be a pair the check above never sees.
    const sheets = [DASHBOARD_THEME_CSS, DASHBOARD_LANE_CSS, DASHBOARD_PROGRESS_CSS, DASHBOARD_POLICY_CSS, DASHBOARD_NAV_CSS,
      BACKGROUND_CSS, DISPOSITIONS_CSS, AGENT_CONNECT_CSS, MODEL_SETUP_CSS, SETUP_JOURNEY_CSS].join('\n');
    const literalText = [...sheets.matchAll(/(?<![-\w])color:\s*(#[0-9A-Fa-f]{3,8})/g)].map((match) => match[1]);
    expect(literalText).toEqual([]);
  });

  test('every font size is one of the five type-scale tokens', () => {
    const sheets = [DASHBOARD_THEME_CSS, DASHBOARD_LANE_CSS, DASHBOARD_PROGRESS_CSS, DASHBOARD_POLICY_CSS, DASHBOARD_NAV_CSS,
      BACKGROUND_CSS, DISPOSITIONS_CSS, AGENT_CONNECT_CSS, MODEL_SETUP_CSS, SETUP_JOURNEY_CSS].join('\n');
    const sizes = new Set([...sheets.matchAll(/font-size:\s*([^;}]+)/g)].map((match) => match[1]!.trim()));
    const allowed = new Set(Object.keys(DASHBOARD_TYPE_SCALE).map((name) => `var(--fs-${name})`));
    // Two decorative glyphs (the inspector folder and the blocked-control lock)
    // are icons, not text on the scale.
    const off = [...sizes].filter((size) => !allowed.has(size) && size !== '30px' && size !== '11px');
    expect(off).toEqual([]);
    expect(sheets).not.toContain('text-transform: uppercase');
  });
});

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

  test("gives an attention banner's description a width floor and lets the controls wrap below it", () => {
    // The banner paragraph was squeezed into a ~30-character column beside the
    // Sync now button, its status text and the agent-prompt control (owner,
    // 2026-09-04): the text column had a zero flex basis while the controls
    // kept their intrinsic width.
    expect(DASHBOARD_THEME_CSS).toContain('.attncard.banner { flex-wrap: wrap; }');
    expect(DASHBOARD_THEME_CSS).toContain('.attncard.banner .grow { flex: 1 1 320px; min-width: 0; }');
  });

  test('leaves every other attention-card shape exactly as it was', () => {
    // The source page's one banner is a paragraph with controls; the home rows
    // and the whole-row links are neither, and the mobile block below owns what
    // they do at 375px -- including the documented exclusion that keeps a
    // row-link's single chevron beside its text rather than on its own line.
    const base = DASHBOARD_THEME_CSS.split('\n').find((line) => line.startsWith('.attncard {'))!;
    expect(base).not.toContain('flex-wrap');
    expect(DASHBOARD_THEME_CSS).toContain('.attncard .grow { flex: 1; }');
    expect(DASHBOARD_THEME_CSS).toContain('.attncard:not(.rowzone) { flex-wrap: wrap; }');
    // The mobile rule is declared after the banner rule, so at 375px the
    // banner's basis gives way to the full-width one rather than fighting it.
    expect(DASHBOARD_THEME_CSS.indexOf('.attncard:not(.rowzone) .grow'))
      .toBeGreaterThan(DASHBOARD_THEME_CSS.indexOf('.attncard.banner .grow'));
  });

  test('is balanced, so an inlined <style> cannot swallow the page', () => {
    const opens = [...DASHBOARD_THEME_CSS].filter((character) => character === '{').length;
    const closes = [...DASHBOARD_THEME_CSS].filter((character) => character === '}').length;
    expect(opens).toBe(closes);
    expect(DASHBOARD_THEME_CSS).not.toContain('</style');
  });
});
