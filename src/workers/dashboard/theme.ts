/**
 * Calm Field: the single stylesheet all three dashboard pages share.
 *
 * One string, inlined into every page — no CDN, no external stylesheet, no
 * build step. The token values below are the design's ground truth and are
 * duplicated nowhere else; SVG glyphs need literal colors, so they read
 * DASHBOARD_STATUS_COLORS rather than a CSS variable.
 */
import type { DashboardStatus } from './vocabulary.ts';

export const DASHBOARD_THEME_TOKENS = {
  bg: '#101014',
  panel: '#17181D',
  panel2: '#1B1C22',
  line: '#30323A',
  line2: '#24252B',
  t1: '#ECECEA',
  t2: '#C9CAD0',
  t3: '#A9ABB3',
  t4: '#8C8E97',
  good: '#6CC08B',
  warn: '#E3AA45',
  run: '#AE9EF0',
  bad: '#F08276',
  off: '#8C8E97',
  warnBg: '#261E10',
  warnLine: '#8A6A2A',
  errBg: '#2B1614',
  errLine: '#B04A40',
  link: '#9DB4F0',
  linkLine: '#5A7BD6',
  accent: '#3E63C8',
  onAccent: '#FFFFFF',
  field: '#6A6D77',
  selected: '#2C4485',
} as const;

/**
 * The page backdrop. The page sits directly on it: there is no card frame
 * around the page any more (UX review 2026-10-01, release 3), so --bg and the
 * backdrop are one surface.
 */
export const DASHBOARD_PAGE_BACKDROP = DASHBOARD_THEME_TOKENS.bg;

/**
 * One small type scale (UX review 2026-10-01): page title, section heading,
 * row title, body, caption. Every font-size on the dashboard reads one of
 * these, so hierarchy comes from five sizes and weight, never from ten
 * near-identical sizes.
 */
export const DASHBOARD_TYPE_SCALE = {
  title: '22px',
  section: '16px',
  row: '15px',
  body: '14px',
  caption: '12.5px',
} as const;

/**
 * The text/background pairs the dashboard actually paints, for the WCAG AA
 * check in test/dashboard-theme.test.ts. Body text needs 4.5:1; UI component
 * edges (field borders, the secondary button outline, warning and error
 * borders) need 3:1.
 */
export const DASHBOARD_CONTRAST_PAIRS: ReadonlyArray<{
  fg: keyof typeof DASHBOARD_THEME_TOKENS;
  bg: keyof typeof DASHBOARD_THEME_TOKENS;
  min: 4.5 | 3;
}> = [
  ...(['t1', 't2', 't3', 't4', 'link', 'warn', 'bad', 'good', 'run'] as const).flatMap((fg) =>
    (['bg', 'panel', 'panel2', 'warnBg', 'errBg'] as const).map((bg) => ({ fg, bg, min: 4.5 as const }))),
  { fg: 'onAccent', bg: 'accent', min: 4.5 },
  { fg: 't1', bg: 'selected', min: 4.5 },
  { fg: 't2', bg: 'selected', min: 4.5 },
  { fg: 'accent', bg: 'bg', min: 3 },
  { fg: 'linkLine', bg: 'bg', min: 3 },
  { fg: 'linkLine', bg: 'panel', min: 3 },
  { fg: 'field', bg: 'bg', min: 3 },
  { fg: 'field', bg: 'panel', min: 3 },
  { fg: 'field', bg: 'panel2', min: 3 },
  { fg: 'warnLine', bg: 'bg', min: 3 },
  { fg: 'errLine', bg: 'bg', min: 3 },
  { fg: 'good', bg: 'bg', min: 3 },
];

/** Literal glyph color per status word. */
export const DASHBOARD_STATUS_COLORS: Readonly<Record<DashboardStatus, string>> = {
  'Fresh': DASHBOARD_THEME_TOKENS.good,
  'Working': DASHBOARD_THEME_TOKENS.run,
  'Waiting': DASHBOARD_THEME_TOKENS.off,
  'Needs you': DASHBOARD_THEME_TOKENS.warn,
  'Failing': DASHBOARD_THEME_TOKENS.bad,
  'Off': DASHBOARD_THEME_TOKENS.line,
};

