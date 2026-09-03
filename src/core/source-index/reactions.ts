// Shared reaction representation for the source pipeline.
//
// Owner ruling (2026-07-24): an emoji reaction can CONFIRM a message, so it is
// evidence. Reactions are captured as metadata attached to the REACTED item —
// never as separate messages, never as an append-only event log. This module
// owns the source-neutral half of that ruling: the normalized aggregate a
// connector emits, the bounds a store enforces on write, and the ONE
// deterministic line that reaches search_text, the embedding input, and the
// Analyst's evidence. A connector only has to produce the aggregate; nothing
// downstream is source-aware.
//
// Shape: one entry per reaction token, carrying the CURRENT total. A removal
// reduces a count or drops the entry — the connector re-emits the item with
// the aggregate as it stands now and the store replaces what it holds. Actors
// are optional because some providers expose counts only, and reaction tokens
// are opaque strings so custom/provider-specific reactions survive unchanged.
//
// Bounds are refusals, not repairs. A producer past a bound is pushing
// unbounded provider data into one item column, and silently trimming would
// make the stored aggregate disagree with the source it claims to mirror.
// Refusal messages state the rule and the limit ONLY — never the offending
// token, label, or actor id, because reaction content is content-tier data and
// this error can surface in a counts-only lane.

export interface SourceReactionActor {
  providerActorId?: string;
  label?: string;
}

export interface SourceReaction {
  /** Opaque reaction token: an emoji, or a provider's custom-reaction id. */
  key: string;
  /** Current total for this token across all actors. */
  count: number;
  /** Optional and possibly partial: providers may expose counts only. */
  actors?: readonly SourceReactionActor[];
}

export const MAX_SOURCE_REACTION_TOKENS = 32;
export const MAX_SOURCE_REACTION_KEY_CHARS = 64;
export const MAX_SOURCE_REACTION_COUNT = 1_000_000;
export const MAX_SOURCE_REACTION_ACTORS = 32;
export const MAX_SOURCE_REACTION_ACTOR_FIELD_CHARS = 120;
export const MAX_SOURCE_REACTIONS_SERIALIZED_CHARS = 4_000;

export type SourceReactionRefusal =
  | 'not_an_array'
  | 'entry_not_an_object'
  | 'invalid_key'
  | 'key_too_long'
  | 'duplicate_key'
  | 'too_many_tokens'
  | 'invalid_count'
  | 'count_too_large'
  | 'invalid_actors'
  | 'too_many_actors'
  | 'invalid_actor'
  | 'actor_field_too_long'
  | 'serialized_too_large';

/**
 * Typed refusal for a malformed or unbounded reaction aggregate.
 *
 * `refusal` is the machine-readable reason; `message` restates the rule and
 * its limit. Neither ever carries the rejected value.
 */
export class SourceReactionValidationError extends Error {
  readonly refusal: SourceReactionRefusal;

  constructor(refusal: SourceReactionRefusal, message: string) {
    super(message);
    this.name = 'SourceReactionValidationError';
    this.refusal = refusal;
  }
}

/**
 * Validates and canonicalizes a connector-supplied reaction aggregate.
 *
 * Absent (`undefined`/`null`) input returns `undefined` — "this emit says
 * nothing about reactions", which callers translate into "leave what is
 * stored alone". An explicit empty array is the way to say "there are no
 * reactions any more"; that is what makes removal-to-empty expressible without
 * an append-only history.
 */
export function normalizeSourceReactions(value: unknown): readonly SourceReaction[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new SourceReactionValidationError(
      'not_an_array',
      'Reaction metadata must be an array of {key, count, actors?} aggregates.',
    );
  }
  if (value.length > MAX_SOURCE_REACTION_TOKENS) {
    throw new SourceReactionValidationError(
      'too_many_tokens',
      `A reaction aggregate is limited to ${MAX_SOURCE_REACTION_TOKENS} distinct tokens.`,
    );
  }

  const seenKeys = new Set<string>();
  const normalized: SourceReaction[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new SourceReactionValidationError(
        'entry_not_an_object',
        'Each reaction aggregate entry must be an object with a key and a count.',
      );
    }
    const record = entry as Record<string, unknown>;
    const key = normalizeReactionKey(record['key']);
    if (seenKeys.has(key)) {
      throw new SourceReactionValidationError(
        'duplicate_key',
        'A reaction aggregate carries one entry per token; duplicate tokens are not aggregated.',
      );
    }
    seenKeys.add(key);
    const actors = normalizeReactionActors(record['actors']);
    normalized.push({
      key,
      count: normalizeReactionCount(record['count']),
      ...(actors.length > 0 ? { actors } : {}),
    });
  }

  // Canonical order makes the stored aggregate, the rendered line, and every
  // hash derived from them independent of provider emission order: the same
  // set of reactions never churns FTS rows or re-embeds chunks just because a
  // provider returned them in a different sequence.
  return normalized.sort((left, right) => right.count - left.count || compareStrings(left.key, right.key));
}

/**
 * Canonical JSON for the `reactions_json` item column, or null when there is
 * nothing to store. Empty aggregate and absent column are the same state.
 */
