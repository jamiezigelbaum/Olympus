// The photo privacy judge (docs/design/photo-embeddings.md, owner decision
// 2026-10-08). Shared and source-neutral: it reads a picture's image-only
// vector from a model that embeds pictures and text in one space, and never
// names a source.
//
// Ordinary photos are Personal, like the owner's other files. Only SENSITIVE
// photos are Private: nudity or intimate images, identity documents, bank or
// credit cards, and pictures of financial or medical documents. The judge is
// zero-shot: the picture's vector is compared with a short description of each
// sensitive category and of an ordinary photo, and the margin by which the
// closest sensitive description beats the ordinary one decides. A picture that
// cannot be judged (no image encoder, no model that reads pictures, a picture
// the encoder fails on) is `unjudged`, and an unjudged picture stays Private.
// A missed sensitive photo is worse than a wrongly Private one.

import type { SourceEmbeddingImageInput, SourceEmbeddingProvider } from './embeddings.ts';

export type MediaJudgmentVerdict = 'sensitive' | 'ordinary' | 'unjudged';

export const MEDIA_JUDGE_SENSITIVE_CATEGORIES = [
  'id_document',
  'bank_card',
  'financial_document',
  'medical_document',
  'intimate',
] as const;
export type MediaJudgeSensitiveCategory = (typeof MEDIA_JUDGE_SENSITIVE_CATEGORIES)[number];
export type MediaJudgeCategory = MediaJudgeSensitiveCategory | 'ordinary';

/**
 * One description per category, embedded as a classification query. The
 * version names this exact prompt set: a judgment records it, and a changed
 * prompt set is a new judge.
 */
export const MEDIA_JUDGE_PROMPT_SET = 'photo-judge-2026-10-08';
export const MEDIA_JUDGE_PROMPTS: Readonly<Record<MediaJudgeCategory, string>> = Object.freeze({
  id_document: 'a photo of a passport, national identity card or driving licence',
  bank_card: 'a photo of a credit card, debit card or bank card',
  financial_document: 'a bank statement, payslip or document showing account numbers',
  medical_document: 'a medical report or lab test results document',
  intimate: 'a nude, intimate or sexually explicit photo',
  ordinary: 'an ordinary photo of a place, a room, food, a landscape or people',
});
/** How each description is framed for EmbeddingGemma 2 (its classification task prompt). */
export const MEDIA_JUDGE_PROMPT_PREFIX = 'task: classification | query: ';

export interface MediaJudgeThresholds {
  /** Sensitive when the closest sensitive description beats the ordinary one by at least this. */
  margin: number;
  /** Sensitive (intimate) when the intimate description alone beats the ordinary one by at least this. */
  intimateMargin: number;
}

/**
 * The judge's thresholds (the config this build ships).
 *
 * Calibration, 2026-10-08, EmbeddingGemma 2 on LiteRT-LM (image-only vectors,
 * cosine against the descriptions above):
 * - 22 public specimen images (passports, identity cards, driving licences,
 *   bank cards, bank statements, payslips): margins 0.051 to 0.180, median
 *   0.107.
 * - The owner's 116 Dropbox photos: median margin -0.011, highest 0.128 (a
 *   lab-result picture: medical, correctly sensitive), next 0.040 (a family
 *   beach photo, near "intimate").
 * - margin 0.04: all 22 specimens caught, 2 of 116 owner photos flagged.
 * - intimateMargin 0.025 (owner's choice, 2026-10-08: medium, not maximally
 *   strict): no real intimate picture was available to measure, so the
 *   intimate rule is more cautious than the general one. Among ordinary
 *   photos the intimate description's margin peaks on beach and swimwear
 *   pictures (owner photos: median -0.016, highest 0.040), and on
 *   non-intimate sensitive specimens it stays below 0.015. At 0.025, 8 of
 *   116 owner photos rest Private (7 beach or family shots, plus the medical
 *   one the general margin holds); 0.02 held 12.
 */
