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
  DASHBOARD_CHATGPT_PRIVACY_COPY as PRIVACY,
  DASHBOARD_CHATGPT_PRIVACY_SETUP_COPY as PRIVACY_SETUP,
  DASHBOARD_PRIVACY_ITEMS_COPY as ITEMS,
  DASHBOARD_PRIVATE_ANSWERS_COPY as ASK,
  DASHBOARD_UPDATE_COPY as UPDATE,
} from '../../src/workers/dashboard/vocabulary.ts';
import { BACKUP_COPY as BACKUP } from '../../src/workers/dashboard/backup-section.ts';
import type { Journey, JourneyStep, StepContext } from './journey.ts';
import { RESTORE_BACKUP_FOLDER, RESTORE_BACKUP_PATH, RESTORE_PASSPHRASE } from './restore.ts';
import { STAND_IN_FROM, STAND_IN_TO } from './update-stand-in.ts';
import { wireTarget, type Target } from './probe.ts';

/** The words on the page that mean something is stuck or broken for the person reading it. */
const STUCK = /\b(stuck|stalled|paused while|not working|something went wrong)\b/i;
const DASHBOARD_PAGES = ['/dashboard', '/dashboard?keys', '/dashboard?agents', '/dashboard?private-answers', '/dashboard?connector'] as const;
/** Forwarded saves can take 120 s; leave time for the reply to render and the next observation. Only save steps use this. */
const FORWARDED_SAVE_TIMEOUT_MS = 130_000;

/** The privacy settings open from the setup prompt on a fresh install, or from Edit once they are saved. */
const OPEN_PRIVACY: Target = { role: 'button', name: new RegExp(`^(${PRIVACY_SETUP.label}|${PRIVACY.edit}|${PRIVACY.editLabel})$`) };
const DESCRIPTION: Target = { role: 'textbox', name: PRIVACY.descriptionLabel };
/** The description shows as text with Edit, or (none yet) as "Describe what's private"; either opens the box (1.3.0, #684). */
const DESCRIPTION_EDIT: Target = { css: 'button[data-key="privacy:description:edit"]' };
const OPEN_DESCRIPTION = { name: 'Open the description box', do: { click: DESCRIPTION_EDIT, frame: 'panel' as const }, expect: [{ present: DESCRIPTION, frame: 'panel' as const }] };
// The sender field's label also holds its error once one shows.
const SENDER: Target = { role: 'textbox', name: PRIVACY.senderLabel, contains: true };
// 1.3 adds a rule on a three-step sheet: Add a rule, pick what kind, then the details.
const ADD_RULE = { name: 'Press Add a rule', do: { click: { role: 'button', name: PRIVACY.addRule }, frame: 'panel' as const }, expect: [{ text: PRIVACY.kindPrompt, frame: 'panel' as const }, { present: { role: 'button', name: PRIVACY.addSender }, frame: 'panel' as const }] };
const PICK_SENDER = { name: 'Choose Add a sender', do: { click: { role: 'button', name: PRIVACY.addSender }, frame: 'panel' as const }, expect: [{ present: { role: 'button', name: PRIVACY.next }, frame: 'panel' as const }] };
const SENDER_NEXT = { name: 'Press Next to the sender', do: { click: { role: 'button', name: PRIVACY.next }, frame: 'panel' as const }, expect: [{ text: PRIVACY.senderIntro, frame: 'panel' as const }, { present: SENDER, frame: 'panel' as const }] };
/** Settings › Models on this computer (#1043, #1085): the models moved off Home; Private answers is a row on every platform. */
const MODELS_ANSWERS_ROW: Target = { css: '#models [data-model-row="private-answers"]' };
/** Settings shows one section at a time: Agents and access with no target. */
const AGENTS_PANE_HEADING: Target = { css: '#agents h3' };
/** The id of the first Inbox row below the top one that is settled (not "not checked yet"), or null. */
const KEEP_ROW = `(() => { const rows = Array.from(document.querySelectorAll('[data-pa-question]')).slice(1); const keep = rows.find((row) => !(row.querySelector('.pafrom')?.textContent ?? '').includes(${JSON.stringify(ASK.unchecked)})); return keep ? keep.getAttribute('data-pa-question') : null; })()`;
const onlyDeletedGone = (expected: string) => async ({ count, vars }: StepContext): Promise<{ ok: boolean; expected: string; actual: string }> => {
  const gone = await count({ css: `[data-pa-question="${String(vars.firstId)}"]` }, 'host');
  const kept = await count({ css: `[data-pa-question="${String(vars.keepId)}"]` }, 'host');
  return { ok: gone === 0 && kept === 1, expected, actual: `deleted answer: ${gone === 0 ? 'gone' : 'still listed'}; the settled answer: ${kept === 1 ? 'still listed' : 'missing'}` };
};
const DISCARDED_NOTE = 'release check: this note is never saved';

