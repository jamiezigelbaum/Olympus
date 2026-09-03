// The shared reaction representation (src/core/source-index/reactions.ts).
//
// Reactions are evidence: an emoji can confirm a message, so the aggregate has
// to be normalized identically for every source, bounded on write, and
// rendered to exactly one deterministic line. These tests pin all three, plus
// the refusal posture — a refusal names the rule and its limit and NEVER
// echoes the token, label, or actor id it rejected.

import { describe, expect, test } from 'bun:test';
import {
  MAX_SOURCE_REACTIONS_SERIALIZED_CHARS,
  MAX_SOURCE_REACTION_ACTORS,
  MAX_SOURCE_REACTION_ACTOR_FIELD_CHARS,
  MAX_SOURCE_REACTION_KEY_CHARS,
  MAX_SOURCE_REACTION_TOKENS,
  SourceReactionValidationError,
  normalizeSourceReactions,
  parseStoredSourceReactions,
  renderSourceReactionLine,
  serializeSourceReactions,
} from '../src/core/source-index/reactions.ts';

function refusalFor(value: unknown): SourceReactionValidationError {
  try {
    normalizeSourceReactions(value);
  } catch (error) {
    if (error instanceof SourceReactionValidationError) return error;
    throw error;
  }
  throw new Error('expected a reaction refusal');
}

