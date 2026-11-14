import { DASHBOARD_MODELS_BLOCKED_REASON } from './vocabulary.ts';
import { totalmem } from 'node:os';
import { privateAnswerOptions } from '../../core/privacy-language.ts';
import { VENICE_SETUP_SHORTCUT, VENICE_SETUP_STEPS } from '../source-dashboard.ts';
import type { ModelSetupCard, ModelSetupView } from '../../core/model-setup.ts';
import { blockerBanner, connectorSheet, escapeHtml, rowMenu, setupStepsSheet } from './components.ts';
import { DEFAULT_VENICE_JUDGE_MODEL, judgeArchiveEstimate, judgeDefaultCapDollars, judgeLocalIsSlow, type JudgeObserved } from '../classification/judge-spending.ts';
import { runtimeArchiveFor } from '../source-index/built-in-reasoning/manifest.ts';
import { judgeCount, judgeDuration, judgeMoney } from './judge-format.ts';

interface FirstRunJudgeSetup {
  chosen?: boolean;
  cloudModel: string | null;
  observed?: JudgeObserved;
}
interface ModelSetupOptions {
  heading?: boolean;
  /** Test seam: the machine's memory, which decides the first-run recommendation. */
  totalMemoryBytes?: number;
  judgeSetup?: FirstRunJudgeSetup | undefined;
  judgeRuntime?: { gpu: boolean } | undefined;
}

export const LOCAL_MODELS_SETUP_PROMPT = 'Connect my existing local models to Olympus. Read the installed docs/SOVEREIGNTY_CONFIG.md, inspect the current Olympus policy, and help identify the running answer endpoint and its exact model ID on the machine hosting Olympus. Do not install or maintain model software, download models, change network access, or replace existing vectors. Explain any needed configuration changes before applying them. After an approved policy change, use olympus worker restart to apply it. Use synthetic text to verify the configured answer model, run olympus doctor, then send me back to the Keys page of the Olympus dashboard and its Check readiness button. If the server is on another machine or needs unsupported settings, explain that specific limit rather than inventing a working configuration.';

const LOCAL_MODELS_TOGGLE = 'data-sheet-toggle="#local-model-setup-sheet" aria-expanded="false">Connect existing local models</button>';
const CHECK_FORM_OPEN = '<form method="post" action="/dashboard/models/check" data-model-check>';
const CHECK_FORM_TAIL = '<span data-action-message role="status"></span></form>';