/** Home's status line (#1085): Home keeps source totals, and the Sources tab is the list. */
const HOME_STATUS: Target = { css: '[data-home-status]' };
/**
 * Home has no source list since 1.5 (#1085): a source's row is on Home only while an open link lands on it or an archive is at work
 * or waiting on the owner. The step waits for Home to have drawn.
 */
export const OPEN_ALL_SOURCES: Journey['steps'][number] = {
  name: 'Home has drawn',
  do: { observe: true },
  expect: [{ present: HOME_STATUS, frame: 'panel' }],
};
/** The Sources tab: every connected source's row. */
const OPEN_SOURCES_TAB: Journey['steps'][number] = {
  name: 'Open the Sources tab',
  do: { go: '/dashboard?connect' },
  expect: [{ present: { css: '.srcrows' }, frame: 'host' }],
};
/** "Connect an agent", or "Connect another agent" once one is connected (the suite's own connection). */
const CONNECT_AGENT: Target = { role: 'button', name: /^Connect (an|another) agent$/ };
const DISCARDED_SENDER = 'release-check@example.com';

// --- Fix one item (#1060): Privacy › Your items.

/** One item's row on Your items, by the id an earlier step remembered. */
const itemRow = (vars: Record<string, string | number>) => ({ css: `[data-pi-item="${String(vars.itemId)}"]` });
const PI_ROWS = { css: '[data-pi-item]' };
const piFilter = (id: '' | 'private' | 'personal' | 'changed') => ({ css: `[data-pi-filter="${id}"]` });
/** The remembered item is listed, with this label (and, once the owner set it, "Changed by you" beside it). */
const itemListedAs = (tier: 'Personal' | 'Private', changedByYou: boolean) => async ({ count, vars }: StepContext): Promise<{ ok: boolean; expected: string; actual: string }> => {
  const row = `[data-pi-item="${String(vars.itemId)}"]`;
  const listed = await count({ css: row }, 'host');
  const labelled = await count({ css: `${row} .pipill.${tier}` }, 'host');
  const marked = await count({ css: `${row} .piyou` }, 'host');
  const ok = listed === 1 && labelled === 1 && (!changedByYou || marked === 1);
  return {
    ok,
    expected: `the item is listed as ${tier}${changedByYou ? ', marked Changed by you' : ''}`,
    actual: listed === 0 ? 'the item is not listed' : `it is listed${labelled === 1 ? ` as ${tier}` : ` but not as ${tier}`}${changedByYou ? (marked === 1 ? ', Changed by you' : ', not marked Changed by you') : ''}`,
  };
};
const OPEN_ITEM_PANEL: JourneyStep = {
  name: 'Open the item',
  do: { click: itemRow, frame: 'host' },
  expect: [{ present: { css: '[data-pi-detail] [data-pi-preview]' }, frame: 'host' }, { present: { role: 'radio', name: /^Personal/ }, frame: 'host' }],
};

// --- Update from the dashboard (#1063): the update stand-in (update-stand-in.ts).

const UPDATE_NOW = { role: 'button', name: UPDATE.updateNow } as const;
/** The stand-in's engine answers 502 once while it restarts, as the proxy in front of a restarting engine does. */
const RESTART_502 = [{ url: /\/dashboard\/engine\/update\/status$/, status: 502 }];
const offered = (outcome: string, index: number): JourneyStep => ({
  name: `An update is offered (${outcome})`,
  do: index === 0 ? { open: 'update' } : { go: `/?outcome=${outcome}` },
  expect: [{ text: UPDATE.notice(STAND_IN_TO), frame: 'host' }, { present: UPDATE_NOW, frame: 'host' }],
});
const pressUpdateNow: JourneyStep = {
  name: 'Press Update now',
  do: { click: UPDATE_NOW, frame: 'host' },
  // The four steps begin: the page says what it is updating to and that the old version comes back if the new one does not start.
  expect: [{ text: UPDATE.updating(STAND_IN_TO), frame: 'host' }, { text: UPDATE.pause(STAND_IN_TO, STAND_IN_FROM), frame: 'host' }],
};

// --- Restore on a clean machine (#1065): restore.ts and run.ts prepareRestore and finishRestore.