describe('source reaction aggregates', () => {
  test('absent metadata says nothing; an empty array says "no reactions"', () => {
    expect(normalizeSourceReactions(undefined)).toBeUndefined();
    expect(normalizeSourceReactions(null)).toBeUndefined();
    expect(normalizeSourceReactions([])).toEqual([]);
    expect(serializeSourceReactions(undefined)).toBeNull();
    expect(serializeSourceReactions([])).toBeNull();
    expect(renderSourceReactionLine([])).toBeUndefined();
  });

  test('normalizes to a canonical order so provider emission order never churns', () => {
    const emittedOneWay = normalizeSourceReactions([
      { key: '❤️', count: 1 },
      { key: '👍', count: 2, actors: [{ providerActorId: 'b', label: 'Dor' }, { providerActorId: 'a', label: 'Sam' }] },
      { key: '🎉', count: 2 },
    ]);
    const emittedAnother = normalizeSourceReactions([
      { key: '🎉', count: 2 },
      { key: '👍', count: 2, actors: [{ providerActorId: 'a', label: 'Sam' }, { providerActorId: 'b', label: 'Dor' }] },
      { key: '❤️', count: 1 },
    ]);

    expect(emittedOneWay).toEqual(emittedAnother);
    // Strongest signal first, ties broken by token, actors by their stable
    // provider id — nothing about the ordering depends on the provider.
    expect(emittedOneWay?.map((reaction) => reaction.key)).toEqual(['🎉', '👍', '❤️']);
    expect(serializeSourceReactions(emittedOneWay)).toBe(serializeSourceReactions(emittedAnother));
    expect(renderSourceReactionLine(emittedOneWay)).toBe('Reactions: 🎉 ×2; 👍 ×2 (Sam, Dor); ❤️ ×1');
  });

  test('actors are optional and custom tokens stay opaque strings', () => {
    const countsOnly = normalizeSourceReactions([{ key: '👍', count: 7 }]);
    expect(renderSourceReactionLine(countsOnly)).toBe('Reactions: 👍 ×7');

    const custom = normalizeSourceReactions([
      { key: 'custom:5312048573923123456', count: 1, actors: [{ providerActorId: 'actor-1' }] },
    ]);
    // An actor with no label contributes no attribution: the line stays
    // human-readable while the full actor detail survives in the aggregate.
    expect(renderSourceReactionLine(custom)).toBe('Reactions: custom:5312048573923123456 ×1');
    expect(custom?.[0]?.actors).toEqual([{ providerActorId: 'actor-1' }]);
  });

  test('renders one line, whatever the aggregate holds', () => {
    const line = renderSourceReactionLine(normalizeSourceReactions([
      { key: '👍', count: 2, actors: [{ label: 'Sam' }, { label: 'Dor' }] },
    ]));
    expect(line?.includes('\n')).toBe(false);
  });

  test('round-trips through storage, and unreadable storage reads as no reactions', () => {
    const reactions = normalizeSourceReactions([
      { key: '👍', count: 2, actors: [{ providerActorId: 'a', label: 'Sam' }] },
    ]);
    const stored = serializeSourceReactions(reactions);
    expect(parseStoredSourceReactions(stored)).toEqual(reactions ?? []);
    expect(parseStoredSourceReactions(null)).toEqual([]);
    expect(parseStoredSourceReactions('{not json')).toEqual([]);
    expect(parseStoredSourceReactions('[{"key":"","count":1}]')).toEqual([]);
  });

  test('refuses malformed aggregates with typed reasons', () => {
    expect(refusalFor('👍').refusal).toBe('not_an_array');
    expect(refusalFor([['👍', 2]]).refusal).toBe('entry_not_an_object');
    expect(refusalFor([{ key: '   ', count: 1 }]).refusal).toBe('invalid_key');
    expect(refusalFor([{ key: '👍\nsecret', count: 1 }]).refusal).toBe('invalid_key');
    expect(refusalFor([{ key: '👍', count: 0 }]).refusal).toBe('invalid_count');
    expect(refusalFor([{ key: '👍', count: 1.5 }]).refusal).toBe('invalid_count');
    expect(refusalFor([{ key: '👍', count: 2_000_000 }]).refusal).toBe('count_too_large');
    expect(refusalFor([{ key: '👍', count: 1 }, { key: '👍', count: 2 }]).refusal).toBe('duplicate_key');
    expect(refusalFor([{ key: '👍', count: 1, actors: 'Sam' }]).refusal).toBe('invalid_actors');
    expect(refusalFor([{ key: '👍', count: 1, actors: [{}] }]).refusal).toBe('invalid_actor');
  });

  test('refuses unbounded aggregates on every axis', () => {
    expect(refusalFor([{ key: 'k'.repeat(MAX_SOURCE_REACTION_KEY_CHARS + 1), count: 1 }]).refusal)
      .toBe('key_too_long');
    expect(refusalFor(
      Array.from({ length: MAX_SOURCE_REACTION_TOKENS + 1 }, (_unused, index) => ({ key: `k${index}`, count: 1 })),
    ).refusal).toBe('too_many_tokens');
    expect(refusalFor([{
      key: '👍',
      count: 1,
      actors: Array.from({ length: MAX_SOURCE_REACTION_ACTORS + 1 }, (_unused, index) => ({ label: `a${index}` })),
    }]).refusal).toBe('too_many_actors');
    expect(refusalFor([{
      key: '👍',
      count: 1,
      actors: [{ label: 'l'.repeat(MAX_SOURCE_REACTION_ACTOR_FIELD_CHARS + 1) }],
    }]).refusal).toBe('actor_field_too_long');

    // Every axis is individually in bounds; the serialized total is not.
    const wide = Array.from({ length: MAX_SOURCE_REACTION_TOKENS }, (_unused, index) => ({
      key: `token-${index}`,
      count: 1,
      actors: Array.from({ length: MAX_SOURCE_REACTION_ACTORS }, (_ignored, actor) => ({
        label: `actor-${actor}`.padEnd(MAX_SOURCE_REACTION_ACTOR_FIELD_CHARS, 'x'),
      })),
    }));
    let serializedRefusal: SourceReactionValidationError | undefined;
    try {
      serializeSourceReactions(normalizeSourceReactions(wide));
    } catch (error) {
      if (error instanceof SourceReactionValidationError) serializedRefusal = error;
    }
    expect(serializedRefusal?.refusal).toBe('serialized_too_large');
    expect(serializedRefusal?.message).toContain(String(MAX_SOURCE_REACTIONS_SERIALIZED_CHARS));
  });

  test('refusals never echo the content they rejected', () => {
    const secretToken = 'custom:private-project-codename';
    const secretLabel = 'Confidential Counterparty Name';
    const refusals = [
      refusalFor([{ key: `${secretToken}${'x'.repeat(MAX_SOURCE_REACTION_KEY_CHARS)}`, count: 1 }]),
      refusalFor([{ key: secretToken, count: 0 }]),
      refusalFor([{ key: '👍', count: 1, actors: [{ label: secretLabel.padEnd(200, 'y') }] }]),
      refusalFor([{ key: secretToken, count: 1 }, { key: secretToken, count: 2 }]),
    ];
    for (const refusal of refusals) {
      expect(refusal.name).toBe('SourceReactionValidationError');
      expect(refusal.message).not.toContain(secretToken);
      expect(refusal.message).not.toContain(secretLabel);
      expect(refusal.message).not.toContain('private-project-codename');
    }
  });
});
