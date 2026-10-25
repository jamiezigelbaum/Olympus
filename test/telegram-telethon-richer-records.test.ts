/**
 * The Telethon helper's records carry what the export carries too: a service
 * message's event under the export's own action names, who a forward came
 * from, and a heartbeat beside the spool after every finished cycle. Its
 * report reads the spool in chunks and passes a damaged record instead of
 * failing. Stand-in Telethon objects only; no network.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

const SCRIPT = join(import.meta.dir, '..', 'scripts', 'telegram-telethon-reader.py');
const PYTHON = Bun.which('python3');
const pythonTest = test.skipIf(!PYTHON);

async function python(body: string, env: Record<string, string> = {}): Promise<any> {
  const program = `
import importlib.util, json, sys, datetime as dt
spec = importlib.util.spec_from_file_location("reader", ${JSON.stringify(SCRIPT)})
reader = importlib.util.module_from_spec(spec)
sys.modules["reader"] = reader
spec.loader.exec_module(reader)
${body}
`;
  const proc = Bun.spawn([PYTHON ?? 'python3', '-I', '-c', program], {
    stdout: 'pipe', stderr: 'pipe', env: { PATH: process.env.PATH ?? '', ...env },
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(stderr);
  return JSON.parse(stdout);
}

const STUBS = `
class MessageActionPhoneCall:
    def __init__(self):
        self.duration = 65
        self.reason = PhoneCallDiscardReasonHangup()
class PhoneCallDiscardReasonHangup: pass
class MessageActionChatEditTitle:
    title = "Trip planning"
class MessageActionSuggestedPostApproval: pass
class User:
    first_name = "Origin"
    last_name = "Person"
class Forward:
    def __init__(self, from_name=None, sender=None):
        self.from_name = from_name
        self.sender = sender
        self.chat = None
class Msg:
    def __init__(self, mid, action=None, forward=None, text=None):
        self.id = mid
        self.date = dt.datetime(2026, 10, 20, 9, 0, tzinfo=dt.timezone.utc)
        self.edit_date = None
        self.sender_id = 7
        self.out = False
        self.raw_text = text
        self.reply_to_msg_id = None
        self.forward = forward
        self.media = None
        self.action = action
        self.reactions = None
def norm(message):
    return reader.normalize_message(message, "telegram.personal", "-1001", "Chat", "group")
`;

describe('Telethon helper: richer records', () => {
  pythonTest('a service message carries its event by the export\'s names', async () => {
    const out = await python(`${STUBS}
print(json.dumps([norm(Msg(1, MessageActionPhoneCall())), norm(Msg(2, MessageActionChatEditTitle())), norm(Msg(3, MessageActionSuggestedPostApproval())), norm(Msg(4, text="hi"))]))
`);
    expect(out[0].service).toEqual({ action: 'phone_call', duration_seconds: 65, discard_reason: 'hangup' });
    expect(out[1].service).toEqual({ action: 'edit_group_title', title: 'Trip planning' });
    // An action this does not know keeps its own name.
    expect(out[2].service).toEqual({ action: 'suggested_post_approval' });
    expect(out[3]).not.toHaveProperty('service');
  });

  pythonTest('a forward names where it came from when Telethon holds it, else keeps the bare flag', async () => {
    const out = await python(`${STUBS}
print(json.dumps([norm(Msg(1, forward=Forward(from_name="Hidden Name"), text="a")), norm(Msg(2, forward=Forward(sender=User()), text="b")), norm(Msg(3, forward=Forward(), text="c"))]))
`);
    expect(out[0]).toMatchObject({ forwardSource: 'telegram_forward', forwardFromName: 'Hidden Name' });
    expect(out[1]).toMatchObject({ forwardSource: 'telegram_forward', forwardFromName: 'Origin Person' });
    expect(out[2].forwardSource).toBe('telegram_forward');
    expect(out[2]).not.toHaveProperty('forwardFromName');
  });

  pythonTest('the report counts and dates the spool without failing on a damaged record, and the heartbeat reads', async () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-telegram-report-'));
    try {
      const spoolDir = join(root, 'spool');
      mkdirSync(spoolDir);
      writeFileSync(join(spoolDir, '2026-10-19.jsonl'), '{"captured_at":"2026-10-19T08:00:00Z"}\n');
      writeFileSync(join(spoolDir, '2026-10-20.jsonl'), '{"captured_at":"2026-10-20T08:00:00Z"}\nnot json at all\n\n{"captured_at":"2026-10-20T09');
      const out = await python(`
from pathlib import Path
spool = Path(${JSON.stringify(spoolDir)})
reader.write_capture_heartbeat(spool)
config = reader.GatewayConfig(account="telegram.personal", approved_scopes=(), classifications={}, state_dir=spool, spool_dir=spool,
    state_path=spool / "state.json", report_path=spool / "report.json", backfill_path=spool / "b.jsonl", max_messages=10,
    interval_seconds=60, stale_threshold_seconds=3600)
report = reader.gateway_report(config, reader.read_gateway_state(spool / "state.json"), 0)
heartbeat = json.loads((spool / reader.CAPTURE_HEARTBEAT_NAME).read_text())
print(json.dumps({"report": report, "heartbeat": heartbeat}))
`, { OLYMPUS_TELEGRAM_GATEWAY_NOW: '2026-10-20T09:00:00Z' });
      expect(out.report).toMatchObject({ spool_records: 3, spool_newest_age_seconds: 3_600, spool_freshness_status: 'fresh' });
      expect(out.heartbeat).toEqual({ kind: 'telegram_capture_heartbeat', schema_version: 1, cycle_completed_at: '2026-10-20T09:00:00Z' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
