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
  panel: '#15161A',
  panel2: '#17181D',
  line: '#26272C',
  line2: '#1E1F24',
  t1: '#ECECEA',
  t2: '#B9BAC0',
  t3: '#7C7E86',
  t4: '#55575E',
  good: '#4E9468',
  warn: '#B08430',
  run: '#8F7BD8',
  bad: '#C4574D',
  off: '#6B6E76',
  warnBg: '#1B1913',
  warnLine: '#4A3D22',
  link: '#8FA8E8',
  linkLine: '#3A5AA8',
} as const;

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
  link: '--link',
  linkLine: '--link-line',
};

// One step darker than --bg, so the page sits as a panel on a backdrop rather
// than filling the viewport edge to edge. Not a token: nothing but the body
// backdrop uses it, and the six status colors are what the token set is for.
const PAGE_BACKDROP = '#0B0B0E';

const MONO_STACK = '"Berkeley Mono","SF Mono",Menlo,Consolas,monospace';

const ROOT_BLOCK = [
  ':root {',
  ...(Object.keys(CSS_VARIABLE_NAMES) as Array<keyof typeof DASHBOARD_THEME_TOKENS>)
    .map((key) => `  ${CSS_VARIABLE_NAMES[key]}: ${DASHBOARD_THEME_TOKENS[key]};`),
  `  --mono: ${MONO_STACK};`,
  '}',
].join('\n');

