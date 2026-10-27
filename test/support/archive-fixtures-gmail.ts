// Synthetic Gmail mail, as both inputs see it: a Google Takeout mbox message
// (the published shape: `From <decimal id>@xxx <date>`, `X-GM-THRID` in
// decimal, `X-Gmail-Labels` by name, `Delivered-To` on received mail) and the
// same message as the Gmail API returns it (hex ids, label ids, a MIME tree
// with part ids). Never real mail.

import type { GmailMessage } from '../../src/workers/google-connectors/gmail.ts';

export interface SyntheticMail {
  /** Gmail's id, as the API writes it (hex). */
  id: string;
  threadId: string;
  /** Takeout's label names. */
  labels: string[];
  /** Label ids, as the API gives them. */
  labelIds: string[];
  deliveredTo?: string;
  from: string;
  to: string;
  subject: string;
  /** ISO date. */
  date: string;
  messageId?: string;
  body: string;
  attachment?: { name: string; mime: string; text: string };
}

const decimal = (hex: string): string => BigInt(`0x${hex}`).toString(10);

function ctime(iso: string): string {
  const date = new Date(iso);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const time = date.toISOString().slice(11, 19);
  return `${days[date.getUTCDay()]} ${months[date.getUTCMonth()]} ${String(date.getUTCDate()).padStart(2, '0')} ${time} +0000 ${date.getUTCFullYear()}`;
}

/** One message as Takeout writes it in its mbox. `separator` overrides the `From ` line (a non-Takeout export). */
export function takeoutMessage(mail: SyntheticMail, options: { separator?: string; markers?: boolean } = {}): string {
  const markers = options.markers !== false;
  const head = [
    options.separator ?? `From ${decimal(mail.id)}@xxx ${ctime(mail.date)}`,
    ...(markers ? [`X-GM-THRID: ${decimal(mail.threadId)}`, `X-Gmail-Labels: ${mail.labels.join(',')}`] : []),
    ...(mail.deliveredTo ? [`Delivered-To: ${mail.deliveredTo}`] : []),
    ...(mail.messageId ? [`Message-ID: <${mail.messageId}>`] : []),
    `From: ${mail.from}`,
    `To: ${mail.to}`,
    `Subject: ${mail.subject}`,
    `Date: ${new Date(mail.date).toUTCString()}`,
    'MIME-Version: 1.0',
  ];
  if (!mail.attachment) return [...head, 'Content-Type: text/plain; charset="UTF-8"', '', mail.body, '', ''].join('\n');
  return [
    ...head,
    'Content-Type: multipart/mixed; boundary="b1"',
    '',
    '--b1',
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    mail.body,
    '--b1',
    `Content-Type: ${mail.attachment.mime}; name="${mail.attachment.name}"`,
    `Content-Disposition: attachment; filename="${mail.attachment.name}"`,
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(mail.attachment.text).toString('base64'),
    '--b1--',
    '',
    '',
  ].join('\n');
}

export function takeoutMbox(mails: readonly SyntheticMail[], options: { separator?: (mail: SyntheticMail) => string; markers?: boolean } = {}): string {
  return mails.map((mail) => takeoutMessage(mail, {
    ...(options.separator ? { separator: options.separator(mail) } : {}),
    ...(options.markers === false ? { markers: false } : {}),
  })).join('');
}

/** The same message as the Gmail API returns it in full. */
export function apiMessage(mail: SyntheticMail, historyId = '9001'): GmailMessage {
  const headers = [
    ...(mail.deliveredTo ? [{ name: 'Delivered-To', value: mail.deliveredTo }] : []),
    ...(mail.messageId ? [{ name: 'Message-ID', value: `<${mail.messageId}>` }] : []),
    { name: 'From', value: mail.from },
    { name: 'To', value: mail.to },
    { name: 'Subject', value: mail.subject },
    { name: 'Date', value: new Date(mail.date).toUTCString() },
  ];
  const text = { partId: mail.attachment ? '0' : '', mimeType: 'text/plain', filename: '', body: { data: Buffer.from(mail.body).toString('base64url'), size: mail.body.length } };
  return {
    id: mail.id,
    threadId: mail.threadId,
    historyId,
    internalDate: String(Date.parse(mail.date)),
    labelIds: mail.labelIds,
    snippet: mail.body.slice(0, 40),
    payload: mail.attachment
      ? {
        partId: '',
        mimeType: 'multipart/mixed',
        headers,
        parts: [
          text,
          {
            partId: '1',
            mimeType: mail.attachment.mime,
            filename: mail.attachment.name,
            body: { attachmentId: `att-${mail.id}`, size: mail.attachment.text.length },
          },
        ],
      }
      : { ...text, headers },
  };
}

export const OWNER_ADDRESS = 'owner@example.test';

export function mail(index: number, overrides: Partial<SyntheticMail> = {}): SyntheticMail {
  const id = (0x18a0000000000000n + BigInt(index)).toString(16);
  return {
    id,
    threadId: id,
    labels: ['Inbox', 'Opened', 'Category Personal'],
    labelIds: ['INBOX', 'CATEGORY_PERSONAL'],
    deliveredTo: OWNER_ADDRESS,
    from: `Sender ${index} <sender${index}@example.test>`,
    to: OWNER_ADDRESS,
    subject: `Fixture subject ${index}`,
    date: `2024-0${1 + (index % 9)}-1${index % 10}T12:00:00.000Z`,
    messageId: `fixture-${index}@example.test`,
    body: `fixturebody${index} words for the fixture message ${index}.`,
    ...overrides,
  };
}
