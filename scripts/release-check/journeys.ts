/**
 * The journeys the release check walks in a throwaway machine's browser, as the owner would.
 *
 * Each one comes from somewhere a person found a problem: the owner's 1.0.0 manual test plan (the items a machine can do) or a
 * defect the owner found by hand after 1.0.0 (the pull request that fixed it is named). Each step says what its action must do, in
 * words a person would use: the text that must be on the page afterwards, the control that must be there, the number of rows that
 * changed, the address the page must be at. The words the product itself owns (the dashboard's vocabulary) are imported, so a
 * reworded label is a change here only where the product says something else.
 *
 * What a journey can rely on: the machine has the synthetic test life (a connected stand-in for Readwise, its items sorted into
 * Personal, Private and Secret), the engine is settled, the models are ready, and one agent connection exists (the suite's). It has
 * nothing else: no Gmail, no Dropbox, no real account.
 *
 * `mutates: true` journeys change the install (a saved setting, a deleted answer); the screens for the visual baselines are taken
 * before them.
 */
import {
  DASHBOARD_CHATGPT_PAGE_COPY as PANEL,
  DASHBOARD_CHATGPT_PRIVACY_COPY as PRIVACY,
  DASHBOARD_CHATGPT_PRIVACY_SETUP_COPY as PRIVACY_SETUP,
  DASHBOARD_COMPUTER_PANEL_COPY as COMPUTER,
  DASHBOARD_PRIVATE_ANSWERS_COPY as ASK,
} from '../../src/workers/dashboard/vocabulary.ts';
import type { Journey } from './journey.ts';

/** The words on the page that mean something is stuck or broken for the person reading it. */
const STUCK = /\b(stuck|stalled|paused while|not working|something went wrong)\b/i;
const DASHBOARD_PAGES = ['/dashboard', '/dashboard?keys', '/dashboard?agents', '/dashboard?private-answers', '/dashboard?connector'] as const;

