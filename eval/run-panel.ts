// Offline evaluation of the panel's own retrieval, selection and answer path.
import { readFileSync } from 'node:fs';
import { defaultConfig } from '../src/core/config.ts';
import { answerPrivately } from '../src/core/analyst-built-in.ts';
import { createBuiltInPrivateAnswerModel, embeddingPanelRelevance, PANEL_ANSWER_LIMITS, panelLimitsForWindow, privateEvidence } from '../src/workers/chatgpt/private-answer-model.ts';
import { createLocalPrivateRoute, createLocalSovereigntyAnalystModel, probeLocalSovereigntyProfile } from '../src/workers/engine/runtime/private-analysts.ts';
import { resolveLocalAnalystWindow } from '../src/workers/source-index/local-analyst-window.ts';
import { searchPrivateEvidence, checkPrivateEvidenceItems, readPrivateEvidenceItem } from '../src/workers/source-index/analyst-answer.ts';
import { NoPrivateEvidenceError, type PrivateEvidenceItem } from '../src/workers/chatgpt/private-answer-contract.ts';
import type { SovereigntyResolvedProfile } from '../src/core/sovereignty.ts';
import { openEvalDataRoot, type EvalDataRootOptions } from './data-root.ts';
import { parseDataRootArgs } from './data-root-args.ts';
import { createEvalPrivateLanes, prepareEvalEmbedding } from './retrieval.ts';
import { localDraftModel } from './local-model.ts';
import { answerMeaningJudge } from './answer-judge.ts';
import { passageContainsQuote } from './passage-match.ts';
import { validatePassageDataset, type EvalDataset } from './types.ts';

export interface PanelEvalOptions {
  isolation: EvalDataRootOptions;
  dataset: EvalDataset;
  modelBaseUrl: string;
  model: string;
  limits: 'today' | 'window';
  split?: 'open' | 'sealed';
  /** Score only these question ids (a screen on the questions that matter). */
  only?: readonly string[];
}

interface PanelRow {
  id: string;
  matched: number;
  foundDoc: number;
  foundParagraph: number;
  answeredCorrectly: number;
  answeredPartially: number;
  judgeUnknown: number;
  noEvidence: number;
  filesRead: number;
  neededFiles: number;
  neededFilesRead: number;
}

