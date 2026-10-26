import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { deleteOlympusData, exportOlympusData } from '../src/data-lifecycle.ts';
import { openWaitingPrivateQuestionStore, waitingPrivateQuestionsDbPath, type StoredPrivateAnswer } from '../src/core/waiting-private-questions.ts';
import { resolveRemoteConnectionsDbPath } from '../src/core/remote-connections.ts';
import { createSourceCorpusRegistry } from '../src/core/source-corpus-registry.ts';
import { olympusOpenUrl, parseOlympusOpenUrl, openTargetToken } from '../src/core/open-targets.ts';
import { withRemotePrivateNote } from '../src/core/remote-result.ts';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-inbox-lifecycle-')); dirs.push(dir);
  // A data folder relocated outside the home (XDG_DATA_HOME): the answers sit beside the remote connections there.
  const homeDir = join(dir, 'home');
  const env = { HOME: homeDir, XDG_DATA_HOME: join(dir, 'custom-private-state') };
  const path = waitingPrivateQuestionsDbPath(resolveRemoteConnectionsDbPath(env));
  mkdirSync(dirname(path), { recursive: true });
  const options = { homeDir, env };
  return { dir, path, options };
}
function save(path: string, corpusId: string, question = 'Example?', pathKind: 'private' | 'anonymous' | 'venice' = 'private') {
  const store = openWaitingPrivateQuestionStore(path);
  const ref = store.record(store.ticket('example-agent'), { question, surface: 'remote', state: 'waiting', path: pathKind })!;
  const result: StoredPrivateAnswer = { status: 'answered', answer: pathKind === 'venice' ? 'VENICE_INBOX_LIFECYCLE_SENTINEL' : pathKind === 'anonymous' ? 'ANONYMOUS_INBOX_LIFECYCLE_SENTINEL' : 'PRIVATE_INBOX_LIFECYCLE_SENTINEL', citations: [], unanswered: [], leftOut: [], read: [{ corpusId }] };
  store.saveAnswer(ref, result); store.close(); return ref;
}
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]);
}
test('data delete --all removes retained answer state, including a relocated data folder', () => {
  const f = fixture(); save(f.path, 'secure_local.example.files'); save(f.path, '', 'Exact outside question', 'anonymous'); save(f.path, 'secure_local.example.files', 'Venice question', 'venice');
  const dry = deleteOlympusData({ all: true, dryRun: true, ...f.options });
  expect(dry.removed).toContain(f.path); expect(existsSync(f.path)).toBe(true);
  const deleted = deleteOlympusData({ all: true, ...f.options });
  expect(deleted.removed).toContain(f.path); expect(existsSync(f.path)).toBe(false);
});
test('export omits the inbox answer bytes and names it as skipped', () => {
  const f = fixture(); save(f.path, 'secure_local.example.files'); save(f.path, '', 'Exact outside question', 'anonymous'); save(f.path, 'secure_local.example.files', 'Venice question', 'venice');
  const out = join(f.dir, 'export');
  const exported = exportOlympusData({ destination: out, ...f.options });
  expect(exported.skipped).toContain(f.path);
  expect(files(out).some(path => path.endsWith('waiting-private-questions.sqlite'))).toBe(false);
  for (const path of files(out)) { expect(readFileSync(path).includes(Buffer.from('PRIVATE_INBOX_LIFECYCLE_SENTINEL'))).toBe(false); expect(readFileSync(path).includes(Buffer.from('ANONYMOUS_INBOX_LIFECYCLE_SENTINEL'))).toBe(false); expect(readFileSync(path).includes(Buffer.from('VENICE_INBOX_LIFECYCLE_SENTINEL'))).toBe(false); }
});
test('source deletion removes answers depending on that source and pending work, preserving unrelated answers', () => {
  const f = fixture();
  const corpora = createSourceCorpusRegistry().list();
  const dependent = save(f.path, corpora.find(c => c.sourceId === 'dropbox.files')!.corpusId);
  const unrelated = save(f.path, corpora.find(c => c.sourceId === 'gmail.email')!.corpusId, 'Other question?');
  const store = openWaitingPrivateQuestionStore(f.path);
  const pending = store.record(store.ticket('another-agent'), { question: 'Pending?', surface: 'remote', state: 'waiting' })!; store.close();
  deleteOlympusData({ sourceId: 'dropbox.files', dryRun: true, ...f.options });
  const before = openWaitingPrivateQuestionStore(f.path); expect(before.list().questions).toHaveLength(3); before.close();
  deleteOlympusData({ sourceId: 'dropbox.files', ...f.options });
  const after = openWaitingPrivateQuestionStore(f.path);
  expect(after.get(dependent.id)).toBeUndefined(); expect(after.get(pending.id)).toBeUndefined(); expect(after.get(unrelated.id)?.result?.answer).toBe('PRIVATE_INBOX_LIFECYCLE_SENTINEL');
  expect(after.saveAnswer(pending, { status: 'not_found', citations: [], unanswered: [], leftOut: [], read: [] })).toBe(false); after.close();
});
test('agent link carries only random opaque row id, and uses the existing computer opening target', () => {
  const f = fixture(); const ref = save(f.path, 'secure_local.example.files', 'PRIVATE_QUESTION_NOT_IN_LINK');
  const link = olympusOpenUrl({ kind: 'private_answers', answerId: ref.id });
  expect(link).toMatch(/^olympus:\/\/open\/private\/[A-Za-z0-9_-]{22}$/);
  expect(link).not.toContain('PRIVATE_QUESTION'); expect(link).not.toContain('?');
  expect(parseOlympusOpenUrl(link)).toEqual({ kind: 'private_answers', answerId: ref.id });
  expect(openTargetToken(parseOlympusOpenUrl(link)!)).toBe(`page.private.${ref.id}`);
  const noted = withRemotePrivateNote({ kind: 'source_answer', status: 'answered', answer: 'Public answer', citations: [] }, ref.id);
  expect(noted.private_note).toBe(`Your answer is in Olympus on your computer. [Open answer](${link})`);
  expect(JSON.stringify(noted)).not.toContain('PRIVATE_INBOX_LIFECYCLE_SENTINEL');
  expect(parseOlympusOpenUrl('olympus://open/private/question-text')).toEqual({ kind: 'dashboard', fallback: true });
});