export function serializeSourceReactions(
  reactions: readonly SourceReaction[] | undefined,
): string | null {
  if (reactions === undefined || reactions.length === 0) return null;
  const serialized = JSON.stringify(reactions.map((reaction) => ({
    key: reaction.key,
    count: reaction.count,
    ...(reaction.actors && reaction.actors.length > 0
      ? {
        actors: reaction.actors.map((actor) => ({
          ...(actor.providerActorId ? { providerActorId: actor.providerActorId } : {}),
          ...(actor.label ? { label: actor.label } : {}),
        })),
      }
      : {}),
  })));
  if (serialized.length > MAX_SOURCE_REACTIONS_SERIALIZED_CHARS) {
    throw new SourceReactionValidationError(
      'serialized_too_large',
      `A serialized reaction aggregate is limited to ${MAX_SOURCE_REACTIONS_SERIALIZED_CHARS} characters.`,
    );
  }
  return serialized;
}

/**
 * Reads a stored aggregate back. Storage was validated on write, so anything
 * unreadable here is a store written by a different build: an evidence read
 * must not fail the whole answer over it, so the item simply carries no
 * reactions.
 */
export function parseStoredSourceReactions(json: string | null | undefined): readonly SourceReaction[] {
  if (!json) return [];
  try {
    return normalizeSourceReactions(JSON.parse(json)) ?? [];
  } catch {
    return [];
  }
}

/**
 * The ONE deterministic line reactions are rendered as. It is what search_text
 * indexes, what seasons the embedding input, and what the Analyst reads in the
 * evidence — so a citation can honestly say a message was confirmed by a
 * reaction. Returns undefined when there is nothing to render.
 */
export function renderSourceReactionLine(
  reactions: readonly SourceReaction[] | undefined,
): string | undefined {
  if (!reactions || reactions.length === 0) return undefined;
  const rendered = reactions.map((reaction) => {
    const labels = (reaction.actors ?? [])
      .map((actor) => actor.label)
      .filter((label): label is string => Boolean(label));
    const attribution = labels.length > 0 ? ` (${labels.join(', ')})` : '';
    return `${reaction.key} ×${reaction.count}${attribution}`;
  });
  return `Reactions: ${rendered.join('; ')}`;
}

function normalizeReactionKey(value: unknown): string {
  if (typeof value !== 'string') {
    throw new SourceReactionValidationError('invalid_key', 'A reaction token must be a non-empty string.');
  }
  const key = value.trim();
  if (!key) {
    throw new SourceReactionValidationError('invalid_key', 'A reaction token must be a non-empty string.');
  }
  if (key.length > MAX_SOURCE_REACTION_KEY_CHARS) {
    throw new SourceReactionValidationError(
      'key_too_long',
      `A reaction token is limited to ${MAX_SOURCE_REACTION_KEY_CHARS} characters.`,
    );
  }
  // The rendered form is a single line by contract; a token carrying a line
  // break would silently split it and corrupt every derived representation.
  if (hasControlCharacter(key)) {
    throw new SourceReactionValidationError(
      'invalid_key',
      'A reaction token must not contain line breaks or control characters.',
    );
  }
  return key;
}

function normalizeReactionCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new SourceReactionValidationError(
      'invalid_count',
      'A reaction count must be a positive integer; a removed reaction drops its entry instead.',
    );
  }
  if (value > MAX_SOURCE_REACTION_COUNT) {
    throw new SourceReactionValidationError(
      'count_too_large',
      `A reaction count is limited to ${MAX_SOURCE_REACTION_COUNT}.`,
    );
  }
  return value;
}

function normalizeReactionActors(value: unknown): readonly SourceReactionActor[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new SourceReactionValidationError(
      'invalid_actors',
      'Reaction actors must be an array of {providerActorId?, label?} entries when provided.',
    );
  }
  if (value.length > MAX_SOURCE_REACTION_ACTORS) {
    throw new SourceReactionValidationError(
      'too_many_actors',
      `A reaction token is limited to ${MAX_SOURCE_REACTION_ACTORS} listed actors.`,
    );
  }
  const actors: SourceReactionActor[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new SourceReactionValidationError(
        'invalid_actor',
        'Each reaction actor must be an object with a provider actor id and/or a label.',
      );
    }
    const record = entry as Record<string, unknown>;
    const providerActorId = normalizeActorField(record['providerActorId']);
    const label = normalizeActorField(record['label']);
    if (!providerActorId && !label) {
      throw new SourceReactionValidationError(
        'invalid_actor',
        'A reaction actor must carry a provider actor id or a label.',
      );
    }
    actors.push({
      ...(providerActorId ? { providerActorId } : {}),
      ...(label ? { label } : {}),
    });
  }
  return actors.sort((left, right) =>
    compareStrings(left.providerActorId ?? '', right.providerActorId ?? '')
    || compareStrings(left.label ?? '', right.label ?? ''));
}

function normalizeActorField(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new SourceReactionValidationError(
      'invalid_actor',
      'Reaction actor ids and labels must be strings when provided.',
    );
  }
  const field = value.trim();
  if (!field) return undefined;
  if (field.length > MAX_SOURCE_REACTION_ACTOR_FIELD_CHARS) {
    throw new SourceReactionValidationError(
      'actor_field_too_long',
      `A reaction actor id or label is limited to ${MAX_SOURCE_REACTION_ACTOR_FIELD_CHARS} characters.`,
    );
  }
  if (hasControlCharacter(field)) {
    throw new SourceReactionValidationError(
      'invalid_actor',
      'A reaction actor id or label must not contain line breaks or control characters.',
    );
  }
  return field;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function compareStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