/** The full stylesheet, already wrapped in nothing: callers put it in <style>. */
export const DASHBOARD_THEME_CSS: string = `${ROOT_BLOCK}
* { box-sizing: border-box; }
body { margin: 0; background: ${PAGE_BACKDROP}; color: var(--t1); font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; padding: 0 20px 80px; }
a { color: var(--link); }
.frame { max-width: 920px; margin: 0 auto; }
.page { background: var(--bg); border: 1px solid var(--line); border-radius: 14px; padding: 30px 34px 38px; margin-top: 20px; box-shadow: 0 2px 12px rgba(0,0,0,.4); }
.top { display: flex; justify-content: space-between; align-items: baseline; gap: 14px; margin-bottom: 24px; }
.brand { font-weight: 600; letter-spacing: .02em; font-size: 15px; }
.brand .lead { color: var(--t3); text-decoration: none; }
.brand a.lead:hover, .brand a.lead:focus-visible { color: var(--link); }
.brand .crumb { color: var(--t3); font-weight: 400; }
.meta { color: var(--t3); font-size: 12px; }
.meta b { font-weight: 600; }
.sect { font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: var(--t4); margin: 0 0 8px; }
.sect.attn { color: var(--warn); }
.dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; flex: none; }
/* The text column gets a floor, and the row may wrap. A bare flex:1 gave the
   description a zero basis, so a banner carrying Sync now, its status text and
   an agent-prompt button squeezed a whole paragraph into a ~30-character column
   while the controls kept their intrinsic width (owner, 2026-09-04). With a
   basis the text keeps its width and the controls drop to their own row. */
.attncard { background: var(--warn-bg); border: 1px solid var(--warn-line); border-radius: 9px; padding: 12px 15px; margin-bottom: 24px; display: flex; justify-content: space-between; align-items: center; gap: 14px; flex-wrap: wrap; }
.attncard.plain { background: var(--panel); border-color: var(--line2); }
.attncard .grow { flex: 1 1 320px; min-width: 0; }
.attncard .name { font-weight: 600; }
.attncard .why { color: var(--t3); font-size: 12.5px; }
/* A warning row that carries no control is itself the link to the detail page,
   so its whole rectangle is the hit zone. */
a.attncard.rowzone { display: flex; color: inherit; text-decoration: none; -webkit-user-drag: none; }
a.attncard.rowzone:hover { border-color: var(--link); }
a.attncard.rowzone:hover .name, a.attncard.rowzone:hover .go { color: var(--link); }
a.attncard.rowzone:focus-visible { outline: 1px solid var(--link); outline-offset: 2px; }
a.attncard.rowzone .go { color: var(--t4); font-size: 13px; }
/* A warning row that DOES carry a control keeps the control and links its name. */
.attncard a.name { color: inherit; text-decoration: underline; text-decoration-color: var(--line2); text-underline-offset: 3px; }
.attncard a.name:hover { color: var(--link); text-decoration-color: var(--link); }
.attncard a.go { color: var(--t4); font-size: 13px; text-decoration: none; padding: 0 2px; }
.attncard a.go:hover { color: var(--link); }
.attncard a.name:focus-visible { outline: 1px solid var(--link); outline-offset: 3px; border-radius: 4px; }
.rowlink { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.rowlink .btn { text-decoration: none; display: inline-block; }
.blurb .ext { color: var(--link); }
.hint { color: var(--t4); font-size: 12px; }
.btn { border: 1px solid var(--link-line); color: var(--link); border-radius: 6px; padding: 4px 13px; font-size: 12.5px; background: none; cursor: pointer; white-space: nowrap; font: inherit; }
.btn:focus-visible { outline: 1px solid var(--link); outline-offset: 2px; }
.btn.primary { background: var(--link-line); color: #E8EDF8; }
.btn.quiet { border-color: transparent; color: var(--t4); }
.btn.quiet:hover { border-color: var(--line2); color: var(--t2); }
.cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 22px; }
.cards.four { grid-template-columns: repeat(4, 1fr); }
.card { background: var(--panel); border: 1px solid var(--line2); border-radius: 9px; padding: 12px 14px; }
.card .hd { display: flex; gap: 9px; align-items: center; font-weight: 600; font-size: 13.5px; }
.card .ln { color: var(--t3); font-size: 12px; margin-top: 6px; }
/* The whole card is the link. Hover and focus land on the card, not the name:
   the border warms and the name follows it, so the affordance is the shape the
   pointer is actually over. -webkit-user-drag keeps a text selection inside the
   card from turning into a link drag. */
a.card.cardlink { display: block; color: inherit; text-decoration: none; -webkit-user-drag: none; }
a.card.cardlink:hover { border-color: var(--link-line); }
a.card.cardlink:hover .hd { color: var(--link); }
a.card.cardlink:focus-visible { outline: 1px solid var(--link); outline-offset: 2px; }
.bar { height: 3px; background: var(--line); border-radius: 2px; overflow: hidden; margin-top: 9px; max-width: 340px; }
.bar i { display: block; height: 100%; background: var(--run); }
.foot { color: var(--t4); font-size: 12px; margin-top: 22px; }
.kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 16px 0 22px; }
.kpi { background: var(--panel); border: 1px solid var(--line2); border-radius: 9px; padding: 11px 13px; }
.kpi .u { font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--t4); }
.kpi .n { font-size: 17px; font-weight: 650; margin-top: 3px; font-variant-numeric: tabular-nums; }
.kpi .s { font-size: 11px; color: var(--t3); margin-top: 1px; }
.selectioncounts { display: flex; gap: 24px; flex-wrap: wrap; margin-bottom: 22px; }
.selectioncounts div { display: flex; gap: 8px; align-items: baseline; }
.selectioncounts span { color: var(--t3); font-size: 12.5px; }
.selectioncounts b { color: var(--t1); font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; }
.dsect { font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: var(--t4); margin: 24px 0 8px; }
/* A heading one level under .dsect: sentence case, because it is a sentence
   about the chips beneath it rather than another section label. */
.subsect { font-size: 11.5px; color: var(--t3); margin: 12px 0 6px; }
/* The who-acts summary, directly under its section heading — .foot's 22px top
   margin would detach it from the total it is explaining. */
.reviewsum { color: var(--t3); font-size: 12px; margin: 0 0 4px; }
.bigstrip { display: flex; gap: 3px; margin: 8px 0 4px; }
.bigstrip i { width: 14px; height: 30px; border-radius: 2.5px; display: block; }
.stripcap { display: flex; justify-content: space-between; color: var(--t4); font-size: 11px; margin-bottom: 4px; }
.tip { background: var(--panel2); border: 1px solid var(--line); border-radius: 8px; padding: 11px 14px; font-family: var(--mono); font-size: 11.5px; color: var(--t2); margin: 10px 0 4px; max-width: 520px; }
.tip .h { color: var(--t4); font-size: 10px; letter-spacing: .1em; text-transform: uppercase; font-family: system-ui, sans-serif; margin-bottom: 4px; }
/* The consequence line under a failing check: plain language, in the page's own
   font, so the mechanical row above it stays the evidence and this stays the
   meaning. */
.tip .cq { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; font-size: 12px; color: var(--t3); margin: 2px 0 8px 15px; }
.tip > .cq:last-child { margin-bottom: 0; }
/* Passing checks, collapsed. A page whose header reports a fault opens with the
   fault; the green rows are evidence a reader may unfold. */
.evidence { background: var(--panel2); border: 1px solid var(--line); border-radius: 8px; padding: 8px 14px; font-family: var(--mono); font-size: 11.5px; color: var(--t2); margin: 6px 0 4px; max-width: 520px; }
.evidence > summary { color: var(--t4); font-size: 10px; letter-spacing: .1em; text-transform: uppercase; font-family: system-ui, sans-serif; cursor: pointer; }
.evidence > summary:focus-visible { outline: 1px solid var(--link); outline-offset: 2px; }
.evidence[open] > summary { margin-bottom: 4px; }
.ok { color: var(--good); }
.no { color: var(--bad); }
table { border-collapse: collapse; width: 100%; font-size: 12.5px; font-variant-numeric: tabular-nums; }
th { text-align: left; color: var(--t4); font-size: 10.5px; text-transform: uppercase; letter-spacing: .08em; font-weight: 600; padding: 5px 10px 5px 0; border-bottom: 1px solid var(--line); }
td { padding: 7px 10px 7px 0; border-bottom: 1px solid var(--line2); color: var(--t2); }
.setrow { display: grid; grid-template-columns: 15px 140px 1fr auto; gap: 12px; align-items: center; background: var(--panel); border: 1px dashed var(--line); border-radius: 9px; padding: 12px 14px; margin-bottom: 7px; }
.setrow.noblurb { grid-template-columns: 15px 1fr auto; }
.setrow .name { font-weight: 600; color: var(--t2); }
.setrow .blurb { color: var(--t4); font-size: 12px; }
.rowform { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.keyfield { background: var(--bg); border: 1px solid var(--line); border-radius: 6px; color: var(--t1); font: inherit; font-size: 12.5px; padding: 4px 9px; width: 170px; }
.keyfield:focus-visible { outline: 1px solid var(--link); outline-offset: 1px; }
.actmsg { color: var(--t3); font-size: 11.5px; }
.actmsg:empty { display: none; }
.copystatus { color: var(--t3); font-size: 11.5px; margin-left: 8px; }
.sheet { display: none; background: var(--panel2); border: 1px solid var(--line); border-radius: 9px; padding: 16px 18px; margin: 12px 0 0; }
.sheet.on { display: block; }
.sheet h4 { margin: 0 0 6px; font-size: 13.5px; }
.sheet p { color: var(--t3); font-size: 12.5px; margin: 0 0 10px; max-width: 66ch; }
.promptbox { background: var(--bg); border: 1px solid var(--line); border-radius: 7px; padding: 12px 14px; font-family: var(--mono); font-size: 11.5px; color: var(--t2); white-space: pre-wrap; user-select: all; margin-bottom: 10px; word-break: break-all; }
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
.sheet .steps { margin: 0 0 14px; padding-left: 22px; color: var(--t3); font-size: 12.5px; max-width: 66ch; }
.sheet .steps li { margin-bottom: 10px; }
.sheet .steps li:last-child { margin-bottom: 0; }
.sheet .steps b { color: var(--t2); font-weight: 600; }
.sheet .steps .promptbox { margin-top: 6px; }
.sheet .steps .ext { color: var(--link); }
/* The agent prompt, now secondary to the steps above it. */
.sheet .agentprompt { margin-top: 14px; }
.sheet .agentprompt summary { color: var(--t3); font-size: 12.5px; cursor: pointer; margin-bottom: 8px; }
.sheet .agentprompt summary:hover { color: var(--link); }
@media (max-width: 700px) {
  .page { padding: 22px 18px 28px; }
  .cards, .cards.four { grid-template-columns: 1fr 1fr; }
  .kpis { grid-template-columns: 1fr 1fr; }
  .setrow { grid-template-columns: 15px 1fr auto; }
  .setrow .blurb { grid-column: 1 / -1; grid-row: 2; }
  .setrow .btn { justify-self: end; width: max-content; }
  /* A row's control and its hint wrap under the reason rather than squeezing
     the name to nothing on a 375px screen. A whole-row link is excluded: its
     arrow is one glyph and belongs beside the text, not on a line of its own. */
  .attncard:not(.rowzone) { flex-wrap: wrap; }
  .attncard:not(.rowzone) .grow { flex-basis: 100%; }
  .rowlink { width: 100%; justify-content: flex-end; }
}
`;
