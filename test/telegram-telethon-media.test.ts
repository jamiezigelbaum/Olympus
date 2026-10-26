/**
 * The Telethon helper's kept media (#556 review): a download that fails at
 * any point leaves no copy, the size limit holds while the bytes arrive, a
 * total quota stops new media without evicting any, a changed attachment is
 * downloaded again under a new name, and a stopped process's temporaries are
 * swept. Stand-in Telethon objects and synthetic bytes only; no network.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';

const SCRIPT = join(import.meta.dir, '..', 'scripts', 'telegram-telethon-reader.py');
const PYTHON = Bun.which('python3');
const pythonTest = test.skipIf(!PYTHON);

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function python(body: string, env: Record<string, string> = {}): Promise<any> {
  const program = `
import importlib.util, json, sys, os, asyncio, datetime as dt
spec = importlib.util.spec_from_file_location("reader", ${JSON.stringify(SCRIPT)})
reader = importlib.util.module_from_spec(spec)
sys.modules["reader"] = reader
spec.loader.exec_module(reader)
class Photo:
    def __init__(self, pid):
        self.id = pid
        self.access_hash = 99
        self.date = dt.datetime(2026, 10, 20, 9, 0, tzinfo=dt.timezone.utc)
class Msg:
    def __init__(self, mid, photo_id=5, payload=b"synthetic jpeg bytes", fail=None, chunks=1):
        self.id = mid
        self.photo = Photo(photo_id)
        self.document = None
        self.payload = payload
        self.fail = fail
        self.chunks = chunks
        self.downloads = 0
        self.written = 0
    async def download_media(self, file=None, progress_callback=None):
        self.downloads += 1
        step = max(1, len(self.payload) // self.chunks)
        with open(file, "wb") as out:
            for at in range(0, len(self.payload), step):
                out.write(self.payload[at:at + step])
                out.flush()
                self.written += len(self.payload[at:at + step])
                await asyncio.sleep(0)
                if self.fail == "midway":
                    raise RuntimeError("network")
                if progress_callback:
                    progress_callback(min(at + step, len(self.payload)), None)
        return file
def record(mid, chat="-1000001", size=None):
    attachment = {"attachmentId": "photo:5", "type": "image"}
    if size is not None:
        attachment["sizeBytes"] = size
    return {"id": str(mid), "conversationId": chat, "attachments": [attachment]}
def files(chat="-1000001"):
    folder = reader.media_dir() / chat
    return sorted(os.listdir(folder)) if folder.is_dir() else []
${body}
`;
  const proc = Bun.spawn([PYTHON ?? 'python3', '-I', '-c', program], {
    stdout: 'pipe', stderr: 'pipe', env: { PATH: process.env.PATH ?? '', ...env },
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(stderr);
  return JSON.parse(stdout);
}

function spool(): string {
  const root = mkdtempSync(join(tmpdir(), 'olympus-telegram-media-py-'));
  roots.push(root);
  return join(root, 'spool');
}

describe('the helper keeps media with no copy left behind', () => {
  pythonTest('a download that fails partway, or a rename that throws, leaves no temporary and no locator', async () => {
    const dir = spool();
    const out = await python(`
midway = record(1)
asyncio.run(reader.capture_message_media(Msg(1, fail="midway"), midway))
renamed = record(2)
real_replace = reader.os.replace
def broken(*args):
    raise OSError("disk")
reader.os.replace = broken
asyncio.run(reader.capture_message_media(Msg(2), renamed))
reader.os.replace = real_replace
print(json.dumps({"files": files(), "midway": midway["attachments"][0], "renamed": renamed["attachments"][0]}))
`, { OLYMPUS_TELEGRAM_GATEWAY_SPOOL_DIR: dir });
    expect(out.files).toEqual([]);
    expect(out.midway.mediaFile).toBeUndefined();
    expect(out.renamed.mediaFile).toBeUndefined();
  });

  pythonTest('the size limit stops a photo with no stated size while its bytes arrive, and names why', async () => {
    const dir = spool();
    const out = await python(`
big = record(3)
message = Msg(3, payload=b"x" * 4000, chunks=40)
asyncio.run(reader.capture_message_media(message, big))
print(json.dumps({"files": files(), "attachment": big["attachments"][0], "written": message.written}))
`, { OLYMPUS_TELEGRAM_GATEWAY_SPOOL_DIR: dir, OLYMPUS_TELEGRAM_MEDIA_MAX_BYTES: '1000' });
    expect(out.files).toEqual([]);
    expect(out.attachment).toMatchObject({ mediaLeftOut: 'too_large' });
    // Stopped once the limit was passed: about 1000 of the 4000 bytes, not all of them.
    expect(out.written).toBeLessThanOrEqual(1100);
    expect(out.attachment.mediaFile).toBeUndefined();
  });

  pythonTest('past the quota new media is named only, the kept files stay, and the state file says the store is full', async () => {
    const dir = spool();
    mkdirSync(join(dir, 'media', '-1000001'), { recursive: true });
    writeFileSync(join(dir, 'media', '-1000001', '9.aaaaaaaaaaaa.jpg'), 'k'.repeat(900));
    const out = await python(`
late = record(4)
asyncio.run(reader.capture_message_media(Msg(4), late))
print(json.dumps({"files": files(), "attachment": late["attachments"][0]}))
`, { OLYMPUS_TELEGRAM_GATEWAY_SPOOL_DIR: dir, OLYMPUS_TELEGRAM_MEDIA_QUOTA_BYTES: '910' });
    expect(out.files).toEqual(['9.aaaaaaaaaaaa.jpg']);
    expect(out.attachment).toMatchObject({ mediaLeftOut: 'storage_full' });
    const state = JSON.parse(readFileSync(join(dir, '.capture-media.json'), 'utf8'));
    expect(state).toMatchObject({ kind: 'telegram_capture_media', schema_version: 1, storage_full: true, quota_bytes: 910, stored_bytes: 900 });
  });

  pythonTest('a changed attachment is downloaded again under a new name and replaces the old file; the same one is not', async () => {
    const dir = spool();
    const out = await python(`
first = record(6)
asyncio.run(reader.capture_message_media(Msg(6, photo_id=5, payload=b"old photo"), first))
again_message = Msg(6, photo_id=5, payload=b"old photo")
again = record(6)
asyncio.run(reader.capture_message_media(again_message, again))
changed = record(6)
asyncio.run(reader.capture_message_media(Msg(6, photo_id=8, payload=b"new photo"), changed))
kept = open(reader.media_dir().parent / changed["attachments"][0]["mediaFile"], "rb").read().decode()
print(json.dumps({"files": files(), "first": first["attachments"][0]["mediaFile"], "again": again["attachments"][0]["mediaFile"], "againDownloads": again_message.downloads, "changed": changed["attachments"][0]["mediaFile"], "kept": kept}))
`, { OLYMPUS_TELEGRAM_GATEWAY_SPOOL_DIR: dir });
    expect(out.first).toMatch(/^media\/-1000001\/6\.[0-9a-f]{12}\.jpg$/);
    expect(out.again).toBe(out.first);
    expect(out.againDownloads).toBe(0);
    expect(out.changed).not.toBe(out.first);
    expect(out.files).toEqual([out.changed.split('/').pop()]);
    expect(out.kept).toBe('new photo');
  });

  for (const declared of [true, false]) {
    pythonTest(`overlapping downloads share the quota (sizes ${declared ? 'stated' : 'not stated'}): one of four 60-byte files fits in 100 bytes`, async () => {
      const dir = spool();
      const out = await python(`
records = [record(20 + n, size=${declared ? 60 : 'None'}) for n in range(4)]
messages = [Msg(20 + n, photo_id=20 + n, payload=b"m" * 60, chunks=6) for n in range(4)]
async def overlapping():
    await asyncio.gather(*(reader.capture_message_media(m, r) for m, r in zip(messages, records)))
asyncio.run(overlapping())
folder = reader.media_dir() / "-1000001"
on_disk = sum(os.path.getsize(folder / name) for name in os.listdir(folder))
state = json.load(open(reader.media_dir().parent / ".capture-media.json"))
print(json.dumps({"kept": [r["attachments"][0].get("mediaFile") for r in records], "leftOut": [r["attachments"][0].get("mediaLeftOut") for r in records], "onDisk": on_disk, "files": files(), "state": state}))
`, { OLYMPUS_TELEGRAM_GATEWAY_SPOOL_DIR: dir, OLYMPUS_TELEGRAM_MEDIA_QUOTA_BYTES: '100' });
      expect(out.kept.filter(Boolean)).toHaveLength(1);
      expect(out.leftOut.filter((reason: string | null) => reason === 'storage_full')).toHaveLength(3);
      expect(out.onDisk).toBe(60);
      expect(out.files.filter((name: string) => name.includes('.tmp.'))).toEqual([]);
      expect(out.state).toMatchObject({ stored_bytes: 60, quota_bytes: 100, storage_full: true, left_out_items: 3 });
    });
  }

  pythonTest('the total is measured from disk at start, so files kept before a restart count against the quota', async () => {
    const dir = spool();
    mkdirSync(join(dir, 'media', '-1000001'), { recursive: true });
    writeFileSync(join(dir, 'media', '-1000001', '9.aaaaaaaaaaaa.jpg'), 'k'.repeat(80));
    writeFileSync(join(dir, 'media', '-1000001', '.8.aaaaaaaaaaaa.jpg.tmp.999999999'), 'x'.repeat(500));
    const out = await python(`
reader.media_usage["bytes"] = 0
measured = reader.media_stored_bytes(reader.media_dir(), fresh=True)
late = record(5, size=30)
asyncio.run(reader.capture_message_media(Msg(5, payload=b"p" * 30), late))
print(json.dumps({"measured": measured, "attachment": late["attachments"][0]}))
`, { OLYMPUS_TELEGRAM_GATEWAY_SPOOL_DIR: dir, OLYMPUS_TELEGRAM_MEDIA_QUOTA_BYTES: '100' });
    // A temporary is not a kept file: only the 80 kept bytes count.
    expect(out.measured).toBe(80);
    expect(out.attachment).toMatchObject({ mediaLeftOut: 'storage_full' });
  });

  pythonTest('fill, free, re-measure: the helper\'s own state clears once room is made, and its count starts again', async () => {
    const dir = spool();
    mkdirSync(join(dir, 'media', '-1000001'), { recursive: true });
    writeFileSync(join(dir, 'media', '-1000001', '9.aaaaaaaaaaaa.jpg'), 'k'.repeat(90));
    const out = await python(`
refused = record(30, size=60)
asyncio.run(reader.capture_message_media(Msg(30, payload=b"p" * 60), refused))
full = json.load(open(reader.media_dir().parent / ".capture-media.json"))
os.unlink(reader.media_dir() / "-1000001" / "9.aaaaaaaaaaaa.jpg")
reader.media_stored_bytes(reader.media_dir(), fresh=True)
cleared = json.load(open(reader.media_dir().parent / ".capture-media.json"))
fits = record(31, size=60)
asyncio.run(reader.capture_message_media(Msg(31, payload=b"q" * 60), fits))
print(json.dumps({"refused": refused["attachments"][0], "full": full, "cleared": cleared, "fits": fits["attachments"][0]}))
`, { OLYMPUS_TELEGRAM_GATEWAY_SPOOL_DIR: dir, OLYMPUS_TELEGRAM_MEDIA_QUOTA_BYTES: '100' });
    expect(out.refused).toMatchObject({ mediaLeftOut: 'storage_full' });
    expect(out.full).toMatchObject({ storage_full: true, left_out_items: 1, refused_with_bytes: 90 });
    expect(out.cleared).toMatchObject({ storage_full: false, left_out_items: 0, stored_bytes: 0 });
    expect(out.cleared.refused_with_bytes).toBeUndefined();
    expect(out.fits.mediaFile).toMatch(/^media\/-1000001\/31\./);
  });

  pythonTest('a gateway start says what is true now: a raised quota clears a full state the last run left', async () => {
    const dir = spool();
    mkdirSync(join(dir, 'media', '-1000001'), { recursive: true });
    writeFileSync(join(dir, 'media', '-1000001', '9.aaaaaaaaaaaa.jpg'), 'k'.repeat(90));
    writeFileSync(join(dir, '.capture-media.json'), JSON.stringify({ kind: 'telegram_capture_media', schema_version: 1, stored_bytes: 90, quota_bytes: 100, storage_full: true, left_out_items: 4, refused_with_bytes: 90 }));
    const out = await python(`
folder = reader.media_dir()
reader.media_start(folder)
print(json.dumps(json.load(open(folder.parent / ".capture-media.json"))))
`, { OLYMPUS_TELEGRAM_GATEWAY_SPOOL_DIR: dir, OLYMPUS_TELEGRAM_MEDIA_QUOTA_BYTES: '1000' });
    expect(out).toMatchObject({ storage_full: false, left_out_items: 0, stored_bytes: 90, quota_bytes: 1000 });
  });

  pythonTest('0 keeps no media and downloads nothing', async () => {
    const dir = spool();
    const out = await python(`
message = Msg(7)
off = record(7)
asyncio.run(reader.capture_message_media(message, off))
print(json.dumps({"downloads": message.downloads, "attachment": off["attachments"][0]}))
`, { OLYMPUS_TELEGRAM_GATEWAY_SPOOL_DIR: dir, OLYMPUS_TELEGRAM_MEDIA_MAX_BYTES: '0' });
    expect(out.downloads).toBe(0);
    expect(out.attachment.mediaFile).toBeUndefined();
  });

  pythonTest('the sweep removes a stopped process\'s temporaries and keeps a running one\'s', async () => {
    const dir = spool();
    const folder = join(dir, 'media', '-1000001');
    mkdirSync(folder, { recursive: true });
    // A pid far past any running process, and this test runner's own (running) pid.
    writeFileSync(join(folder, '.10.aaaaaaaaaaaa.jpg.tmp.999999999'), 'half');
    writeFileSync(join(folder, `.11.aaaaaaaaaaaa.jpg.tmp.${process.pid}`), 'in flight');
    writeFileSync(join(folder, '12.aaaaaaaaaaaa.jpg'), 'kept');
    const out = await python(`
print(json.dumps({"removed": reader.sweep_media_temporaries(reader.media_dir())}))
`, { OLYMPUS_TELEGRAM_GATEWAY_SPOOL_DIR: dir });
    expect(out.removed).toBe(1);
    expect(readdirSync(folder).sort()).toEqual([`.11.aaaaaaaaaaaa.jpg.tmp.${process.pid}`, '12.aaaaaaaaaaaa.jpg']);
  });
});