export async function runPanelEval(options: PanelEvalOptions) {
  validatePassageDataset(options.dataset);
  // Apply the existing local-only endpoint validation before any evidence is read.
  const judge = answerMeaningJudge(localDraftModel({ baseUrl: options.modelBaseUrl, model: options.model }));
  const config = defaultConfig();
  config.argus.requestTimeoutSeconds = 0; // Keep an answer in progress until completion.
  const member: SovereigntyResolvedProfile = { id: 'panel-eval', profile: {
    provider: 'local-openai-compatible', trust: 'local', purpose: 'analyst',
    baseUrl: options.modelBaseUrl, model: options.model,
  } };
  let modelCalls = 0;
  const startedAt = Date.now();
  const route = createLocalPrivateRoute({
    log: () => console.error(JSON.stringify({ routeErrors: 1 })),
    firstMember: () => member,
    model: () => {
      const model = createLocalSovereigntyAnalystModel({ profile: member.profile, olympusConfig: config, env: {} });
      if (!model) return undefined;
      // Count every call the panel makes to the answer model (numbers only).
      const counted = new Proxy(model, { get: (target, key, receiver) => {
        const value = Reflect.get(target, key, receiver);
        return typeof value === 'function' ? (...args: unknown[]) => { modelCalls += 1; return (value as (...a: unknown[]) => unknown).apply(target, args); } : value;
      } });
      return { model: counted, modelId: options.model, baseUrl: options.modelBaseUrl };
    },
    reachable: () => probeLocalSovereigntyProfile(config, member.profile),
    window: (model, baseUrl) => resolveLocalAnalystWindow({ model, ...(baseUrl ? { baseUrl } : {}) }),
  });
  const chosen = await route();
  if (!chosen || 'unavailable' in chosen) throw new Error('Panel eval model unavailable.');
  if (options.limits === 'window' && chosen.windowTokens === 0) throw new Error('Panel eval served window unavailable.');
  const limits = options.limits === 'window' ? panelLimitsForWindow(PANEL_ANSWER_LIMITS, chosen.windowTokens) : PANEL_ANSWER_LIMITS;
  const opened = openEvalDataRoot(options.isolation);
  try {
    // An offline copy needs no installed model: without a loaded local embedding
    // provider the engine's lane factory uses its keyword lane, as in passage evals.
    const embedding = await prepareEvalEmbedding({ configured: {} });
    const lanes = createEvalPrivateLanes({ ...opened, embeddingFor: embedding.embeddingFor });
    const rows: PanelRow[] = [];
    let judgeCalls = 0;
    for (const question of options.dataset.questions.filter(q => (q.split ?? 'open') === (options.split ?? 'open') && (!options.only || options.only.includes(q.id)))) {
      opened.checkFileDescriptors();
      const evidence = await searchPrivateEvidence({ lanes, question: question.question });
      const matches = (expected: { corpusId: string; providerItemId?: string }, hit: typeof evidence.candidates[number]) =>
        expected.corpusId === hit.corpusId && expected.providerItemId === hit.provenance.sourceItem.providerItemId;
      const foundDoc = (question.expectedEvidence ?? []).some(expected => evidence.candidates.some(hit => [expected, ...(expected.alternates ?? [])].some(id => matches(id, hit))));
      const foundParagraph = (question.expectedEvidence ?? []).some(expected => evidence.candidates.some(hit =>
        [expected, ...(expected.alternates ?? [])].some(id => matches(id, hit)) && Boolean(expected.quote && passageContainsQuote(hit.chunks.join('\n'), expected.quote))));
      const candidates = evidence.candidates as unknown as readonly PrivateEvidenceItem[];
      const readable = privateEvidence(candidates, limits.maxPassageChars);
      const identities = new Map(readable.items.map((item, index) => [item.id, evidence.candidates[readable.sources[index]!]!]));
      let readIds: readonly string[] = [];
      const panel = createBuiltInPrivateAnswerModel({
        model: undefined, available: () => false, route, limits,
        eligible: items => checkPrivateEvidenceItems({ lanes, items }),
        readItem: (item, request) => readPrivateEvidenceItem({ lanes, item, ...request }),
        relevance: embeddingPanelRelevance(() => undefined),
        answer: (q, items, settings) => answerPrivately(q, items, { ...settings, onEvidence: ids => { readIds = ids; } }),
      });
      let answer: Awaited<ReturnType<typeof panel.answerPrivately>> | undefined;
      try { answer = await panel.answerPrivately(question.question, candidates); }
      catch (error) {
        if (!(error instanceof NoPrivateEvidenceError) && !(error instanceof Error && error.message === 'no private evidence')) throw error;
      }

      const expected = (question.expectedEvidence ?? []).map(item => item.quote).filter(Boolean).join('\n') || (question.expectedAnswerContains ?? []).join('; ');
      if (expected && answer) judgeCalls += 1;
      const meaning = expected && answer ? await judge(question.question, expected, answer.answer) : null;
      const needed = [...new Map((question.neededFiles ?? []).map(file => [JSON.stringify([file.corpusId, file.providerItemId]), file])).values()];
      rows.push({ id: question.id, matched: evidence.matched, foundDoc: Number(foundDoc), foundParagraph: Number(foundParagraph),
        answeredCorrectly: Number(meaning === 'correct'), answeredPartially: Number(meaning === 'partial'), judgeUnknown: Number(meaning === null), noEvidence: Number(!answer),
        filesRead: readIds.length, neededFiles: needed.length,
        neededFilesRead: needed.filter(file => readIds.some(id => { const hit = identities.get(id); return hit && matches(file, hit); })).length });
      opened.checkFileDescriptors();
    }
    const sum = (key: Exclude<keyof typeof rows[number], 'id'>) => rows.reduce((n, row) => n + row[key], 0);
    return { windowTokens: chosen.windowTokens, maxItems: limits.maxItems, maxPromptBytes: limits.maxPromptBytes, retrievalHybrid: 0,
      minutes: Math.round((Date.now() - startedAt) / 6_000) / 10, answerModelCalls: modelCalls, judgeCalls,
      stores: opened.stores.length, skippedStores: opened.skipped.length, questions: rows.length,
      foundDoc: sum('foundDoc'), foundParagraph: sum('foundParagraph'), answeredCorrectly: sum('answeredCorrectly'),
      answeredPartially: sum('answeredPartially'), judgeUnknown: sum('judgeUnknown'), noEvidence: sum('noEvidence'), neededFiles: sum('neededFiles'), neededFilesRead: sum('neededFilesRead'),
      ...((options.split ?? 'open') === 'open' ? { rows } : {}) };
  } finally { opened.close(); }
}

export async function main(argv = process.argv.slice(2)) {
  const { rest, isolation } = parseDataRootArgs(argv);
  if (!isolation) throw new Error('Offline root required.');
  const values = new Map<string, string>();
  let datasetPath: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (!arg.startsWith('--')) { if (datasetPath) throw new Error('One dataset required.'); datasetPath = arg; continue; }
    const separator = arg.indexOf('=');
    const key = separator < 0 ? arg : arg.slice(0, separator);
    if (!['--limits', '--model-base-url', '--model', '--split', '--only'].includes(key)) throw new Error('Unsupported panel eval option.');
    const value = separator < 0 ? rest[++i] : arg.slice(separator + 1);
    if (!value || value.startsWith('--')) throw new Error('Option value required.');
    values.set(key, value);
  }
  const modelBaseUrl = values.get('--model-base-url'); const model = values.get('--model');
  const limits = values.get('--limits') ?? 'today'; const split = values.get('--split') ?? 'open';
  if (!datasetPath || !modelBaseUrl || !model || !['today', 'window'].includes(limits) || !['open', 'sealed'].includes(split)) throw new Error('Invalid panel eval arguments.');
  const dataset: unknown = JSON.parse(readFileSync(datasetPath, 'utf8'));
  validatePassageDataset(dataset);
  const receipt = await runPanelEval({ isolation, dataset, modelBaseUrl, model, limits: limits as 'today' | 'window', split: split as 'open' | 'sealed',
    ...(values.get('--only') ? { only: values.get('--only')!.split(',').map(id => id.trim()).filter(Boolean) } : {}) });
  console.log(JSON.stringify(receipt));
}

// Keep failures as numbers too: upstream errors can contain private content.
if (import.meta.main) main().catch(() => { console.error(JSON.stringify({ errors: 1 })); process.exitCode = 1; }).finally(() => process.exit(process.exitCode ?? 0));
