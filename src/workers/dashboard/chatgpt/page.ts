/**
 * The Olympus dashboard as a ChatGPT app: one self-contained HTML page served
 * as the `ui://olympus/dashboard` MCP Apps resource (and by the relay when the
 * Mac is offline).
 *
 * No external origins (the resource's CSP allows none), no custom fonts, no
 * gradients. Colours follow the host theme; the brand accent appears only on
 * the page's one primary button. The page renders exactly what the view model
 * contains and nothing else; see client.ts for the program.
 */
import {
  DASHBOARD_CHATGPT_CONNECTION_COPY,
  DASHBOARD_CHATGPT_PAGE_COPY,
  DASHBOARD_STATUS_PRESENTATION,
  type DashboardStatus,
  type DashboardStatusColorToken,
} from '../vocabulary.ts';
import { DASHBOARD_TOOL_NAME } from '../../chatgpt/dashboard-contract.ts';
import { chatgptDashboardClient, type ChatGptDashboardClientConfig } from './client.ts';

export interface ChatGptDashboardPageOptions {
  /** How long to wait for a tool result before saying the Mac is unreachable. */
  resultTimeoutMs?: number;
  /** When `generatedAt` is older than this, the page offers Check again. */
  staleAfterMs?: number;
}

export const CHATGPT_DASHBOARD_RESULT_TIMEOUT_MS = 20_000;
export const CHATGPT_DASHBOARD_STALE_AFTER_MS = 10 * 60_000;

const STATUS_TONE = Object.fromEntries(
  (Object.keys(DASHBOARD_STATUS_PRESENTATION) as DashboardStatus[])
    .map((status) => [status, DASHBOARD_STATUS_PRESENTATION[status].colorToken]),
) as Record<DashboardStatus, DashboardStatusColorToken>;

// Light values are ChatGPT's neutral greys; every text pair clears WCAG AA
// (4.5:1) on its background, and the status dots clear 3:1 as UI graphics.
export const CHATGPT_DASHBOARD_LIGHT = {
  bg: '#ffffff', text: '#0d0d0d', muted: '#5d5d5d', line: '#d9d9d9', surface: '#f7f7f8',
  accent: '#5b45c2', onAccent: '#ffffff', focus: '#2f5bd6',
  warnBg: '#fff6e0', warnLine: '#8a5a00', infoBg: '#f2f0fc', infoLine: '#6d5bd0', danger: '#b42318',
  good: '#2e7d4f', run: '#6d5bd0', warn: '#a86a00', bad: '#c0362c', off: '#6b6e76', idle: '#8e8e93',
};
export const CHATGPT_DASHBOARD_DARK = {
  bg: '#212121', text: '#ececec', muted: '#b4b4b4', line: '#4a4a4a', surface: '#2a2a2a',
  accent: '#a594f0', onAccent: '#14121f', focus: '#8fb0ff',
  warnBg: '#2e2614', warnLine: '#c99a3e', infoBg: '#24213a', infoLine: '#a594f0', danger: '#f07468',
  good: '#5fb582', run: '#a594f0', warn: '#d9a441', bad: '#f07468', off: '#9a9ca3', idle: '#8e8e93',
};

function vars(palette: typeof CHATGPT_DASHBOARD_LIGHT): string {
  return [
    `--bg:${palette.bg}`, `--text:${palette.text}`, `--muted:${palette.muted}`, `--line:${palette.line}`,
    `--surface:${palette.surface}`, `--accent:${palette.accent}`, `--on-accent:${palette.onAccent}`,
    `--focus:${palette.focus}`, `--warn-bg:${palette.warnBg}`, `--warn-line:${palette.warnLine}`,
    `--info-bg:${palette.infoBg}`, `--info-line:${palette.infoLine}`, `--danger:${palette.danger}`,
    `--good:${palette.good}`, `--run:${palette.run}`, `--warn:${palette.warn}`, `--bad:${palette.bad}`,
    `--off:${palette.off}`, `--idle:${palette.idle}`,
  ].join(';');
}

