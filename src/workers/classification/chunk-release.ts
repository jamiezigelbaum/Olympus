/** The single chunk gate: windows prove reading, and only item tiers decide privacy. */
import { RELEASE_CHUNK_JUDGE_BUDGET_MS, type ChunkReleaseResult, type ReleaseCheck, type ReleaseInput } from '../../core/release-manifest.ts';
import { classifyContentTier, contentDigestReason, SNIFFER_EXCERPT_MAX_CHARS, TIER_CLASSIFIER_VERSION, type TierSnifferRequest, type TierSnifferVerdict } from './tier-classifier.ts';
import { DEFAULT_EXCERPT_LIMIT } from './delphi-scorer.ts';
import { registeredInstalledTierClassification } from './installed-tier-classification-registry.ts';
import { tierLedgerIdentityKey } from './tier-ledger.ts';
import type { TierVisibilityScope } from '../connector-store/tier-visibility.ts';
import { tierSetForLedger } from '../connector-store/tier-set-registry.ts';
import { emptyTierRejudgeReport, rejudgeStoredContent } from '../connector-store/tier-rejudge.ts';
import { automaticTierMoveOptions, automaticTierMovesAllowed } from '../connector-store/tier-auto-move.ts';
import { moveTieredItem } from '../connector-store/tier-move.ts';
import { parentNamesContext } from '../connector-store/parent-context.ts';

