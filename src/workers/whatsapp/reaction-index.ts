// WhatsApp reaction aggregation: spool reaction lines -> the shared reaction
// aggregate the connector attaches to the REACTED item (src/core/source-index/
// reactions.ts). This is the connector's half of the 2026-07-24 owner ruling
// that a reaction confirms a message, so it is evidence carried BY that
// message.
//
// Why aggregation lives here and not in the daemon: the drain deliberately
// rescans the whole spool whenever it meets a foreign cursor, so any
// accumulate-a-delta scheme double-counts on replay. Aggregation is therefore
// last-write-wins keyed by (target message, reacting actor) over the WHOLE
// spool: one actor holds at most one live reaction per message, a removal
// deletes that entry, and the result is identical no matter how many times the
// spool is rescanned or in what order removals and additions were spooled.
// The daemon stays a dumb pipe with no reaction state of its own.
//
// Bounds are a SELECTION, not a refusal. The store's bounds are run-aborting
// typed refusals, and a pathological chat (a 200-reactor group thread) must not
// be able to wedge the capture lane: the aggregate is truncated to what the
// store accepts, never thrown. What gives way, in order: the actor lists
// (lowest-count token first), and only then — for tokens at the 64-character
// ceiling — whole tokens. The token and its true count carry the owner
// ruling's claim, so they are the last thing to go.

import {
  MAX_SOURCE_REACTION_ACTORS,
  MAX_SOURCE_REACTION_ACTOR_FIELD_CHARS,
  MAX_SOURCE_REACTION_COUNT,
  MAX_SOURCE_REACTION_KEY_CHARS,
  MAX_SOURCE_REACTION_TOKENS,
  normalizeSourceReactions,
  serializeSourceReactions,
  type SourceReaction,
  type SourceReactionActor,
} from '../../core/source-index/reactions.ts';

/**
 * The spool fields reaction aggregation reads. Structurally satisfied by the
 * connector's parsed spool message, declared here so this module never has to
 * know the rest of the spool line.
 */
export interface WhatsAppReactionSpoolLine {
  id: string;
  chatJid: string;
  senderJid: string;
  senderName: string;
  mediaType?: string;
  reactionTargetId?: string;
  reactionTargetChatJid?: string;
  reactionKey?: string;
  reactionRemoved?: boolean;
}

/** One actor's CURRENT reaction to one target, as of the last spool line. */
export interface WhatsAppReactionEntry {
  /** The reaction key's RemoteJID: the provider's statement of the chat. */
  targetChatJid?: string;
  /** Chat the reaction line itself arrived in (the envelope's chat). */
  chatJid: string;
  /** Aggregation identity of the reactor; see reactionActorKey. */
  actorKey: string;
  /** Reactor JID exactly as the sender convention records it elsewhere. */
  actorId?: string;
  /** Reactor push name, falling back to the JID. */
  actorLabel?: string;
  /** Reaction token; absent on a removal. */
  key?: string;
  /** True when the actor took their reaction back. */
  removed: boolean;
}

export interface WhatsAppReactionIndex {
  /** Provider ids of every message reacted to anywhere in the spool. */
  readonly targetIds: readonly string[];
  /** Live entries for one target, in spool order. */
  entriesFor(targetId: string): readonly WhatsAppReactionEntry[];
  /** Reaction lines seen, including legacy ones that carry no target. */
  readonly reactionLines: number;
}

export interface WhatsAppReactionIndexBuilder {
  /** Feeds one spool line; returns true when it was a reaction line. */
  add(line: WhatsAppReactionSpoolLine): boolean;
  build(): WhatsAppReactionIndex;
}

/**
 * True for any spool line the daemon classified as a reaction. Such a line is
 * never an item of its own — it is a fact about another message — so the
 * connector consumes it and emits nothing for it, which is what stops the
 * empty metadata_only junk items R0 inherited.
 */
export function isWhatsAppReactionLine(line: WhatsAppReactionSpoolLine): boolean {
  return line.mediaType === 'reaction';
}