export const CHATGPT_DASHBOARD_CSS = `
:root{${vars(CHATGPT_DASHBOARD_LIGHT)};color-scheme:light dark}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){${vars(CHATGPT_DASHBOARD_DARK)}}}
:root[data-theme=dark]{${vars(CHATGPT_DASHBOARD_DARK)}}
:root[data-theme=light]{color-scheme:light}
:root[data-theme=dark]{color-scheme:dark}
*{box-sizing:border-box}
html{font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;font-size:100%;line-height:1.45}
body{margin:0;background:var(--bg);color:var(--text);font-size:0.9375rem;overflow-wrap:anywhere}
p{margin:0}
h1{font-size:1.25rem;font-weight:600;margin:0 0 1rem}
h2{font-size:1rem;font-weight:600;margin:0 0 0.5rem}
h3{font-size:0.875rem;font-weight:600;color:var(--muted);margin:0.75rem 0 0.25rem}
.page{max-width:48rem;margin:0 auto;padding:1.25rem 1rem 2rem}
.card{padding:0.75rem}
.section{margin-top:1.5rem}
.muted{color:var(--muted);font-size:0.875rem}
.banner{display:flex;gap:0.75rem;align-items:flex-start;padding:0.875rem 1rem;border:1px solid var(--warn-line);border-left-width:4px;border-radius:0.75rem;background:var(--warn-bg);margin-bottom:0.75rem}
.banner.info{border-color:var(--info-line);background:var(--info-bg)}
.banner-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:0.5rem}
.banner-title{font-weight:600}
.icon{flex:none;width:1.5rem;height:1.5rem;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-weight:700;background:var(--warn-line);color:var(--bg)}
.banner.info .icon{background:var(--info-line)}
.help{user-select:text;-webkit-user-select:text;padding:0.5rem 0.75rem;border:1px solid var(--line);border-radius:0.5rem;background:var(--bg)}
.stale{display:flex;flex-wrap:wrap;align-items:center;gap:0.5rem;margin:0.25rem 0 0.5rem}
.rows{list-style:none;margin:0;padding:0;border-top:1px solid var(--line)}
.row{display:flex;flex-wrap:wrap;align-items:center;gap:0.5rem 1rem;padding:0.75rem 0;border-bottom:1px solid var(--line)}
.row-text{flex:1 1 14rem;min-width:0}
.need .dot{margin-top:0}
.source-main{flex:1 1 16rem;min-width:0}
.source-head{display:flex;flex-wrap:wrap;align-items:center;gap:0.25rem 0.5rem}
.source-name{font-weight:600}
.status{color:var(--muted);font-size:0.875rem}
.source-actions{display:flex;flex-wrap:wrap;align-items:flex-start;gap:0.5rem;justify-content:flex-end}
.dot{flex:none;width:0.625rem;height:0.625rem;border-radius:50%;display:inline-block;background:var(--off)}
.tone-good{background:var(--good)}.tone-run{background:var(--run)}.tone-warn{background:var(--warn)}
.tone-bad{background:var(--bad)}.tone-off{background:var(--off)}.tone-line{background:transparent;border:2px solid var(--idle)}
.fix{display:inline-flex;flex-wrap:wrap;align-items:center;gap:0.5rem}
.reason{color:var(--muted);font-size:0.875rem}
.reason.strong{color:var(--text);font-weight:600}
.actions{display:flex;flex-wrap:wrap;gap:0.5rem;align-items:center}
.btn{font:inherit;font-size:0.875rem;font-weight:500;min-height:2.25rem;padding:0.375rem 0.875rem;border-radius:999px;border:1px solid var(--line);background:var(--bg);color:var(--text);cursor:pointer}
.btn:hover:not(:disabled){background:var(--surface)}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
.btn.primary:hover:not(:disabled){background:var(--accent);filter:brightness(1.08)}
.btn.danger{border-color:var(--danger);color:var(--danger)}
.btn:disabled{cursor:not-allowed;color:var(--muted);background:var(--surface);border-style:dashed}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
summary{cursor:pointer;border-radius:0.375rem}
.menu summary{list-style:none;font-size:1.25rem;line-height:1;min-width:2.25rem;min-height:2.25rem;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--line);border-radius:999px}
.menu summary::-webkit-details-marker{display:none}
.menu{display:flex;flex-direction:column;align-items:flex-end;gap:0.5rem}
.menu-panel{display:flex;flex-direction:column;align-items:flex-end;gap:0.5rem;padding-top:0.25rem}
.progress-line{margin-bottom:0.5rem}
.progress-line.stalled{font-weight:600}
.bar{height:0.5rem;border-radius:999px;background:var(--surface);border:1px solid var(--line)}
.bar-fill{height:100%;border-radius:999px;background:var(--run);min-width:0}
.disclosure{margin-top:0.75rem}
.disclosure summary,.models summary{color:var(--muted);font-size:0.875rem;padding:0.25rem 0}
.models summary{font-size:1rem;color:var(--text);font-weight:600}
.models{padding-top:0.75rem;border-top:1px solid var(--line)}
.plain{margin:0.5rem 0;padding-left:1.25rem}
.sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0}
[data-mode=inline] .banner{margin-bottom:0.5rem}
@media (max-width:30rem){.page{padding:1rem 0.75rem 1.5rem}.source-actions{justify-content:flex-start;width:100%}.menu,.menu-panel{align-items:flex-start}}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
`;

/** The page, with every string the client prints inlined as data. */
export function chatgptDashboardPageHtml(options: ChatGptDashboardPageOptions = {}): string {
  const config: ChatGptDashboardClientConfig = {
    toolName: DASHBOARD_TOOL_NAME,
    connection: DASHBOARD_CHATGPT_CONNECTION_COPY,
    page: DASHBOARD_CHATGPT_PAGE_COPY,
    statusTone: STATUS_TONE,
    resultTimeoutMs: options.resultTimeoutMs ?? CHATGPT_DASHBOARD_RESULT_TIMEOUT_MS,
    staleAfterMs: options.staleAfterMs ?? CHATGPT_DASHBOARD_STALE_AFTER_MS,
  };
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${DASHBOARD_CHATGPT_PAGE_COPY.title}</title>`,
    `<style>${CHATGPT_DASHBOARD_CSS}</style>`,
    '</head>',
    '<body>',
    '<div id="app"></div>',
    `<script>(${chatgptDashboardClient.toString()})(${scriptJson(config)});</script>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/** JSON that cannot close the script element it sits in. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).split('<').join('\\u003c').split('\u2028').join('\\u2028').split('\u2029').join('\\u2029');
}