export async function releaseChunks(
  inputs: readonly ReleaseInput[], scopes: readonly TierVisibilityScope[], check: ReleaseCheck,
  options: { budgetMs?: number; now?: () => number; schedule?: (callback: () => void, ms: number) => () => void } = {},
): Promise<ChunkReleaseResult> {
  const now = options.now ?? (() => performance.now());
  const deadline = now() + Math.max(0, options.budgetMs ?? RELEASE_CHUNK_JUDGE_BUDGET_MS);
  const allowed: string[][] = inputs.map(() => []);
  const blockedItems = new Set<string>();
  const initial = await (check.inputsOffThread?.(inputs) ?? check.inputs(inputs));
  const snapshots = new Map<number, () => boolean>();
  for (const [index, input] of inputs.entries()) {
    if (input.layer === 'names') continue;
    const status = initial[index];
    if (!status || status.gone || !['public_or_personal', 'legacy'].includes(status.tier)) continue;
    const scope = scopes.find(scope => scope.corpusIds.has(input.corpusId));
    if (!scope || !input.accountScope) continue;
    const classification = registeredInstalledTierClassification()?.forLedger(scope.ledger.dbPath);
    const judge = classification?.releaseJudge;
    const sniffer = classification?.sniffer;
    if (!judge || !sniffer || classification.unavailableReason || sniffer.rejudgeReady === false) continue;
    const set = tierSetForLedger(scope.ledger.dbPath);
    const store = scope.stores?.().find(store => store.corpusId === input.corpusId)
      ?? set?.openStores().find(store => store.corpusId === input.corpusId);
    const snapshot = store?.releaseItemChunks?.(input);
    const record = scope.ledger.getCurrent(input);
    if (!snapshot || !record) continue;
    const names = JSON.stringify([snapshot.title, snapshot.path, snapshot.sender]);
    const parentContext = set ? parentNamesContext(set, input) : undefined;
    snapshots.set(index, () => {
      const current = store?.releaseItemChunks?.(input);
      const currentJudge = registeredInstalledTierClassification()?.forLedger(scope.ledger.dbPath).releaseJudge;
      return !!current && JSON.stringify([current.title, current.path, current.sender]) === names
        && (!set || parentNamesContext(set, input) === parentContext)
        && currentJudge?.modelId === judge.modelId && currentJudge.promptVersion === judge.promptVersion
        && allowed[index]!.every(hash => current.chunks.some(chunk => chunk.contentHash === hash));
    });
    const fullText = snapshot.chunks.map(chunk => chunk.text).join('');
    // An existing whole-item model verdict covers short text without new records or calls.
    const shortRead = normalize(fullText).length <= SNIFFER_EXCERPT_MAX_CHARS
      && record.reasons.includes(contentDigestReason(fullText))
      && record.reasons.some(reason => reason.startsWith(`content:sniffer:${sniffer.id}:`) && !reason.endsWith(':undecided'));
    for (const hash of new Set(input.chunkHashes ?? [])) {
      const chunk = snapshot.chunks.find(chunk => chunk.contentHash === hash);
      if (!chunk) continue;
      if (shortRead) { allowed[index]!.push(hash); continue; }
      // Keep layout for the production detectors. The production excerpt
      // builder normalizes only after those screens have read this window.
      const text = chunk.text;
      if (!text.trim()) continue;
      let complete = true;
      for (let offset = 0, windowIndex = 0; offset < text.length; windowIndex++) {
        let end = Math.min(text.length, offset + SNIFFER_EXCERPT_MAX_CHARS);
        // A window boundary must not turn one Unicode character into two
        // replacement characters that the original passage never contained.
        if (end < text.length && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff
          && text.charCodeAt(end) >= 0xdc00 && text.charCodeAt(end) <= 0xdfff) end--;
        const window = text.slice(offset, end);
        offset = end;
        let request: TierSnifferRequest | undefined;
        // The classifier supplies the production material and all detector flags.
        const decision = classifyContentTier({
          text: window, requireModelRead: true, metadataTier: 'private', metadataForced: false, metadataFlagged: false,
          title: snapshot.title, path: snapshot.path, sender: snapshot.sender, subject: input,
          mimeType: 'text/plain', holdUntilJudged: true,
          ...(parentContext ? { parentContext } : {}),
        }, { sniffer: { id: sniffer.id, judge: question => { request = question; return { verdict: 'undecided' }; } } });
        let verdict: TierSnifferVerdict = { verdict: 'undecided' };
        if (decision.contentTier === 'secure' || decision.contentTier === 'secrets') {
          verdict = { verdict: 'decided', tier: decision.contentTier, code: 'window_screen' };
        } else if (request?.material && request.material.length <= DEFAULT_EXCERPT_LIMIT) {
          request.stillAsk = () => {
            const status = check.inputs([input])[0];
            return !!status && !status.gone && ['public_or_personal', 'legacy'].includes(status.tier);
          };
          const key = { subject: input, contentHash: hash, modelId: judge.modelId,
            promptVersion: judge.promptVersion, materialHash: `${request.materialHash}:${TIER_CLASSIFIER_VERSION}`, windowIndex };
          const cached = judge.read(key);
          if (cached) verdict = { verdict: 'decided', tier: cached, code: 'window_cached' };
          else if (now() < deadline) {
            verdict = await withinBudget(signal => judge.resolve(request!, signal), deadline - now(), options.schedule);
            if (verdict.verdict === 'decided') judge.record(key, verdict.tier);
          }
        }
        if (verdict.verdict === 'undecided') { complete = false; break; }
        if (verdict.tier !== 'private') {
          complete = false;
          blockedItems.add(tierLedgerIdentityKey(input));
          // Use the ordinary automatic re-judge/placement path. Its full-text
          // secret screen still runs; the window verdict can only raise it.
          if (set) {
            const current = scope.ledger.getCurrent(input);
            if (current) rejudgeStoredContent(set, current, {
              sniffer: { id: sniffer.id, judge: () => verdict },
              report: emptyTierRejudgeReport(), autoMoves: true, hideRaises: true, preserveMetadata: true,
            });
            const context = set.automaticMoveContext;
            const moving = scope.ledger.getCurrent(input);
            if (context && automaticTierMovesAllowed(set, context) && moving?.state === 'moving') {
              try { await moveTieredItem({ set, identity: input,
                target: { metadataTier: moving.targetMetadataTier!, contentTier: moving.targetContentTier! },
                expectedGeneration: moving.generation, ...automaticTierMoveOptions(set, context) }); }
              catch { /* The queued raise stays hidden and the automatic executor retries. */ }
            }
          }
          break;
        }
      }
      if (complete) allowed[index]!.push(hash);
      if (blockedItems.has(tierLedgerIdentityKey(input))) break;
    }
  }
  // A late Private verdict invalidates every earlier passage from the same item.
  const final = await (check.inputsOffThread?.(inputs) ?? check.inputs(inputs));
  let withheldPassages = 0;
  const withheldDocuments = new Set<string>();
  inputs.forEach((input, index) => {
    if (input.layer === 'names') return;
    const status = final[index];
    if (!status || status.gone || !['public_or_personal', 'legacy'].includes(status.tier)
      || blockedItems.has(tierLedgerIdentityKey(input)) || snapshots.get(index)?.() !== true) allowed[index] = [];
    const count = Math.max(1, new Set(input.chunkHashes ?? []).size) - allowed[index]!.length;
    if (count > 0) { withheldPassages += count; withheldDocuments.add(tierLedgerIdentityKey(input)); }
  });
  return { allowed, withheldPassages, withheldDocuments: withheldDocuments.size };
}

function normalize(text: string): string { return text.replace(/\s+/g, ' ').trim(); }

/** Bound even a transport that ignores cancellation. Late answers cannot authorize release. */
async function withinBudget(ask: (signal: AbortSignal) => Promise<TierSnifferVerdict>, ms: number,
  schedule = (callback: () => void, ms: number) => { const timer = setTimeout(callback, ms); return () => clearTimeout(timer); },
): Promise<TierSnifferVerdict> {
  if (ms <= 0) return { verdict: 'undecided' };
  const controller = new AbortController();
  let cancel: (() => void) | undefined;
  try {
    return await Promise.race([
      ask(controller.signal),
      new Promise<TierSnifferVerdict>(resolve => { cancel = schedule(() => { controller.abort(); resolve({ verdict: 'undecided' }); }, ms); }),
    ]);
  } catch { return { verdict: 'undecided' }; }
  finally { cancel?.(); controller.abort(); }
}
