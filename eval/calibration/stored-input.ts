// Shared read-only reconstruction for calibration sampling and replay.
import { storedSignals } from '../../src/workers/connector-store/stored-names.ts';
import type { ConnectorStoreItemCopy } from '../../src/workers/connector-store/local-index.ts';
import { judgeInput } from './judge-input.ts';
export type Row = Record<string, string | number | null>;
/** What the production classifier would ask the judge about this stored item. */
export function storedJudgeInput(item: Row, text: string, provider: string) {
  const conversation = typeof item['provider_conversation_id'] === 'string' ? item['provider_conversation_id'] : undefined;
  const signals = storedSignals({
    columns: item,
    identity: { providerConversationId: conversation },
  } as unknown as ConnectorStoreItemCopy);
  return { signals, ...judgeInput(signals, text, provider) };
}