export function renderModelSetup(view: ModelSetupView | undefined, options: ModelSetupOptions = {}): string {
  if (!view) return '';
  // The browser reads the same readiness facts as these cards, without
  // treating the asynchronous check request's acknowledgement as success.
  const status = `<span hidden data-model-setup-status="${escapeHtml(JSON.stringify(view))}"></span>`;
  if (view.computer_use_pending) return status + renderComputerUseChoice(view);
  const engine = renderEngineServerMode(view);
  if (view.privacy_choice_pending) return status + engine + privateModelProgress(view) + renderFirstRunPrivacyChoice(options);
  // The local-models sheet opens in place: directly under whichever control
  // opens it, and only where one does.
  const bannerOwnsToggle = blockerOwnsLocalToggle(view);
  const cards = view.cards.map((card) => {
    // A ready model is a fact, not a task: one row in the source rows' shape,
    // with its replace form behind the row's ⋯ menu (owner, 2026-09-23; UX
    // review 2026-10-01). A model still waiting for its key keeps the full
    // card, so first entry is unchanged.
    if (card.state === 'ready') return readyModelRow(card);
    const state = modelStateWord(card);
    let action = '';
    let sheet = '';
    if (card.id === 'local') {
      // Offered only while the local credential is missing, and only once:
      // when the blocker banner already carries it, the card does not repeat it.
      if (card.state === 'not_configured' && !bannerOwnsToggle) {
        action = `<button type="button" class="btn primary" ${LOCAL_MODELS_TOGGLE}`;
        sheet = localModelsSheet();
      }
    } else {
      action = modelKeyAction(card, card.state === 'applying'
        ? '<span class="modelnote">Key saved. Olympus is applying the configuration or waiting for another required key.</span>'
        : modelKeyForm(card));
    }
    return `<section class="modelcard" data-model-card="${card.id}"><header><b>${escapeHtml(card.label)}</b><span role="status">${escapeHtml(state)}</span></header>`
      + `<p>${escapeHtml(card.detail)}</p>${action}</section>${sheet}`;
  }).join('');
  const localCard = view.cards.some((card) => card.id === 'local');
  // Once every required model is ready, the optional local-model help and the
  // re-check shrink to one quiet line: still reachable, no longer a paragraph
  // and two buttons between the reader and the sources below.
  const extras = view.ready
    ? '<div class="modelextras">'
      + (localCard ? '' : `<button type="button" class="btn" ${LOCAL_MODELS_TOGGLE}`)
      + `${CHECK_FORM_OPEN}<button class="btn" type="submit">Check readiness</button>${CHECK_FORM_TAIL}`
      + '</div>' + (localCard ? '' : localModelsSheet())
    : localCard
      ? ''
      : '<div class="modeltools">'
        + `<p>Optional: your agent can help connect models you already run and review the matching privacy choice.</p><button type="button" class="btn" ${LOCAL_MODELS_TOGGLE}`
        + `${CHECK_FORM_OPEN}<button class="btn" type="submit">Check readiness</button>${CHECK_FORM_TAIL}`
        + '</div>' + localModelsSheet();
  return status + engine + (view.ready ? privateModelProgress(view) : '') + `<section aria-label="Models">${options.heading === false ? '' : '<div class="sect">Models</div>'}`
    + (view.ready
      ? `<p class="quiet" role="status">${options.heading === false ? 'Models are ready.' : 'Models are ready. You can connect sources below.'}</p>`
      : '<p class="modelintro">Add the keys required by your privacy choice. Olympus checks them and updates this page when they are ready. Saved keys are not displayed.</p>')
    + (view.migration_notes ?? []).map(note => `<p role="status" data-embedding-migration>${escapeHtml(note)} See "Legacy embedding migration" in docs/SOVEREIGNTY_CONFIG.md.</p>`).join('')
    + (view.attention ? `<p role="status">${escapeHtml(view.attention)}</p>` : '')
    + `<div class="modelcards">${cards}</div>`
    + extras
    + '</section>';
}

