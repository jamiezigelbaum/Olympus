import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const SCRIPT = join(process.cwd(), 'scripts', 'telegram-pair.py');
const DRIVER = String.raw`
import importlib.util, io, json, os, sys
spec = importlib.util.spec_from_file_location('telegram_pair', sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
os.environ['OLYMPUS_TELEGRAM_DASHBOARD_PROMPTS'] = '1'
sys.stdin = io.StringIO(sys.argv[2])
try:
    with m.pairing_terminal() as terminal:
        for field in json.loads(sys.argv[3]):
            value = m.prompt_secret(terminal, 'DO NOT PRINT THIS LABEL', field=field)
            if value != 'private-test-value':
                raise RuntimeError('wrong input')
            del value
except m.SafePairingError as error:
    sys.stderr.write(error.code)
    sys.exit(2)
`;
function run(input: string, fields = ['api_id', 'api_hash', 'phone', 'code', 'password']) {
  return spawnSync('python3', ['-c', DRIVER, SCRIPT, input, JSON.stringify(fields)], { encoding: 'utf8', timeout: 10000 });
}

describe('Telegram private dashboard subprocess protocol', () => {
  test('requests typed values one at a time without echoing values or labels', () => {
    const fields = ['api_id', 'api_hash', 'phone', 'code', 'password'];
    const result = run(fields.map(field => JSON.stringify({ field, value: 'private-test-value' })).join('\n') + '\n');
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim().split('\n').map(line => JSON.parse(line))).toEqual(fields.map(field => ({ event: 'prompt', field })));
    expect(result.stdout).not.toContain('private-test-value');
    expect(result.stdout).not.toContain('DO NOT PRINT');
  });
  test('fails closed on EOF', () => {
    const result = run('', ['code']);
    expect(result.status).toBe(2);
    expect(result.stderr).toBe('dashboard_prompt_closed');
  });
  test.each([
    'private-test-value\n',
    '{"field":"password","value":"private-test-value"}\n',
    '{"field":"code","value":123}\n',
    '{"field":"code","value":"private-test-value","extra":true}\n',
    JSON.stringify({ field: 'code', value: 'x'.repeat(17000) }) + '\n',
  ])('rejects malformed or misdirected input without leaking it', input => {
    const result = run(input, ['code']);
    expect(result.status).toBe(2);
    expect(result.stderr).toBe('dashboard_prompt_invalid');
    expect(result.stdout).toBe('{"event":"prompt","field":"code"}\n');
  });
});

const PAIR_DRIVER = String.raw`
import asyncio, importlib.util, io, json, os, pathlib, sys, tempfile, types
spec = importlib.util.spec_from_file_location('telegram_pair', sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
class PasswordNeeded(Exception): pass
class Client:
    def __init__(self, session, api_id, api_hash):
        assert api_id == 12345 and api_hash == 'test-api-hash'
        pathlib.Path(session + '.session').touch()
        self.authorized = False
    async def connect(self): pass
    async def disconnect(self): pass
    async def is_user_authorized(self): return self.authorized
    async def send_code_request(self, phone): assert phone == '+10000000000'
    async def sign_in(self, **kwargs):
        frame = sys._getframe(1)
        if 'code' in kwargs:
            assert kwargs['code'] == 'test-login-code'
            raise PasswordNeeded()
        assert kwargs == {'password': 'test-2fa-password'}
        assert frame.f_locals['code'] == ''
        self.authorized = True
    async def get_me(self):
        frame = sys._getframe(1)
        assert frame.f_locals['code'] == '' and frame.f_locals['password'] == ''
        return types.SimpleNamespace(id=42)
    async def iter_dialogs(self, **kwargs):
        yield types.SimpleNamespace(entity=types.SimpleNamespace(bot=False), is_user=True, id=7, name='Example')
sys.modules['telethon'] = types.SimpleNamespace(TelegramClient=Client)
sys.modules['telethon.errors'] = types.SimpleNamespace(SessionPasswordNeededError=PasswordNeeded)
with tempfile.TemporaryDirectory() as folder:
    os.environ['OLYMPUS_TELEGRAM_SESSION_PATH'] = folder + '/telegram'
    os.environ['OLYMPUS_TELEGRAM_DASHBOARD_PROMPTS'] = '1'
    sys.stdin = io.StringIO(''.join(json.dumps({'field': k, 'value': v}) + '\n' for k, v in [
        ('api_id', '12345'), ('api_hash', 'test-api-hash'), ('phone', '+10000000000'),
        ('code', 'test-login-code'), ('password', 'test-2fa-password')]))
    def transfer(value): assert value == {'api_id': 12345, 'api_hash': 'test-api-hash'}
    m.transfer_credentials = transfer
    sys.exit(m.main())
`;

