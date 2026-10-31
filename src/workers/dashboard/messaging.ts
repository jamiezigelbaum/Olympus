import { escapeHtml } from './components.ts';

/** Local controls only: the QR and credentials never enter the remote panel. */
export function renderMessagingCard(source: 'telegram' | 'whatsapp', localSession: boolean): string {
  const label = source === 'telegram' ? 'Telegram' : 'WhatsApp';
  const form = (kind: string, text: string) => `<form method="dialog" data-messaging-kind="${kind}"><button class="btn" type="submit">${text}</button></form>`;
  return `<section id="agent-${source}-personal" class="sheet on" aria-hidden="false" data-source="${source === 'telegram' ? 'telegram.messages' : 'whatsapp.personal.messages'}" data-messaging-source="${source}"><h3>${escapeHtml(label)}</h3>`
    + (source === 'whatsapp' ? '<p>The chat list includes saved contacts and groups and may omit unsaved chats. Choose all chats to include those.</p>' : '')
    + '<p>Choose which chats Olympus reads. Each message is classified on its own; choosing a chat does not set its privacy tier.</p>'
    + (!localSession ? '<p>Open dashboard controls on this computer to pair and choose chats.</p><form method="dialog" data-messaging-open-controls><button class="btn" type="submit">Open controls on this computer</button><span data-action-message role="status"></span></form></section>'
      : `${form('start', `Pair ${label}`)}${form('chats', 'Choose chats')}<div data-messaging-view><p data-messaging-status role="status" aria-live="polite"></p><img data-messaging-qr hidden alt="Scan this QR code in WhatsApp to link Olympus" width="256" height="256"><div data-messaging-input></div><div data-messaging-chats></div></div>${form('cancel', 'Cancel pairing')}</section>`);
}