// The custom-property name each token is published under. Written out rather
// than derived from the key so a rename on either side is a visible edit
// instead of a silently renamed variable no rule refers to any more.
const CSS_VARIABLE_NAMES: Readonly<Record<keyof typeof DASHBOARD_THEME_TOKENS, string>> = {
  bg: '--bg',
  panel: '--panel',
  panel2: '--panel2',
  line: '--line',
  line2: '--line2',
  t1: '--t1',
  t2: '--t2',
  t3: '--t3',
  t4: '--t4',
  good: '--good',
  warn: '--warn',
  run: '--run',
  bad: '--bad',
  off: '--off',
  warnBg: '--warn-bg',
  warnLine: '--warn-line',
  errBg: '--err-bg',
  errLine: '--err-line',
  link: '--link',
  linkLine: '--link-line',
  accent: '--accent-fill',
  onAccent: '--on-accent',
  field: '--field',
  selected: '--selected',
};

const PAGE_BACKDROP = DASHBOARD_PAGE_BACKDROP;

const MONO_STACK = '"Berkeley Mono","SF Mono",Menlo,Consolas,monospace';

const ROOT_BLOCK = [
  ':root {',
  ...(Object.keys(CSS_VARIABLE_NAMES) as Array<keyof typeof DASHBOARD_THEME_TOKENS>)
    .map((key) => `  ${CSS_VARIABLE_NAMES[key]}: ${DASHBOARD_THEME_TOKENS[key]};`),
  `  --mono: ${MONO_STACK};`,
  `  --fs-title: ${DASHBOARD_TYPE_SCALE.title};`,
  `  --fs-section: ${DASHBOARD_TYPE_SCALE.section};`,
  `  --fs-row: ${DASHBOARD_TYPE_SCALE.row};`,
  `  --fs-body: ${DASHBOARD_TYPE_SCALE.body};`,
  `  --fs-caption: ${DASHBOARD_TYPE_SCALE.caption};`,
  '}',
].join('\n');