export function createWhatsAppReactionIndexBuilder(): WhatsAppReactionIndexBuilder {
  // targetId -> actorKey -> entry. Assigning into the inner map IS the
  // last-write-wins rule: a later spool line for the same (target, actor)
  // replaces the earlier one, whether it adds, changes, or removes.
  const byTarget = new Map<string, Map<string, WhatsAppReactionEntry>>();
  let reactionLines = 0;

  return {
    add(line: WhatsAppReactionSpoolLine): boolean {
      if (!isWhatsAppReactionLine(line)) return false;
      reactionLines += 1;
      const targetId = trimmed(line.reactionTargetId);
      // Lines spooled before the daemon captured reaction targets carry no
      // target at all. They are still consumed (no junk item), but there is
      // nothing to attach them to.
      if (targetId === undefined) return true;
      const actors = byTarget.get(targetId) ?? new Map<string, WhatsAppReactionEntry>();
      byTarget.set(targetId, actors);
      const targetChatJid = trimmed(line.reactionTargetChatJid);
      const actorKey = reactionActorKey(line);
      const actorId = trimmed(line.senderJid);
      const label = trimmed(line.senderName) ?? actorId;
      const key = trimmed(line.reactionKey);
      actors.set(actorKey, {
        ...(targetChatJid === undefined ? {} : { targetChatJid }),
        chatJid: line.chatJid,
        actorKey,
        ...(actorId === undefined ? {} : { actorId }),
        ...(label === undefined ? {} : { actorLabel: label }),
        ...(key === undefined ? {} : { key }),
        // A line with no token at all says nothing an aggregate can carry,
        // so it is treated as this actor having no live reaction.
        removed: line.reactionRemoved === true || key === undefined,
      });
      return true;
    },

    build(): WhatsAppReactionIndex {
      return {
        targetIds: [...byTarget.keys()],
        entriesFor(targetId: string): readonly WhatsAppReactionEntry[] {
          return [...(byTarget.get(targetId)?.values() ?? [])];
        },
        reactionLines,
      };
    },
  };
}

/**
 * The bounded aggregate to attach to one resolved target, or undefined when no
 * reaction in the index belongs to that target's chat.
 *
 * Undefined is the SKIP signal, not "no reactions": WhatsApp message ids are
 * only unique per chat, so a target resolved by id alone can be the wrong
 * message from another conversation. An empty array is different — it means
 * every reaction on this message was taken back, which is how the store is told
 * to clear what it holds.
 */
export function boundedReactionsForTarget(
  entries: readonly WhatsAppReactionEntry[],
  targetChatJid: string,
): readonly SourceReaction[] | undefined {
  const matched = entries.filter((entry) => reactionBelongsToChat(entry, targetChatJid));
  if (matched.length === 0) return undefined;

  // Count is distinct ACTORS per token, so a truncated actor list still
  // reports the true total. An actor that cannot be represented inside the
  // store's actor bounds is counted and simply not listed — partial actor
  // lists are legal by design.
  const byToken = new Map<string, Map<string, SourceReactionActor | undefined>>();
  for (const entry of matched) {
    if (entry.removed) continue;
    const key = reactionToken(entry.key);
    if (key === undefined) continue;
    const actors = byToken.get(key) ?? new Map<string, SourceReactionActor | undefined>();
    byToken.set(key, actors);
    actors.set(entry.actorKey, reactionActor(entry));
  }

  const ranked = [...byToken.entries()]
    .map(([key, actors]) => ({
      key,
      count: Math.min(actors.size, MAX_SOURCE_REACTION_COUNT),
      actors: [...actors.values()]
        .filter((actor): actor is SourceReactionActor => actor !== undefined)
        .sort(compareActors)
        .slice(0, MAX_SOURCE_REACTION_ACTORS),
    }))
    .sort((left, right) => right.count - left.count || compareStrings(left.key, right.key))
    .slice(0, MAX_SOURCE_REACTION_TOKENS);

  // Size pre-check against the store's own validator, shedding in the order
  // the owner ruling implies. "This message was confirmed by 👍 ×2" is the
  // claim; the token and its true count are the claim, and the actor list is
  // enrichment on top of it. So every ranked token keeps its count, and the
  // actor lists are what give way — from the lowest-count token upward, since
  // the busiest reaction is the one worth naming names for.
  for (let listed = ranked.length; listed >= 0; listed -= 1) {
    const candidate = ranked.map((entry, index) => ({
      key: entry.key,
      count: entry.count,
      ...(index < listed && entry.actors.length > 0 ? { actors: entry.actors } : {}),
    }));
    if (storeAcceptsReactions(candidate)) return candidate;
  }

  // Even 32 bare token+count pairs did not fit, which takes tokens at the
  // 64-character ceiling. Only here does a token itself get dropped, lowest
  // count first. An empty aggregate would falsely tell the store every
  // reaction was taken back, so it is the last resort and nothing else.
  for (let tokens = ranked.length - 1; tokens > 0; tokens -= 1) {
    const candidate = ranked.slice(0, tokens).map((entry) => ({ key: entry.key, count: entry.count }));
    if (storeAcceptsReactions(candidate)) return candidate;
  }
  return [];
}

