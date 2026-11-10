/**
 * The model pickers on Privacy rules (owner, 2026-11-07; mockups final-4 and
 * final-5): one row per provider with Change model. The picker lists only
 * models Olympus can use now, "Always the strongest" first where the
 * provider has one; "+ Add a model" opens a dialog (✕, Esc or a click
 * outside closes it) to find or name another.
 */
import type { DashboardModelChoices, ModelChoiceList, ModelChoiceProvider } from '../../core/model-choices.ts';
import { escapeHtml } from './components.ts';
import { LOCAL_MODELS_SETUP_PROMPT } from './model-setup.ts';

const TITLES: Record<ModelChoiceProvider, { row: string; pick: string; intro: string; add: string; addTitle: string }> = {
  local: { row: 'Local', pick: 'Choose your local model', intro: 'Models on this computer that Olympus can use. Nothing leaves this computer.', add: '+ Add a model', addTitle: 'Add a local model' },
  venice: { row: 'Venice', pick: 'Choose your Venice model', intro: "Private models only: Venice doesn't keep what you send.", add: '+ Add a Venice model', addTitle: 'Add a Venice model' },
  zkapi: { row: 'zkAPI', pick: 'Choose your zkAPI model', intro: "zkAPI can't tell who's asking, whichever model you pick.", add: '+ Add', addTitle: 'Add a zkAPI model' },
};

export const LOCAL_MODEL_AGENT_REQUEST = 'Help me add a local model to Olympus. Pick a model that fits this computer\'s memory, download it with Ollama or LM Studio, start it, and tell me when it is running so I can press "Look on this computer" in Olympus Privacy rules. Do not change Olympus settings yourself.';

function currentLabel(list: ModelChoiceList): string {
  const option = list.options.find(entry => entry.value === list.current);
  if (list.current === 'strongest') return `Always the strongest${list.strongestNow ? ` (${list.strongestNow})` : ''}`;
  return option?.label ?? list.current;
}

function picker(list: ModelChoiceList, disabled: boolean): string {
  const t = TITLES[list.provider];
  const id = `model-pick-${list.provider}`;
  const off = disabled ? ' disabled' : '';
  const radios = list.options.map(option => {
    const inUse = option.value === list.current;
    const now = inUse && option.value === 'strongest' && list.strongestNow ? ` · now ${list.strongestNow}` : '';
    const note = option.value === 'strongest'
      ? `${inUse ? ' · in use' : ''}${now}</span><span class="picknote">${escapeHtml(option.note ?? '')}`
      : `${inUse && option.note !== 'in use' ? ' · in use' : ''}${option.note ? ` · ${escapeHtml(option.note)}` : ''}`;
    return `<label class="pickopt${option.value === 'strongest' ? ' strong' : ''}"><input type="radio" name="model" value="${escapeHtml(option.value)}"${inUse ? ' checked' : ''}${off}> <span><b>${escapeHtml(option.label)}</b><span class="pnote">${note}</span></span></label>`;
  }).join('');
  return `<div class="sheet pickpanel" id="${id}" aria-hidden="true"><h4>${escapeHtml(t.pick)}</h4><p class="pnote">${escapeHtml(t.intro)}</p>`
    + `<form data-model-choice><input type="hidden" name="provider" value="${list.provider}"><fieldset${off}><legend class="sr">${escapeHtml(t.pick)}</legend>${radios}</fieldset>`
    + `<div class="pickbar"><button class="btn primary" type="submit"${off}>Use this model</button><button class="btn" type="button" data-sheet-toggle="#${id}">Cancel</button>`
    + `<button class="btn addmodel" type="button" data-add-model-open="${list.provider}"${off}>${escapeHtml(t.add)}</button></div>`
    + '<span data-action-message role="status"></span></form></div>';
}