export const MEDIA_JUDGE_THRESHOLDS: Readonly<MediaJudgeThresholds> = Object.freeze({
  margin: 0.04,
  intimateMargin: 0.025,
});

export interface MediaJudgment {
  verdict: MediaJudgmentVerdict;
  /** The closest sensitive category (sensitive: the one that decided). */
  category?: MediaJudgeSensitiveCategory;
  /** The closest sensitive description's score minus the ordinary one's. */
  margin?: number;
  /** The per-category scores, kept so a later threshold can be re-applied without the picture. */
  scores?: Partial<Record<MediaJudgeCategory, number>>;
  /** Which judge decided: the prompt set, the thresholds and the model that read the picture. */
  judgeId: string;
  /** Why a picture is unjudged (it could not be read). */
  reason?: string;
}

// A stored judgment made under any other id is stale: the picture is judged
// again, and a changed verdict is applied again.
export function mediaJudgeId(
  provider: Pick<SourceEmbeddingProvider, 'modelId' | 'configHash'>,
  thresholds: MediaJudgeThresholds = MEDIA_JUDGE_THRESHOLDS,
): string {
  return `${MEDIA_JUDGE_PROMPT_SET}:m${thresholds.margin}:i${thresholds.intimateMargin}:${provider.modelId}:${provider.configHash.slice(0, 12)}`;
}

function dot(left: readonly number[], right: readonly number[]): number {
  let sum = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) sum += left[index]! * right[index]!;
  return sum;
}

