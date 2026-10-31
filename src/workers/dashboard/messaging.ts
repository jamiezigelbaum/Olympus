import { escapeHtml, setupStepsSheet } from './components.ts';

/** Guide app registration, then use the existing local, in-memory prompt flow. */
function telegramSetupSheet(): string {
  const walkthrough = setupStepsSheet({
    id: 'telegram-setup', provider: 'Telegram', submitLabel: 'Check keys and continue',
    steps: [
      { title: 'Sign in to Telegram', text: 'Sign in at my.telegram.org with your Telegram phone number. Telegram sends the login code to your Telegram app.', link: { label: 'Sign in to Telegram', url: 'https://my.telegram.org/auth' } },
      { title: 'Open API development tools', text: 'Choose API development tools. If you have not created an app, enter an app title and short name and create it. Keep the app page open.', link: { label: 'API development tools', url: 'https://my.telegram.org/apps' } },
      { title: 'Enter your Telegram app credentials', text: 'Find api_id and api_hash on the app page. Check keys and continue starts pairing on this computer: enter the API ID and API hash when prompted, then your phone number, Telegram login code and two-step verification password if requested.' },
    ],
    finalForm: formId => `<form id="${formId}" method="dialog" data-messaging-kind="start"></form>`,
  });
  return '<div class="sheet" id="telegram-setup" aria-hidden="true" data-messaging-setup><h4>Connect Telegram</h4><p data-messaging-status role="status" aria-live="polite"></p>'
    + `<div data-messaging-setup-intro>${walkthrough}</div>`
    + '<div data-messaging-view><div data-messaging-input></div><div data-messaging-chats></div></div>'
    + '<form method="dialog" data-messaging-kind="cancel" hidden><button class="btn" type="submit">Cancel pairing</button></form></div>';
}

/** Local controls only: the QR and credentials never enter the remote panel. */
export function renderMessagingCard(source: 'telegram' | 'whatsapp', localSession: boolean): string {
  const label = source === 'telegram' ? 'Telegram' : 'WhatsApp';
  const form = (kind: string, text: string) => `<form method="dialog" data-messaging-kind="${kind}"><button class="btn${kind === 'start' ? ' primary' : ''}" type="submit">${text}</button></form>`;
  return `<section id="agent-${source}-personal" class="messaging-card" aria-hidden="false" data-source="${source === 'telegram' ? 'telegram.messages' : 'whatsapp.personal.messages'}" data-messaging-source="${source}"><h3>${escapeHtml(label)}</h3>`
    + (source === 'whatsapp' ? '<p>The chat list includes saved contacts and groups and may omit unsaved chats. Choose all chats to include those.</p>' : '')
    + '<p>Pairing alone does not start capture. After pairing, choose which chats Olympus reads. Each message is classified on its own; choosing a chat does not set its privacy tier.</p>'
    + (!localSession ? '<p>Open dashboard controls on this computer to pair and choose chats.</p><form method="dialog" data-messaging-open-controls><button class="btn" type="submit">Open controls on this computer</button><span data-action-message role="status"></span></form></section>'
      : source === 'telegram'
        ? `<div class="actionrow"><button class="btn primary" type="button" data-sheet-toggle="#telegram-setup" aria-controls="telegram-setup" aria-expanded="false">Pair Telegram</button>${form('chats', 'Choose chats')}</div>${telegramSetupSheet()}</section>`
        : `<div class="actionrow">${form('start', `Pair ${label}`)}${form('chats', 'Choose chats')}${form('cancel', 'Cancel pairing')}</div><div data-messaging-view><p data-messaging-status role="status" aria-live="polite"></p><img data-messaging-qr hidden alt="Scan this QR code in WhatsApp to link Olympus" width="256" height="256"><div data-messaging-input></div><div data-messaging-chats></div></div></section>`);
}