function addDialog(provider: ModelChoiceProvider): string {
  const t = TITLES[provider];
  const head = `<dialog class="adddialog" data-add-model="${provider}" aria-labelledby="add-model-${provider}"><div class="adddialoghead"><h3 id="add-model-${provider}">${escapeHtml(t.addTitle)}</h3><button class="btn iconbtn" type="button" data-dialog-close aria-label="Close">✕</button></div>`;
  if (provider === 'local') {
    return head + '<p class="pnote">Olympus doesn\'t install or download models itself.</p>'
      + '<section class="addbox"><h4>Find a model you already run</h4><p class="pnote">Olympus looks for Ollama and LM Studio on this computer. If your model server uses another port, enter its address.</p>'
      + '<form data-local-models-discover class="addrow"><button class="btn primary" type="submit">Look on this computer</button><input class="keyfield" name="base_url" type="url" placeholder="http://127.0.0.1:1234/v1 (optional)" aria-label="Model server address on this computer (optional)"><span data-action-message role="status"></span></form>'
      + '<div data-local-models-results></div><form data-local-models-test hidden><input type="hidden" name="base_url"><label>Answer model<select name="answer_model" required></select></label><button class="btn primary" type="submit">Test and add</button><span data-action-message role="status"></span></form>'
      + '<p class="pnote">Olympus tests each model it finds with made-up text before adding it.</p></section>'
      + '<section class="addbox"><h4>Get a new model with your agent\'s help</h4><p class="pnote">Your agent can pick a model that fits this computer, download it and connect it. Copy this request into your agent.</p>'
      + `<div class="promptbox" id="add-model-request" hidden>${escapeHtml(LOCAL_MODEL_AGENT_REQUEST)}</div><button class="btn" type="button" data-copy-target="#add-model-request">Copy request</button><span class="copystatus" data-copy-status aria-live="polite"></span></section>`
      + '</dialog>';
  }
  if (provider === 'venice') {
    return head + '<p class="pnote">Every private model Venice offers you now. Olympus never sends Private items to a model Venice keeps data on.</p>'
      + '<form data-model-choice data-addable-list="venice"><input type="hidden" name="provider" value="venice"><div data-addable-models><p class="pnote" role="status">Loading Venice\'s models…</p></div>'
      + '<div class="pickbar"><button class="btn primary" type="submit">Use this model</button></div><span data-action-message role="status"></span></form></dialog>';
  }
  return head + '<p class="pnote">Name a model zkAPI offers, such as anthropic/claude-sonnet-5.5.</p>'
    + '<form data-model-choice><input type="hidden" name="provider" value="zkapi"><input class="keyfield" name="model" required autocomplete="off" placeholder="provider/model" aria-label="zkAPI model">'
    + '<div class="pickbar"><button class="btn primary" type="submit">Use this model</button></div><span data-action-message role="status"></span></form></dialog>';
}

function pickerRow(list: ModelChoiceList, disabled: boolean, extra = ''): string {
  const t = TITLES[list.provider];
  const id = `model-pick-${list.provider}`;
  return `<div class="pickrow" data-model-pick="${list.provider}"><div class="pickhead"><span class="dot ok" aria-hidden="true"></span><b>${escapeHtml(t.row)}</b><span class="pnote"> · ${escapeHtml(currentLabel(list))}</span>`
    + `<span class="grow"></span><button class="btn" type="button" data-sheet-toggle="#${id}" aria-controls="${id}" aria-expanded="false"${disabled ? ' disabled' : ''}>Change model</button>${extra}</div>`
    + picker(list, disabled) + addDialog(list.provider) + '</div>';
}

/** Local and Venice pickers, for "How Private items are answered". */
export function renderAnswerModelPickers(choices: DashboardModelChoices | undefined, unlocked: boolean): string {
  if (!choices) return '';
  const rows = [choices.local, choices.venice].filter((list): list is ModelChoiceList => list !== undefined).map(list => pickerRow(list, !unlocked));
  return rows.length ? `<div class="pickrows">${rows.join('')}</div>` : '';
}

/** The zkAPI picker, for "On Private questions". */
export function renderZkapiModelPicker(choices: DashboardModelChoices | undefined, unlocked: boolean): string {
  if (!choices?.zkapi) return '';
  // The rows only: Privacy rules › zkAPI (#1047) gives them their section and heading.
  return `<div class="pickrows">${pickerRow(choices.zkapi, !unlocked)}</div>`;
}

export const MODEL_PICKER_CSS = `
.pickrows { display: grid; gap: 12px; margin: 12px 0; }
.pickrow { border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; }
.pickhead { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.pickhead .grow { flex: 1; }
.pickhead .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ok, #3fb950); }
.pickpanel { margin-top: 12px; border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; }
.pickopt { display: flex; gap: 10px; align-items: flex-start; padding: 10px 6px; border-top: 1px solid var(--line); cursor: pointer; }
.pickopt:first-of-type { border-top: 0; }
.pickopt.strong:has(input:checked) { background: color-mix(in srgb, var(--link) 14%, transparent); border-radius: 6px; }
.pickopt .picknote { display: block; color: var(--t2); font-size: 0.92em; margin-top: 2px; }
.pickbar { display: flex; gap: 10px; align-items: center; margin-top: 12px; flex-wrap: wrap; }
.pickbar .addmodel { margin-left: auto; border-style: dashed; }
.adddialog { max-width: 560px; width: calc(100% - 32px); border: 1px solid var(--line); border-radius: 12px; background: var(--bg); color: var(--t1); padding: 18px 20px; }
.adddialog::backdrop { background: rgba(0, 0, 0, 0.55); }
.adddialoghead { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.adddialoghead h3 { margin: 0; }
.iconbtn { min-width: 36px; padding: 4px 8px; }
.addbox { border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; margin-top: 12px; }
.addbox h4 { margin: 0 0 4px; }
.addrow { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
.addrow .keyfield { flex: 1; min-width: 200px; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
@media (max-width: 640px) { .pickbar .addmodel { margin-left: 0; } }
`;
