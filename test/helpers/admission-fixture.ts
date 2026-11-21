// Wiring shared by the row-parity test and its repeatable timing baseline.
import type { RawItem, SourceConnector } from '../../src/core/contracts.ts';
import { buildSourceIndexCorpusRegistry } from '../../src/core/source-index/corpus.ts';
import { defineConnectorCorpus, type LocalConnectorStore } from '../../src/workers/connector-store/index.ts';
import { connectorStoreAnswerScope } from '../../src/workers/engine/runtime/answer-scope.ts';
import { createSourceAnswerLanes, type SourceAnswerLaneDependencies } from '../../src/workers/engine/runtime/source-answer-lanes.ts';

export function fixtureLanes(stores: LocalConnectorStore[], readScope: SourceAnswerLaneDependencies['readScope'],
  principal: (store: LocalConnectorStore) => { provider: string; accountScope: string }) {
  return createSourceAnswerLanes({
    stores: () => stores, registry: () => buildSourceIndexCorpusRegistry(stores.map(store => defineConnectorCorpus(store))),
    embeddingProvider: () => undefined, localEmbedding: () => undefined, readScope,
    accountScope: store => principal(store).accountScope,
    answerScope: (store, request) => connectorStoreAnswerScope({ store, request, principal: principal(store) }),
  });
}

export function listedItems(id: string, items: RawItem[]): SourceConnector {
  const byId = new Map(items.map(item => [item.identity.localItemId, item]));
  return {
    id, family: items[0]!.identity.family, async authenticate() {},
    async *listItems() { yield { items, done: true }; },
    async fetchItem(id) {
      const item = byId.get(id);
      if (!item) throw new Error('Unknown fixture item');
      return item;
    },
    classificationSignals(item) { return { title: String(item.metadata.title) }; },
  };
}