const tab = (name: string): Target => ({ role: 'link', name });

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
          { present: HOME_STATUS, frame: 'panel' },
          // The ingest has settled before the journeys run: nothing is still in progress, and no word says it is stuck.
          { noText: STUCK, frame: 'panel' },
          { noText: /\b[1-9]\d?% done\b/, frame: 'panel' },
        ],
      },
      OPEN_SOURCES_TAB,
      {
        name: 'Readwise is listed and reads settled',
        do: { observe: true },
        expect: [
          { text: 'Readwise', frame: 'host' },
          { noText: STUCK, frame: 'host' },
          { noText: /Readwise\s+—\s+(Needs you|Paused)/, frame: 'host' },
        ],
      },
      {
        name: 'Look again after a reload',
        do: { reload: true },
        expect: [{ present: { css: '.srcrows' }, frame: 'host' }, { noText: STUCK, frame: 'host' }],
      },
      { name: 'Readwise is still listed', do: { observe: true }, expect: [{ text: 'Readwise', frame: 'host' }, { noText: STUCK, frame: 'host' }] },
    ],
  },
  {
    id: 'sources-healthy',
    title: 'Sources shows the connected source as healthy and the local-files card',
    source: 'owner test plan: dashboard pass; the new "Files on this computer" card (#440, #443); the Sources tab is the list (#1085)',
    steps: [
      { name: 'Open the dashboard', do: { open: 'dashboard' }, expect: [{ present: HOME_STATUS, frame: 'panel' }] },
      OPEN_SOURCES_TAB,
      {
        name: 'Look at the sources',
        do: { observe: true },
        expect: [
          { count: { css: '[data-source-row="readwise.library"]' }, equals: 1, frame: 'host' },
          { noText: /Readwise\s+—\s+(Needs you|Paused|Working)/, frame: 'host' },
        ],
      },
      {
        // Connected, it is a row; not yet, it is a tile in Add a source, which is a dialog. Either way the Sources tab offers it.
        name: 'Press + Add a source',
        do: { click: { css: '.srcbar [data-dialog-open="add-source"]' }, frame: 'host' },
        expect: [{ count: { css: '[data-source-row="local.files"], [data-source-pick="local.files"]' }, atLeast: 1, frame: 'host' }],
      },
    ],
  },
  {
    id: 'models-ready',
    title: 'Settings says which models answer Private questions, and none of them is broken',
    source: 'owner test plan: dashboard pass; the models moved to Settings › Models on this computer (#1043, #1085)',
    steps: [
      { name: 'Open the dashboard', do: { open: 'dashboard' }, expect: [{ present: HOME_STATUS, frame: 'panel' }] },
      {
        name: 'Open Settings › Models on this computer',
        do: { go: '/dashboard?settings#models' },
        expect: [
          { present: MODELS_ANSWERS_ROW, frame: 'host' },
          // Settings' own words for a broken model (models-on-computer.ts): a download that failed or stopped, a model that could not start.
          { noText: /download failed|download interrupted|couldn't start/i, frame: 'host' },
        ],
      },
    ],
  },
  {
    id: 'models-section-opens',
    title: 'Settings opens Models on this computer from its side list, one section at a time',
    source: 'release check coverage: the Models section was never opened; Settings shows one section at a time (owner, 2026-11-10)',
    steps: [
      { name: 'Open the dashboard', do: { open: 'dashboard' }, expect: [{ present: HOME_STATUS, frame: 'panel' }] },
      { name: 'Open Settings', do: { go: '/dashboard?settings' }, expect: [{ present: AGENTS_PANE_HEADING, frame: 'host' }, { absent: MODELS_ANSWERS_ROW, frame: 'host' }] },
      {
        name: 'Press Models on this computer in the side list',
        do: { click: { css: '.setside a[href="#models"]' }, frame: 'host' },
        expect: [{ present: MODELS_ANSWERS_ROW, frame: 'host' }, { absent: AGENTS_PANE_HEADING, frame: 'host' }, { noText: STUCK, frame: 'host' }],
      },
    ],
  },
  {
    id: 'opens-in-place',
    title: 'The dashboard opens its own pages in place, and the way back works',
    source: 'bug found by hand: the dashboard opened its own pages in a new window (#370); the 1.4.0 top bar',
    steps: [
      { name: 'Open the dashboard', do: { open: 'dashboard' }, expect: [{ present: tab('Settings'), frame: 'host' }, { present: HOME_STATUS, frame: 'panel' }] },
      {
        name: 'Press Privacy in the top bar',
        do: { click: tab('Privacy'), frame: 'host' },
        expect: [{ url: /\/dashboard\?private-answers/ }, { noNewWindow: true }, { text: ASK.title, frame: 'host' }],
      },
      {
        name: 'Go back with Home',
        do: { click: tab('Home'), frame: 'host' },
        expect: [{ url: /^\/dashboard(?!\?)/ }, { noNewWindow: true }, { present: HOME_STATUS, frame: 'panel' }],
      },
      {
        name: 'Press Settings in the top bar',
        do: { click: tab('Settings'), frame: 'host' },
        expect: [{ url: /\/dashboard\?settings/ }, { noNewWindow: true }, { text: 'Agents and access', frame: 'host' }],
      },
      {
        name: 'Press Sources in the top bar',
        do: { click: tab('Sources'), frame: 'host' },
        expect: [{ url: /\/dashboard\?connect/ }, { noNewWindow: true }, { present: { css: '.srcbar [data-dialog-open="add-source"]' }, frame: 'host' }],
      },
      {
        name: 'Go back with Home again',
        do: { click: tab('Home'), frame: 'host' },
        expect: [{ url: /^\/dashboard(?!\?)/ }, { present: HOME_STATUS, frame: 'panel' }],
      },
    ],
  },
  {
    id: 'agent-never-expired',
    title: 'An agent that connected and worked is listed as connected, never expired',
    source: 'bug found by hand: connecting an agent showed "expired" after it worked (#399)',
    needs: ['suite'],
    steps: [
      { name: 'Open the dashboard', do: { open: 'dashboard' }, expect: [{ present: tab('Settings'), frame: 'host' }] },
      {
        name: 'Press Settings: Agents and access lists the connection',
        do: { click: tab('Settings'), frame: 'host' },
        expect: [
          { url: /\/dashboard\?settings/ },
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
      { name: 'Open the dashboard', do: { open: 'dashboard' }, expect: [{ present: tab('Settings'), frame: 'host' }] },
      {
        name: 'Press Settings: Agents and access offers Connect an agent',
        do: { click: tab('Settings'), frame: 'host' },
        expect: [{ url: /\/dashboard\?settings/ }, { present: CONNECT_AGENT, frame: 'host' }],
      },
      {
        name: 'Press Connect an agent',
        do: { click: CONNECT_AGENT, frame: 'host' },
        expect: [
          { text: 'Pick the agent you use', frame: 'host' },
          { present: { role: 'button', name: 'Claude', contains: true }, frame: 'host' },
          { present: { role: 'button', name: 'ChatGPT', contains: true }, frame: 'host' },
          { present: { role: 'button', name: 'Grok', contains: true }, frame: 'host' },
          // Each agent's steps sit in its own closed section until it is picked.
          { absent: { role: 'button', name: 'Copy address' }, frame: 'host' },
        ],
      },
      {
        name: 'Pick ChatGPT',
        do: { click: { role: 'button', name: 'ChatGPT', contains: true }, frame: 'host' },
        expect: [
          { text: 'Add custom MCP server', frame: 'host' },
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
        expect: [{ present: HOME_STATUS, frame: 'panel' }],
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
              // The rows are the list items (the section holds one list); a section without a list falls back to its children.
              const items = Array.from(section.querySelectorAll('li'));
              const rows = (items.length > 0 ? items : Array.from(section.children).filter((n) => n !== heading)).filter((n) => __rc.clean(n.textContent) !== '');
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
    needs: ['inbox'],
    steps: [
      {
        name: 'Open the Inbox page',
        do: { open: 'private' },
        expect: [
          { count: { css: '[data-pa-question]' }, atLeast: 2 },
          // The answer that must survive is a settled one below the first. A "not checked yet" row is re-checked in the background and
          // dropped when nothing Private matches it, so neither it nor a row count can be pinned across a reload (2026-10-28, 8 -> 4).
          { custom: async ({ driver, vars }) => {
            vars.keepId = String(await driver.probe('host', KEEP_ROW) ?? '');
            return { ok: vars.keepId !== '', expected: 'a settled answer below the first one, to check it survives', actual: vars.keepId ? 'found one' : 'every answer below the first is still being checked' };
          } },
        ],
      },
      {
        name: 'Delete the first answer',
        do: { click: { role: 'button', name: ASK.delete, within: { css: '[data-pa-question]' } }, frame: 'host' },
        remember: { firstId: { attrOf: { css: '[data-pa-question]', nth: 0 }, attr: 'data-pa-question', frame: 'host' } },
        expect: [
          // What the worker says it removed (the page records it): a delete that removed nothing names itself here,
          // not at the reload (2026-10-26, a Linux run whose deleted answers all came back).
          { custom: async ({ count }) => {
            const one = await count({ css: '[data-pa-removed="1"]' }, 'host');
            const none = await count({ css: '[data-pa-removed="0"]' }, 'host');
            return { ok: one === 1, expected: 'the worker says it removed exactly one answer', actual: one === 1 ? 'it removed one' : none === 1 ? 'it removed none' : 'it said nothing about what it removed' };
          } },
          { custom: onlyDeletedGone('the answer that was deleted is gone and a settled one after it is still there') },
        ],
      },
      {
        name: 'Reload: the deleted answer stays gone',
        do: { reload: true },
        expect: [{ custom: onlyDeletedGone('after a reload the deleted answer is still gone and the settled one is still there') }],
      },
    ],
  },
  {
    id: 'privacy-cancel-asks',
    title: 'Leaving the privacy settings with unsaved changes asks first, Discard changes keeps nothing, and Cancel puts the description back',
    source: 'owner test plan: what is private; the release check had never pressed Cancel there',
    steps: [
      { name: 'Open the dashboard', do: { open: 'dashboard' }, expect: [{ present: HOME_STATUS, frame: 'panel' }] },
      { name: 'Open the privacy settings', do: { click: OPEN_PRIVACY, frame: 'panel' }, expect: [{ text: PRIVACY.title, frame: 'panel' }, { present: DESCRIPTION_EDIT, frame: 'panel' }] },
      OPEN_DESCRIPTION,
      {
        name: 'Type a description',
        do: { type: { into: DESCRIPTION, text: DISCARDED_NOTE }, frame: 'panel' },
        expect: [{ value: DESCRIPTION, equals: DISCARDED_NOTE, frame: 'panel' }],
      },
      {
        name: 'Press Back with the description unsaved',
        do: { click: { role: 'button', name: PRIVACY.back }, frame: 'panel' },
        expect: [
          { text: PRIVACY.discardPrompt, frame: 'panel' },
          { present: { role: 'button', name: PRIVACY.discard }, frame: 'panel' },
          { present: { role: 'button', name: PRIVACY.keep }, frame: 'panel' },
        ],
      },
      {
        name: 'Press Keep editing',
        do: { click: { role: 'button', name: PRIVACY.keep }, frame: 'panel' },
        expect: [{ noText: PRIVACY.discardPrompt, frame: 'panel' }, { value: DESCRIPTION, equals: DISCARDED_NOTE, frame: 'panel' }],
      },
      { name: 'Press Back again', do: { click: { role: 'button', name: PRIVACY.back }, frame: 'panel' }, expect: [{ text: PRIVACY.discardPrompt, frame: 'panel' }] },
      {
        name: 'Press Discard changes',
        do: { click: { role: 'button', name: PRIVACY.discard }, frame: 'panel' },
        expect: [{ present: HOME_STATUS, frame: 'panel' }, { absent: DESCRIPTION, frame: 'panel' }],
      },
      {
        name: 'Open the privacy settings again',
        do: { click: OPEN_PRIVACY, frame: 'panel' },
        expect: [{ text: PRIVACY.title, frame: 'panel' }, { present: DESCRIPTION_EDIT, frame: 'panel' }, { noText: DISCARDED_NOTE, frame: 'panel' }],
      },
      OPEN_DESCRIPTION,
      { name: 'Type the description again', do: { type: { into: DESCRIPTION, text: DISCARDED_NOTE }, frame: 'panel' }, expect: [{ value: DESCRIPTION, equals: DISCARDED_NOTE, frame: 'panel' }] },
      {
        name: 'Press Cancel',
        do: { click: { role: 'button', name: PRIVACY.cancel }, frame: 'panel' },
        // Cancel is the owner saying "put it back": the box closes on the saved description, with nothing to ask about.
        expect: [{ absent: DESCRIPTION, frame: 'panel' }, { present: DESCRIPTION_EDIT, frame: 'panel' }, { noText: DISCARDED_NOTE, frame: 'panel' }, { noText: PRIVACY.discardPrompt, frame: 'panel' }],
      },
      {
        name: 'Press Back with nothing changed',
        do: { click: { role: 'button', name: PRIVACY.back }, frame: 'panel' },
        // Nothing is unsaved now, so there is nothing to ask about.
        expect: [{ present: HOME_STATUS, frame: 'panel' }, { noText: PRIVACY.discardPrompt, frame: 'panel' }, { absent: DESCRIPTION, frame: 'panel' }],
      },
    ],
  },
  {
    id: 'privacy-add-sender',
    title: 'Add a rule for a sender refuses what is not an address, takes one that is, and backing out of the review keeps nothing',
    source: 'owner test plan: what is private; the release check had never added a sender',
    steps: [
      { name: 'Open the dashboard', do: { open: 'dashboard' }, expect: [{ present: HOME_STATUS, frame: 'panel' }] },
      // The title shows while the settings still load; the description box only once they have.
      { name: 'Open the privacy settings', do: { click: OPEN_PRIVACY, frame: 'panel' }, expect: [{ text: PRIVACY.title, frame: 'panel' }, { present: DESCRIPTION_EDIT, frame: 'panel' }] },
      ADD_RULE,
      PICK_SENDER,
      SENDER_NEXT,
      { name: 'Type something that is not an address', do: { type: { into: SENDER, text: 'not an address' }, frame: 'panel' }, expect: [{ value: SENDER, equals: 'not an address', frame: 'panel' }] },
      {
        name: 'Press Next with it',
        do: { click: { role: 'button', name: PRIVACY.next }, frame: 'panel' },
        expect: [{ text: PRIVACY.senderInvalid, frame: 'panel' }, { present: SENDER, frame: 'panel' }],
      },
      { name: 'Press Back to the kinds', do: { click: { role: 'button', name: PRIVACY.sheetBack }, frame: 'panel' }, expect: [{ text: PRIVACY.kindPrompt, frame: 'panel' }, { absent: SENDER, frame: 'panel' }] },
      {
        name: 'Press Back to privacy',
        do: { click: { role: 'button', name: PRIVACY.sheetBack }, frame: 'panel' },
        expect: [{ present: DESCRIPTION_EDIT, frame: 'panel' }, { absent: SENDER, frame: 'panel' }, { noText: 'not an address', frame: 'panel' }],
      },
      { ...ADD_RULE, name: 'Press Add a rule again' },
      PICK_SENDER,
      {
        ...SENDER_NEXT,
        // A fresh start: the refused value and its error are gone.
        expect: [{ value: SENDER, equals: '', frame: 'panel' }, { noText: PRIVACY.senderInvalid, frame: 'panel' }],
      },
      { name: 'Type an address', do: { type: { into: SENDER, text: DISCARDED_SENDER }, frame: 'panel' }, expect: [{ value: SENDER, equals: DISCARDED_SENDER, frame: 'panel' }] },
      {
        name: 'Press Next with the address',
        do: { click: { role: 'button', name: PRIVACY.next }, frame: 'panel' },
        expect: [{ text: PRIVACY.confirmRule, frame: 'panel' }, { text: DISCARDED_SENDER, frame: 'panel' }, { present: { role: 'button', name: PRIVACY.makePrivate }, frame: 'panel' }],
      },
      // Make private would save the rule at once; backing out of the review must keep nothing.
      { name: 'Press Back from the review', do: { click: { role: 'button', name: PRIVACY.sheetBack }, frame: 'panel' }, expect: [{ value: SENDER, equals: DISCARDED_SENDER, frame: 'panel' }] },
      { name: 'Press Back to the kinds again', do: { click: { role: 'button', name: PRIVACY.sheetBack }, frame: 'panel' }, expect: [{ text: PRIVACY.kindPrompt, frame: 'panel' }] },
      {
        name: 'Press Back to privacy again',
        do: { click: { role: 'button', name: PRIVACY.sheetBack }, frame: 'panel' },
        expect: [{ present: DESCRIPTION_EDIT, frame: 'panel' }, { noText: DISCARDED_SENDER, frame: 'panel' }],
      },
      {
        name: 'Leave the privacy settings',
        do: { click: { role: 'button', name: PRIVACY.back }, frame: 'panel' },
        expect: [{ present: HOME_STATUS, frame: 'panel' }, { noText: PRIVACY.discardPrompt, frame: 'panel' }],
      },
      {
        name: 'Open the privacy settings again',
        do: { click: OPEN_PRIVACY, frame: 'panel' },
        // Loaded first, so the saved senders are on the page when their absence is read.
        expect: [{ text: PRIVACY.title, frame: 'panel' }, { present: DESCRIPTION_EDIT, frame: 'panel' }, { noText: DISCARDED_SENDER, frame: 'panel' }],
      },
      { name: 'Leave the privacy settings again', do: { click: { role: 'button', name: PRIVACY.back }, frame: 'panel' }, expect: [{ present: HOME_STATUS, frame: 'panel' }] },
    ],
  },
  {
    id: 'privacy-persists',
    title: 'A privacy setting saved on the dashboard is still there after a reload',
    source: 'owner test plan: what is private; owner ruling: settings persist',
    mutates: true,
    steps: [
      { name: 'Open the dashboard', do: { open: 'dashboard' }, expect: [{ present: HOME_STATUS, frame: 'panel' }] },
      {
        name: 'Open the privacy settings',
        do: { click: { role: 'button', name: new RegExp(`^(${PRIVACY_SETUP.label}|${PRIVACY.edit}|${PRIVACY.editLabel})$`) }, frame: 'panel' },
        expect: [{ text: PRIVACY.title, frame: 'panel' }, { present: DESCRIPTION_EDIT, frame: 'panel' }],
      },
      OPEN_DESCRIPTION,
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
        timeoutMs: FORWARDED_SAVE_TIMEOUT_MS,
        expect: [{ text: PRIVACY.saved, frame: 'panel', transient: true }, { noText: PRIVACY.saveFailed, frame: 'panel' }],
      },
      { name: 'Reload the dashboard', do: { reload: true }, expect: [{ present: HOME_STATUS, frame: 'panel' }, { noText: PRIVACY_SETUP.sentence, frame: 'panel' }] },
      {
        // Once privacy is saved Home has no way in; Privacy rules › What's private › Open lands on the settings (#1223, #1228).
        name: "Privacy rules offers What's private › Open",
        do: { go: '/dashboard?keys' },
        expect: [{ present: { css: 'a[data-privacy-open][href*="olympus-open=privacy"]' }, frame: 'host' }],
      },
      {
        name: 'Open the privacy settings again from that landing',
        do: { go: '/dashboard#olympus-open=privacy' },
        // The saved description shows as text, with Edit (the approved #684 design), before any box opens.
        expect: [{ text: 'my medical records and my tax papers', frame: 'panel' }, { present: { css: 'button[data-key="privacy:description:edit"]', text: PRIVACY.edit }, frame: 'panel' }, { absent: DESCRIPTION, frame: 'panel' }],
      },
      {
        name: 'Press Edit on the description',
        do: { click: DESCRIPTION_EDIT, frame: 'panel' },
        // The saved description keeps what was typed and gains the answers to the quick questions after it (found on the second Linux run).
        expect: [{ value: DESCRIPTION, equals: /^my medical records and my tax papers/, frame: 'panel' }],
      },
    ],
  },
  {
    id: 'fix-one-item',
    title: 'The owner corrects one item\'s label on Your items, and the change sticks across a reload, both ways',
    source: 'owner 1.5 plan, Owner controls: fix one item\'s privacy label (#1060, Your items #1154)',
    mutates: true,
    steps: [
      { name: 'Open the Privacy page', do: { open: 'private' }, expect: [{ present: tab(ITEMS.tab), frame: 'host' }] },
      {
        name: 'Press Your items',
        do: { click: tab(ITEMS.tab), frame: 'host' },
        timeoutMs: 45_000,
        expect: [{ url: /\/dashboard\?privacy-items/ }, { noNewWindow: true }, { text: ITEMS.intro, frame: 'host' }, { count: PI_ROWS, atLeast: 1, frame: 'host' }],
      },
      {
        name: 'Show only Personal items',
        do: { click: piFilter('personal'), frame: 'host' },
        expect: [{ present: { css: '[data-pi-filter="personal"][aria-pressed="true"]' }, frame: 'host' }, { count: PI_ROWS, atLeast: 1, frame: 'host' }],
      },
      { ...OPEN_ITEM_PANEL, name: 'Open the first Personal item', do: { click: { css: '[data-pi-item]', nth: 0 }, frame: 'host' }, remember: { itemId: { attrOf: { css: '[data-pi-item]', nth: 0 }, attr: 'data-pi-item', frame: 'host' } } },
      {
        name: 'Make it Private',
        do: { click: { css: '[data-pi-detail] [data-pi-choose="Private"]' }, frame: 'host' },
        timeoutMs: FORWARDED_SAVE_TIMEOUT_MS,
        // Raising only adds protection, so nothing asks first.
        expect: [{ text: ITEMS.toastPrivate, frame: 'host', transient: true }, { absent: { css: 'dialog[data-pi-confirm][open]' }, frame: 'host' }, { custom: itemListedAs('Private', true) }],
      },
      { name: 'Reload the page', do: { reload: true }, timeoutMs: 45_000, expect: [{ count: PI_ROWS, atLeast: 1, frame: 'host' }] },
      {
        name: 'Show the items changed by you: it is there, still Private',
        do: { click: piFilter('changed'), frame: 'host' },
        expect: [{ present: { css: '[data-pi-filter="changed"][aria-pressed="true"]' }, frame: 'host' }, { custom: itemListedAs('Private', true) }],
      },
      OPEN_ITEM_PANEL,
      {
        name: 'Make it Personal again',
        do: { click: { css: '[data-pi-detail] [data-pi-choose="Personal"]' }, frame: 'host' },
        // Lowering asks first, and says what changes.
        expect: [{ text: ITEMS.confirmTitle, frame: 'host' }, { present: { role: 'button', name: ITEMS.makePersonal }, frame: 'host' }],
      },
      {
        name: 'Press Make Personal',
        do: { click: { role: 'button', name: ITEMS.makePersonal }, frame: 'host' },
        timeoutMs: FORWARDED_SAVE_TIMEOUT_MS,
        expect: [{ text: ITEMS.toastPersonal, frame: 'host', transient: true }, { custom: itemListedAs('Personal', true) }],
      },
      { name: 'Reload the page again', do: { reload: true }, timeoutMs: 45_000, expect: [{ count: PI_ROWS, atLeast: 1, frame: 'host' }] },
      {
        name: 'Show the items changed by you: it is there, now Personal',
        do: { click: piFilter('changed'), frame: 'host' },
        expect: [{ custom: itemListedAs('Personal', true) }],
      },
    ],
  },
  {
    id: 'update-from-dashboard',
    title: 'Update now runs a signed update from the dashboard: one that does not start is put back, one that does runs, and a bad signature runs nothing',
    source: 'owner 1.5 plan, Owner controls: update with one button (#1063, #1144); the engine\'s own updater behind the release check\'s stand-in',
    allowRequests: RESTART_502,
    steps: [
      offered('rolled-back', 0),
      pressUpdateNow,
      {
        name: 'The new version does not start: the previous one is put back',
        do: { observe: true },
        timeoutMs: 60_000,
        expect: [{ text: UPDATE.rolledBack(STAND_IN_TO, STAND_IN_FROM), frame: 'host' }, { present: UPDATE_NOW, frame: 'host' }],
      },
      offered('done', 1),
      pressUpdateNow,
      {
        name: 'The new version starts: the page says it is running',
        do: { observe: true },
        timeoutMs: 60_000,
        expect: [{ text: UPDATE.done(STAND_IN_TO), frame: 'host' }, { absent: UPDATE_NOW, frame: 'host' }],
      },
      offered('bad-signature', 1),
      {
        name: 'Press Update now on an update whose signature does not check out',
        do: { click: UPDATE_NOW, frame: 'host' },
        timeoutMs: 30_000,
        expect: [{ text: UPDATE.failures.bad_signature!, frame: 'host' }],
      },
    ],
  },
  {
    id: 'backup-for-restore',
    title: 'Settings offers Back up and restore, and a backup of this install is made with a passphrase',
    source: 'owner 1.5 plan, Owner controls: back up and restore (#1065, #1098, #1149); the first half of restore-clean-machine',
    machine: 'restore-from',
    steps: [
      { name: 'Open the dashboard', do: { open: 'dashboard' }, expect: [{ present: tab('Settings'), frame: 'host' }] },
      { name: 'Press Settings', do: { click: tab('Settings'), frame: 'host' }, expect: [{ url: /\/dashboard\?settings/ }, { present: tab(BACKUP.title), frame: 'host' }] },
      {
        name: 'Open Back up and restore',
        do: { click: tab(BACKUP.title), frame: 'host' },
        expect: [{ text: BACKUP.intro, frame: 'host' }, { present: { role: 'button', name: BACKUP.unlock }, frame: 'host' }],
      },
      {
        // The owner's link opens a session that is not local grade yet; the section unlocks in place (#1277).
        name: 'Press Unlock on this computer',
        do: { click: { role: 'button', name: BACKUP.unlock }, frame: 'host' },
        expect: [{ present: { role: 'button', name: BACKUP.backUpNow }, frame: 'host' }, { text: BACKUP.restoreButton, frame: 'host' }],
      },
      {
        name: 'Make a backup with a passphrase',
        do: { run: { argv: ['data', 'backup', '--output', RESTORE_BACKUP_FOLDER, '--passphrase-stdin'], stdin: `${RESTORE_PASSPHRASE}\n`, timeoutMs: 600_000 } },
        expect: [{ exit: 0 }, { output: /\.olympusbackup\b/ }],
      },
    ],
  },
  {
    id: 'restore-clean-machine',
    title: 'A backup restored into an empty install on a clean machine brings back the sources and the owner\'s own decisions',
    source: 'owner 1.5 plan, Owner controls: back up and restore (#1065, #1098); restore.ts compares the stores and rules',
    machine: 'restore-to',
    mutates: true,
    steps: [
      { name: 'Stop Olympus', do: { run: { argv: ['engine', 'stop'], timeoutMs: 300_000 } }, expect: [{ exit: 0 }] },
      {
        name: 'Restore the backup',
        do: { run: { argv: ['data', 'restore', '--input', RESTORE_BACKUP_PATH, '--passphrase-stdin'], stdin: `${RESTORE_PASSPHRASE}\n`, timeoutMs: 600_000 } },
        expect: [{ exit: 0 }, { output: /readwise/i }],
      },
      { name: 'Start Olympus', do: { run: { argv: ['engine', 'start'], timeoutMs: 300_000 } }, expect: [{ exit: 0 }] },
      { name: 'Open the dashboard', do: { open: 'dashboard' }, timeoutMs: 120_000, expect: [{ present: tab('Sources'), frame: 'host' }] },
      // The source is back; its sign-in never travels, so it asks for one again rather than syncing.
      { name: 'Press Sources: Readwise is back', do: { click: tab('Sources'), frame: 'host' }, expect: [{ url: /\/dashboard\?connect/ }, { text: 'Readwise', frame: 'host' }] },
      { name: 'Open the Privacy page', do: { open: 'private' }, expect: [{ present: tab(ITEMS.tab), frame: 'host' }] },
      { name: 'Press Your items', do: { click: tab(ITEMS.tab), frame: 'host' }, timeoutMs: 45_000, expect: [{ count: PI_ROWS, atLeast: 1, frame: 'host' }] },
      {
        // fix-one-item set one item on the first machine; nothing on a clean machine was changed by the owner, so this came from the backup.
        name: 'Show the items changed by you: the owner\'s decision came back',
        do: { click: piFilter('changed'), frame: 'host' },
        expect: [{ count: { css: '[data-pi-item] .piyou' }, atLeast: 1, frame: 'host' }],
      },
    ],
  },
];

export const journeyIds = (): string[] => JOURNEYS.map((journey) => journey.id);

/** Which machine a journey is walked on: the run's own (`main`), or one side of the restore leg. */
export type JourneyMachine = 'main' | 'restore-from' | 'restore-to';

/**
 * The journeys for a run on one machine, in order: those that leave the install as it was first, then those that change it. The
 * restore leg's journeys are walked only by that leg, each on its own machine.
 */
export function selectJourneys(only?: readonly string[], skip: readonly string[] = [], machine: JourneyMachine = 'main'): Journey[] {
  const unknown = [...(only ?? []), ...skip].filter((id) => !JOURNEYS.some((journey) => journey.id === id));
  if (unknown.length > 0) throw new Error(`unknown journey id(s): ${unknown.join(', ')}; known: ${journeyIds().join(', ')}`);
  const here = JOURNEYS.filter((journey) => (journey.machine ?? 'main') === machine);
  const chosen = (only === undefined || only.length === 0 ? here : here.filter((journey) => only.includes(journey.id))).filter((journey) => !skip.includes(journey.id));
  return [...chosen.filter((journey) => journey.mutates !== true), ...chosen.filter((journey) => journey.mutates === true)];
}
