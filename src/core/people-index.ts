/**
 * One person across sources (#1076): the shared, source-agnostic people index.
 *
 * Connectors publish who sent each item (`senderId`, `senderLabel`,
 * `senderIsOwner`) and every connector store keeps it per item. This module
 * reads those per-sender observations from any store, links the identities
 * that belong to one person, and keeps the owner's corrections. It names no
 * source: an identity is `(provider, senderId)` (or the label when a source
 * gives no id), and the only strong keys it reads are address formats any
 * source can carry: a phone number in international form and an email address.
 *
 * Linking rules (owner direction, 2026-11-10: automatic and optimistic,
 * corrected later):
 *  1. Strong keys link on their own: the same phone number (E.164), the same
 *     email address (lowercased), entries the owner's contacts tie together.
 *  2. A name links only when one more independent signal agrees: the two
 *     identities spoke in the same conversation, or each shares a group
 *     conversation with the same third person. A name alone never links.
 *  3. Every automatic link records why.
 *  4. Owner corrections (Not the same, Split, Merge, Rename) are stored apart
 *     from the derived index and hold across every rebuild; a rejected pair
 *     is never linked again until the owner merges it.
 *  5. Every identity a source marks as the owner is the one person "You".
 *
 * Linking never sets or reads a privacy tier: each item is still judged on
 * its own content. The index is Private local data. It lives in the data root
 * on this computer (so Delete all removes it), and the only thing that leaves
 * it is the display name a citation already carries as its author label.
 * A name seen only on Private rows is never used as that display name.
 */
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { sharedDataPath, type LayoutEnv } from './olympus-layout.ts';
import { assertSqliteSchemaCanOpen, runSqliteMigrations, type SqliteMigration } from './sqlite-migrations.ts';
import { closeSqliteStore } from './sqlite-store.ts';

/** What one store knows about one sender: the input the index is built from. */
export interface PeopleSenderObservation {
  /** The source's provider id, opaque here. */
  provider: string;
  senderId?: string;
  senderLabel?: string;
  /** Any item from this sender said it was the owner. */
  isOwner: boolean;
  itemCount: number;
  /** The label was seen only on rows that are Private by their own tier. */
  privateOnly?: boolean;
  /** Conversations this sender spoke in (provider-scoped ids). */
  conversationIds?: readonly string[];
  /** The corpus whose store holds these items, so a source's Delete can forget them here. */
  corpusId?: string;
}

/**
 * A card from the owner's contacts: keys that belong to one person. A key is
 * `phone:+<digits>`, `email:<address>`, or `sender:<provider>:<senderId>`.
 */
export interface PeopleContactCard {
  cardId: string;
  name?: string;
  keys: readonly string[];
}

export type PeopleLinkReason =
  | 'owner'
  | 'phone'
  | 'email'
  | 'contacts'
  | 'name_and_shared_conversation'
  | 'name_and_shared_group'
  | 'merged_by_owner';

export const PEOPLE_LINK_REASON_TEXT: Readonly<Record<PeopleLinkReason, string>> = Object.freeze({
  owner: 'You on every source',
  phone: 'Linked by phone number',
  email: 'Linked by email address',
  contacts: 'Linked by your contacts',
  name_and_shared_conversation: 'Linked by name and a shared conversation',
  name_and_shared_group: 'Linked by name and shared group chat',
  merged_by_owner: 'Merged by you',
});

export const OWNER_PERSON_ID = 'you';
export const OWNER_DISPLAY_NAME = 'You';

export interface PeopleIdentity {
  identityKey: string;
  provider: string;
  senderId?: string;
  senderLabel?: string;
  keys: string[];
  names: string[];
  isOwner: boolean;
  itemCount: number;
  personId: string;
  /** The corpora this identity was seen in. */
  corpusIds: string[];
  /** Why this identity joined its person; absent for the person's first identity. */
  linkReason?: PeopleLinkReason;
}

export interface PeoplePerson {
  personId: string;
  displayName: string;
  isOwner: boolean;
  /**
   * The display name may go where a citation's author label goes: the owner
   * named the person, or the name was seen on a row not Private by its tier.
   */
  nameShareable: boolean;
  itemCount: number;
  identities: PeopleIdentity[];
  /** Distinct reasons the identities were linked, in the words the screen shows. */
  linkedBy: string[];
}

export interface PeopleSuggestion {
  /** One identity on each side, so a "Not the same" answer can be recorded. */
  identityA: string;
  identityB: string;
  personA: string;
  personB: string;
  name: string;
}

export type PeopleCorrection =
  | { kind: 'not_same'; identityA: string; identityB: string }
  | { kind: 'merge'; identityA: string; identityB: string }
  | { kind: 'split'; identity: string }
  | { kind: 'rename'; identity: string; name: string };

/** At most this many senders in one conversation make it a group signal. */
const MAX_GROUP_SIGNAL_MEMBERS = 50;
const MAX_NAMES_PER_IDENTITY = 8;
const PEOPLE_SCHEMA_VERSION = 1;
export const PEOPLE_INDEX_STORE_ID = 'people-index';

