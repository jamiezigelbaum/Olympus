import type { ModelSetupCard, ModelSetupView } from '../../core/model-setup.ts';
import { connectorSheet, escapeHtml } from './components.ts';

export const MODEL_SETUP_CSS = `
.modelcards{display:grid;gap:12px;margin:16px 0 24px}.modelcard{border:1px solid var(--border,#333);border-radius:12px;padding:18px}
.modelcard header{display:flex;justify-content:space-between;gap:16px}.modelcard form{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:12px}
.modelcard input[type=password]{flex:1;min-width:160px}.modelcard p{margin:8px 0}.source-model-gate{border:0;padding:0;margin:0;min-width:0}.source-model-gate[disabled]{opacity:.5}
.modelcards .modelrow,.modelcards .sheet{margin:0}.modelcards .sheet form{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:0 0 10px}
.modelcards .sheet input[type=password]{flex:1;min-width:160px}
.modelextras{display:flex;gap:4px;align-items:center;flex-wrap:wrap;margin:-12px 0 24px}.modelextras form{display:inline-flex;align-items:center;gap:8px}
`;

export const LOCAL_MODELS_SETUP_PROMPT = 'Connect my existing local models to Olympus. Read the installed docs/SOVEREIGNTY_CONFIG.md, inspect the current Olympus policy, and help identify the running answer and embedding endpoints and their exact model IDs on the machine hosting Olympus. Do not install or maintain model software, download models, change network access, or replace existing vectors. Explain any needed configuration changes before applying them. After an approved policy change, use olympus worker restart to apply it. Use synthetic text to verify the configured models and embedding dimensions, run olympus doctor, then send me back to Models in Setup and its Check readiness button. If the server is on another machine or needs unsupported settings, explain that specific limit rather than inventing a working configuration.';

const LOCAL_MODELS_TOGGLE = 'data-sheet-toggle="#local-model-setup-sheet" aria-expanded="false">Connect existing local models</button>';
const CHECK_FORM_OPEN = '<form method="post" action="/dashboard/models/check" data-model-check>';
const CHECK_FORM_TAIL = '<span data-action-message role="status"></span></form>';

export function renderModelSetup(view: ModelSetupView | undefined): string {
  if (!view) return '';
  const cards = view.cards.map((card) => {
    // A ready model is a fact, not a task: one row in the source rows' shape,
    // with its replace form a quiet click away (owner, 2026-09-23). A model
    // still waiting for its key keeps the full card, so first entry is unchanged.
    if (card.state === 'ready') return readyModelRow(card);
    const state = { not_configured: 'Not configured', applying: 'Applying…', needs_attention: 'Needs attention', ready: 'Ready' }[card.state];
    let action = '';
    if (card.id === 'local') {
      action = `<button type="button" class="btn" ${LOCAL_MODELS_TOGGLE}`;
    } else {
      action = card.state === 'applying'
        ? '<p>Key saved. Olympus is applying the configuration or waiting for another required key.</p>'
        : modelKeyForm(card);
      action += modelKeyLink(card);
    }
    return `<section class="modelcard" data-model-card="${card.id}"><header><b>${escapeHtml(card.label)}</b><span role="status">${state}</span></header>`
      + `<p>${escapeHtml(card.detail)}</p>${action}</section>`;
  }).join('');
  const localCard = view.cards.some((card) => card.id === 'local');
  // Once every required model is ready, the optional local-model help and the
  // re-check shrink to one quiet line: still reachable, no longer a paragraph
  // and two buttons between the reader and the sources below.
  const extras = view.ready
    ? '<div class="modelextras">'
      + (localCard ? '' : `<button type="button" class="btn quiet" ${LOCAL_MODELS_TOGGLE}`)
      + `${CHECK_FORM_OPEN}<button class="btn quiet" type="submit">Check readiness</button>${CHECK_FORM_TAIL}`
      + '</div>'
    : (localCard ? '' : `<p>Optional: your agent can help connect models you already run and review the matching privacy choice.</p><button type="button" class="btn" ${LOCAL_MODELS_TOGGLE}`)
      + `${CHECK_FORM_OPEN}<button class="btn" type="submit">Check readiness</button>${CHECK_FORM_TAIL}`;
  return '<section aria-label="Models"><div class="sect">Models</div>'
    + (view.ready
      ? '<p class="quiet" role="status">Models are ready. You can connect sources below.</p>'
      : '<p>Add the keys required by your privacy choice. Olympus checks them and updates this page when they are ready. Saved keys are not displayed.</p>')
    + (view.attention ? `<p role="status">${escapeHtml(view.attention)}</p>` : '')
    + `<div class="modelcards">${cards}</div>`
    + extras
    + (view.ready ? '' : '<p role="status">Finish the required model setup above to unlock new source connections.</p>')
    + '</section>'
    + connectorSheet({ id: 'local-model-setup-sheet', heading: 'Connect existing local models', intro: 'Your agent can help connect models you already run. Olympus does not install, download, or maintain them. Local means the machine hosting Olympus.', promptText: LOCAL_MODELS_SETUP_PROMPT, copyButtonLabel: 'Copy prompt' });
}

/**
 * One ready model as a source-style row: name, state, and a quiet control. A
 * key provider's control opens a sheet holding the same replace form and key
 * link the full card carries; the local lane's reopens the local-models sheet.
 */
function readyModelRow(card: ModelSetupCard): string {
  const label = escapeHtml(card.label);
  const state = card.id === 'local' ? 'Ready' : 'Ready · key connected';
  const head = `<div class="attncard plain modelrow" data-model-card="${card.id}">`
    + `<div class="grow"><span class="name">${label}</span><span class="why"> — ${state}</span></div>`;
  if (card.id === 'local') return `${head}<button type="button" class="btn quiet" ${LOCAL_MODELS_TOGGLE}</div>`;
  const sheetId = `model-key-${card.id.replace(/[^A-Za-z0-9_-]+/g, '-')}`;
  return `${head}<button type="button" class="btn quiet" data-sheet-toggle="#${sheetId}" aria-controls="${sheetId}" aria-expanded="false">Replace key</button></div>`
    + `<div class="sheet" id="${sheetId}" aria-hidden="true"><h4>Replace the ${label} key</h4>`
    + `<p>${escapeHtml(card.detail)} Saved keys are not displayed.</p>${modelKeyForm(card)}${modelKeyLink(card)}</div>`;
}

function modelKeyForm(card: ModelSetupCard): string {
  return `<form method="post" action="/dashboard/connect/api-key" data-connect-kind="api_key" data-model-provider="${card.id}">`
    + `<input type="hidden" name="source" value="${card.id}">`
    + `<input class="keyfield" type="password" name="api_key" required autocomplete="new-password" placeholder="${card.label} API key" aria-label="${card.label} API key">`
    + '<button class="btn" type="submit">Connect</button><span data-action-message role="status"></span></form>';
}

function modelKeyLink(card: ModelSetupCard): string {
  const href = card.id === 'gemini' ? 'https://aistudio.google.com/apikey' : 'https://venice.ai';
  return `<p><a href="${href}" target="_blank" rel="noopener noreferrer">Get a ${card.label} API key</a></p>`;
}
