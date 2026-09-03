import { homedir } from 'node:os';
import { join } from 'node:path';
import { LEGACY_TELEGRAM_MESSAGES_CORPUS_ID } from '../../core/source-corpus-registry.ts';
import { defineSourceIndexCorpus, type SourceIndexCorpusDefinition } from '../../core/source-index/corpus.ts';
import type { SourceTrustDomain } from '../../core/source-index/types.ts';

export const INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID = 'internal.telegram.messages';
export const PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID = 'secure_local.telegram.protected.messages';
export const LEGACY_SECURE_LOCAL_TELEGRAM_MESSAGES_CORPUS_ID = LEGACY_TELEGRAM_MESSAGES_CORPUS_ID;
export const DEFAULT_TELEGRAM_MESSAGES_CORPUS_ID = INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID;

export type TelegramMessagesCorpusId =
  | typeof INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID
  | typeof PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID
  | typeof LEGACY_SECURE_LOCAL_TELEGRAM_MESSAGES_CORPUS_ID;
export type TelegramMessagesCorpusTrustDomain = Extract<SourceTrustDomain, 'internal' | 'secure_local'>;

export function defaultInternalTelegramConnectorStoreDbPath(
  env: Record<string, string | undefined> = process.env,
): string {
  return join(
    env.HOME?.trim() || homedir(),
    '.local',
    'share',
    'openclaw',
    'olympus',
    'telegram-internal-connector-store.sqlite',
  );
}

export function defaultProtectedTelegramConnectorStoreDbPath(
  env: Record<string, string | undefined> = process.env,
): string {
  return join(
    env.HOME?.trim() || homedir(),
    '.local',
    'share',
    'openclaw',
    'olympus',
    'telegram-protected-connector-store.sqlite',
  );
}

export function defineTelegramMessagesCorpus(): SourceIndexCorpusDefinition {
  return defineInternalTelegramMessagesCorpus();
}

export function defineInternalTelegramMessagesCorpus(): SourceIndexCorpusDefinition {
  return defineSourceIndexCorpus({
    corpusId: INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
    family: 'chat',
    trustDomain: 'internal',
    activationMode: 'hybrid_shadow',
    storageProfileInput: {
      cloudEmbeddingApproved: true,
      cloudQueryApproved: false,
    },
    description: 'Internal Telegram chat metadata, tombstones, attachment metadata, and bounded local text for approved ordinary chats.',
  });
}

export function defineProtectedTelegramMessagesCorpus(): SourceIndexCorpusDefinition {
  return defineSourceIndexCorpus({
    corpusId: PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID,
    family: 'chat',
    trustDomain: 'secure_local',
    activationMode: 'hybrid_shadow',
    description: 'Secure-local protected Telegram chat metadata, tombstones, attachment metadata, and bounded local text.',
  });
}

export function telegramMessagesCorpusIdForTrustDomain(trustDomain: SourceTrustDomain): TelegramMessagesCorpusId {
  if (trustDomain === 'internal') return INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID;
  if (trustDomain === 'secure_local') return PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID;
  throw new Error(`Telegram messages do not support trust domain "${trustDomain}".`);
}

export function telegramMessagesTrustDomainForCorpusId(corpusId: string): TelegramMessagesCorpusTrustDomain {
  if (corpusId === INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID) return 'internal';
  if (corpusId === PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID || corpusId === LEGACY_SECURE_LOCAL_TELEGRAM_MESSAGES_CORPUS_ID) return 'secure_local';
  throw new Error(`Unsupported Telegram messages corpus id "${corpusId}".`);
}

export function isTelegramMessagesCorpusId(corpusId: string): corpusId is TelegramMessagesCorpusId {
  return corpusId === INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID
    || corpusId === PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID
    || corpusId === LEGACY_SECURE_LOCAL_TELEGRAM_MESSAGES_CORPUS_ID;
}
