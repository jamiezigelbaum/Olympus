export {
  DEFAULT_TELEGRAM_MESSAGES_CORPUS_ID,
  INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
  LEGACY_SECURE_LOCAL_TELEGRAM_MESSAGES_CORPUS_ID,
  PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID,
  defaultInternalTelegramConnectorStoreDbPath,
  defaultProtectedTelegramConnectorStoreDbPath,
  defineInternalTelegramMessagesCorpus,
  defineProtectedTelegramMessagesCorpus,
  defineTelegramMessagesCorpus,
  isTelegramMessagesCorpusId,
  telegramMessagesCorpusIdForTrustDomain,
  telegramMessagesTrustDomainForCorpusId,
  type TelegramMessagesCorpusId,
  type TelegramMessagesCorpusTrustDomain,
} from './corpus-adapter.ts';

export {
  normalizeTelegramSyncDirection,
  assertTelegramProviderCursorMatchesSyncDirection,
} from './sync-cursor.ts';

export {
  TELEGRAM_CAPTURE_CONNECTOR_ID,
  TELEGRAM_CAPTURE_CONNECTOR_IDS,
  TELEGRAM_TRUST_EVICTION_CONNECTOR_ID,
  TELEGRAM_TRUST_RECONCILIATION_CONNECTOR_ID,
  createTelegramCaptureSpoolConnector,
  defaultTelegramCaptureSpoolDir,
  readTelegramCaptureSpool,
  type TelegramCaptureSpoolReadResult,
  type TelegramCaptureSpoolRecord,
} from './capture-spool-connector.ts';

export {
  DEFAULT_TELEGRAM_PULL_MAX_ITEMS,
  TELEGRAM_MALFORMED_SPOOL_WARNING,
  TELEGRAM_TRUST_CONFLICT_WARNING,
  TELEGRAM_MESSAGES_SOURCE_ID,
  TELEGRAM_PERSONAL_ACCOUNT_SCOPE,
  createTelegramConnectorStores,
  createTelegramConnectorStoreSyncHandler,
  reconcileTelegramTrustStores,
  sanitizeTelegramCaptureCursor,
  type TelegramConnectorStores,
  type TelegramConnectorStoreSyncHandler,
  type TelegramConnectorStoreSyncReceipt,
} from './store-sync.ts';