/**
 * Whether a reaction happened in the same chat as the message it claims to
 * target. Two independent statements of that chat are available: the reaction
 * key's RemoteJID, and the chat the reaction line itself arrived in. The
 * envelope chat is written by the same daemon code path as the target line's
 * chat_jid, so it always compares cleanly; RemoteJID can arrive in the other
 * JID namespace (LID vs phone) for the same conversation. Either match proves
 * same-chat. A target from a genuinely different conversation fails both —
 * which is exactly the per-chat id collision this check exists to catch.
 */
function reactionBelongsToChat(entry: WhatsAppReactionEntry, targetChatJid: string): boolean {
  const target = normalizeWhatsAppJid(targetChatJid);
  if (target === '') return false;
  return [entry.targetChatJid, entry.chatJid].some(
    (candidate) => candidate !== undefined && normalizeWhatsAppJid(candidate) === target,
  );
}

/**
 * Comparable form of a JID: case-folded, with the device suffix dropped, so
 * "1234:5@s.whatsapp.net" and "1234@s.whatsapp.net" are one conversation and
 * one actor rather than two.
 */
export function normalizeWhatsAppJid(value: string): string {
  const jid = value.trim().toLowerCase();
  const at = jid.lastIndexOf('@');
  if (at <= 0) return jid;
  const user = jid.slice(0, at);
  const device = user.indexOf(':');
  return `${device === -1 ? user : user.slice(0, device)}@${jid.slice(at + 1)}`;
}

/**
 * Aggregation identity of a reactor. The normalized sender JID when there is
 * one; otherwise the reaction message's own id, which keeps a re-delivered
 * duplicate of the same reaction from counting twice while still letting two
 * genuinely different anonymous reactions count separately.
 */
function reactionActorKey(line: WhatsAppReactionSpoolLine): string {
  const senderJid = trimmed(line.senderJid);
  return senderJid === undefined ? `message:${line.id}` : normalizeWhatsAppJid(senderJid);
}

function reactionActor(entry: WhatsAppReactionEntry): SourceReactionActor | undefined {
  // The id is an identity: a truncated one would be a different actor, so an
  // unrepresentable id is dropped rather than trimmed. A label is a display
  // string, so bounding it loses nothing that matters.
  const providerActorId = exactActorField(entry.actorId);
  const label = boundedActorLabel(entry.actorLabel) ?? providerActorId;
  if (providerActorId === undefined && label === undefined) return undefined;
  return {
    ...(providerActorId === undefined ? {} : { providerActorId }),
    ...(label === undefined ? {} : { label }),
  };
}

function reactionToken(key: string | undefined): string | undefined {
  const token = key?.trim();
  if (!token) return undefined;
  if (token.length > MAX_SOURCE_REACTION_KEY_CHARS) return undefined;
  if (hasControlCharacter(token)) return undefined;
  return token;
}

function exactActorField(value: string | undefined): string | undefined {
  const field = value?.trim();
  if (!field) return undefined;
  if (field.length > MAX_SOURCE_REACTION_ACTOR_FIELD_CHARS) return undefined;
  if (hasControlCharacter(field)) return undefined;
  return field;
}

function boundedActorLabel(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  let label = '';
  for (const character of value) {
    if (hasControlCharacter(character)) continue;
    if (label.length + character.length > MAX_SOURCE_REACTION_ACTOR_FIELD_CHARS) break;
    label += character;
  }
  return label.trim() || undefined;
}

function storeAcceptsReactions(candidate: readonly SourceReaction[]): boolean {
  try {
    serializeSourceReactions(normalizeSourceReactions(candidate));
    return true;
  } catch {
    return false;
  }
}

function compareActors(left: SourceReactionActor, right: SourceReactionActor): number {
  return compareStrings(left.providerActorId ?? '', right.providerActorId ?? '')
    || compareStrings(left.label ?? '', right.label ?? '');
}

function compareStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function trimmed(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}
