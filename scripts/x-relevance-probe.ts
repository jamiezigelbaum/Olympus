#!/usr/bin/env bun

import { Database } from 'bun:sqlite';
import {
  connectorStoreCurrentEmbeddingModelId,
  connectorStoreCurrentEmbeddingRows,
} from '../src/workers/connector-store/index.ts';
import { createCloudSourceIndexEmbeddingProviderFromEnv } from '../src/workers/email-source/server.ts';
import {
  cosineSimilarity,
  decodeEmbedding,
} from '../src/workers/source-index/embeddings.ts';

const X_EMBEDDING_ENV_PREFIX = 'OLYMPUS_SOURCE_INDEX_X_BOOKMARKS';
const RELEVANCE_THRESHOLDS = [0.30, 0.35, 0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70] as const;

export interface XRelevanceProbeOptions {
  dbPath: string;
  account: string;
  modelId?: string;
  queries: string[];
}

export function parseXRelevanceProbeArgs(argv: readonly string[]): XRelevanceProbeOptions {
  let dbPath: string | undefined;
  let account: string | undefined;
  let modelId: string | undefined;
  const queries: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === '--db') {
      dbPath = requiredArgumentValue(argv, ++index, '--db');
    } else if (argument.startsWith('--db=')) {
      dbPath = requiredInlineValue(argument, '--db=');
    } else if (argument === '--account') {
      account = requiredArgumentValue(argv, ++index, '--account');
    } else if (argument.startsWith('--account=')) {
      account = requiredInlineValue(argument, '--account=');
    } else if (argument === '--model-id') {
      modelId = requiredArgumentValue(argv, ++index, '--model-id');
    } else if (argument.startsWith('--model-id=')) {
      modelId = requiredInlineValue(argument, '--model-id=');
    } else if (argument === '--query') {
      queries.push(requiredArgumentValue(argv, ++index, '--query'));
    } else if (argument.startsWith('--query=')) {
      queries.push(requiredInlineValue(argument, '--query='));
    } else {
      throw new Error('Unknown argument. Use --db, --account, optional --model-id, and repeatable --query.');
    }
  }

  if (!dbPath) throw new Error('--db is required; the probe never selects a default store.');
  if (!account) throw new Error('--account is required.');
  if (queries.length === 0) throw new Error('At least one --query is required.');
  return {
    dbPath,
    account,
    ...(modelId ? { modelId } : {}),
    queries,
  };
}

export async function runXRelevanceProbe(
  options: XRelevanceProbeOptions,
  env: Record<string, string | undefined> = process.env,
  writeLine: (line: string) => void = console.log,
): Promise<void> {
  const db = new Database(options.dbPath, { readonly: true, create: false, strict: true });
  try {
    db.exec('PRAGMA busy_timeout = 10000; PRAGMA query_only = ON; PRAGMA foreign_keys = ON;');
    const modelId = options.modelId
      ?? connectorStoreCurrentEmbeddingModelId(db, options.account);
    if (!modelId) {
      throw new Error('No current embedding model exists for the requested account.');
    }
    const provider = createCloudSourceIndexEmbeddingProviderFromEnv({
      ...env,
      [`${X_EMBEDDING_ENV_PREFIX}_EMBEDDING_MODEL`]: modelId,
    }, X_EMBEDDING_ENV_PREFIX);
    if (!provider) {
      throw new Error(
        'Gemini embedding key is required via OLYMPUS_SOURCE_INDEX_X_BOOKMARKS_GEMINI_API_KEY, '
        + 'OLYMPUS_SOURCE_INDEX_CLOUD_GEMINI_API_KEY, OLYMPUS_SOURCE_INDEX_GEMINI_API_KEY, or GEMINI_API_KEY.',
      );
    }

    const rows = connectorStoreCurrentEmbeddingRows(db, {
      modelId: provider.modelId,
      accountScope: options.account,
    });
    for (let queryIndex = 0; queryIndex < options.queries.length; queryIndex += 1) {
      const [queryVector] = await provider.embed(
        [{ text: options.queries[queryIndex]! }],
        { taskType: 'RETRIEVAL_QUERY' },
      );
      if (!queryVector) throw new Error('Gemini returned no query embedding.');

      const bestByItem = new Map<string, number>();
      for (const row of rows) {
        const cosine = cosineSimilarity(queryVector, decodeEmbedding(row.embedding));
        const existing = bestByItem.get(row.localItemId);
        if (existing === undefined || cosine > existing) {
          bestByItem.set(row.localItemId, cosine);
        }
      }
      const ranked = [...bestByItem.entries()]
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
      writeLine(JSON.stringify({
        queryIndex: queryIndex + 1,
        modelId: provider.modelId,
        eligibleItems: ranked.length,
        top5: ranked.slice(0, 5).map(([localItemId, cosine]) => ({
          cosine: roundCosine(cosine),
          local_item_id: localItemId,
        })),
        countsAtOrAbove: Object.fromEntries(
          RELEVANCE_THRESHOLDS.map((threshold) => [
            threshold.toFixed(2),
            ranked.filter(([, cosine]) => cosine >= threshold).length,
          ]),
        ),
      }));
    }
  } finally {
    db.close();
  }
}

function requiredArgumentValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index]?.trim();
  if (!value || value.startsWith('--')) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

function requiredInlineValue(argument: string, prefix: string): string {
  const value = argument.slice(prefix.length).trim();
  if (!value) throw new Error(`${prefix.slice(0, -1)} requires a value.`);
  return value;
}

function roundCosine(value: number): number {
  return Number(value.toFixed(4));
}

if (import.meta.main) {
  await runXRelevanceProbe(parseXRelevanceProbeArgs(process.argv.slice(2)));
}
