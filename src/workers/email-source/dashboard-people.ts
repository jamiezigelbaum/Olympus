/**
 * The People screen's backend (#1076): the people index as the screen shows
 * it, and the owner's corrections (Same person, Not the same, Merge, Split,
 * Rename). Served only inside a local control session (workers/http.ts): the
 * people list is Private and stays on this computer.
 */
import {
  type LocalPeopleIndex,
  type PeopleCorrection,
  type PeoplePerson,
} from '../../core/people-index.ts';
import type {
  DashboardPeopleIdentityChip,
  DashboardPeoplePerson,
  DashboardPeopleSuggestion,
  DashboardPeopleView,
} from '../dashboard/pages/people.ts';

/**
 * A same-name pair is asked about only when both people have at least this
 * many messages: the screen asks about people the owner talks with, not every
 * one-off sender who shares a first name.
 */
export const PEOPLE_SUGGESTION_MIN_MESSAGES = 3;
/** The most people the screen lists at once; search narrows within them. */
export const PEOPLE_SCREEN_MAX_PEOPLE = 2000;
const MAX_SUGGESTIONS = 20;

export interface DashboardPeopleBackend {
  view(): DashboardPeopleView;
  handle(record: Record<string, unknown>): { status: number; body: Record<string, unknown> };
}

export function createDashboardPeople(input: {
  index: LocalPeopleIndex;
  /** Rebuild from every store now, so a correction shows at once. */
  refresh: () => void;
}): DashboardPeopleBackend {
  return {
    view: () => dashboardPeopleView(input.index),
    handle(record) {
      const correction = correctionFrom(record, input.index);
      if (!correction) {
        return { status: 400, body: { ok: false, error: { code: 'invalid_request', message: 'That change could not be read. Reload and try again.' } } };
      }
      input.index.correct(correction);
      input.refresh();
      return { status: 200, body: { ok: true } };
    },
  };
}

export function dashboardPeopleView(index: LocalPeopleIndex): DashboardPeopleView {
  const people = index.list();
  const byId = new Map(people.map((person) => [person.personId, person]));
  const suggestions: DashboardPeopleSuggestion[] = [];
  for (const suggestion of index.suggestions()) {
    const a = byId.get(suggestion.personA);
    const b = byId.get(suggestion.personB);
    if (!a || !b) continue;
    if (a.itemCount < PEOPLE_SUGGESTION_MIN_MESSAGES || b.itemCount < PEOPLE_SUGGESTION_MIN_MESSAGES) continue;
    // Asked as the mockup words it: the smaller side "on <source>" first.
    const flip = b.identities.length < a.identities.length
      || (b.identities.length === a.identities.length && b.itemCount < a.itemCount);
    suggestions.push({
      identityA: flip ? suggestion.identityB : suggestion.identityA,
      identityB: flip ? suggestion.identityA : suggestion.identityB,
      a: suggestionSide(flip ? b : a),
      b: suggestionSide(flip ? a : b),
    });
    if (suggestions.length >= MAX_SUGGESTIONS) break;
  }
  const sources = new Set(people.flatMap((person) => person.identities.map((identity) => identity.provider)));
  return {
    total: people.length,
    sourceCount: sources.size,
    suggestions,
    people: people.slice(0, PEOPLE_SCREEN_MAX_PEOPLE).map(screenPerson),
  };
}

function suggestionSide(person: PeoplePerson): DashboardPeopleSuggestion['a'] {
  // The identity that carries the name and the most messages speaks for the person.
  const best = [...person.identities].sort((x, y) =>
    Number(y.names.length > 0) - Number(x.names.length > 0) || y.itemCount - x.itemCount)[0]!;
  const chip = identityChip(best);
  return { name: person.displayName, source: chip.source, detail: chip.detail };
}

function screenPerson(person: PeoplePerson): DashboardPeoplePerson {
  const named = person.isOwner || person.identities.some((identity) => identity.names.length > 0) || person.nameShareable;
  return {
    personId: person.personId,
    displayName: person.displayName,
    isOwner: person.isOwner,
    named,
    messages: person.itemCount,
    linkedBy: person.linkedBy,
    identities: person.identities.map(identityChip),
  };
}

const SOURCE_NAMES: Readonly<Record<string, string>> = {
  gmail: 'Gmail',
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
  apple_messages: 'Messages',
  x: 'X',
  x_bookmarks: 'X',
};

function identityChip(identity: PeoplePerson['identities'][number]): DashboardPeopleIdentityChip {
  const email = identity.keys.find((key) => key.startsWith('email:'))?.slice('email:'.length);
  const phone = identity.keys.find((key) => key.startsWith('phone:'))?.slice('phone:'.length);
  const handle = identity.senderLabel?.startsWith('@') ? identity.senderLabel : undefined;
  const detail = handle ?? email ?? phone ?? identity.names[0] ?? identity.senderLabel ?? identity.senderId ?? '';
  return {
    identityKey: identity.identityKey,
    provider: identity.provider,
    source: SOURCE_NAMES[identity.provider] ?? identity.provider,
    detail,
  };
}

function correctionFrom(record: Record<string, unknown>, index: LocalPeopleIndex): PeopleCorrection | undefined {
  const text = (key: string): string | undefined => {
    const value = record[key];
    return typeof value === 'string' && value.trim() && value.length <= 2_000 ? value.trim() : undefined;
  };
  const known = new Set(index.list().flatMap((person) => person.identities.map((identity) => identity.identityKey)));
  const identity = (key: string): string | undefined => {
    const value = text(key);
    return value && known.has(value) ? value : undefined;
  };
  switch (record.op) {
    case 'same':
    case 'merge': {
      const a = identity('identity_a');
      const b = identity('identity_b');
      return a && b && a !== b ? { kind: 'merge', identityA: a, identityB: b } : undefined;
    }
    case 'not_same': {
      const a = identity('identity_a');
      const b = identity('identity_b');
      return a && b && a !== b ? { kind: 'not_same', identityA: a, identityB: b } : undefined;
    }
    case 'split': {
      const a = identity('identity');
      return a ? { kind: 'split', identity: a } : undefined;
    }
    case 'rename': {
      const a = identity('identity');
      const name = text('name');
      return a && name && name.length <= 160 ? { kind: 'rename', identity: a, name } : undefined;
    }
    default:
      return undefined;
  }
}