export const JOURNEYS: readonly Journey[] = [
  {
    id: 'progress-settles',
    title: 'On a fresh install the dashboard finishes its work and never reads stuck',
    source: 'bug found by hand: progress never reached done; Gmail read as stuck while it synced (#390, #397, #432, #434)',
    steps: [
      {
        name: 'Open the dashboard',
        do: { open: 'dashboard' },
        expect: [
          { text: PANEL.sources, frame: 'panel' },
          { text: 'Readwise', frame: 'panel' },
          // The ingest has settled before the journeys run: nothing is still in progress, and no word says it is stuck.
          { noText: STUCK, frame: 'panel' },
          { noText: /\b[1-9]\d?% done\b/, frame: 'panel' },
          { noText: /Readwise\s+—\s+(Needs you|Paused)/, frame: 'panel' },
        ],
      },
      {
        name: 'Look again after a reload',
        do: { reload: true },
        expect: [{ text: 'Readwise', frame: 'panel' }, { noText: STUCK, frame: 'panel' }],
      },
    ],
  },
  {
    id: 'sources-healthy',
    title: 'Sources shows the connected source as healthy and the local-files card',
    source: 'owner test plan: dashboard pass; the new "Files on this computer" card (#440, #443)',
    steps: [
      {
        name: 'Open the dashboard',
        do: { open: 'dashboard' },
        expect: [
          { count: { role: 'button', name: PANEL.moreActions.replace('{source}', 'Readwise'), contains: true }, equals: 1, frame: 'panel' },
          { noText: /Readwise\s+—\s+(Needs you|Paused|Working)/, frame: 'panel' },
          { text: 'Files on this computer', frame: 'panel' },
          // Not yet chosen: the card offers Connect; once connected it offers Choose folders. Either way it has a control.
          { custom: async ({ driver }) => {
            const names = await driver.probe('panel', `(() => {
              const label = Array.from(document.querySelectorAll('*')).filter((n) => /^Files on this computer/.test(__rc.clean(n.textContent)) && !Array.from(n.children).some((c) => /^Files on this computer/.test(__rc.clean(c.textContent))))[0];
              for (let row = label; row && row !== document.body; row = row.parentElement) {
                const buttons = Array.from(row.querySelectorAll('button')).filter((b) => b.getBoundingClientRect().width > 0 && !/More actions/.test(b.getAttribute('aria-label') || b.textContent));
                if (buttons.length > 0) return buttons.map((b) => __rc.clean(b.getAttribute('aria-label') || b.textContent));
              }
              return [];
            })()`) as string[];
            const ok = names.some((name) => /^(Connect|Choose folders)$/i.test(name));
            return { ok, expected: 'the Files on this computer card has a control: Connect, or Choose folders once connected', actual: ok ? `it has "${names.join('", "')}"` : `its controls are: ${names.join(', ') || 'none'}` };
          } },
        ],
      },
    ],
  },
  {
    id: 'models-ready',
    title: 'The models are ready and the Models line says so',
    source: 'owner test plan: dashboard pass',
    steps: [
      {
        name: 'Open the dashboard',
        do: { open: 'dashboard' },
        expect: [{ text: new RegExp(`${PANEL.models}\\s+—\\s+${PANEL.modelBuiltIn}\\s+·\\s+${PANEL.modelReady}`), frame: 'panel' }],
      },
    ],
  },
  {
    id: 'opens-in-place',
    title: 'The dashboard opens its own pages in place, and the way back works',
    source: 'bug found by hand: the dashboard opened its own pages in a new window (#370)',
    steps: [
      { name: 'Open the dashboard', do: { open: 'dashboard' }, expect: [{ text: COMPUTER.section, frame: 'panel' }] },
      {
        name: 'Press Open on Keys',
        do: { click: { role: 'button', name: `${COMPUTER.open} ${COMPUTER.rows.keys.title}` }, frame: 'panel' },
        expect: [{ url: /\/dashboard\?keys/ }, { noNewWindow: true }, { text: ASK.connectVenice, frame: 'host' }],
      },
      {
        name: 'Go back to the dashboard from the page\'s own Olympus link',
        do: { click: { role: 'link', name: 'Olympus' }, frame: 'host' },
        expect: [{ url: /^\/dashboard(?!\?)/ }, { noNewWindow: true }, { text: PANEL.sources, frame: 'panel' }],
      },
      {
        name: 'Press Open on Agents',
        do: { click: { role: 'button', name: `${COMPUTER.open} ${COMPUTER.rows.agents.title}` }, frame: 'panel' },
        expect: [{ url: /\/dashboard\?agents/ }, { noNewWindow: true }, { text: 'Connect an agent', frame: 'host' }],
      },
      {
        name: 'Go back again',
        do: { click: { role: 'link', name: 'Olympus' }, frame: 'host' },
        expect: [{ url: /^\/dashboard(?!\?)/ }, { text: PANEL.sources, frame: 'panel' }],
      },
      {
        name: 'Press Open on Inbox',
        do: { click: { role: 'button', name: `${COMPUTER.open} ${COMPUTER.rows.privateAnswers.title}` }, frame: 'panel' },
        expect: [{ url: /\/dashboard\?private-answers/ }, { noNewWindow: true }, { text: ASK.title, frame: 'host' }],
      },
    ],
  },
  {
    id: 'agent-never-expired',
    title: 'An agent that connected and worked is listed as connected, never expired',
    source: 'bug found by hand: connecting an agent showed "expired" after it worked (#399)',
    steps: [
      {
        name: 'Open the Agents page',
        do: { open: 'dashboard' },
        expect: [{ text: COMPUTER.rows.agents.title, frame: 'panel' }],
      },
      {
        name: 'Press Open on Agents',
        do: { click: { role: 'button', name: `${COMPUTER.open} ${COMPUTER.rows.agents.title}` }, frame: 'panel' },
        expect: [
          { url: /\/dashboard\?agents/ },
          { text: /Connected agents\s+—\s+[1-9]/, frame: 'host' },
          { noText: /expired/i, frame: 'host' },
          { count: { role: 'button', name: 'Revoke' }, atLeast: 1, frame: 'host' },
        ],
      },
    ],
  },
  {
    id: 'agent-connect-instructions',
    title: 'Connect an agent shows the steps and the address to copy',
    source: 'owner test plan: connect ChatGPT, Claude and Grok from the Agents page',
    steps: [
      { name: 'Open the Agents page', do: { open: 'dashboard' }, expect: [{ text: COMPUTER.rows.agents.title, frame: 'panel' }] },
      {
        name: 'Press Open on Agents',
        do: { click: { role: 'button', name: `${COMPUTER.open} ${COMPUTER.rows.agents.title}` }, frame: 'panel' },
        expect: [{ url: /\/dashboard\?agents/ }, { present: { role: 'button', name: 'Connect an agent' }, frame: 'host' }],
      },
      {
        name: 'Press Connect an agent',
        do: { click: { role: 'button', name: 'Connect an agent' }, frame: 'host' },
        expect: [
          { text: 'Pick the agent you use', frame: 'host' },
          { present: { role: 'button', name: 'Claude', contains: true }, frame: 'host' },
          { present: { role: 'button', name: 'ChatGPT', contains: true }, frame: 'host' },
          { present: { role: 'button', name: 'Grok', contains: true }, frame: 'host' },
          { present: { role: 'button', name: 'Copy address' }, frame: 'host' },
        ],
      },
    ],
  },
  {
    id: 'needs-you-fix-reachable',
    title: 'Every problem the dashboard shows has a control that leads to its fix',
    source: 'owner ruling: every problem shown links to its fix; the privacy setup prompt',
    steps: [
      {
        name: 'Open the dashboard',
        do: { open: 'dashboard' },
        expect: [{ text: PANEL.sources, frame: 'panel' }],
      },
      {
        name: 'Every "Needs you" row has a control',
        do: { observe: true },
        expect: [
          { custom: async ({ driver }) => {
            // Each row of the Needs you section is a line with a button beside it: count rows that name a problem and have none.
            const result = await driver.probe('panel', `(() => {
              const text = __rc.clean(document.body.innerText);
              if (!/Needs you/.test(text)) return { rows: 0, bare: 0 };
              const heading = Array.from(document.querySelectorAll('h1,h2,h3,[role="heading"],div,section')).find((n) => __rc.clean(n.textContent) === 'Needs you');
              if (!heading) return { rows: 0, bare: 0 };
              const section = heading.parentElement;
              const rows = Array.from(section.children).filter((n) => n !== heading && __rc.clean(n.textContent) !== '');
              return { rows: rows.length, bare: rows.filter((n) => !n.querySelector('button, a[href]')).length };
            })()`) as { rows: number; bare: number };
            return { ok: result.bare === 0, expected: 'each problem under Needs you has a control (a button or a link)', actual: result.rows === 0 ? 'nothing is under Needs you' : `${result.rows} row(s), ${result.bare} without a control` };
          } },
        ],
      },
    ],
  },
  {
    id: 'no-public-tier',
    title: 'With no Public tier in the policy, no Public card or S0 row appears anywhere',
    source: 'bug found by hand: the dashboard showed a Public card and an S0 row with no Public tier (#359)',
    steps: [
      ...(['/dashboard', '/dashboard?keys', '/dashboard?agents', '/dashboard?private-answers'] as const).map((path, index) => ({
        name: `Look at ${path}`,
        do: index === 0 ? { open: 'dashboard' as const } : { go: path },
        expect: [
          { noText: /\bPublic\b/ },
          { noText: /\bS0\b/ },
          { noText: /\bpublic_safe\b/ },
        ],
      })),
    ],
  },
  {
    id: 'no-sideways-scroll',
    title: 'No page scrolls sideways on a phone-width screen',
    source: 'bug found by hand: private answers and the dashboard top scrolled sideways (#391)',
    steps: [
      { name: 'Open the dashboard at phone width', do: { viewport: { width: 390 } }, expect: [] },
      ...DASHBOARD_PAGES.map((path, index) => ({
        name: `Look at ${path} at 390 px`,
        do: index === 0 ? { open: 'dashboard' as const } : { go: path },
        expect: [{ noOverflow: true as const }],
      })),
      { name: 'Back to desktop width', do: { viewport: { width: 1280 } }, expect: [] },
    ],
  },
  {
    id: 'inbox-delete-one',
    title: 'Deleting one Inbox answer removes that answer and only that one',
    source: 'owner test plan: the private-answers Inbox',
    mutates: true,
    steps: [
      { name: 'Open the Inbox page', do: { open: 'private' }, expect: [{ count: { css: '[data-pa-question]' }, atLeast: 2 }] },
      {
        name: 'Delete the first answer',
        do: { click: { role: 'button', name: ASK.delete, within: { css: '[data-pa-question]' } }, frame: 'host' },
        remember: {
          before: { countOf: { css: '[data-pa-question]' } },
          firstId: { attrOf: { css: '[data-pa-question]', nth: 0 }, attr: 'data-pa-question' },
          secondId: { attrOf: { css: '[data-pa-question]', nth: 1 }, attr: 'data-pa-question' },
        },
        expect: [
          { countSince: { target: { css: '[data-pa-question]' }, since: 'before', delta: -1 } },
          { custom: async ({ count, vars }) => {
            const gone = await count({ css: `[data-pa-question="${String(vars.firstId)}"]` });
            const kept = await count({ css: `[data-pa-question="${String(vars.secondId)}"]` });
            return { ok: gone === 0 && kept === 1, expected: 'the answer that was deleted is gone and the one after it is still there', actual: `deleted answer: ${gone === 0 ? 'gone' : 'still listed'}; the next answer: ${kept === 1 ? 'still listed' : 'missing'}` };
          } },
        ],
      },
      {
        name: 'Reload: the deleted answer stays gone',
        do: { reload: true },
        expect: [
          { countSince: { target: { css: '[data-pa-question]' }, since: 'before', delta: -1 } },
          { custom: async ({ count, vars }) => {
            const gone = await count({ css: `[data-pa-question="${String(vars.firstId)}"]` });
            return { ok: gone === 0, expected: 'the deleted answer is still gone after a reload', actual: gone === 0 ? 'it is' : 'it is listed again' };
          } },
        ],
      },
    ],
  },
  {
    id: 'privacy-persists',
    title: 'A privacy setting saved on the dashboard is still there after a reload',
    source: 'owner test plan: what is private; owner ruling: settings persist',
    mutates: true,
    steps: [
      { name: 'Open the dashboard', do: { open: 'dashboard' }, expect: [{ text: PANEL.sources, frame: 'panel' }] },
      {
        name: 'Open the privacy settings',
        do: { click: { role: 'button', name: new RegExp(`^(${PRIVACY_SETUP.label}|${PRIVACY.edit}|${PRIVACY.editLabel})$`) }, frame: 'panel' },
        expect: [{ text: PRIVACY.title, frame: 'panel' }, { present: { role: 'textbox', name: PRIVACY.descriptionLabel }, frame: 'panel' }],
      },
      {
        name: 'Type a description of what is private',
        do: { type: { into: { role: 'textbox', name: PRIVACY.descriptionLabel }, text: 'my medical records and my tax papers' }, frame: 'panel' },
        expect: [{ value: { role: 'textbox', name: PRIVACY.descriptionLabel }, equals: 'my medical records and my tax papers', frame: 'panel' }],
      },
      {
        name: 'Press Save',
        do: { click: { role: 'button', name: PRIVACY.save }, frame: 'panel' },
        // A new description changes what Olympus keeps private, so the page asks first (found on the first Mac run).
        expect: [{ text: PRIVACY.confirmDescription, frame: 'panel' }, { present: { role: 'button', name: PRIVACY.confirm }, frame: 'panel' }],
      },
      {
        name: 'Confirm the change',
        do: { click: { role: 'button', name: PRIVACY.confirm }, frame: 'panel' },
        timeoutMs: 60_000,
        expect: [{ text: PRIVACY.saved, frame: 'panel' }, { noText: PRIVACY.saveFailed, frame: 'panel' }],
      },
      { name: 'Reload the dashboard', do: { reload: true }, expect: [{ text: PANEL.sources, frame: 'panel' }, { noText: PRIVACY_SETUP.sentence, frame: 'panel' }] },
      {
        name: 'Open the privacy settings again',
        do: { click: { role: 'button', name: new RegExp(`^(${PRIVACY.edit}|${PRIVACY.editLabel})$`) }, frame: 'panel' },
        // The saved description keeps what was typed and gains the answers to the quick questions after it (found on the second Linux run).
        expect: [{ value: { role: 'textbox', name: PRIVACY.descriptionLabel }, equals: /^my medical records and my tax papers/, frame: 'panel' }],
      },
    ],
  },
];

export const journeyIds = (): string[] => JOURNEYS.map((journey) => journey.id);

/** The journeys for a run, in order: those that leave the install as it was first, then those that change it. */
export function selectJourneys(only?: readonly string[]): Journey[] {
  const chosen = only === undefined || only.length === 0 ? [...JOURNEYS] : JOURNEYS.filter((journey) => only.includes(journey.id));
  return [...chosen.filter((journey) => journey.mutates !== true), ...chosen.filter((journey) => journey.mutates === true)];
}
