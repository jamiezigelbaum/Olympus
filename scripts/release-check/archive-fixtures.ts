/**
 * Synthetic archives for the release check's archive-import leg (archive-leg.ts), built in code, never from real data.
 *
 * Each archive carries a token that appears nowhere else on the machine: a body word the search later looks for. It is in the body and
 * never in a subject, because a subject is a name, and names may be kept apart from contents (a name can be Personal while its
 * content waits to be judged). The token is letters and digits only, so the search index keeps it as one word.
 *
 * The files go in a folder directly under the home directory (`rc-archives`), which no macOS privacy rule guards: Desktop, Documents,
 * Downloads and the removable and network volumes are the guarded places (local-files/mac-permissions.ts), so the throwaway machine
 * never has to answer a permission prompt it cannot see. The picker lists the home directory first, so the folder is one press from it.
 *
 * Adding a format. One entry in `ARCHIVE_FORMATS`: a builder for a small archive that has the same shape of life as the mbox one (a few
 * readable items on known days, something that cannot be read in full, something left out on purpose), and the expectation row that
 * goes with it (the format's label as the dashboard shows it, its citation label, the counts, the dates, the gaps). The leg then
 * imports that archive by the agent path, checks the dashboard against the row, searches for its token, and removes it. Nothing else
 * in the leg names a format. The model-off and changed-file stages use `STRESS_FORMAT`, which also needs a plain archive, a large
 * one, and the bytes that change a file (`ArchiveStressSpec`); a later format only has to supply them to be used there too.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The folder under the home directory the archives are written to, and the picker's first press. */
export const FIXTURE_FOLDER = 'rc-archives';

/** What the dashboard must show for an archive once it has been imported. */
export interface ArchiveExpectation {
  /** The format as the dashboard's row names it. */
  label: string;
  /** How a search result names the archive's items. */
  citationLabel: string;
  /** Messages (items) stored: what was readable. */
  messages: number;
  /** The first and last day (UTC) of the stored items. */
  earliest: string;
  latest: string;
  /** What could not be read in full, by the product's kind code, with how many. */
  gaps: ReadonlyArray<{ kind: string; count: number }>;
  /** What was left out on purpose. */
  leftOut: ReadonlyArray<{ kind: string; count: number }>;
}

export interface BuiltArchive {
  bytes: Uint8Array;
  expect: ArchiveExpectation;
}

export interface ArchiveFixtureSpec {
  /** The id the report uses ("mbox"). */
  format: string;
  /** The format as the dashboard's row names it, and how a search result names its items. */
  label: string;
  citationLabel: string;
  /** The file's extension, with its dot. */
  extension: string;
  /** The family and provider its items carry in the stores. */
  family: string;
  provider: string;
  /** A small Takeout-style archive: readable items, one thing not read in full, one thing left out. */
  small(token: string): BuiltArchive;
}

/** What the model-off and changed-file stages need besides `small`. */
export interface ArchiveStressSpec extends ArchiveFixtureSpec {
  /** A small archive with nothing unreadable or left out. */
  plain(token: string): BuiltArchive;
  /** `count` distinct readable items, enough to need several passes. */
  bulk(token: string, count: number): Uint8Array;
  /** Bytes appended to the file to change it after the import started. */
  late(token: string): string;
}

// ---------------------------------------------------------------------------
// mbox

const MBOX_LABEL = 'Mail (mbox)';
const MBOX_CITATION = 'Imported mail';

interface MailInput {
  id: string;
  /** The day, UTC, at midday: the product's date range is the UTC day of each message. */
  day: string;
  subject: string;
  from: string;
  to: string;
  body: string;
  labels?: string;
  /** A file attached to the message, named only (its bytes are never stored). */
  attachment?: { name: string; mime: string; text: string };
}

const OWNER = '"Release Check" <owner@example.test>';

function rfcDate(day: string): string {
  return new Date(`${day}T12:00:00Z`).toUTCString();
}

function separator(day: string): string {
  const date = new Date(`${day}T12:00:00Z`);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `From rc-fixture@example.test ${days[date.getUTCDay()]} ${months[date.getUTCMonth()]} ${String(date.getUTCDate()).padStart(2, ' ')} 12:00:00 ${date.getUTCFullYear()}`;
}

function mailMessage(input: MailInput): string {
  const head = [
    separator(input.day),
    `Message-ID: <${input.id}@example.test>`,
    ...(input.labels ? [`X-Gmail-Labels: ${input.labels}`] : []),
    `From: ${input.from}`,
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    `Date: ${rfcDate(input.day)}`,
    'MIME-Version: 1.0',
  ];
  if (!input.attachment) {
    return [...head, 'Content-Type: text/plain; charset="UTF-8"', '', input.body, '', ''].join('\n');
  }
  const attachment = input.attachment;
  return [
    ...head,
    'Content-Type: multipart/mixed; boundary="rc-boundary"',
    '',
    '--rc-boundary',
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    input.body,
    '',
    '--rc-boundary',
    `Content-Type: ${attachment.mime}; name="${attachment.name}"`,
    `Content-Disposition: attachment; filename="${attachment.name}"`,
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(attachment.text).toString('base64'),
    '--rc-boundary--',
    '',
    '',
  ].join('\n');
}