function renderFirstRunPrivacyChoice(options: ModelSetupOptions): string {
  const choices = privateAnswerOptions(options.totalMemoryBytes ?? totalmem()).map(option => `<label class="modelcard"><input type="radio" name="choice" value="${escapeHtml(option.id)}"${option.recommended ? ' checked' : ''}> <b>${escapeHtml(option.label)}${option.recommended ? ' — Recommended' : ''}</b><p>${escapeHtml(option.description)}</p>${option.reason ? `<p data-memory-reason>${escapeHtml(option.reason)}</p>` : ''}</label>`).join('');
  const choice = `<form id="first-run-privacy-choice" data-first-run-privacy>${choices}<span data-action-message role="status"></span></form>`;
  const connect = '<div data-first-run-venice hidden><h4>Add a Venice key</h4><p data-first-run-venice-help></p><button class="btn" type="button" data-focus-target="#venice-setup input[name=api_key]">Go to the Venice key field</button></div>'
    + `<div data-first-run-local hidden><h4>Connect my local models</h4><p>The built-in model is already included. Connect a model you run, or continue with the built-in model.</p><button type="button" class="btn" ${LOCAL_MODELS_TOGGLE}${localModelsSheet()}</div>`;
  const verify = `<form id="first-run-privacy-form" method="post" action="/dashboard/models/check" data-model-check>${CHECK_FORM_TAIL}`
    + '<p data-first-run-result role="status">Run the readiness check to verify your setup.</p><button class="btn" type="button" data-first-run-redo hidden></button><button class="btn" type="button" data-first-run-keys hidden>Continue setup in Keys</button>';
  const judge = options.judgeSetup?.chosen ? '' : firstRunJudgeForm(options);
  return '<section aria-label="Private answers" data-first-run-sheet>' + setupStepsSheet({
    id: 'first-run-privacy', provider: 'Olympus', steps: [
      { title: 'How should Olympus answer with Private items?', text: 'Choose how Private answers may be made. You can change this later in Privacy settings.' },
      { title: 'Connect your choice', text: 'Your privacy choice is saved.' },
      ...(judge ? [{ title: 'Who checks privacy?', text: 'Choose who reads each item to check whether it is Personal, Private or Secret.' }] : []),
      { title: 'Verify it works', text: 'Check that Olympus is ready with your saved choice.' },
    ], stepContent: [choice, connect, ...(judge ? [judge] : [])], finalForm: () => verify,
    stepActions: [{ formId: 'first-run-privacy-choice', label: 'Continue' }, undefined,
      ...(judge ? [{ formId: 'first-run-judge-form', label: 'Save privacy check choice' }] : []),
      { formId: 'first-run-privacy-form', label: 'Check readiness' }],
    footerContent: '<button class="btn primary" type="button" data-first-run-done hidden>Done</button>',
  }) + '</section>';
}

function firstRunJudgeForm(options: ModelSetupOptions): string {
  const observed = options.judgeSetup?.observed ?? {};
  const archive = options.judgeRuntime ?? runtimeArchiveFor(`${process.platform}-${process.arch}`);
  const slow = judgeLocalIsSlow(observed, archive);
  // A fresh install has no Venice lane yet (the Private pool is off until the
  // privacy choice applies), so price the model Venice judging would use.
  const estimate = judgeArchiveEstimate(1_000, options.judgeSetup?.cloudModel ?? DEFAULT_VENICE_JUDGE_MODEL, observed);
  const count = judgeCount(estimate.items);
  const localTime = estimate.measuredHours !== undefined
    ? `${judgeDuration(estimate.measuredHours)} for ${count} items, measured on this computer (${judgeCount(estimate.measuredPerMinute!)} items a minute).`
    : `Time for ${count} items: not measured yet.${archive?.gpu === false ? ' The built-in privacy checker uses only the CPU on this computer and may be slow.' : ''}`;
  return '<form id="first-run-judge-form" method="post" action="/dashboard/models/judge" data-judge-choice data-first-run-judge>'
    + `<label class="modelcard"><input type="radio" name="choice" value="local"${slow ? '' : ' checked'}> <b>This computer</b><p>Free. ${escapeHtml(localTime)}</p></label>`
    + `<label class="modelcard"><input type="radio" name="choice" value="venice"${slow ? ' checked' : ''}> <b>Venice${slow ? ' — Recommended' : ''}</b><p>${escapeHtml(judgeDuration(estimate.cloudHours))} and ${escapeHtml(judgeMoney(estimate.cloudDollars).toLowerCase())} for ${count} items, charged to your Venice account.</p></label>`
    + '<p>Choosing Venice lets it read every item, including Private items, to check privacy. End-to-end encryption is not available yet.</p>'
    + `<label>Total Venice spending limit in dollars<input class="keyfield" type="number" name="cap_dollars" min="0" step="0.01" value="${judgeDefaultCapDollars(estimate.cloudDollars)}"></label>`
    + '<p>Olympus stops sending privacy checks to Venice at this limit. You can change your choice and limit later in Privacy settings.</p>'
    + '<span data-action-message role="status"></span></form>';
}