test('dashboard pairing completes 2FA, releases transient values and preserves credential transfer', () => {
  const result = spawnSync('python3', ['-c', PAIR_DRIVER, SCRIPT], { encoding: 'utf8', timeout: 10000 });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  const messages = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  expect(messages.slice(0, 5)).toEqual(['api_id', 'api_hash', 'phone', 'code', 'password'].map(field => ({ event: 'prompt', field })));
  expect(messages[5]).toMatchObject({ event: 'ready', proof: { credentials_transferred: true }, dialogs: [{ chat_scope: 'telegram.personal:chat:7' }] });
  for (const value of ['test-api-hash', '+10000000000', 'test-login-code', 'test-2fa-password']) expect(result.stdout).not.toContain(value);
});

const LIST_DRIVER = String.raw`
import importlib.util, io, json, os, pathlib, sys, tempfile, types
spec = importlib.util.spec_from_file_location('telegram_pair', sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
mode = sys.argv[2]
class Client:
    def __init__(self, session, api_id, api_hash):
        assert api_id == 12345 and api_hash == 'test-api-hash'
    async def connect(self): pass
    async def disconnect(self): pass
    async def is_user_authorized(self): return mode != 'unauthorized'
    async def iter_dialogs(self, **kwargs):
        assert kwargs.get('limit') is None
        for n in range(225):
            yield types.SimpleNamespace(entity=types.SimpleNamespace(bot=False), is_user=True, id=n, name='Chat %d' % n)
sys.modules['telethon'] = types.SimpleNamespace(TelegramClient=Client)
with tempfile.TemporaryDirectory() as folder:
    session = folder + '/telegram'
    if mode != 'missing': pathlib.Path(session + '.session').touch()
    os.environ['OLYMPUS_TELEGRAM_SESSION_PATH'] = session
    os.environ['OLYMPUS_TELEGRAM_LIST_CHATS'] = '1'
    sys.stdin = io.StringIO(json.dumps({'api_id': 12345, 'api_hash': 'test-api-hash'}) + '\n')
    sys.exit(m.main())
`;

describe('Telegram existing-session chat listing', () => {
  test('lists every dialog through a private credential pipe without a login flow', () => {
    const result = spawnSync('python3', ['-c', LIST_DRIVER, SCRIPT, 'authorized'], { encoding: 'utf8', timeout: 10000 });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const receipt = JSON.parse(result.stdout);
    expect(receipt.event).toBe('dialogs');
    expect(receipt.dialogs).toHaveLength(225);
    expect(receipt.dialogs[224].chat_scope).toBe('telegram.personal:chat:224');
    expect(result.stdout).not.toContain('test-api-hash');
    expect(result.stdout).not.toContain('prompt');
  });
  test.each([['missing', 'session_not_persisted'], ['unauthorized', 'authorization_not_confirmed']])('fails safely for %s session without asking for login', (mode, error) => {
    const result = spawnSync('python3', ['-c', LIST_DRIVER, SCRIPT, mode], { encoding: 'utf8', timeout: 10000 });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toEqual({ error });
  });
});