function peopleIndexMigrations(): SqliteMigration[] {
  return [{
    version: 1,
    name: 'people_index_v1',
    up(db: Database) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS people_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS people_identities (
          identity_key TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          sender_id TEXT,
          sender_label TEXT,
          keys_json TEXT NOT NULL,
          names_json TEXT NOT NULL,
          is_owner INTEGER NOT NULL CHECK(is_owner IN (0, 1)),
          item_count INTEGER NOT NULL,
          person_id TEXT NOT NULL,
          corpus_ids_json TEXT NOT NULL DEFAULT '[]',
          link_reason TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_people_identities_person ON people_identities(person_id);
        CREATE TABLE IF NOT EXISTS people_persons (
          person_id TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
          is_owner INTEGER NOT NULL CHECK(is_owner IN (0, 1)),
          name_shareable INTEGER NOT NULL CHECK(name_shareable IN (0, 1)),
          item_count INTEGER NOT NULL,
          linked_by_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS people_corrections (
          correction_id INTEGER PRIMARY KEY AUTOINCREMENT,
          kind TEXT NOT NULL CHECK(kind IN ('not_same', 'merge', 'split', 'rename')),
          identity_a TEXT NOT NULL,
          identity_b TEXT,
          name TEXT,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS people_contact_cards (
          card_id TEXT PRIMARY KEY,
          name TEXT,
          keys_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
    },
  }];
}

export function peopleIndexPath(env: LayoutEnv = process.env): string {
  return sharedDataPath('people-index', env);
}

/** The identity key of a sender: its id when the source gives one, else its label. */
export function peopleIdentityKey(provider: string, senderId?: string, senderLabel?: string): string | undefined {
  const id = senderId?.trim();
  if (id) return `sender:${provider}:${id}`;
  const label = senderLabel?.trim();
  return label ? `label:${provider}:${label}` : undefined;
}

/** `+<digits>` for a phone number in international form, else undefined. */
export function normalizePhone(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith('+') && !trimmed.startsWith('00')) return undefined;
  if (/[^\d\s().+-]/.test(trimmed)) return undefined;
  const digits = trimmed.replace(/\D/g, '').replace(/^00/, '');
  return digits.length >= 8 && digits.length <= 15 && !digits.startsWith('0') ? `+${digits}` : undefined;
}

const ADDRESS = /([A-Za-z0-9._%+-]+)@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;

/**
 * The strong keys an id or a label carries, read as address formats only:
 * `email:<address>` for an email address, `phone:+<digits>` for a number in
 * international form, and for an address whose local part is an
 * international number (a phone-addressed id) that number.
 */
export function strongKeysFromText(value: string | undefined): string[] {
  if (!value) return [];
  const keys = new Set<string>();
  for (const match of value.matchAll(ADDRESS)) {
    const local = match[1]!;
    // An address is always an email key, even with an all-digit mailbox
    // (123456789@qq.com). A digit-only local part also reads as a phone
    // number (a chat id such as 14155550123@s.whatsapp.net); a phone key
    // shared by two such addresses on different domains is a known limit.
    keys.add(`email:${match[0]!.toLowerCase()}`);
    if (/^\d{8,15}$/.test(local) && !local.startsWith('0')) keys.add(`phone:+${local}`);
  }
  if (keys.size === 0) {
    const phone = normalizePhone(value);
    if (phone) keys.add(`phone:${phone}`);
  }
  return [...keys];
}

/** A label as a person's name, or undefined when it is an address, number or id. */
export function displayNameFromLabel(label: string | undefined): string | undefined {
  if (!label) return undefined;
  const withoutAddress = label.replace(/<[^>]*>/g, ' ').replace(ADDRESS, ' ').replace(/["']/g, ' ');
  const name = withoutAddress.replace(/\s+/g, ' ').trim();
  if (!name || normalizePhone(name)) return undefined;
  if (!/\p{L}/u.test(name)) return undefined;
  return name.slice(0, 160);
}

/** A name compared across sources: accents, case, punctuation and spacing aside. */
export function normalizePersonName(name: string): string {
  return name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

interface WorkingIdentity extends PeopleIdentity {
  nameKeys: Set<string>;
  publicNames: Map<string, number>;
  conversations: Set<string>;
}

// Fields are set in constructors, never as class-field initializers: an
// initializer is a load-time side effect that keeps this module, and
// bun:sqlite with it, in the Node-loaded plugin bundle
// (test/plugin-bundle-no-bun-sqlite.test.ts).
class UnionFind {
  private readonly parent: Map<string, string>;
  readonly members: Map<string, Set<string>>;
  constructor() {
    this.parent = new Map();
    this.members = new Map();
  }
  add(key: string): void {
    if (this.parent.has(key)) return;
    this.parent.set(key, key);
    this.members.set(key, new Set([key]));
  }
  find(key: string): string {
    let root = key;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    let node = key;
    while (node !== root) {
      const next = this.parent.get(node)!;
      this.parent.set(node, root);
      node = next;
    }
    return root;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    const [big, small] = this.members.get(ra)!.size >= this.members.get(rb)!.size ? [ra, rb] : [rb, ra];
    this.parent.set(small, big);
    for (const member of this.members.get(small)!) this.members.get(big)!.add(member);
    this.members.delete(small);
  }
}

/**
 * Link observations into people. Pure: the same observations, contacts and
 * corrections always give the same people.
 */
export function linkPeople(input: {
  observations: readonly PeopleSenderObservation[];
  contacts?: readonly PeopleContactCard[];
  corrections?: readonly PeopleCorrection[];
}): PeoplePerson[] {
  const identities = new Map<string, WorkingIdentity>();
  for (const observation of input.observations) {
    const key = peopleIdentityKey(observation.provider, observation.senderId, observation.senderLabel);
    if (!key) continue;
    let identity = identities.get(key);
    if (!identity) {
      identity = {
        identityKey: key,
        provider: observation.provider,
        ...(observation.senderId?.trim() ? { senderId: observation.senderId.trim() } : {}),
        keys: [],
        names: [],
        isOwner: false,
        itemCount: 0,
        personId: '',
        corpusIds: [],
        nameKeys: new Set(),
        publicNames: new Map(),
        conversations: new Set(),
      };
      identities.set(key, identity);
    }
    const label = observation.senderLabel?.trim();
    if (label && (!identity.senderLabel || !observation.privateOnly)) identity.senderLabel = label;
    identity.isOwner ||= observation.isOwner;
    identity.itemCount += observation.itemCount;
    if (observation.corpusId && !identity.corpusIds.includes(observation.corpusId)) identity.corpusIds.push(observation.corpusId);
    for (const strong of [...strongKeysFromText(observation.senderId), ...strongKeysFromText(label)]) {
      if (!identity.keys.includes(strong)) identity.keys.push(strong);
    }
    const name = displayNameFromLabel(label);
    if (name) {
      const normalized = normalizePersonName(name);
      if (normalized) identity.nameKeys.add(normalized);
      if (!identity.names.includes(name) && identity.names.length < MAX_NAMES_PER_IDENTITY) identity.names.push(name);
      if (!observation.privateOnly) identity.publicNames.set(name, (identity.publicNames.get(name) ?? 0) + observation.itemCount);
    }
    for (const conversation of observation.conversationIds ?? []) {
      if (conversation) identity.conversations.add(`${observation.provider}\u0000${conversation}`);
    }
  }

  const pairKey = (a: string, b: string) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);
  const { merges, rejected, splits, renames } = replayCorrections(input.corrections ?? [], pairKey);

  const uf = new UnionFind();
  for (const key of identities.keys()) uf.add(key);
  const reason = new Map<string, PeopleLinkReason>();
  const blocked = (ra: string, rb: string): boolean => {
    const left = uf.members.get(ra)!;
    const right = uf.members.get(rb)!;
    for (const a of left) {
      for (const b of right) {
        if (rejected.has(pairKey(a, b))) return true;
        // A split identity stays alone unless the owner merges it.
        if (splits.has(a) || splits.has(b)) return true;
      }
    }
    return false;
  };
  /** Joins a and b unless a correction forbids it; true when they end up one person. */
  const link = (a: string, b: string, why: PeopleLinkReason): boolean => {
    if (!identities.has(a) || !identities.has(b)) return false;
    const ra = uf.find(a);
    const rb = uf.find(b);
    if (ra === rb) return true;
    if (blocked(ra, rb)) return false;
    uf.union(a, b);
    // Record the reason on the identity that joined, once.
    if (!reason.has(b)) reason.set(b, why);
    else if (!reason.has(a)) reason.set(a, why);
    return true;
  };
  // Everyone who shares a key or a card links with each other: each member
  // joins the first earlier member it may, so a split or rejected first
  // member never keeps the rest apart.
  const linkAll = (members: readonly string[], why: PeopleLinkReason): void => {
    const sorted = [...members].sort();
    for (let i = 1; i < sorted.length; i += 1) {
      for (let j = 0; j < i; j += 1) {
        if (link(sorted[j]!, sorted[i]!, why)) break;
      }
    }
  };

  // 0. The owner's merges come first: the owner decides.
  for (const [a, b] of merges) {
    const ra = identities.has(a) ? uf.find(a) : undefined;
    const rb = identities.has(b) ? uf.find(b) : undefined;
    if (ra && rb && ra !== rb) {
      uf.union(a, b);
      reason.set(b, 'merged_by_owner');
    }
  }
  // 1. One "me".
  const owners = [...identities.values()].filter((identity) => identity.isOwner).map((identity) => identity.identityKey).sort();
  for (const owner of owners.slice(1)) link(owners[0]!, owner, 'owner');
  // 2. Strong keys.
  const byKey = new Map<string, string[]>();
  for (const identity of identities.values()) {
    for (const key of identity.keys) byKey.set(key, [...(byKey.get(key) ?? []), identity.identityKey]);
  }
  for (const [key, members] of [...byKey].sort(([a], [b]) => a.localeCompare(b))) {
    linkAll(members, key.startsWith('phone:') ? 'phone' : 'email');
  }
  // 3. The owner's contacts.
  for (const card of [...(input.contacts ?? [])].sort((a, b) => a.cardId.localeCompare(b.cardId))) {
    const members = new Set<string>();
    for (const raw of card.keys) {
      const key = raw.trim();
      if (key.startsWith('sender:')) {
        if (identities.has(key)) members.add(key);
        continue;
      }
      for (const member of byKey.get(normalizeCardKey(key) ?? '') ?? []) members.add(member);
    }
    linkAll([...members], 'contacts');
  }
  // 4. A name with one more independent signal.
  const byName = new Map<string, string[]>();
  for (const identity of identities.values()) {
    for (const name of identity.nameKeys) byName.set(name, [...(byName.get(name) ?? []), identity.identityKey]);
  }
  const conversationMembers = new Map<string, string[]>();
  for (const identity of identities.values()) {
    for (const conversation of identity.conversations) {
      conversationMembers.set(conversation, [...(conversationMembers.get(conversation) ?? []), identity.identityKey]);
    }
  }
  const groupPeers = (identity: WorkingIdentity): Set<string> => {
    const peers = new Set<string>();
    for (const conversation of identity.conversations) {
      const members = conversationMembers.get(conversation) ?? [];
      if (members.length > MAX_GROUP_SIGNAL_MEMBERS) continue;
      for (const member of members) {
        if (member === identity.identityKey) continue;
        const peer = identities.get(member)!;
        if (peer.isOwner) continue;
        peers.add(uf.find(member));
      }
    }
    return peers;
  };
  for (const [, members] of [...byName].sort(([a], [b]) => a.localeCompare(b))) {
    if (members.length < 2) continue;
    const sorted = [...members].sort();
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        const a = identities.get(sorted[i]!)!;
        const b = identities.get(sorted[j]!)!;
        if (uf.find(a.identityKey) === uf.find(b.identityKey)) continue;
        if ([...a.conversations].some((conversation) => b.conversations.has(conversation))) {
          link(a.identityKey, b.identityKey, 'name_and_shared_conversation');
          continue;
        }
        const rootA = uf.find(a.identityKey);
        const rootB = uf.find(b.identityKey);
        const peersB = groupPeers(b);
        const shared = [...groupPeers(a)].some((peer) => peer !== rootA && peer !== rootB && peersB.has(peer));
        if (shared) link(a.identityKey, b.identityKey, 'name_and_shared_group');
      }
    }
  }

  const people: PeoplePerson[] = [];
  for (const [root, memberSet] of uf.members) {
    void root;
    const members = [...memberSet].sort().map((key) => identities.get(key)!);
    const isOwner = members.some((member) => member.isOwner);
    const personId = isOwner ? OWNER_PERSON_ID : `p_${createHash('sha256').update(members[0]!.identityKey).digest('hex').slice(0, 16)}`;
    // The owner's newest rename of any identity of this person wins.
    const renamed = [...memberSet].map((identity) => renames.get(identity))
      .reduce<{ name: string; at: number } | undefined>((best, next) => (next && (!best || next.at > best.at) ? next : best), undefined)?.name;
    const displayName = isOwner ? OWNER_DISPLAY_NAME : renamed ?? bestName(members);
    const nameShareable = isOwner || renamed !== undefined || members.some((member) => member.publicNames.size > 0);
    const linkedBy = new Set<string>();
    const out: PeopleIdentity[] = members.map((member) => {
      const why = memberSet.size > 1 ? reason.get(member.identityKey) : undefined;
      if (why) linkedBy.add(PEOPLE_LINK_REASON_TEXT[why]);
      return {
        identityKey: member.identityKey,
        provider: member.provider,
        ...(member.senderId ? { senderId: member.senderId } : {}),
        ...(member.senderLabel ? { senderLabel: member.senderLabel } : {}),
        keys: [...member.keys].sort(),
        names: member.names,
        isOwner: member.isOwner,
        itemCount: member.itemCount,
        personId,
        corpusIds: [...member.corpusIds].sort(),
        ...(why ? { linkReason: why } : {}),
      };
    });
    people.push({
      personId,
      displayName,
      isOwner,
      nameShareable,
      itemCount: members.reduce((total, member) => total + member.itemCount, 0),
      identities: out,
      linkedBy: [...linkedBy].sort(),
    });
  }
  return people.sort((a, b) => Number(b.isOwner) - Number(a.isOwner) || b.itemCount - a.itemCount || a.personId.localeCompare(b.personId));
}

interface ReplayedCorrections {
  /** The owner's merges still in force, oldest first. */
  merges: Array<[string, string]>;
  /** Pairs the owner said are not the same, still in force. */
  rejected: Set<string>;
  /** Identities the owner split off and has not merged since. */
  splits: Set<string>;
  /** The newest rename of each identity, with its place in the replay. */
  renames: Map<string, { name: string; at: number }>;
}

/**
 * The owner's corrections, replayed strictly in the order they were made, as
 * one model: the later answer always wins.
 * - Merge joins a pair, and ends any earlier Not the same between identities
 *   the merges now join, and any earlier split of either identity.
 * - Not the same keeps a pair apart: while earlier merges still join the
 *   pair, the newest merge on the path between them is undone.
 * - Split keeps an identity alone: every earlier merge of it is undone.
 * - Rename: the newest rename of any identity of a person names the person.
 */
function replayCorrections(corrections: readonly PeopleCorrection[], pairKey: (a: string, b: string) => string): ReplayedCorrections {
  // Active merges keyed by pair, each with the step it was made at.
  const merges = new Map<string, { a: string; b: string; at: number }>();
  const rejected = new Set<string>();
  const splits = new Set<string>();
  const renames = new Map<string, { name: string; at: number }>();
  /** The active merges joining a to b (a shortest path), or undefined when they do not. */
  const mergePath = (from: string, to: string): Array<{ key: string; at: number }> | undefined => {
    const edges = new Map<string, Array<{ next: string; key: string; at: number }>>();
    for (const [key, merge] of merges) {
      edges.set(merge.a, [...(edges.get(merge.a) ?? []), { next: merge.b, key, at: merge.at }]);
      edges.set(merge.b, [...(edges.get(merge.b) ?? []), { next: merge.a, key, at: merge.at }]);
    }
    const via = new Map<string, { from: string; key: string; at: number } | null>([[from, null]]);
    const queue = [from];
    while (queue.length > 0) {
      const node = queue.shift()!;
      if (node === to) break;
      for (const edge of edges.get(node) ?? []) {
        if (via.has(edge.next)) continue;
        via.set(edge.next, { from: node, key: edge.key, at: edge.at });
        queue.push(edge.next);
      }
    }
    if (!via.has(to)) return undefined;
    const path: Array<{ key: string; at: number }> = [];
    for (let step = via.get(to); step; step = via.get(step.from)) path.push({ key: step.key, at: step.at });
    return path;
  };
  corrections.forEach((correction, at) => {
    if (correction.kind === 'merge') {
      const { identityA: a, identityB: b } = correction;
      if (a === b) return;
      merges.set(pairKey(a, b), { a, b, at });
      splits.delete(a);
      splits.delete(b);
      for (const pair of [...rejected]) {
        const [x, y] = pair.split('\u0000') as [string, string];
        if (mergePath(x, y)) rejected.delete(pair);
      }
    } else if (correction.kind === 'not_same') {
      const { identityA: a, identityB: b } = correction;
      if (a === b) return;
      rejected.add(pairKey(a, b));
      for (let path = mergePath(a, b); path && path.length > 0; path = mergePath(a, b)) {
        const newest = path.reduce((best, edge) => (edge.at > best.at ? edge : best));
        merges.delete(newest.key);
      }
    } else if (correction.kind === 'split') {
      for (const [key, merge] of [...merges]) {
        if (merge.a === correction.identity || merge.b === correction.identity) merges.delete(key);
      }
      splits.add(correction.identity);
    } else {
      renames.set(correction.identity, { name: correction.name, at });
    }
  });
  return {
    merges: [...merges.values()].sort((x, y) => x.at - y.at).map((merge): [string, string] => [merge.a, merge.b]),
    rejected,
    splits,
    renames,
  };
}

function bestName(members: readonly WorkingIdentity[]): string {
  const counts = new Map<string, number>();
  for (const member of members) {
    for (const [name, count] of member.publicNames) counts.set(name, (counts.get(name) ?? 0) + count);
  }
  // A real name before a handle ("Mark Alexander" before "@xandoru"), then the most used.
  const handle = (name: string) => Number(name.startsWith('@'));
  const named = [...counts].sort(([a, ca], [b, cb]) => handle(a) - handle(b) || cb - ca || b.length - a.length || a.localeCompare(b))[0]?.[0];
  if (named) return named;
  // With no name, a phone number reads better than an all-digit chat id
  // (351912000444@s.whatsapp.net) that carries the same number.
  const numericAddress = (key: string) => Number(/^email:\d+@/.test(key));
  const key = members.flatMap((member) => member.keys).sort((a, b) => numericAddress(a) - numericAddress(b) || a.localeCompare(b))[0];
  if (key) return key.slice(key.indexOf(':') + 1);
  return members[0]!.senderLabel ?? members[0]!.senderId ?? 'Unknown sender';
}

function normalizeCardKey(key: string): string | undefined {
  if (key.startsWith('phone:')) {
    const phone = normalizePhone(key.slice('phone:'.length));
    return phone ? `phone:${phone}` : undefined;
  }
  if (key.startsWith('email:')) return `email:${key.slice('email:'.length).trim().toLowerCase()}`;
  return undefined;
}

/** A person as a citation may show them: a display name only. */
export interface PeopleCitationName {
  personId: string;
  displayName: string;
  isOwner: boolean;
}

/** A sender the search should match for one person. */
export interface PeopleSenderIdentity {
  provider: string;
  senderId?: string;
  senderLabel?: string;
}

/**
 * The people index on disk: the derived people (rebuilt from observations)
 * and the owner's own corrections and contact cards, which no rebuild
 * touches.
 */
export class LocalPeopleIndex {
  private readonly db: Database;
  private people: PeoplePerson[];
  private readonly bySender: Map<string, PeoplePerson>;
  private readonly now: () => Date;

  constructor(options: { dbPath: string; now?: () => Date }) {
    this.people = [];
    this.bySender = new Map();
    if (options.dbPath !== ':memory:') mkdirSync(dirname(options.dbPath), { recursive: true, mode: 0o700 });
    this.db = new Database(options.dbPath, { create: true, strict: true });
    this.now = options.now ?? (() => new Date());
    try {
      if (options.dbPath !== ':memory:') chmodSync(options.dbPath, 0o600);
      this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA secure_delete = ON;');
      this.db.transaction(() => {
        assertSqliteSchemaCanOpen(this.db, PEOPLE_INDEX_STORE_ID, PEOPLE_SCHEMA_VERSION);
        runSqliteMigrations(this.db, PEOPLE_INDEX_STORE_ID, peopleIndexMigrations());
      }).immediate();
    } catch (error) {
      closeSqliteStore(this.db);
      throw error;
    }
    this.loadPeople();
  }

  close(): void {
    closeSqliteStore(this.db);
  }

  /** Rebuild the derived people from fresh observations; corrections and cards stay. */
  rebuild(observations: readonly PeopleSenderObservation[]): PeoplePerson[] {
    const people = linkPeople({ observations, contacts: this.contactCards(), corrections: this.corrections() });
    const insertIdentity = this.db.query(`
      INSERT INTO people_identities (identity_key, provider, sender_id, sender_label, keys_json, names_json, is_owner, item_count, person_id, corpus_ids_json, link_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertPerson = this.db.query(`
      INSERT INTO people_persons (person_id, display_name, is_owner, name_shareable, item_count, linked_by_json) VALUES (?, ?, ?, ?, ?, ?)
    `);
    this.db.transaction(() => {
      this.db.exec('DELETE FROM people_identities; DELETE FROM people_persons;');
      for (const person of people) {
        insertPerson.run(person.personId, person.displayName, Number(person.isOwner), Number(person.nameShareable), person.itemCount, JSON.stringify(person.linkedBy));
        for (const identity of person.identities) {
          insertIdentity.run(
            identity.identityKey, identity.provider, identity.senderId ?? null, identity.senderLabel ?? null,
            JSON.stringify(identity.keys), JSON.stringify(identity.names), Number(identity.isOwner),
            identity.itemCount, person.personId, JSON.stringify(identity.corpusIds), identity.linkReason ?? null,
          );
        }
      }
      this.db.query(`INSERT OR REPLACE INTO people_meta (key, value) VALUES ('rebuilt_at', ?)`).run(this.now().toISOString());
    })();
    this.setPeople(people);
    return people;
  }

  list(): PeoplePerson[] {
    return this.people;
  }

  person(personId: string): PeoplePerson | undefined {
    return this.people.find((person) => person.personId === personId);
  }

  /** The person behind one sender, if the index knows them. */
  personForSender(provider: string, senderId?: string, senderLabel?: string): PeoplePerson | undefined {
    const key = peopleIdentityKey(provider, senderId, senderLabel);
    return key ? this.bySender.get(key) : undefined;
  }

  /**
   * The name a citation shows for a non-owner sender linked to a person, when
   * that name is safe to show: the owner's own rename, or a name seen on a
   * row that is not Private by its own tier. Undefined leaves the item's own
   * label in place.
   */
  citationName(provider: string, senderId?: string, senderLabel?: string): PeopleCitationName | undefined {
    const person = this.personForSender(provider, senderId, senderLabel);
    if (!person || person.isOwner) return undefined;
    if (!person.nameShareable) return undefined;
    return { personId: person.personId, displayName: person.displayName, isOwner: false };
  }

  /**
   * The people a name, email address, number or handle names: an exact
   * normalized name, a whole-word part of one, or an exact strong key.
   */
  findPeople(query: string): PeoplePerson[] {
    const keys = strongKeysFromText(query);
    const wanted = normalizePersonName(query);
    if (!wanted && keys.length === 0) return [];
    return this.people.filter((person) => {
      if (keys.some((key) => person.identities.some((identity) => identity.keys.includes(key)))) return true;
      if (!wanted) return false;
      const names = [person.displayName, ...person.identities.flatMap((identity) => identity.names)]
        .map(normalizePersonName);
      return names.some((name) => name === wanted || ` ${name} `.includes(` ${wanted} `));
    });
  }

  /** Every sender of the people a name matches, for a search to expand to. */
  senderIdentitiesFor(query: string): PeopleSenderIdentity[] {
    return this.findPeople(query).flatMap((person) => person.identities.map((identity) => ({
      provider: identity.provider,
      ...(identity.senderId ? { senderId: identity.senderId } : {}),
      ...(!identity.senderId && identity.senderLabel ? { senderLabel: identity.senderLabel } : {}),
    })));
  }

  /** Same-name people the rules did not link, for the owner to answer. */
  suggestions(): PeopleSuggestion[] {
    const rejected = new Set(this.corrections().flatMap((c) => (c.kind === 'not_same' ? [`${c.identityA}\u0000${c.identityB}`, `${c.identityB}\u0000${c.identityA}`] : [])));
    const byName = new Map<string, PeoplePerson[]>();
    for (const person of this.people) {
      if (person.isOwner) continue;
      for (const name of new Set(person.identities.flatMap((identity) => identity.names.map(normalizePersonName)))) {
        if (name) byName.set(name, [...(byName.get(name) ?? []), person]);
      }
    }
    const out: PeopleSuggestion[] = [];
    const seen = new Set<string>();
    for (const [name, people] of byName) {
      for (let i = 0; i < people.length; i += 1) {
        for (let j = i + 1; j < people.length; j += 1) {
          const a = people[i]!;
          const b = people[j]!;
          const pair = [a.personId, b.personId].sort().join('\u0000');
          if (seen.has(pair)) continue;
          const crossRejected = a.identities.some((x) => b.identities.some((y) => rejected.has(`${x.identityKey}\u0000${y.identityKey}`)));
          if (crossRejected) continue;
          seen.add(pair);
          out.push({ identityA: a.identities[0]!.identityKey, identityB: b.identities[0]!.identityKey, personA: a.personId, personB: b.personId, name });
        }
      }
    }
    return out;
  }

  /**
   * Record an owner correction. It applies at the next rebuild (pass the
   * same observations to `rebuild` to see it at once) and every one after.
   */
  correct(correction: PeopleCorrection): void {
    const at = this.now().toISOString();
    const insert = this.db.query(`
      INSERT INTO people_corrections (kind, identity_a, identity_b, name, created_at) VALUES (?, ?, ?, ?, ?)
    `);
    this.db.transaction(() => {
      if (correction.kind === 'not_same' || correction.kind === 'merge') {
        // The newer answer about the same pair replaces the older one.
        this.db.query(`
          DELETE FROM people_corrections WHERE kind IN ('not_same', 'merge')
            AND ((identity_a = ? AND identity_b = ?) OR (identity_a = ? AND identity_b = ?))
        `).run(correction.identityA, correction.identityB, correction.identityB, correction.identityA);
        if (correction.kind === 'merge') {
          this.db.query(`DELETE FROM people_corrections WHERE kind = 'split' AND identity_a IN (?, ?)`).run(correction.identityA, correction.identityB);
        }
        insert.run(correction.kind, correction.identityA, correction.identityB, null, at);
      } else if (correction.kind === 'split') {
        // A split undoes the owner's earlier merges of this identity.
        this.db.query(`DELETE FROM people_corrections WHERE kind = 'merge' AND (identity_a = ? OR identity_b = ?)`).run(correction.identity, correction.identity);
        insert.run('split', correction.identity, null, null, at);
      } else {
        const name = correction.name.trim().slice(0, 160);
        if (!name) throw new Error('A person needs a name.');
        insert.run('rename', correction.identity, null, name, at);
      }
    })();
  }

  corrections(): PeopleCorrection[] {
    const rows = this.db.query(`
      SELECT kind, identity_a, identity_b, name FROM people_corrections ORDER BY correction_id
    `).all() as Array<{ kind: PeopleCorrection['kind']; identity_a: string; identity_b: string | null; name: string | null }>;
    return rows.map((row): PeopleCorrection => {
      if (row.kind === 'split') return { kind: 'split', identity: row.identity_a };
      if (row.kind === 'rename') return { kind: 'rename', identity: row.identity_a, name: row.name ?? '' };
      return { kind: row.kind, identityA: row.identity_a, identityB: row.identity_b ?? '' };
    });
  }

  /** Store a card from the owner's contacts (replacing one with the same id). */
  putContactCard(card: PeopleContactCard): void {
    this.db.query(`
      INSERT OR REPLACE INTO people_contact_cards (card_id, name, keys_json, updated_at) VALUES (?, ?, ?, ?)
    `).run(card.cardId, card.name ?? null, JSON.stringify([...card.keys]), this.now().toISOString());
  }

  contactCards(): PeopleContactCard[] {
    return (this.db.query(`SELECT card_id, name, keys_json FROM people_contact_cards ORDER BY card_id`).all() as Array<{
      card_id: string; name: string | null; keys_json: string;
    }>).map((row) => ({ cardId: row.card_id, ...(row.name ? { name: row.name } : {}), keys: JSON.parse(row.keys_json) as string[] }));
  }

  private loadPeople(): void {
    const persons = this.db.query(`SELECT person_id, display_name, is_owner, name_shareable, item_count, linked_by_json FROM people_persons`).all() as Array<{
      person_id: string; display_name: string; is_owner: number; name_shareable: number; item_count: number; linked_by_json: string;
    }>;
    const identities = this.db.query(`
      SELECT identity_key, provider, sender_id, sender_label, keys_json, names_json, is_owner, item_count, person_id, corpus_ids_json, link_reason
      FROM people_identities ORDER BY identity_key
    `).all() as Array<{
      identity_key: string; provider: string; sender_id: string | null; sender_label: string | null; keys_json: string;
      names_json: string; is_owner: number; item_count: number; person_id: string; corpus_ids_json: string; link_reason: PeopleLinkReason | null;
    }>;
    const byPerson = new Map<string, PeopleIdentity[]>();
    for (const row of identities) {
      byPerson.set(row.person_id, [...(byPerson.get(row.person_id) ?? []), {
        identityKey: row.identity_key,
        provider: row.provider,
        ...(row.sender_id ? { senderId: row.sender_id } : {}),
        ...(row.sender_label ? { senderLabel: row.sender_label } : {}),
        keys: JSON.parse(row.keys_json) as string[],
        names: JSON.parse(row.names_json) as string[],
        isOwner: row.is_owner === 1,
        itemCount: row.item_count,
        personId: row.person_id,
        corpusIds: JSON.parse(row.corpus_ids_json) as string[],
        ...(row.link_reason ? { linkReason: row.link_reason } : {}),
      }]);
    }
    const people = persons.map((row): PeoplePerson => ({
      personId: row.person_id,
      displayName: row.display_name,
      isOwner: row.is_owner === 1,
      nameShareable: row.name_shareable === 1,
      itemCount: row.item_count,
      identities: byPerson.get(row.person_id) ?? [],
      linkedBy: JSON.parse(row.linked_by_json) as string[],
    }));
    this.setPeople(people);
  }

  private setPeople(people: PeoplePerson[]): void {
    this.people = people;
    this.bySender.clear();
    for (const person of people) {
      for (const identity of person.identities) {
        if (identity.senderId) this.bySender.set(`sender:${identity.provider}:${identity.senderId}`, person);
        else if (identity.senderLabel) this.bySender.set(`label:${identity.provider}:${identity.senderLabel}`, person);
      }
    }
  }
}

/**
 * The families whose items have an author: the ones the people index reads
 * and the author-coverage count covers.
 */
export const PEOPLE_AUTHORED_FAMILIES: ReadonlySet<string> = new Set(['chat', 'email']);

/** A store the people index can read: any connector store qualifies. */
export interface PeopleObservationSource {
  family: string;
  peopleObservations(): PeopleSenderObservation[];
  /** The store's latest sync run, so a refresh can tell when a sync has finished. */
  lastSyncRun?(): { syncRunId: string; status: string; completedAt?: string } | undefined;
  setPeopleNames?(resolver: ((provider: string, senderId: string | undefined, senderLabel: string | undefined) => PeopleCitationName | undefined) | undefined): void;
}

/**
 * Rebuild the index from every authored store and point each store's
 * citations at it. A store that cannot be read is left out of this rebuild
 * (its senders drop out until the next one); the others still link.
 */
export function refreshPeopleIndex(index: LocalPeopleIndex, stores: readonly PeopleObservationSource[]): PeoplePerson[] {
  const observations: PeopleSenderObservation[] = [];
  for (const store of stores) {
    if (!PEOPLE_AUTHORED_FAMILIES.has(store.family)) continue;
    try {
      observations.push(...store.peopleObservations());
    } catch {
      // Unreadable now; the next refresh tries again.
    }
  }
  const people = index.rebuild(observations);
  const resolver = (provider: string, senderId: string | undefined, senderLabel: string | undefined) =>
    index.citationName(provider, senderId, senderLabel);
  for (const store of stores) store.setPeopleNames?.(resolver);
  return people;
}

/**
 * Keeps the index current: a rebuild right after any authored store finishes
 * a sync (`refreshIfSynced`, cheap to call often), and on demand.
 */
export class PeopleIndexRefresher {
  private lastFingerprint: string | undefined;

  constructor(
    private readonly index: LocalPeopleIndex,
    private readonly stores: () => readonly PeopleObservationSource[],
  ) {}

  /** Rebuild now. */
  refresh(): PeoplePerson[] {
    const stores = this.stores();
    this.lastFingerprint = syncFingerprint(stores);
    return refreshPeopleIndex(this.index, stores);
  }

  /** Rebuild when a sync has completed since the last rebuild; true when it did. */
  refreshIfSynced(): boolean {
    const fingerprint = syncFingerprint(this.stores());
    if (fingerprint === this.lastFingerprint) return false;
    this.refresh();
    return true;
  }
}

function syncFingerprint(stores: readonly PeopleObservationSource[]): string {
  return stores.filter((store) => PEOPLE_AUTHORED_FAMILIES.has(store.family)).map((store) => {
    try {
      const run = store.lastSyncRun?.();
      return run && run.status === 'completed' ? `${run.syncRunId}@${run.completedAt ?? ''}` : '';
    } catch {
      return '';
    }
  }).join('|');
}

/**
 * A source's Delete (core/source-forget-registry.ts): forget every identity
 * seen in the account's corpora, the owner's corrections and contact-card
 * entries that name them, and the derived people (rebuilt from the stores
 * that remain at the next refresh). Returns how many rows it removed, or
 * would remove on a dry run. A file that is not there has nothing to forget.
 */
export function forgetPeopleIndexRows(
  dbPath: string,
  scope: { corpusIds: readonly string[] },
  options: { dryRun?: boolean } = {},
): number {
  if (!existsSync(dbPath) || scope.corpusIds.length === 0) return 0;
  const dryRun = options.dryRun === true;
  const db = new Database(dbPath, dryRun ? { readonly: true } : { readwrite: true });
  try {
    db.exec(`PRAGMA busy_timeout = 10000; ${dryRun ? '' : 'PRAGMA secure_delete = ON;'}`);
    const corpora = JSON.stringify([...scope.corpusIds]);
    const keys = (db.query(`
      SELECT identity_key FROM people_identities
      WHERE EXISTS (SELECT 1 FROM json_each(corpus_ids_json) c WHERE c.value IN (SELECT value FROM json_each(?)))
    `).all(corpora) as Array<{ identity_key: string }>).map((row) => row.identity_key);
    if (keys.length === 0) return 0;
    const keyList = JSON.stringify(keys);
    const corrections = (db.query(`
      SELECT COUNT(*) AS n FROM people_corrections
      WHERE identity_a IN (SELECT value FROM json_each(?1)) OR identity_b IN (SELECT value FROM json_each(?1))
    `).get(keyList) as { n: number }).n;
    const cards = (db.query(`
      SELECT card_id FROM people_contact_cards
      WHERE EXISTS (SELECT 1 FROM json_each(keys_json) k WHERE k.value IN (SELECT value FROM json_each(?)))
    `).all(keyList) as Array<{ card_id: string }>).length;
    if (dryRun) return keys.length + corrections + cards;
    db.transaction(() => {
      db.query(`DELETE FROM people_identities WHERE identity_key IN (SELECT value FROM json_each(?))`).run(keyList);
      db.query(`
        DELETE FROM people_corrections
        WHERE identity_a IN (SELECT value FROM json_each(?1)) OR identity_b IN (SELECT value FROM json_each(?1))
      `).run(keyList);
      // A card keeps its other entries; only the deleted source's are taken out.
      const rows = db.query(`SELECT card_id, keys_json FROM people_contact_cards`).all() as Array<{ card_id: string; keys_json: string }>;
      const gone = new Set(keys);
      for (const row of rows) {
        const kept = (JSON.parse(row.keys_json) as string[]).filter((key) => !gone.has(key));
        if (kept.length === (JSON.parse(row.keys_json) as string[]).length) continue;
        db.query(`UPDATE people_contact_cards SET keys_json = ? WHERE card_id = ?`).run(JSON.stringify(kept), row.card_id);
      }
      db.exec('DELETE FROM people_persons;');
      db.query(`UPDATE people_identities SET person_id = identity_key`).run();
    })();
    return keys.length + corrections + cards;
  } finally {
    closeSqliteStore(db);
  }
}