function localModelsSheet(): string {
  const controls = '<form data-local-models-discover><label>OpenAI-compatible URL (optional)<input class="keyfield" name="base_url" type="url" placeholder="http://127.0.0.1:1234/v1"></label><p>Leave blank to detect Ollama and LM Studio on this computer. Only loopback URLs are accepted.</p><button class="btn primary" type="submit">Detect local models</button><span data-action-message role="status"></span></form>'
    + '<div data-local-models-results></div><form data-local-models-test hidden><input type="hidden" name="base_url"><label>Answer model<select name="answer_model" required></select></label><p>Olympus tests the answer model before saving it. Your existing search index stays unchanged.</p><button class="btn primary" type="submit">Connect answer model</button><span data-action-message role="status"></span></form>';
  return connectorSheet({ id: 'local-model-setup-sheet', heading: 'Connect existing local models', intro: 'Detect models you already run and test them with synthetic text. Olympus does not install, download, or maintain them. Local means the machine hosting Olympus.', promptText: LOCAL_MODELS_SETUP_PROMPT, copyButtonLabel: 'Copy prompt' }).replace('<div class="promptbox"', controls + '<div class="promptbox"');
}

/** The first model in the way, which the blocker banner names. */
function blockingCard(view: ModelSetupView): ModelSetupCard | undefined {
  return view.ready ? undefined : view.cards.find((entry) => entry.required && entry.state !== 'ready');
}

/** True when the blocker banner itself carries "Connect existing local models". */
function blockerOwnsLocalToggle(view: ModelSetupView): boolean {
  const card = blockingCard(view);
  return card?.id === 'local' && card.state === 'not_configured';
}

/**
 * One ready model as a source-style row: name and state, with its secondary
 * act (Replace key, or the local-models help) behind the ⋯ menu.
 */
function readyModelRow(card: ModelSetupCard): string {
  const label = escapeHtml(card.label);
  const state = card.id === 'local' ? 'Ready' : 'Ready · key connected';
  const head = `<div class="attncard plain modelrow" data-model-card="${card.id}">`
    + `<div class="grow"><span class="name">${label}</span><span class="why"> — ${state}</span></div>`;
  if (card.id === 'local') {
    return `${head}${rowMenu(card.label, `<button type="button" class="btn" ${LOCAL_MODELS_TOGGLE}`)}</div>${localModelsSheet()}`;
  }
  const sheetId = `model-key-${card.id.replace(/[^A-Za-z0-9_-]+/g, '-')}`;
  const toggle = `<button type="button" class="btn" data-sheet-toggle="#${sheetId}" aria-controls="${sheetId}" aria-expanded="false">Replace key</button>`;
  return `${head}${rowMenu(card.label, toggle)}</div>`
    + `<div class="sheet" id="${sheetId}" aria-hidden="true"><h4>Replace the ${label} key</h4>`
    + `<p>${escapeHtml(card.detail)} Saved keys are not displayed.</p>${modelKeyAction(card, modelKeyForm(card))}</div>`;
}

/** A model card's state word. A local model under test reads Checking…, never Not configured. */
function modelStateWord(card: ModelSetupCard): string {
  if (card.state === 'applying') return card.id === 'local' ? 'Checking…' : 'Applying…';
  if (card.state === 'needs_attention') return card.id === 'local' ? 'Not answering' : 'Needs attention';
  if (card.state === 'ready') return 'Ready';
  return 'Not configured';
}

/**
 * The Setup page's blocker while models are not ready: every source connection
 * is refused until they are, so this is one banner at the top naming the
 * first model in the way and the one control that clears it. Empty when
 * nothing blocks.
 */