function rounded(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * The verdict for one picture from its per-category scores. Anything that is
 * not a finite score for every category is unjudged.
 */
export function judgeMediaScores(
  scores: Partial<Record<MediaJudgeCategory, number>>,
  judgeId: string,
  thresholds: MediaJudgeThresholds = MEDIA_JUDGE_THRESHOLDS,
): MediaJudgment {
  const ordinary = scores.ordinary;
  const sensitive = MEDIA_JUDGE_SENSITIVE_CATEGORIES.map((category) => [category, scores[category]] as const);
  if (typeof ordinary !== 'number' || !Number.isFinite(ordinary)
    || sensitive.some(([, score]) => typeof score !== 'number' || !Number.isFinite(score))) {
    return { verdict: 'unjudged', judgeId, reason: 'scores_unavailable' };
  }
  let top: MediaJudgeSensitiveCategory = sensitive[0]![0];
  let topScore = -Infinity;
  for (const [category, score] of sensitive) {
    if (score! > topScore) {
      top = category;
      topScore = score!;
    }
  }
  const margin = topScore - ordinary;
  const intimateMargin = scores.intimate! - ordinary;
  const kept = Object.fromEntries(Object.entries(scores).map(([key, value]) => [key, rounded(value!)])) as Partial<Record<MediaJudgeCategory, number>>;
  if (margin >= thresholds.margin) {
    return { verdict: 'sensitive', category: top, margin: rounded(margin), scores: kept, judgeId };
  }
  if (intimateMargin >= thresholds.intimateMargin) {
    return { verdict: 'sensitive', category: 'intimate', margin: rounded(margin), scores: kept, judgeId };
  }
  return { verdict: 'ordinary', category: top, margin: rounded(margin), scores: kept, judgeId };
}

/** The verdict for one image-only vector against the description vectors (same order as MEDIA_JUDGE_PROMPTS). */
export function judgeImageVector(
  imageVector: readonly number[] | undefined,
  promptVectors: Readonly<Record<MediaJudgeCategory, readonly number[]>>,
  judgeId: string,
  thresholds: MediaJudgeThresholds = MEDIA_JUDGE_THRESHOLDS,
): MediaJudgment {
  if (!imageVector || imageVector.length === 0) return { verdict: 'unjudged', judgeId, reason: 'image_unreadable' };
  // A vector with no direction scores 0 against every description, which
  // would read as ordinary.
  if (Math.hypot(...imageVector) < 1e-6) return { verdict: 'unjudged', judgeId, reason: 'image_unreadable' };
  const scores: Partial<Record<MediaJudgeCategory, number>> = {};
  for (const category of Object.keys(MEDIA_JUDGE_PROMPTS) as MediaJudgeCategory[]) {
    scores[category] = dot(imageVector, promptVectors[category]);
  }
  return judgeMediaScores(scores, judgeId, thresholds);
}

/**
 * The capability a provider offers the judge: present only on a provider
 * whose model embeds pictures into the same space as text (the built-in
 * EmbeddingGemma 2).
 */
export type MediaJudgeProvider = SourceEmbeddingProvider & Required<Pick<SourceEmbeddingProvider, 'embedPromptTexts' | 'embedImageVectors'>>;

export function canJudgeMedia(provider: SourceEmbeddingProvider): provider is MediaJudgeProvider {
  return typeof provider.embedPromptTexts === 'function' && typeof provider.embedImageVectors === 'function';
}

// Description vectors, made once per model in this process.
const promptVectorCache = new Map<string, Promise<Record<MediaJudgeCategory, number[]>>>();

/** The description vectors for this provider's model, made once per model and process. */
export function mediaJudgePromptVectors(provider: MediaJudgeProvider): Promise<Record<MediaJudgeCategory, number[]>> {
  const key = `${provider.provider}\u0000${provider.modelId}\u0000${provider.configHash}`;
  let cached = promptVectorCache.get(key);
  if (!cached) {
    const categories = Object.keys(MEDIA_JUDGE_PROMPTS) as MediaJudgeCategory[];
    cached = provider.embedPromptTexts(categories.map((category) => `${MEDIA_JUDGE_PROMPT_PREFIX}${MEDIA_JUDGE_PROMPTS[category]}`))
      .then((vectors) => {
        if (vectors.length !== categories.length || vectors.some((vector) => vector.length === 0)) {
          throw new Error('The photo judge\'s descriptions could not be embedded.');
        }
        return Object.fromEntries(categories.map((category, index) => [category, vectors[index]!])) as Record<MediaJudgeCategory, number[]>;
      });
    promptVectorCache.set(key, cached);
    // A failure is not remembered: the next pass tries again.
    cached.catch(() => promptVectorCache.delete(key));
  }
  return cached;
}

/** Forgets the cached description vectors (tests only). */
export function resetMediaJudgePromptVectors(): void {
  promptVectorCache.clear();
}

/**
 * Judges pictures with a provider that reads them. Each judgment is
 * `unjudged` for a picture the encoder could not read; a failure of the whole
 * call (the encoder is not running) is thrown, so the caller records nothing
 * and tries again later.
 */
export async function judgeMediaImages(
  provider: MediaJudgeProvider,
  images: readonly SourceEmbeddingImageInput[],
  thresholds: MediaJudgeThresholds = MEDIA_JUDGE_THRESHOLDS,
): Promise<MediaJudgment[]> {
  if (images.length === 0) return [];
  const prompts = await mediaJudgePromptVectors(provider);
  const vectors = await provider.embedImageVectors([...images]);
  const judgeId = mediaJudgeId(provider, thresholds);
  return images.map((_, index) => judgeImageVector(vectors[index], prompts, judgeId, thresholds));
}

/** Judgments for image vectors that came back with a document embedding (one round trip). */
export async function judgeReturnedImageVectors(
  provider: MediaJudgeProvider,
  vectors: ReadonlyArray<readonly number[] | undefined>,
  thresholds: MediaJudgeThresholds = MEDIA_JUDGE_THRESHOLDS,
): Promise<MediaJudgment[]> {
  const prompts = await mediaJudgePromptVectors(provider);
  const judgeId = mediaJudgeId(provider, thresholds);
  return vectors.map((vector) => judgeImageVector(vector, prompts, judgeId, thresholds));
}
