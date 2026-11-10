import { escapeHtml, setupStepsSheet } from './components.ts';
import { sourceLogoTile } from './source-logos.ts';

/** Guide app registration, then use the existing local, in-memory prompt flow. */
function telegramSetupSheet(): string {
  const walkthrough = setupStepsSheet({
    id: 'telegram-setup', provider: 'Telegram', submitLabel: 'Check keys and continue', shortcut: 'I already have my API ID and hash',
    steps: [
      { title: 'Sign in to Telegram', text: 'Sign in at my.telegram.org with your Telegram phone number. Telegram sends the login code to your Telegram app.', link: { label: 'Sign in to Telegram', url: 'https://my.telegram.org/auth' } },
      { title: 'Open API development tools', text: 'Choose API development tools. If you have not created an app, enter an app title and short name and create it. Keep the app page open.', link: { label: 'API development tools', url: 'https://my.telegram.org/apps' } },
      { title: 'Enter your Telegram app credentials', text: 'Find api_id and api_hash on the app page. Check keys and continue starts pairing on this computer: enter the API ID and API hash when prompted, then your phone number. Telegram then sends a login code as a message in your Telegram app; enter it here, and your two-step verification password if asked.' },
    ],
    finalForm: formId => `<form id="${formId}" method="dialog" data-messaging-kind="start"></form>`,
  });
  return '<div class="sheet" id="telegram-setup" aria-hidden="true" data-messaging-setup><h4>Connect Telegram</h4>'
    + `<div data-messaging-setup-intro>${walkthrough}</div>`
    + '<div data-messaging-view><div data-messaging-input></div></div>'
    + '<form method="dialog" data-messaging-kind="cancel" hidden><button class="btn" type="submit">Cancel pairing</button></form></div>';
}

/** Where the card sits: a dialog gives it the close button. */
export interface MessagingCardOptions {
  /** The card heads a dialog: its header carries the dialog's close button. */
  closable?: boolean;
}

/**
 * Local controls only: the QR and credentials never enter the remote panel.
 *
 * One primary action per state (#1086): not paired, Pair; paired, Choose chats,
 * then Save inside the chooser. Check connection and Pair again sit in the
 * header's ⋯ menu, so no row of buttons can overflow a phone-width dialog.
 * The pairing explanation shows only before pairing. Elements marked
 * data-paired-only / data-unpaired-only switch when a pairing completes.
 */
export function renderMessagingCard(source: 'telegram' | 'whatsapp', localSession: boolean, connection: { paired: boolean; account?: string } = { paired: false }, options: MessagingCardOptions = {}): string {
  const label = source === 'telegram' ? 'Telegram' : 'WhatsApp';
  const sourceId = source === 'telegram' ? 'telegram.messages' : 'whatsapp.personal.messages';
  const paired = connection.paired;
  const pairedOnly = paired ? ' data-paired-only' : ' data-paired-only hidden';
  const unpairedOnly = paired ? ' data-unpaired-only hidden' : ' data-unpaired-only';
  const accountLine = paired ? (connection.account ? `Linked account: ${escapeHtml(connection.account)}` : `Your linked ${label} account`) : 'Not paired yet';
  const close = options.closable ? '<button class="btn iconbtn" type="button" data-dialog-close aria-label="Close">✕</button>' : '';
  const pairAgain = source === 'telegram'
    // A connected state can come from old sync evidence while the session has expired, so pairing stays reachable.
    ? '<button class="btn" type="button" data-sheet-toggle="#telegram-setup" aria-controls="telegram-setup" aria-expanded="false">Pair again</button>'
    : '<form method="dialog" data-messaging-kind="start"><button class="btn" type="submit">Pair again</button></form>';
  const menu = localSession
    ? `<details class="rowmenu msgmenu"${pairedOnly}><summary class="btn" aria-label="More actions for ${label}">⋯</summary><div class="menu">`
      + '<form method="dialog" data-messaging-kind="status"><button class="btn" type="submit">Check connection</button></form>'
      + pairAgain + '</div></details>'
    : '';
  const head = `<div class="msghead">${sourceLogoTile(sourceId)}<div class="msgtitle"><h3>${escapeHtml(label)}</h3><p class="pnote" data-messaging-account>${accountLine}</p></div>${menu}${close}</div>`;
  const intro = source === 'telegram'
    ? 'Pair once with your Telegram app keys and a login code. Then choose which chats Olympus reads. Nothing is read until you choose.'
    : 'Pair once with a QR code from WhatsApp on your phone. Then choose which chats Olympus reads. Nothing is read until you choose.';
  const open = `<section id="agent-${source}-personal" class="messaging-card" aria-hidden="false" data-source="${sourceId}" data-source-id="${sourceId}" data-messaging-source="${source}"${paired ? ' data-messaging-paired' : ''}>${head}`;
  if (!localSession) {
    return open + `<p>${intro}</p><p>Open dashboard controls on this computer to pair and choose chats.</p><form method="dialog" data-messaging-open-controls><button class="btn" type="submit">Open controls on this computer</button><span data-action-message role="status"></span></form></section>`;
  }
  const chats = `<form method="dialog" data-messaging-kind="chats"${pairedOnly}><button class="btn primary" type="submit">Choose chats</button></form>`;
  const cancel = '<form method="dialog" data-messaging-kind="cancel" hidden><button class="btn" type="submit">Cancel pairing</button></form>';
  const status = '<p data-messaging-status role="status" aria-live="polite"></p>';
  return open + `<p class="msgintro"${unpairedOnly}>${intro}</p>`
    + (source === 'telegram'
      ? `${status}<div class="actionrow msgactions"><button class="btn primary"${unpairedOnly} type="button" data-sheet-toggle="#telegram-setup" aria-controls="telegram-setup" aria-expanded="false">Pair Telegram</button>${chats}</div>${telegramSetupSheet()}<div data-messaging-chats></div></section>`
      : `<div class="actionrow msgactions"><form method="dialog" data-messaging-kind="start"${unpairedOnly}><button class="btn primary" type="submit">Pair ${label}</button></form>${chats}${cancel}</div><div data-messaging-view>${status}<img data-messaging-qr hidden alt="Scan this QR code in WhatsApp to link Olympus" width="256" height="256"><div data-messaging-input></div><div data-messaging-chats></div></div></section>`);
}
