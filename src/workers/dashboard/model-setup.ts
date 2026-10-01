import type { ModelSetupCard, ModelSetupView } from '../../core/model-setup.ts';
import { blockerBanner, connectorSheet, escapeHtml, rowMenu } from './components.ts';

export const LOCAL_MODELS_SETUP_PROMPT = 'Connect my existing local models to Olympus. Read the installed docs/SOVEREIGNTY_CONFIG.md, inspect the current Olympus policy, and help identify the running answer and embedding endpoints and their exact model IDs on the machine hosting Olympus. Do not install or maintain model software, download models, change network access, or replace existing vectors. Explain any needed configuration changes before applying them. After an approved policy change, use olympus worker restart to apply it. Use synthetic text to verify the configured models and embedding dimensions, run olympus doctor, then send me back to Models in Setup and its Check readiness button. If the server is on another machine or needs unsupported settings, explain that specific limit rather than inventing a working configuration.';

const LOCAL_MODELS_TOGGLE = 'data-sheet-toggle="#local-model-setup-sheet" aria-expanded="false">Connect existing local models</button>';
const CHECK_FORM_OPEN = '<form method="post" action="/dashboard/models/check" data-model-check>';
const CHECK_FORM_TAIL = '<span data-action-message role="status"></span></form>';

export function renderModelSetup(view: ModelSetupView | undefined): string {
  if (!view) return '';
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
  return '<section aria-label="Models"><div class="sect">Models</div>'
    + (view.ready
      ? '<p class="quiet" role="status">Models are ready. You can connect sources below.</p>'
      : '<p class="modelintro">Add the keys required by your privacy choice. Olympus checks them and updates this page when they are ready. Saved keys are not displayed.</p>')
    + (view.attention ? `<p role="status">${escapeHtml(view.attention)}</p>` : '')
    + `<div class="modelcards">${cards}</div>`
    + extras
    + '</section>';
}

function localModelsSheet(): string {
  return connectorSheet({ id: 'local-model-setup-sheet', heading: 'Connect existing local models', intro: 'Your agent can help connect models you already run. Olympus does not install, download, or maintain them. Local means the machine hosting Olympus.', promptText: LOCAL_MODELS_SETUP_PROMPT, copyButtonLabel: 'Copy prompt' });
}

/** The first model in the way, which the blocker banner names. */
function blockingCard(view: ModelSetupView): ModelSetupCard | undefined {
  return view.ready ? undefined : view.cards.find((entry) => entry.state !== 'ready');
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
export function renderModelSetupBlocker(view: ModelSetupView | undefined): string {
  if (!view || view.ready) return '';
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
    controlHtml: `<button type="button" class="btn primary" data-focus-target="#${modelKeyFieldId(card)}">Add ${escapeHtml(card.label)} key</button>`,
  });
}

function modelKeyFieldId(card: ModelSetupCard): string {
  return `model-key-field-${card.id.replace(/[^A-Za-z0-9_-]+/g, '-')}`;
}

function modelKeyForm(card: ModelSetupCard): string {
  return `<form method="post" action="/dashboard/connect/api-key" data-connect-kind="api_key" data-model-provider="${card.id}">`
    + `<input type="hidden" name="source" value="${card.id}">`
    + `<input class="keyfield"${card.state === 'ready' ? '' : ` id="${modelKeyFieldId(card)}"`} type="password" name="api_key" required autocomplete="new-password" placeholder="${card.label} API key" aria-label="${card.label} API key">`
    + '<button class="btn primary" type="submit">Connect</button><span data-action-message role="status"></span></form>';
}

/** One wrapping row: the key form (or the saved-key note) and the "Get a key" link beside it. */
function modelKeyAction(card: ModelSetupCard, lead: string): string {
  const href = card.id === 'gemini' ? 'https://aistudio.google.com/apikey' : 'https://venice.ai';
  return `<div class="modelaction">${lead}<a href="${href}" target="_blank" rel="noopener noreferrer">Get a ${card.label} API key</a></div>`;
}
