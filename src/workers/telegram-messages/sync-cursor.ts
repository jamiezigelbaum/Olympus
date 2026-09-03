export type TelegramSyncDirection = 'forward' | 'backfill';

const FORWARD_CURSOR_PREFIX = 'min_id:';
const BACKFILL_CURSOR_PREFIX = 'offset_id:';

export function normalizeTelegramSyncDirection(
  value: TelegramSyncDirection | undefined,
  providerCursor: string | undefined,
  options: { allowNeutralCursor?: boolean } = {},
): TelegramSyncDirection {
  const cursor = providerCursor?.trim() ?? '';
  if (value === 'forward' || value === 'backfill') {
    assertTelegramProviderCursorMatchesSyncDirection(value, cursor, options);
    return value;
  }
  if (cursor.startsWith(BACKFILL_CURSOR_PREFIX)) return 'backfill';
  if (cursor.startsWith(FORWARD_CURSOR_PREFIX)) return 'forward';
  if (cursor && options.allowNeutralCursor === false) throw invalidTelegramProviderCursorError();
  return 'forward';
}

export function assertTelegramProviderCursorMatchesSyncDirection(
  syncDirection: TelegramSyncDirection,
  providerCursor: string | undefined,
  options: { allowNeutralCursor?: boolean } = {},
): void {
  const cursor = providerCursor?.trim();
  if (!cursor) return;
  if (syncDirection === 'forward' && cursor.startsWith(FORWARD_CURSOR_PREFIX)) return;
  if (syncDirection === 'backfill' && cursor.startsWith(BACKFILL_CURSOR_PREFIX)) return;
  if (!cursor.startsWith(FORWARD_CURSOR_PREFIX) && !cursor.startsWith(BACKFILL_CURSOR_PREFIX) && options.allowNeutralCursor !== false) {
    return;
  }
  throw invalidTelegramProviderCursorError();
}

function invalidTelegramProviderCursorError(): Error {
  return new Error('Telegram sync provider_cursor must be min_id:<id> for forward sync or offset_id:<id> for backfill sync.');
}