/** The full stylesheet, already wrapped in nothing: callers put it in <style>. */
export const DASHBOARD_THEME_CSS: string = `${ROOT_BLOCK}
* { box-sizing: border-box; }
body { margin: 0; background: ${PAGE_BACKDROP}; color: var(--t1); font: var(--fs-body)/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; padding: 0 24px 80px; }
a { color: var(--link); }
/* No card around the page: the page is the surface, as wide as a reading
   layout allows, and every row below shares its left and right edges. */
.frame { max-width: 1120px; margin: 0 auto; }
.page { padding: 28px 0 40px; }
.top { display: flex; justify-content: space-between; align-items: baseline; gap: 14px; margin-bottom: 20px; }
.brand { font-weight: 650; font-size: var(--fs-title); letter-spacing: -.01em; }
.brand .lead { color: var(--t3); text-decoration: none; }
.brand a.lead:hover, .brand a.lead:focus-visible { color: var(--link); }
.brand .crumb { color: var(--t3); font-weight: 400; }
.meta { color: var(--t3); font-size: var(--fs-caption); }
.meta b { font-weight: 600; }
/* Section headings: sentence case at a readable size, never tiny capitals. */
.sect { font-size: var(--fs-section); font-weight: 600; color: var(--t1); margin: 28px 0 10px; }
.sect.attn { color: var(--warn); }
.sect.sub { font-size: var(--fs-body); color: var(--t2); margin: 18px 0 8px; }
.sect.sub.attn { color: var(--warn); }
.dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; flex: none; }
/* Every row is the same shape: a 20px lead column (icon or dot), the text,
   then the controls, so names line up from section to section. */
.attncard { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px 16px; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center; gap: 12px; min-height: 52px; }
.attncard::before { content: ''; flex: 0 0 20px; align-self: flex-start; margin-top: 1px; }
/* A problem is a tinted row with a 1px border and an icon, never a stripe. */
.attncard:not(.plain) { background: var(--warn-bg); border-color: var(--warn-line); }
.attncard:not(.plain)::before { content: '!'; height: 20px; border-radius: 50%; background: var(--warn); color: var(--bg); font-weight: 800; font-size: var(--fs-caption); line-height: 20px; text-align: center; }
.attncard.error { background: var(--err-bg); border-color: var(--err-line); }
.attncard.error::before { background: var(--bad); }
.attncard.plain { background: var(--panel); border-color: var(--line); }
.attncard .grow { flex: 1; }
/* The source page's ONE banner, and only it. A bare flex:1 gave the
   description a zero basis, so a banner carrying Sync now, its status text and
   an agent-prompt button squeezed a whole paragraph into a ~30-character column
   while the controls kept their intrinsic width (owner, 2026-09-04). With a
   basis the text keeps its width and the controls drop to their own row.
   Scoped to .banner: the list rows and the whole-row links are a different
   shape, and the mobile block below still owns what they do at 375px. */
.attncard.banner { flex-wrap: wrap; }
.attncard.banner .grow { flex: 1 1 320px; min-width: 0; }
.attncard .name { font-weight: 600; font-size: var(--fs-row); }
.attncard .why { color: var(--t2); font-size: var(--fs-body); }
/* A warning row that carries no control is itself the link to the detail page,
   so its whole rectangle is the hit zone. */
a.attncard.rowzone { display: flex; color: inherit; text-decoration: none; -webkit-user-drag: none; }
a.attncard.rowzone:hover { border-color: var(--link); }
a.attncard.rowzone:hover .name, a.attncard.rowzone:hover .go { color: var(--link); }
a.attncard.rowzone:focus-visible { outline: 2px solid var(--link); outline-offset: 2px; }
a.attncard.rowzone .go { color: var(--t3); font-size: var(--fs-body); }
/* A warning row that DOES carry a control keeps the control and links its name. */
.attncard a.name { color: inherit; text-decoration: underline; text-decoration-color: var(--line); text-underline-offset: 3px; }
.attncard a.name:hover { color: var(--link); text-decoration-color: var(--link); }
.attncard a.go { color: var(--t3); font-size: var(--fs-body); text-decoration: none; padding: 0 2px; }
.attncard a.go:hover { color: var(--link); }
.attncard a.name:focus-visible { outline: 2px solid var(--link); outline-offset: 3px; border-radius: 4px; }
.rowlink { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.rowlink .btn { text-decoration: none; display: inline-block; }
.blurb .ext { color: var(--link); }
.hint { color: var(--t3); font-size: var(--fs-caption); }
/* Two button styles and no third: filled for the row's one main action,
   outlined for everything else. Links are for navigation only. */
.btn { border: 1px solid var(--link-line); color: var(--link); border-radius: 7px; padding: 6px 14px; font: inherit; font-size: var(--fs-body); font-weight: 500; line-height: 1.3; background: none; cursor: pointer; white-space: nowrap; }
.btn:hover { background: var(--panel2); }
.btn:focus-visible { outline: 2px solid var(--link); outline-offset: 2px; }
.btn.primary { background: var(--accent-fill); border-color: var(--accent-fill); color: var(--on-accent); }
.btn.primary:hover { filter: brightness(1.12); }
/* A blocked control looks blocked and says why beside itself. */
.btn:disabled, .btn[aria-disabled="true"] { background: transparent; border: 1px dashed var(--line); color: var(--t4); cursor: not-allowed; filter: none; }
.blocked { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.blocked .hint { color: var(--t3); }
.blocked .hint::before { content: '\\1F512\\FE0E  '; font-size: 11px; }
/* The row's secondary acts (Disconnect, Provider access, Replace key, Cancel)
   live behind one ⋯ menu: a native <details>, so it works before any script. */
details.rowmenu { position: relative; flex: none; }
details.rowmenu > summary { list-style: none; padding: 4px 10px; font-size: var(--fs-row); line-height: 1.2; letter-spacing: .08em; border-color: var(--line); color: var(--t2); }
details.rowmenu > summary::-webkit-details-marker { display: none; }
details.rowmenu[open] > summary { background: var(--panel2); }
.rowmenu .menu { position: absolute; right: 0; top: calc(100% + 4px); z-index: 20; min-width: 200px; background: var(--panel2); border: 1px solid var(--line); border-radius: 9px; padding: 6px; box-shadow: 0 8px 24px rgba(0,0,0,.45); display: grid; gap: 2px; }
.rowmenu .menu form { display: grid; gap: 2px; margin: 0; }
.rowmenu .menu .btn, .rowmenu .menu a.hint { display: block; width: 100%; text-align: left; border: 0; border-radius: 6px; padding: 7px 10px; color: var(--t1); font-size: var(--fs-body); text-decoration: none; background: none; }
.rowmenu .menu .btn:hover, .rowmenu .menu a.hint:hover { background: var(--panel); color: var(--link); }
.rowmenu .menu .actmsg { padding: 0 10px; }
/* The page's one blocker: full width at the top, a real warning colour. */
.attncard.blocker { margin: 0 0 24px; padding: 16px 18px; }
.attncard.blocker .name { color: var(--t1); font-size: var(--fs-row); }
/* Technical detail under a problem, closed by default. */
details.howto { margin: 6px 0 0; }
details.howto > summary { color: var(--link); font-size: var(--fs-caption); cursor: pointer; }
details.howto > summary:hover { text-decoration: underline; }
details.howto[open] > summary { margin-bottom: 6px; }
details.howto p { margin: 0 0 6px; }
.cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 22px; }
.cards.four { grid-template-columns: repeat(4, 1fr); }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; }
.card .hd { display: flex; gap: 9px; align-items: center; font-weight: 600; font-size: var(--fs-row); }
.card .ln { color: var(--t3); font-size: var(--fs-caption); margin-top: 6px; }
/* The whole card is the link. Hover and focus land on the card, not the name:
   the border warms and the name follows it, so the affordance is the shape the
   pointer is actually over. -webkit-user-drag keeps a text selection inside the
   card from turning into a link drag. */
a.card.cardlink { display: block; color: inherit; text-decoration: none; -webkit-user-drag: none; }
a.card.cardlink:hover { border-color: var(--link-line); }
a.card.cardlink:hover .hd { color: var(--link); }
a.card.cardlink:focus-visible { outline: 2px solid var(--link); outline-offset: 2px; }
.bar { height: 8px; background: var(--line2); border: 1px solid var(--line); border-radius: 5px; overflow: hidden; margin-top: 9px; max-width: 420px; }
.bar i { display: block; height: 100%; background: var(--run); }
.foot { color: var(--t3); font-size: var(--fs-caption); margin-top: 24px; }
.kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 16px 0 22px; }
.kpi { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; }
.kpi .u { font-size: var(--fs-caption); color: var(--t3); }
.kpi .n { font-size: var(--fs-section); font-weight: 650; margin-top: 3px; font-variant-numeric: tabular-nums; }
.kpi .s { font-size: var(--fs-caption); color: var(--t3); margin-top: 1px; }
.selectioncounts { display: flex; gap: 24px; flex-wrap: wrap; margin-bottom: 22px; }
.selectioncounts div { display: flex; gap: 8px; align-items: baseline; }
.selectioncounts span { color: var(--t3); font-size: var(--fs-caption); }
.selectioncounts b { color: var(--t1); font-size: var(--fs-body); font-weight: 600; font-variant-numeric: tabular-nums; }
.dsect { font-size: var(--fs-section); font-weight: 600; color: var(--t1); margin: 28px 0 10px; }
/* A heading one level under .dsect: sentence case, because it is a sentence
   about the chips beneath it rather than another section label. */
.subsect { font-size: var(--fs-caption); color: var(--t3); margin: 12px 0 6px; }
/* The who-acts summary, directly under its section heading — .foot's 22px top
   margin would detach it from the total it is explaining. */
.reviewsum { color: var(--t3); font-size: var(--fs-caption); margin: 0 0 4px; }
.bigstrip { display: flex; gap: 3px; margin: 8px 0 4px; }
.bigstrip i { width: 14px; height: 30px; border-radius: 2.5px; display: block; }
.stripcap { display: flex; justify-content: space-between; color: var(--t3); font-size: var(--fs-caption); margin-bottom: 4px; }
.tip { background: var(--panel2); border: 1px solid var(--line); border-radius: 8px; padding: 11px 14px; font-family: var(--mono); font-size: var(--fs-caption); color: var(--t2); margin: 10px 0 4px; max-width: 640px; }
.tip .h { color: var(--t3); font-size: var(--fs-caption); font-family: system-ui, sans-serif; font-weight: 600; margin-bottom: 4px; }
/* The consequence line under a failing check: plain language, in the page's own
   font, so the mechanical row above it stays the evidence and this stays the
   meaning. */
.tip .cq { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; font-size: var(--fs-caption); color: var(--t3); margin: 2px 0 8px 15px; }
.tip > .cq:last-child { margin-bottom: 0; }
/* Passing checks, collapsed. A page whose header reports a fault opens with the
   fault; the green rows are evidence a reader may unfold. */
.evidence { background: var(--panel2); border: 1px solid var(--line); border-radius: 8px; padding: 8px 14px; font-family: var(--mono); font-size: var(--fs-caption); color: var(--t2); margin: 6px 0 4px; max-width: 640px; }
.evidence > summary { color: var(--t3); font-size: var(--fs-caption); font-family: system-ui, sans-serif; font-weight: 600; cursor: pointer; }
.evidence > summary:focus-visible { outline: 2px solid var(--link); outline-offset: 2px; }
.evidence[open] > summary { margin-bottom: 4px; }
.ok { color: var(--good); }
.no { color: var(--bad); }
table { border-collapse: collapse; width: 100%; font-size: var(--fs-caption); font-variant-numeric: tabular-nums; }
th { text-align: left; color: var(--t3); font-size: var(--fs-caption); font-weight: 600; padding: 5px 10px 5px 0; border-bottom: 1px solid var(--line); }
td { padding: 7px 10px 7px 0; border-bottom: 1px solid var(--line2); color: var(--t2); }
.setrow { display: grid; grid-template-columns: 20px minmax(140px, 200px) 1fr auto; gap: 12px; align-items: center; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px 16px; margin-bottom: 8px; min-height: 52px; }
.setrow > .dot { justify-self: center; }
.setrow.noblurb { grid-template-columns: 20px 1fr auto; }
.setrow .name { font-weight: 600; font-size: var(--fs-row); color: var(--t1); }
.setrow .blurb { color: var(--t2); font-size: var(--fs-body); }
.setrow .blurb .caveat { color: var(--warn); font-weight: 600; }
.setrow .blurb details.howto { color: var(--t3); font-size: var(--fs-caption); }
.rowform { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.keyfield { background: var(--bg); border: 1px solid var(--field); border-radius: 7px; color: var(--t1); font: inherit; font-size: var(--fs-body); padding: 5px 10px; width: 190px; }
.keyfield::placeholder { color: var(--t4); }
.keyfield:focus-visible { outline: 2px solid var(--link); outline-offset: 1px; }
.actmsg { color: var(--t3); font-size: var(--fs-caption); }
.actmsg:empty { display: none; }
.copystatus { color: var(--t3); font-size: var(--fs-caption); margin-left: 8px; }
/* A panel opens in place: directly under the row that opened it, joined to
   it, never further down the page. */
.sheet { display: none; background: var(--panel2); border: 1px solid var(--line); border-radius: 10px; padding: 16px 18px; margin: -4px 0 12px; }
.sheet.on { display: block; }
.sheet h4 { margin: 0 0 6px; font-size: var(--fs-row); }
.sheet p { color: var(--t2); font-size: var(--fs-body); margin: 0 0 10px; max-width: 72ch; }
.sheet .providernote { background: var(--warn-bg); border: 1px solid var(--warn-line); border-radius: 8px; padding: 9px 12px; }
.sheet .providernote::before { content: '! '; color: var(--warn); font-weight: 800; }
.promptbox { background: var(--bg); border: 1px solid var(--line); border-radius: 7px; padding: 12px 14px; font-family: var(--mono); font-size: var(--fs-caption); color: var(--t2); white-space: pre-wrap; user-select: all; margin-bottom: 10px; word-break: break-all; }
/* The popup-blocked authorization link. Empty on every render that did not
   need it, so it must take no space until the script fills it in. */
.authfallback { margin-left: 8px; }
.authfallback:empty { display: none; }
/* A sheet's own labels above the redirect URI and under it. .hint is a 12px
   quiet line everywhere else on the page; inside a sheet it needs its own
   block spacing so the URI is not glued to the guidance under it. */
.sheet .hint { display: block; margin: 0 0 6px; }
/* The numbered callback-registration walkthrough. Numbers are the point — the
   owner is following them in another window — so they stay outside the text
   column and the rows breathe. */
.sheet .steps { margin: 0 0 14px; padding-left: 22px; color: var(--t2); font-size: var(--fs-body); max-width: 72ch; }
.sheet .steps li { margin-bottom: 10px; }
.sheet .steps li:last-child { margin-bottom: 0; }
.sheet .steps b { color: var(--t1); font-weight: 600; }
.sheet .steps .promptbox { margin-top: 6px; }
.sheet .steps .ext { color: var(--link); }
/* The agent prompt, now secondary to the steps above it. */
.sheet .agentprompt { margin-top: 14px; }
.sheet .agentprompt summary { color: var(--link); font-size: var(--fs-caption); cursor: pointer; margin-bottom: 8px; }
.sheet .agentprompt summary:hover { text-decoration: underline; }
@media (max-width: 700px) {
  body { padding: 0 16px 60px; }
  .page { padding: 20px 0 28px; }
  .cards, .cards.four { grid-template-columns: 1fr 1fr; }
  .kpis { grid-template-columns: 1fr 1fr; }
  .setrow { grid-template-columns: 20px 1fr auto; }
  .setrow .blurb { grid-column: 1 / -1; grid-row: 2; }
  .setrow .btn { justify-self: end; width: max-content; }
  /* A row's control and its hint wrap under the reason rather than squeezing
     the name to nothing on a 375px screen. A whole-row link is excluded: its
     arrow is one glyph and belongs beside the text, not on a line of its own. */
  .attncard:not(.rowzone) { flex-wrap: wrap; }
  .attncard:not(.rowzone) .grow { flex-basis: calc(100% - 32px); }
  .rowlink { width: 100%; justify-content: flex-end; }
}
`;