const bytesOf = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'utf8'));

/**
 * Four readable messages (one with a file attached, which is named and not read), and one the sender's Spam label leaves out. The
 * left-out message is the earliest by date, so a date range that counts it is wrong.
 */
function mboxSmall(token: string): BuiltArchive {
  const text = [
    mailMessage({ id: `rc-${token}-1`, day: '2024-03-04', subject: 'Lake trip packing list', from: '"Mina Okafor" <mina@example.test>', to: OWNER, labels: 'Inbox,Important',
      body: `Packing for the lake trip: tent, stove, two jackets. The reference word for this trip is ${token}.` }),
    mailMessage({ id: `rc-${token}-2`, day: '2024-03-05', subject: 'Itinerary for the weekend', from: '"Mina Okafor" <mina@example.test>', to: OWNER, labels: 'Inbox',
      body: 'The route is the north shore road, then the ferry at noon. The printed itinerary is attached.',
      attachment: { name: 'itinerary.pdf', mime: 'application/pdf', text: '%PDF-1.4 synthetic itinerary' } }),
    mailMessage({ id: `rc-${token}-3`, day: '2024-03-06', subject: 'Lentil soup', from: '"Tomas Reyes" <tomas@example.test>', to: OWNER, labels: 'Inbox',
      body: `Lentil soup: onion, carrot, lentils, stock, forty minutes. Same reference word as before: ${token}.` }),
    mailMessage({ id: `rc-${token}-4`, day: '2024-03-09', subject: 'Photos from Saturday', from: '"Mina Okafor" <mina@example.test>', to: OWNER, labels: 'Inbox',
      body: 'The photos are in the shared album. The light on the water was good.' }),
    mailMessage({ id: `rc-${token}-5`, day: '2023-12-30', subject: 'A synthetic offer', from: '"Offers" <offers@example.test>', to: OWNER, labels: 'Spam,Unread',
      body: 'This synthetic offer is left out because of its label.' }),
  ].join('');
  return {
    bytes: bytesOf(text),
    expect: {
      label: MBOX_LABEL,
      citationLabel: MBOX_CITATION,
      messages: 4,
      earliest: '2024-03-04',
      latest: '2024-03-09',
      gaps: [{ kind: 'attachments_not_read', count: 1 }],
      leftOut: [{ kind: 'spam_or_trash', count: 1 }],
    },
  };
}

/** Three readable messages and nothing else. */
function mboxPlain(token: string): BuiltArchive {
  const text = [
    mailMessage({ id: `rc-${token}-1`, day: '2024-04-02', subject: 'Garden notes', from: '"Ines Duarte" <ines@example.test>', to: OWNER,
      body: `Plant the beans in the second bed and water them twice a week. The reference word for the garden is ${token}.` }),
    mailMessage({ id: `rc-${token}-2`, day: '2024-04-03', subject: 'Bike repair', from: '"Ines Duarte" <ines@example.test>', to: OWNER,
      body: 'The front tyre needs a new tube and the chain wants oil. The shop opens at nine.' }),
    mailMessage({ id: `rc-${token}-3`, day: '2024-04-05', subject: 'Library books', from: '"Ines Duarte" <ines@example.test>', to: OWNER,
      body: 'Two books are due on Friday; one can be renewed once more online.' }),
  ].join('');
  return {
    bytes: bytesOf(text),
    expect: { label: MBOX_LABEL, citationLabel: MBOX_CITATION, messages: 3, earliest: '2024-04-02', latest: '2024-04-05', gaps: [], leftOut: [] },
  };
}

/** `count` distinct messages across the first half of 2024, each a few hundred bytes. */
function mboxBulk(token: string, count: number): Uint8Array {
  const chunks: string[] = [];
  const start = Date.UTC(2024, 0, 1);
  for (let i = 0; i < count; i += 1) {
    const day = new Date(start + (i % 180) * 86_400_000).toISOString().slice(0, 10);
    chunks.push(mailMessage({
      id: `rc-${token}-bulk-${i}`,
      day,
      subject: `Bulk note ${i}`,
      from: '"Bulk Sender" <bulk@example.test>',
      to: OWNER,
      body: `Synthetic bulk message number ${i} for the release check, with enough text that the file has weight. The reference word is ${token}. Entry ${i} mentions the harbour, the ferry timetable, the market on the ${(i % 28) + 1}th and a list of things to buy: bread, oil, salt, candles, string.`,
    }));
  }
  return bytesOf(chunks.join(''));
}

