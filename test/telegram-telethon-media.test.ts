/**
 * The Telethon helper's kept media. Every media file is kept, whatever its size
 * (owner, 2026-10-26); the one safeguard is the computer's own free-disk floor
 * (the larger of 5 GB and 5% of the disk), under which new downloads pause, the
 * attachment says it is waiting, and the message is filled in once space
 * returns. A download that fails at any point leaves no copy, a changed
 * attachment is downloaded again under a new name, and a stopped process's
 * temporaries are swept. Stand-in Telethon objects, a stand-in disk and
 * synthetic bytes only; no network.
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

const GB = 1024 ** 3;

async function python(body: string, env: Record<string, string> = {}): Promise<any> {
  const program = `
import importlib.util, json, sys, os, asyncio, datetime as dt
spec = importlib.util.spec_from_file_location("reader", ${JSON.stringify(SCRIPT)})
reader = importlib.util.module_from_spec(spec)
sys.modules["reader"] = reader
spec.loader.exec_module(reader)
GB = 1024 ** 3
# A stand-in disk: free and total bytes, changed by the test.
disk = {"free": 500 * GB, "total": 1000 * GB}
reader.disk_space = lambda path: (disk["free"], disk["total"])
class Photo:
    def __init__(self, pid):
        self.id = pid
        self.access_hash = 99
        self.date = dt.datetime(2026, 10, 20, 9, 0, tzinfo=dt.timezone.utc)
class Msg:
    def __init__(self, mid, photo_id=5, payload=b"synthetic jpeg bytes", fail=None, chunks=1, during=None):
        self.id = mid
        self.photo = Photo(photo_id)
        self.document = None
        self.payload = payload
        self.fail = fail
        self.chunks = chunks
        self.during = during
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
                if self.during:
                    self.during(self.written)
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
def waiting():
    return reader.read_media_waiting(reader.media_dir().parent)
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

describe('every media file is kept, with no copy left behind', () => {
  pythonTest('a file of any size is kept: there is no size cap and no total quota', async () => {
    const dir = spool();
    const out = await python(`
big = record(2, size=3 * GB)
asyncio.run(reader.capture_message_media(Msg(2, payload=b"b" * 4096, chunks=4), big))
print(json.dumps({"attachment": big["attachments"][0], "files": files(), "caps": [hasattr(reader, name) for name in ("media_max_bytes", "media_quota_bytes")]}))
`, { OLYMPUS_TELEGRAM_GATEWAY_SPOOL_DIR: dir, OLYMPUS_TELEGRAM_MEDIA_MAX_BYTES: '1000', OLYMPUS_TELEGRAM_MEDIA_QUOTA_BYTES: '1000' });
    expect(out.attachment.mediaFile).toMatch(/^media\/-1000001\/2\.[0-9a-f]{12}\.jpg$/);
    expect(out.attachment.mediaLeftOut).toBeUndefined();
    expect(out.files).toHaveLength(1);
    expect(out.caps).toEqual([false, false]);
  });

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

  pythonTest('the sweep removes a stopped process\'s temporaries and keeps a running one\'s', async () => {
    const dir = spool();
    const folder = join(dir, 'media', '-1000001');
    mkdirSync(folder, { recursive: true });
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

describe('the free-disk floor: the larger of 5 GB and 5% of the disk', () => {
  pythonTest('the floor is 5 GB on a small disk and 5% on a large one', async () => {
    const out = await python(`
print(json.dumps([reader.disk_floor(40 * GB), reader.disk_floor(100 * GB), reader.disk_floor(1000 * GB)]))
`);
    expect(out).toEqual([5 * GB, 5 * GB, 50 * GB]);
  });

  pythonTest('under the floor a download does not start: the attachment says it is waiting and the message is listed', async () => {
    const dir = spool();
    const out = await python(`
disk["free"], disk["total"] = 4 * GB, 100 * GB
small = record(3)
small_message = Msg(3)
asyncio.run(reader.capture_message_media(small_message, small))
# 5% of a 1 TB disk is 50 GB: 40 GB free is under it.
disk["free"], disk["total"] = 40 * GB, 1000 * GB
large = record(4)
asyncio.run(reader.capture_message_media(Msg(4), large))
print(json.dumps({"small": small["attachments"][0], "large": large["attachments"][0], "downloads": small_message.downloads, "files": files(), "waiting": waiting()}))
`, { OLYMPUS_TELEGRAM_GATEWAY_SPOOL_DIR: dir });
    expect(out.small).toEqual({ attachmentId: 'photo:5', type: 'image', mediaLeftOut: 'waiting_for_disk' });
    expect(out.large.mediaLeftOut).toBe('waiting_for_disk');
    expect(out.downloads).toBe(0);
    expect(out.files).toEqual([]);
    expect(out.waiting).toEqual([{ chat: '-1000001', message: '3' }, { chat: '-1000001', message: '4' }]);
  });

  pythonTest('a stated size that would take free space under the floor waits; one that fits is kept', async () => {
    const dir = spool();
    const out = await python(`
disk["free"], disk["total"] = 5 * GB + 100, 100 * GB
fits = record(5, size=60)
asyncio.run(reader.capture_message_media(Msg(5, payload=b"f" * 60), fits))
over = record(6, size=200)
asyncio.run(reader.capture_message_media(Msg(6, payload=b"o" * 200), over))
print(json.dumps({"fits": fits["attachments"][0], "over": over["attachments"][0], "waiting": waiting()}))
`, { OLYMPUS_TELEGRAM_GATEWAY_SPOOL_DIR: dir });
    expect(out.fits.mediaFile).toBeDefined();
    expect(out.over.mediaLeftOut).toBe('waiting_for_disk');
    expect(out.waiting).toEqual([{ chat: '-1000001', message: '6' }]);
  });

  pythonTest('free space falling under the floor while the bytes arrive stops the download, leaves no copy, and waits', async () => {
    const dir = spool();
    const out = await python(`
reader.MEDIA_DISK_CHECK_BYTES = 1
def fill_the_disk(written):
    if written >= 300:
        disk["free"] = 1 * GB
message = Msg(7, payload=b"x" * 1000, chunks=10, during=fill_the_disk)
paused = record(7)
asyncio.run(reader.capture_message_media(message, paused))
print(json.dumps({"attachment": paused["attachments"][0], "written": message.written, "files": files(), "waiting": waiting()}))
`, { OLYMPUS_TELEGRAM_GATEWAY_SPOOL_DIR: dir });
    expect(out.attachment.mediaLeftOut).toBe('waiting_for_disk');
    expect(out.attachment.mediaFile).toBeUndefined();
    expect(out.written).toBeLessThan(1000);
    expect(out.files).toEqual([]);
    expect(out.waiting).toEqual([{ chat: '-1000001', message: '7' }]);
  });

  pythonTest('overlapping downloads share the room above the floor: one of four fits, three wait', async () => {
    const dir = spool();
    const out = await python(`
disk["free"], disk["total"] = 5 * GB + 100, 100 * GB
records = [record(20 + n, size=60) for n in range(4)]
messages = [Msg(20 + n, photo_id=20 + n, payload=b"m" * 60, chunks=6) for n in range(4)]
async def overlapping():
    await asyncio.gather(*(reader.capture_message_media(m, r) for m, r in zip(messages, records)))
asyncio.run(overlapping())
print(json.dumps({"kept": [r["attachments"][0].get("mediaFile") for r in records], "waiting": [r["attachments"][0].get("mediaLeftOut") for r in records], "files": files()}))
`, { OLYMPUS_TELEGRAM_GATEWAY_SPOOL_DIR: dir });
    expect(out.kept.filter(Boolean)).toHaveLength(1);
    expect(out.waiting.filter((reason: string | null) => reason === 'waiting_for_disk')).toHaveLength(3);
    expect(out.files.filter((name: string) => name.includes('.tmp.'))).toEqual([]);
  });
});

describe('waiting media is filled in once space returns', () => {
  const retry = `
class Config:
    account = "telegram.personal"
    approved_scopes = ["telegram.personal:chat:-1000001"]
class Client:
    def __init__(self, messages):
        self.messages = messages
        self.asked = []
    async def get_messages(self, chat, ids=None):
        self.asked.append([chat, ids])
        return [self.messages.get(i) for i in ids]
appended = []
reader.append_gateway_page = lambda config, scope, page, direction, request_id=None: appended.extend([(scope, m["id"], m["attachments"][0].get("mediaFile")) for m in page["messages"]]) or len(page["messages"])
reader.normalize_message = lambda message, account, chat, title, kind: record(message.id, chat, size=getattr(message, "stated", None))
async def ask(client):
    return await reader.retry_waiting_media(client, Config(), asyncio.Lock())
`;

  pythonTest('while the disk is still nearly full nothing is fetched; once it has room each waiting message is captured again with its file', async () => {
    const dir = spool();
    const out = await python(`${retry}
disk["free"], disk["total"] = 1 * GB, 100 * GB
asyncio.run(reader.capture_message_media(Msg(30), record(30)))
asyncio.run(reader.capture_message_media(Msg(31), record(31)))
before = waiting()
client = Client({30: Msg(30), 31: Msg(31)})
low = asyncio.run(ask(client))
asked_while_low = list(client.asked)
disk["free"] = 500 * GB
filled = asyncio.run(ask(client))
print(json.dumps({"before": before, "low": low, "askedWhileLow": asked_while_low, "filled": filled, "appended": appended, "after": waiting(), "files": files()}))
`, { OLYMPUS_TELEGRAM_GATEWAY_SPOOL_DIR: dir });
    expect(out.before).toEqual([{ chat: '-1000001', message: '30' }, { chat: '-1000001', message: '31' }]);
    expect(out.low).toBe(0);
    expect(out.askedWhileLow).toEqual([]);
    expect(out.filled).toBe(2);
    expect(out.appended.map((entry: [string, string, string]) => [entry[0], entry[1]])).toEqual([['telegram.personal:chat:-1000001', '30'], ['telegram.personal:chat:-1000001', '31']]);
    expect(out.appended.every((entry: [string, string, string]) => /^media\/-1000001\/3[01]\.[0-9a-f]{12}\.jpg$/.test(entry[2]))).toBe(true);
    expect(out.after).toEqual([]);
    expect(out.files).toHaveLength(2);
  });

  pythonTest('a message gone from Telegram, or from a chat no longer approved, is let go', async () => {
    const dir = spool();
    const out = await python(`${retry}
disk["free"], disk["total"] = 1 * GB, 100 * GB
asyncio.run(reader.capture_message_media(Msg(40), record(40)))
asyncio.run(reader.capture_message_media(Msg(41), record(41, chat="-2000002")))
disk["free"] = 500 * GB
filled = asyncio.run(ask(Client({})))
print(json.dumps({"filled": filled, "after": waiting()}))
`, { OLYMPUS_TELEGRAM_GATEWAY_SPOOL_DIR: dir });
    expect(out.filled).toBe(0);
    expect(out.after).toEqual([]);
  });

  pythonTest('the disk filling again partway pauses the fill-in, and what is left keeps waiting', async () => {
    const dir = spool();
    const out = await python(`${retry}
disk["free"], disk["total"] = 1 * GB, 100 * GB
for n in (50, 51, 52):
    asyncio.run(reader.capture_message_media(Msg(n), record(n)))
disk["free"] = 500 * GB
class Filling(Msg):
    async def download_media(self, file=None, progress_callback=None):
        disk["free"] = 1 * GB
        return await Msg.download_media(self, file=file, progress_callback=progress_callback)
filled = asyncio.run(ask(Client({50: Filling(50), 51: Msg(51), 52: Msg(52)})))
print(json.dumps({"filled": filled, "after": waiting()}))
`, { OLYMPUS_TELEGRAM_GATEWAY_SPOOL_DIR: dir });
    expect(out.filled).toBe(1);
    expect(out.after).toEqual([{ chat: '-1000001', message: '51' }, { chat: '-1000001', message: '52' }]);
  });

  // Astra, round 4 (#556): no paused media is ever lost.
  pythonTest('a retry whose download or re-capture fails keeps its entry, and a later cycle fills it in', async () => {
    const dir = spool();
    const out = await python(`${retry}
disk["free"], disk["total"] = 1 * GB, 100 * GB
asyncio.run(reader.capture_message_media(Msg(60), record(60)))
asyncio.run(reader.capture_message_media(Msg(61), record(61)))
disk["free"] = 500 * GB
broken = asyncio.run(ask(Client({60: Msg(60, fail="midway"), 61: Msg(61, fail="midway")})))
after_broken = waiting()
real_append = reader.append_gateway_page
def refuse(*args, **kwargs):
    raise OSError("spool")
reader.append_gateway_page = refuse
unwritten = asyncio.run(ask(Client({60: Msg(60, photo_id=60), 61: Msg(61, photo_id=61)})))
after_unwritten = waiting()
reader.append_gateway_page = real_append
filled = asyncio.run(ask(Client({60: Msg(60, photo_id=70), 61: Msg(61, photo_id=71)})))
print(json.dumps({"broken": broken, "afterBroken": after_broken, "unwritten": unwritten, "afterUnwritten": after_unwritten, "filled": filled, "after": waiting()}))
`, { OLYMPUS_TELEGRAM_GATEWAY_SPOOL_DIR: dir });
    const both = [{ chat: '-1000001', message: '60' }, { chat: '-1000001', message: '61' }];
    expect(out.broken).toBe(0);
    expect(out.afterBroken).toEqual(both);
    expect(out.unwritten).toBe(0);
    expect(out.afterUnwritten).toEqual(both);
    expect(out.filled).toBe(2);
    expect(out.after).toEqual([]);
  });

  pythonTest('a file too large for the room left is skipped and the rest goes on: 6 GB free of 100, a 2 GB file first, then a small one', async () => {
    const dir = spool();
    const out = await python(`${retry}
disk["free"], disk["total"] = 1 * GB, 100 * GB
big = Msg(70, photo_id=70)
big.stated = 2 * GB
small = Msg(71, photo_id=71, payload=b"s" * 100)
small.stated = 100
asyncio.run(reader.capture_message_media(big, record(70, size=2 * GB)))
asyncio.run(reader.capture_message_media(small, record(71, size=100)))
disk["free"] = 6 * GB
filled = asyncio.run(ask(Client({70: big, 71: small})))
print(json.dumps({"filled": filled, "appended": [entry[1] for entry in appended], "after": waiting(), "bigDownloads": big.downloads}))
`, { OLYMPUS_TELEGRAM_GATEWAY_SPOOL_DIR: dir });
    expect(out.filled).toBe(1);
    expect(out.appended).toEqual(['71']);
    expect(out.bigDownloads).toBe(0);
    expect(out.after).toEqual([{ chat: '-1000001', message: '70' }]);
  });

  pythonTest('the waiting list is never cut short: every paused message stays listed, however many', async () => {
    const dir = spool();
    const out = await python(`
folder = reader.media_dir()
folder.mkdir(parents=True)
for n in range(150_001):
    reader.media_waits(folder, "-1000001", str(n), {})
listed = waiting()
print(json.dumps({"count": len(listed), "first": listed[0], "last": listed[-1], "file": reader.MEDIA_WAITING_NAME}))
`, { OLYMPUS_TELEGRAM_GATEWAY_SPOOL_DIR: dir });
    expect(out.count).toBe(150_001);
    expect(out.first).toEqual({ chat: '-1000001', message: '0' });
    expect(out.last).toEqual({ chat: '-1000001', message: '150000' });
    expect(out.file).toBe('.capture-media-waiting.jsonl');
  }, 60_000);
});