export function renderModelSetupBlocker(view: ModelSetupView | undefined, options: { keysHref?: string } = {}): string {
  if (!view || view.ready || view.privacy_choice_pending) return '';
  if (privateModelWords(view)) return `<div data-private-model-progress>${blockerBanner({ sentence: dashboardModelsBlockedReason(view), ...(view.private_model?.state === 'failed' ? { controlHtml: retryPrivateModel() } : {}) })}</div>`;
  const card = blockingCard(view);
  if (!card) {
    return blockerBanner({ sentence: view.attention ?? 'Model setup is not finished, so sources stay locked.' });
  }
  if (card.id === 'local') {
    if (card.state === 'applying') {
      return blockerBanner({ sentence: 'Checking your local models… Sources unlock when the check passes.' });
    }
    if (card.state === 'needs_attention') {
      return blockerBanner({
        sentence: 'Your local model server is not answering, so sources stay locked. Start it, then check again.',
        controlHtml: `${CHECK_FORM_OPEN}<button class="btn primary" type="submit">Check again</button>${CHECK_FORM_TAIL}`,
      });
    }
    return blockerBanner({
      sentence: 'Connect your local models to start connecting sources.',
      controlHtml: `<button type="button" class="btn primary" ${LOCAL_MODELS_TOGGLE}`,
    }) + localModelsSheet();
  }
  if (card.state === 'applying') {
    return blockerBanner({ sentence: `Applying your ${card.label} key… Sources unlock when it is ready.` });
  }
  if (card.state === 'needs_attention') return blockerBanner({ sentence: card.detail });
  return blockerBanner({
    sentence: `Add your ${card.label} API key to start connecting sources.`,
    // Key fields live on Privacy rules; another page links there instead of focusing a field it does not have.
    controlHtml: options.keysHref
      ? `<a class="btn primary" href="${escapeHtml(`${options.keysHref}#${card.id === 'venice' ? 'venice-setup' : modelKeyFieldId(card)}`)}">Add ${escapeHtml(card.label)} key</a>`
      : `<button type="button" class="btn primary" data-focus-target="#${card.id === 'venice' ? 'model-venice-start' : modelKeyFieldId(card)}">Add ${escapeHtml(card.label)} key</button>`,
  });
}

function modelKeyFieldId(card: ModelSetupCard): string {
  return `model-key-field-${card.id.replace(/[^A-Za-z0-9_-]+/g, '-')}`;
}

function modelKeyForm(card: ModelSetupCard, formId?: string): string {
  return `<form${formId ? ` id="${formId}" class="setupfields"` : ''} method="post" action="/dashboard/connect/api-key" data-connect-kind="api_key" data-model-provider="${card.id}">`
    + `<input type="hidden" name="source" value="${card.id}">`
    + `<input class="keyfield"${card.state === 'ready' ? '' : ` id="${modelKeyFieldId(card)}"`} type="password" name="api_key" required autocomplete="new-password" placeholder="${card.label} API key" aria-label="${card.label} API key">`
    + (formId ? '' : '<button class="btn primary" type="submit">Connect</button>') + '<span data-action-message role="status"></span></form>';
}

/** One wrapping row: the key form (or the saved-key note) and the "Get a key" link beside it. */
function modelKeyAction(card: ModelSetupCard, lead: string): string {
  if (card.id === 'venice' && lead.includes('<form')) {
    return `<span id="model-venice-start" tabindex="-1"></span>` + setupStepsSheet({ id: `model-venice-${card.state}`, provider: 'Venice', steps: VENICE_SETUP_STEPS, shortcut: VENICE_SETUP_SHORTCUT, finalForm: (formId) => modelKeyForm(card, formId) });
  }
  if (card.id === 'gemini') return `<div class="modelaction">${lead}<span class="modelnote">Existing Gemini installations only. New embedding setup uses built-in local EmbeddingGemma or Venice. See the embedding migration guide above.</span></div>`;
  const href = 'https://venice.ai';
  return `<div class="modelaction">${lead}<a href="${href}" target="_blank" rel="noopener noreferrer">Get a ${card.label} API key</a></div>`;
}