/** One more message at the end of the file: its size and modification time change, which a running import must notice. */
function mboxLate(token: string): string {
  return mailMessage({ id: `rc-${token}-late`, day: '2024-06-30', subject: 'Added after the import started', from: '"Late Sender" <late@example.test>', to: OWNER, body: 'This message was added to the file while it was being imported.' });
}

export const MBOX_FIXTURES: ArchiveStressSpec = {
  format: 'mbox',
  label: MBOX_LABEL,
  citationLabel: MBOX_CITATION,
  extension: '.mbox',
  family: 'email',
  provider: 'mbox',
  small: mboxSmall,
  plain: mboxPlain,
  bulk: mboxBulk,
  late: mboxLate,
};

/** Every format the leg imports by the agent path. A later format adds its entry here. */
export const ARCHIVE_FORMATS: Readonly<Record<string, ArchiveFixtureSpec>> = { mbox: MBOX_FIXTURES };

/** The format the picker, model-off and changed-file stages use. */
export const STRESS_FORMAT = 'mbox';

// ---------------------------------------------------------------------------
// The fixtures of one run

export type FixtureRole = 'agent' | 'picker' | 'held' | 'bulk';

export interface LegFixture {
  role: FixtureRole;
  format: string;
  fileName: string;
  /** The word in the body that a search looks for. */
  token: string;
  /** The folder and file under the home directory, with the separators the machine uses. */
  relPath: string;
  expect: ArchiveExpectation;
  bytes: Uint8Array;
}

/** A token no real text holds: letters and digits only, derived from the run's seed and the fixture, so the same call gives the same word. */
export function fixtureToken(seed: string, role: string, format: string): string {
  return `rcarch${createHash('sha256').update(`${seed}:${role}:${format}`).digest('hex').slice(0, 14)}`;
}

export function formatSpec(format: string): ArchiveFixtureSpec {
  const spec = ARCHIVE_FORMATS[format];
  if (!spec) throw new Error(`no archive fixtures for the format "${format}" (known: ${Object.keys(ARCHIVE_FORMATS).join(', ')})`);
  return spec;
}

export function stressSpec(): ArchiveStressSpec {
  const spec = ARCHIVE_FORMATS[STRESS_FORMAT] as Partial<ArchiveStressSpec> | undefined;
  if (!spec || !spec.plain || !spec.bulk || !spec.late) throw new Error(`the "${STRESS_FORMAT}" fixtures do not have the plain, bulk and late builders the model-off and changed-file stages need`);
  return spec as ArchiveStressSpec;
}

/**
 * The fixture for one role. `agent` and `picker` are the small archive; `held` is the plain one (imported while the private model is
 * off); `bulk` is a large archive of `count` messages (default 8,000) whose expectation is only its size.
 */
export function legFixture(role: FixtureRole, seed: string, format: string = STRESS_FORMAT, count = 8_000): LegFixture {
  const token = fixtureToken(seed, role === 'bulk' ? `${role}-${count}` : role, format);
  const spec = role === 'agent' || role === 'picker' ? formatSpec(format) : stressSpec();
  const fileName = role === 'bulk' ? `rc-${role}-${count}${spec.extension}` : `rc-${role}-${format}${spec.extension}`;
  let built: BuiltArchive;
  if (role === 'held') built = stressSpec().plain(token);
  else if (role === 'bulk') built = { bytes: stressSpec().bulk(token, count), expect: { label: spec.label, citationLabel: spec.citationLabel, messages: count, earliest: '', latest: '', gaps: [], leftOut: [] } };
  else built = spec.small(token);
  return { role, format, fileName, token, relPath: `${FIXTURE_FOLDER}/${fileName}`, expect: built.expect, bytes: built.bytes };
}

// ---------------------------------------------------------------------------
// On the machine

/** Makes the folder empty and owner-only under `home`; returns it. Archives from an earlier attempt are not left behind. */
export function resetFixtureFolder(home: string): string {
  const folder = join(home, FIXTURE_FOLDER);
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  return folder;
}

/** Writes the fixture's file under `home` (the folder is made when it is missing); returns its full path. */
export function writeFixture(home: string, fixture: LegFixture): string {
  const folder = join(home, FIXTURE_FOLDER);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const path = join(folder, fixture.fileName);
  writeFileSync(path, fixture.bytes, { mode: 0o600 });
  return path;
}

/** Changes the file the way a person's export tool would: more bytes at the end. */
export function changeFixture(path: string, fixture: LegFixture): void {
  appendFileSync(path, stressSpec().late(fixture.token));
}
