import { expect, test } from 'bun:test';
import { terminalMessagingCaptureApproval, formatMessagingPairingResult } from '../src/cli.ts';

test('terminal pairing approves current and future Telegram chats without requiring an existing dialog', () => {
  const messages: string[] = [];
  expect(terminalMessagingCaptureApproval('telegram', (message) => messages.push(message))).toEqual({
    source: 'telegram', explicitApproval: true, wholeAccount: true,
  });
  expect(messages.join('')).toContain('chats started after pairing');
  expect(messages.join('')).toContain('Each message');
});

test('terminal pairing ends with a plain status instead of internal JSON', () => {
  expect(formatMessagingPairingResult('whatsapp', { status: 'connected', captureActivation: 'requested' })).toBe('WhatsApp is connected. Olympus is starting capture; open the dashboard to watch messages arrive.');
  expect(formatMessagingPairingResult('telegram', { status: 'connected', captureActivation: 'needs_attention' })).toContain('needs attention');
});
