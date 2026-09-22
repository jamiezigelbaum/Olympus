import type { ModelSetupView } from '../../core/model-setup.ts';
import { connectorSheet, escapeHtml } from './components.ts';

export const MODEL_SETUP_CSS = `
.modelcards{display:grid;gap:12px;margin:16px 0 24px}.modelcard{border:1px solid var(--border,#333);border-radius:12px;padding:18px}
.modelcard header{display:flex;justify-content:space-between;gap:16px}.modelcard form{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:12px}
.modelcard input[type=password]{flex:1;min-width:160px}.modelcard p{margin:8px 0}.source-model-gate{border:0;padding:0;margin:0;min-width:0}.source-model-gate[disabled]{opacity:.5}
`;

export const LOCAL_MODELS_SETUP_PROMPT = 'Connect my existing local models to Olympus. Read the installed docs/SOVEREIGNTY_CONFIG.md, inspect the current Olympus policy, and help identify the running answer and embedding endpoints and their exact model IDs on the machine hosting Olympus. Do not install or maintain model software, download models, change network access, or replace existing vectors. Explain any needed configuration changes before applying them. After an approved policy change, use olympus worker restart to apply it. Use synthetic text to verify the configured models and embedding dimensions, run olympus doctor, then send me back to Models in Setup and its Check readiness button. If the server is on another machine or needs unsupported settings, explain that specific limit rather than inventing a working configuration.';

export function renderModelSetup(view: ModelSetupView | undefined): string {
  if (!view) return '';
  const cards = view.cards.map((card) => {
    const state = { not_configured: 'Not configured', applying: 'Applying…', needs_attention: 'Needs attention', ready: 'Ready' }[card.state];
    let action = '';
    if (card.id === 'local') {
      action = '<button type="button" class="btn" data-sheet-toggle="#local-model-setup-sheet" aria-expanded="false">Connect existing local models</button>';
    } else {
      const form = `<form method="post" action="/dashboard/connect/api-key" data-connect-kind="api_key" data-model-provider="${card.id}">`
        + `<input type="hidden" name="source" value="${card.id}">`
        + `<input class="keyfield" type="password" name="api_key" required autocomplete="new-password" placeholder="${card.label} API key" aria-label="${card.label} API key">`
        + '<button class="btn" type="submit">Connect</button><span data-action-message role="status"></span></form>';
      action = card.state === 'ready' ? `<details><summary>Replace key</summary>${form}</details>`
        : card.state === 'applying' ? '<p>Key saved. Olympus is applying the configuration or waiting for another required key.</p>' : form;
      const href = card.id === 'gemini' ? 'https://aistudio.google.com/apikey' : 'https://venice.ai';
      action += `<p><a href="${href}" target="_blank" rel="noopener noreferrer">Get a ${card.label} API key</a></p>`;
    }
    return `<section class="modelcard" data-model-card="${card.id}"><header><b>${escapeHtml(card.label)}</b><span role="status">${state}</span></header>`
      + `<p>${escapeHtml(card.detail)}</p>${action}</section>`;
  }).join('');
  return '<section aria-label="Models"><div class="sect">Models</div>'
    + '<p>Add the keys required by your privacy choice. Olympus checks them and updates this page when they are ready. Saved keys are not displayed.</p>'
    + (view.attention ? `<p role="status">${escapeHtml(view.attention)}</p>` : '')
    + `<div class="modelcards">${cards}</div>`
    + (view.cards.some((card) => card.id === 'local') ? '' : '<p>Optional: your agent can help connect models you already run and review the matching privacy choice.</p><button type="button" class="btn" data-sheet-toggle="#local-model-setup-sheet" aria-expanded="false">Connect existing local models</button>')
    + '<form method="post" action="/dashboard/models/check" data-model-check><button class="btn" type="submit">Check readiness</button><span data-action-message role="status"></span></form>'
    + (view.ready ? '<p role="status">Models are ready. You can connect sources below.</p>' : '<p role="status">Finish the required model setup above to unlock new source connections.</p>')
    + '</section>'
    + connectorSheet({ id: 'local-model-setup-sheet', heading: 'Connect existing local models', intro: 'Your agent can help connect models you already run. Olympus does not install, download, or maintain them. Local means the machine hosting Olympus.', promptText: LOCAL_MODELS_SETUP_PROMPT, copyButtonLabel: 'Copy prompt' });
}