const SERVER_MODE_HELP = "Olympus starts by itself after a restart, once the disk is unlocked. Your Mac asks for an administrator's password once.";
const SERVER_CHECKLIST = '<ul data-server-checklist><li>Use a wired network.</li><li>Give this Mac a fixed network address in System Settings.</li><li>After a restart, someone must unlock the disk in person, or use Screen Sharing or SSH unlock on a wired network. After that, Olympus starts by itself.</li></ul>';
function renderComputerUseChoice(view: ModelSetupView): string {
  const pending = view.engine_server_mode?.pending === true;
  return '<section aria-label="Computer setup" data-first-run-computer><h3>How will this computer run?</h3>'
    + '<form data-computer-use><fieldset' + (pending ? ' disabled' : '') + '><legend>Choose how you use this Mac</legend>'
    + '<label class="modelcard"><input type="radio" name="choice" value="everyday" checked> My everyday computer <span>Recommended</span></label>'
    + '<label class="modelcard"><input type="radio" name="choice" value="server"> Always on, as a server</label>'
    + '<p>' + escapeHtml(SERVER_MODE_HELP) + '</p>' + SERVER_CHECKLIST
    + '<button type="submit" class="btn primary">Continue</button></fieldset><span data-action-message role="status">'
    + escapeHtml(view.engine_server_mode?.notice ?? '') + '</span></form></section>';
}
function renderEngineServerMode(view: ModelSetupView): string {
  const mode = view.engine_server_mode;
  if (!mode) return '';
  return '<section aria-label="Engine" id="engine-settings"><h3 class="sect">Engine</h3><form data-computer-use data-server-mode>'
    + '<label><input type="checkbox" role="switch" name="server"' + (mode.enabled ? ' checked' : '') + (mode.pending ? ' disabled' : '')
    + '> Keep Olympus running when no one is logged in</label><p>' + escapeHtml(SERVER_MODE_HELP) + '</p>'
    + '<p role="status">' + (mode.enabled ? 'On — starts once the disk is unlocked.' : 'Off — runs when this account is signed in.') + '</p>'
    + (mode.enabled ? SERVER_CHECKLIST : '')
    + '<button type="submit" class="btn"' + (mode.pending ? ' disabled' : '') + '>Save</button><span data-action-message role="status">'
    + escapeHtml(mode.notice ?? '') + '</span></form></section>';
}

function privateModelWords(view: ModelSetupView | undefined): string {
  const model = view?.private_model;
  if (!model || model.state === 'ready' || model.state === 'not_started' || model.state === 'disabled') return '';
  if (model.state === 'failed') return 'The private answer model download failed. Check your connection and available space, then try again.';
  if (model.state !== 'downloading') return 'Getting the private answer model ready…';
  const done = model.bytesDone; const total = model.bytesTotal;
  if (typeof done !== 'number' || typeof total !== 'number' || !Number.isFinite(done) || !Number.isFinite(total) || total <= 0 || done < 0) return 'Downloading the private answer model…';
  const scale = total >= 1e9 ? 1e9 : 1e6;
  return `Downloading the private answer model: ${(Math.min(done, total) / scale).toFixed(1)} of ${(total / scale).toFixed(1)} ${scale === 1e9 ? 'GB' : 'MB'}`;
}

export function dashboardModelsBlockedReason(view: ModelSetupView | undefined): string {
  const progress = privateModelWords(view);
  return DASHBOARD_MODELS_BLOCKED_REASON + (progress ? `. ${progress}` : '');
}

function retryPrivateModel(): string {
  return '<form method="post" action="/dashboard/models/check" data-model-check data-model-retry><button class="btn primary" type="submit">Try again</button><span data-action-message role="status"></span></form>';
}

function privateModelProgress(view: ModelSetupView): string {
  const words = privateModelWords(view);
  return words ? `<div data-private-model-progress role="status"><p>${escapeHtml(words)}</p>${view.private_model?.state === 'failed' ? retryPrivateModel() : ''}</div>` : '';
}
