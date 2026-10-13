// The deterministic Secrets floor: what counts as a credential and what is only
// a word about one.
//
// The floor (`SHARED_SECRET_PATTERNS`, read by scanDropboxContentPolicyText and
// by the outbound guard in src/core/opsec.ts) is the only thing that classes an
// item as Secrets, and Personal content can reach cloud models by design, so a
// miss leaks a credential. These tests pin both sides: the shapes that must be
// caught, and the prose, placeholders and masks that must not be. Recall wins
// where the two conflict: the floor is a superset of the one it replaced (the
// old regexes are replayed below), and it stays linear-time on hostile input.
//
// Provider-shaped fixtures are assembled at run time so this file itself holds
// no literal that a secret scanner (GitHub push protection, the credential
// diff check) would mistake for a real token.

import { describe, expect, test } from 'bun:test';
import { secretLabelsInText } from '../src/core/opsec.ts';
import { SHARED_SECRET_PATTERNS, hasSecretPatternHit } from '../src/core/secret-patterns.ts';
import { classifyItemTiers } from '../src/workers/classification/tier-classifier.ts';
import { detectSecretFindingKinds } from '../src/workers/classification/engine.ts';
import { scanDropboxContentPolicyText } from '../src/workers/dropbox-files/content-policy.ts';

const join = (...parts: string[]): string => parts.join('');
const B36 = 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
const B24 = 'k9Xp2LmQ7vRt4WzY8bNc3HdF';

const GITHUB = {
  ghp: join('gh', 'p_', B36),
  gho: join('gh', 'o_', B36),
  ghu: join('gh', 'u_', B36),
  ghs: join('gh', 's_', B36),
  ghr: join('gh', 'r_', B36),
  pat: join('github', '_pat_', '11ABCDEFG0aBcDeFgHiJkL_', 'mNoPqRsTuVwXyZ0123456789aBcDeFgHiJkLmNoPq'),
};
const STRIPE_SK = join('sk', '_live_', B24);
const STRIPE_RK = join('rk', '_live_', B24);
const GOOGLE_API_KEY = join('AI', 'za', 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q');
const GOOGLE_CLIENT_SECRET = join('GOC', 'SPX-', 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9v');
const GOOGLE_REFRESH = join('1/', '/0', 'gAbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdEfGhIjKlMnOpQrStUvWx');
const GOOGLE_ACCESS = join('ya', '29.', 'a0AfH6SMBq1w2e3r4t5y6u7i8o9p0');
const ANTHROPIC = join('sk', '-ant-', 'api03-', 'Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv1Wx2Yz3');
const B64_64 = 'k9Xp2LmQ7vRt4WzY8bNc3HdFa1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0';
const AZURE_STORAGE = join(
  'DefaultEndpointsProtocol=https;AccountName=mystorage;Account', 'Key=', B64_64, '==', ';EndpointSuffix=core.windows.net',
);
const AZURE_BUS = join(
  'Endpoint=sb://ns.servicebus.windows.net/;SharedAccessKeyName=RootManageSharedAccessKey;Shared', 'AccessKey=', B64_64.slice(0, 43), '=',
);
const AZURE_SAS = join(
  'https://mystorage.blob.core.windows.net/files/report.pdf?sv=2022-11-02&ss=b&srt=co&sp=r&se=2026-12-31T00:00:00Z&spr=https&si', 'g=',
  'k9Xp2LmQ7vRt4WzY8bNc3HdF%2Ba1B2c3D4e5F6g7H8i9J0%3D',
);

const POSITIVES: Array<[string, string]> = [
  // Environment-style assignments: the keyword is the END of the key name.
  ['DB_PASSWORD env', 'DB_PASSWORD=hunter2hunter2hunter2'],
  ['STRIPE_API_KEY env', `STRIPE_API_KEY=${STRIPE_SK}`],
  ['GITHUB_TOKEN env', `GITHUB_TOKEN=${GITHUB.ghp}`],
  ['*_SECRET env', 'JWT_SECRET=4f9a2c7e1b8d3a6f5e0c9b7a'],
  ['export with quotes', `export OPENAI_API_KEY="${ANTHROPIC}"`],
  ['AWS secret access key', 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'],
  ['camelCase key', 'const config = { clientSecret: "n3v3rR3al-secretValue" }'],
  ['HTTP header key', 'x-api-key: 8c1f3a9d5e7b2c4a6d8f0e1b3a5c7d9e'],
  ['CLI flag', 'mytool login --password=Tr0ub4dor3xyz987'],
  // JSON / YAML quoted keys.
  ['JSON client_secret', `{"client_secret": "${GOOGLE_CLIENT_SECRET}"}`],
  ['JSON password', '{"user": "me", "password": "correcthorsebatterystaple"}'],
  ['JSON password with spaces', '"password": "correct horse battery staple"'],
  ['JSON refresh_token', `{"refresh_token": "${GOOGLE_REFRESH}"}`],
  ['JSON access_token', '{"access_token":"ya29.not-a-real-token-but-long-enough"}'],
  ['YAML password', 'database:\n  password: s3cr3tValue99\n  host: db'],
  ['YAML api_key', 'api_key: abcdef123456ghijkl'],
  ['spaced keyword', 'Access Token = 7f3d9a1c5b8e2d4f6a0c'],
  ['bare secret with credential shape', 'secret: 4f9a2c7e1b8d3a6f5e0c9b7a'],
  ['bare token with credential shape', 'token: 4f9a2c7e1b8d3a6f5e0c9b7a'],
  // Labelled passphrases with spaces.
  ['Password with spaces', 'Password: correct horse battery staple'],
  ['wifi password with spaces', 'Wi-Fi password: purple monkey dishwasher 99'],
  ['markdown bold label', '**Password:** correct horse battery staple'],
  ['password on the next line', 'Your password:\nTr0ub4dor&3xample'],
  ['password that starts with my-', 'password: my-monkey-1234'],
  ['short password with shape', 'Password: P@ssw0rd1'],
  // Provider tokens with no keyword at all.
  ['GitHub ghp_', `see ${GITHUB.ghp} for the bot`],
  ['GitHub gho_', GITHUB.gho],
  ['GitHub ghu_', GITHUB.ghu],
  ['GitHub ghs_', GITHUB.ghs],
  ['GitHub ghr_', GITHUB.ghr],
  ['GitHub fine-grained', GITHUB.pat],
  ['Stripe sk_live_', `charge with ${STRIPE_SK}`],
  ['Stripe rk_live_', STRIPE_RK],
  ['Google API key', `key=${GOOGLE_API_KEY}`],
  ['Google OAuth client secret', GOOGLE_CLIENT_SECRET],
  ['Google refresh token', GOOGLE_REFRESH],
  ['Google access token', GOOGLE_ACCESS],
  ['Anthropic key', `claude uses ${ANTHROPIC}`],
  // The shapes the floor already had.
  ['AWS access key id', join('AK', 'IA', 'ABCDEFGHIJKLMNOP')],
  ['private key header', join('-----BEGIN OPENSSH ', 'PRIVATE KEY-----')],
  ['Slack token', join('xo', 'xb-', '1234567890-abcdefghijklmnop')],
  // Connection strings and headers.
  ['URL with password', 'postgres://admin:Xk29fjQ81z@db.internal:5432/app'],
  ['Authorization Bearer', 'curl -H "Authorization: Bearer 8c1f3a9d5e7b2c4a6d8f0e1b3a5c7d9e"'],
  // Values the first draft of the filters threw away (the old floor caught both).
  ['password with a leading @', 'password=@Moonlight927!'],
  ['password as a dotted passphrase', 'password=correct.horse.battery.staple'],
  ['env password as a dotted passphrase', 'DB_PASSWORD=correct.horse.battery.staple'],
  // Short passwords and passphrases.
  ['short env password', 'DB_PASSWORD=H8!tQ2v'],
  ['bare-word password', 'password=pancakes'],
  ['bare-word password in YAML', 'database:\n  password: pancakes\n  host: db'],
  ['export with a short quoted password', "export DB_PASSWORD='H8!tQ2v'"],
  ['PWD key', 'export DB_PWD=Tr0ub4d'],
  ['PASSWD key', 'LDAP_PASSWD=Tr0ub4dor'],
  ['SECRET key, short value', 'APP_SECRET=pancake9'],
  ['TOKEN key, short value', 'SERVICE_TOKEN=abc123xy'],
  ['ADO.NET Pwd', 'Server=db;User Id=app;Pwd=Tr0ub4dor;Encrypt=true'],
  ['Java properties password', 'spring.datasource.password=pancakes'],
  ['JSON password with ordinary words', '{"password": "the horse rides at midnight"}'],
  ['JSON passphrase with ordinary words', '{"passphrase": "I am the walrus and you are not"}'],
  ['JSON secret with words', '{"secret": "my grandmother sings at dawn"}'],
  ['credential word inside a passphrase', '{"passphrase": "the secret garden gate"}'],
  ['labelled passphrase with a trailing note', 'Password: pancakes (netflix)'],
  ['short labelled password', 'Password: hunter2'],
  ['YAML quoted password', 'password: "letmein99"'],
  ['TOML passphrase with words', 'passphrase = "orange blue tiger"'],
  ['quoted bare word', 'secret = "pancakes"'],
  ['labelled passphrase with ordinary words', 'Password: the horse rides at midnight'],
  ['labelled bold passphrase with ordinary words', '**Password:** the horse rides at midnight'],
  // YAML block scalars hide the value on the next line.
  ['block scalar |-', 'password: |-\n  s3cr3t-value-9'],
  ['block scalar |', 'password: |\n  hunter2hunter2'],
  ['block scalar >', 'password: >\n  pancakes-pancakes'],
  ['block scalar >-', 'password: >-\n  Tr0ub4dor&3'],
  ['block scalar |+', 'password: |+\n  Tr0ub4dor&3\n'],
  ['block scalar with a comment', 'password: | # keep out\n  Tr0ub4dor&3'],
  ['block scalar, nested key', 'database:\n  db_password: |-\n    Tr0ub4dor&3\n  host: db'],
  ['block scalar passphrase with words', 'passphrase: |-\n  the horse rides at midnight'],
  ['block scalar after a blank line', 'client_secret: |\n\n  4f9a2c7e1b8d3a6f5e0c9b7a'],
  ['block scalar, CRLF', 'password: |-\r\n  s3cr3t-value-9\r\n'],
  // Azure.
  ['Azure storage connection string', AZURE_STORAGE],
  ['Azure Service Bus connection string', AZURE_BUS],
  ['Azure SAS signature', AZURE_SAS],
  ['Azure AccountKey on its own line', join('Account', 'Key=', B64_64, '==')],
  ['Azure SAS in an escaped URL', join('https://acct.blob.core.windows.net/c?sp=r&amp;si', 'g=', 'k9Xp2LmQ7vRt4WzY8bNc3HdF%2Ba1B2c3D4e5F6g7H8i9J0%3D')],
];

/**
 * Strings the previous floor (origin/main) already classed as Secrets that the
 * first draft of the shared patterns started letting through. They stay
 * Secrets: the new floor is a superset of the old one. Several are plainly
 * placeholders or code, and the old floor never told those apart either.
 */
const OLD_FLOOR_KEPT: Array<[string, string]> = [
  ['mask of 20 stars', 'password: ********************'],
  ['YOUR_API_KEY', 'export API_KEY=YOUR_API_KEY'],
  ['my_api_key placeholder', 'api_key=my_api_key_value'],
  ['example literal', 'api_key=example_api_key_value'],
  ['process.env', 'const password = process.env.DB_PASSWORD_VALUE;'],
  ['function call', 'const password = getPasswordFromVault(request);'],
  ['property chain', 'password: user.password'],
  ['type annotation', 'password: Optional[str] = None'],
  ['field name value', 'password: password_confirmation'],
  ['path value', 'password: /run/secrets/db_password'],
  ['python format', 'password: %(password_value)s'],
];

const NEGATIVES: Array<[string, string]> = [
  // Prose mentioning credentials.
  ['reset prose', 'To continue, reset your password at the link below.'],
  ['rotate prose', 'Remember to rotate your API key every 90 days.'],
  ['token prose', 'The token ring network passes a token between hosts in turn.'],
  ['secret prose', 'Secret: the recipe lives in the red cookbook on the second shelf.'],
  ['password prose label', 'Password: please enter your password to sign in'],
  ['password rules', 'Password: minimum 8 characters, at least one number'],
  ['password required', 'Password: required'],
  ['hint prose', 'Your password was changed on Tuesday; contact support if that was not you.'],
  ['token explanation', 'Token: the system issues a token for each session'],
  // Empty and masked values.
  ['password nothing after', 'password: '],
  ['password nothing, end', 'Password:'],
  ['empty quotes', 'password: ""'],
  ['short quoted', '"password": "abc"'],
  ['empty JSON value', '{"api_key": "", "client_secret": ""}'],
  ['x mask', 'API_TOKEN=xxxxxxxxxxxxxxxxxxxx'],
  ['dot elision', 'GITHUB_TOKEN=ghp_abc...wxyz1234'],
  // Documentation placeholders.
  ['your-api-key-here', '{"api_key": "your-api-key-here"}'],
  ['angle placeholder', 'api_key: <token>'],
  ['angle long placeholder', 'client_secret = <your client secret goes here>'],
  ['env var placeholder', 'SECRET=${SECRET_FROM_VAULT}'],
  ['shell variable', 'GITHUB_TOKEN=$GITHUB_TOKEN_VALUE'],
  ['template placeholder', 'API_KEY={{ secrets.API_KEY_VALUE }}'],
  ['os.environ', 'token = os.environ["SERVICE_API_TOKEN"]'],
  ['os.getenv call', 'password = os.getenv("DB_PASSWORD_VALUE")'],
  ['Django call', 'token = models.CharField(max_length=40)'],
  ['GitHub Actions secret', 'with:\n  token: ${{ secrets.DEPLOY_PAT }}'],
  ['TypeScript type', 'apiKey: string | undefined;'],
  ['token field name', 'token: access-token-header'],
  ['url value', 'token: https://auth.example.com/oauth/token'],
  ['stripe placeholder', 'STRIPE_API_KEY=sk_live_YOUR_KEY_HERE'],
  ['masked github token', join('gh', 'p_', 'x'.repeat(36))],
  ['masked stripe key', join('sk', '_live_', 'x'.repeat(24))],
  ['Authorization placeholder', 'Authorization: Bearer <token>'],
  ['Authorization env', 'Authorization: Bearer $ACCESS_TOKEN_VALUE'],
  ['url placeholder password', 'postgres://user:password@localhost:5432/app'],
  ['url placeholder variable', 'postgres://admin:${DB_PASSWORD}@db/app'],
  // Keys that merely contain the word.
  ['password_hash key', 'password_hash: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b'],
  ['max_tokens', 'max_tokens: 4096000000000'],
  ['token_type', 'token_type: authentication'],
  ['page token', 'nextPageToken: CAEQAxjBt7eeqeSLhgM4oMAmQg1'],
  ['csrf token', 'csrf_token: 3f8a2b1c9d7e6f5a4b3c2d1e'],
  ['query string token', 'Open https://news.example.org/view?token=8f14e45fceea167a5a36dedd4bea2543 in your browser'],
  ['bare secret all letters', 'secret: authentication-provider'],
  ['bare token all letters', 'token: authentication'],
  // Code assigning one identifier to another is not a credential.
  ['const to identifier', 'const sessionToken = authenticationToken;'],
  ['let to identifier', 'let refreshedToken = previousRefreshToken;'],
  ['member to identifier', 'this.sessionToken = authenticationToken;'],
  ['keyword argument', 'login(password=pwValue)'],
  // Env-style keys that only mention a credential word.
  ['MAX_TOKENS', 'MAX_TOKENS=128000'],
  ['TOKEN_TYPE', 'TOKEN_TYPE=Bearer'],
  ['PWD is the working directory', 'PWD=/Users/me/Code/Olympus'],
  ['PASSWORD_FILE', 'PASSWORD_FILE=/run/secrets/db_password'],
  ['TOKENIZERS_PARALLELISM', 'TOKENIZERS_PARALLELISM=false'],
  ['PASSWORD_MIN_LENGTH', 'PASSWORD_MIN_LENGTH=12345678'],
  // Prose labels and headings.
  ['password heading', 'Password: security guidelines'],
  ['UI label', '"password": "Enter your password"'],
  ['UI label, forgot', '{"forgotPassword": "Forgot password?"}'],
  ['UI label, confirm', '{"confirmPassword": "Confirm password"}'],
  ['password rules in JSON', '{"password": "Password must be at least 8 characters"}'],
  // Block scalars that hold a placeholder, a comment or nothing.
  ['block scalar placeholder', 'password: |-\n  ${DB_PASSWORD}'],
  ['block scalar redacted', 'password: |\n  <redacted>'],
  ['block scalar not indented', 'password: |\nnext_key: s3cr3t-value-here'],
  ['block scalar comment', 'password: |\n  # set this in the vault'],
  ['block scalar empty', 'password: |-\n'],
  ['block scalar mask', 'password: >-\n  ********'],
  // Azure shapes without a key.
  ['Azure AccountKey placeholder', 'AccountName=mystorage;AccountKey=<your account key>'],
  ['Azure AccountKey short', 'AccountKey=abc123'],
  ['Azure AccountKey masked', `AccountKey=${'x'.repeat(88)}`],
  ['Azure AccountKey variable', 'AccountKey=${STORAGE_KEY}'],
  ['sig short', 'https://example.com/share?sig=abc123'],
  ['sig not a query parameter', 'the sig=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa was in the text'],
];

// Placeholders and masks that must never count, whatever key they sit under.
const PLACEHOLDER_VALUES = [
  '<password>', '${DB_PASSWORD}', '$DB_PASSWORD', '$db_password', '%DB_PASSWORD%', '{{ db_password }}', '{{DB_PASSWORD}}',
  '********', 'xxxxxxxx', '........', 'changeme', 'password', 'your_password', 'example', 'REDACTED',
  'null', 'none', 'true', 'false', 'NULL', 'None', 'True', 'False',
];

describe('Secrets floor: credential shapes the detector must catch', () => {
  for (const [name, text] of POSITIVES) {
    test(name, () => {
      expect(scanDropboxContentPolicyText({ text }).policy_decision).toBe('blocked_sensitive');
      expect(detectSecretFindingKinds(text).length).toBeGreaterThan(0);
    });
  }

  test('new shapes reuse the stored finding types', () => {
    const stored = new Set([
      'private_key_material',
      'aws_access_key_id',
      'slack_token',
      'api_secret_token',
      'credential_assignment',
    ]);
    for (const [, text] of POSITIVES) {
      for (const kind of detectSecretFindingKinds(text)) expect(stored.has(kind)).toBe(true);
    }
    expect(detectSecretFindingKinds('DB_PASSWORD=hunter2hunter2hunter2')).toEqual(['credential_assignment']);
    expect(detectSecretFindingKinds(GITHUB.ghp)).toEqual(['api_secret_token']);
    expect(detectSecretFindingKinds(ANTHROPIC)).toEqual(['api_secret_token']);
  });

  test('a match is hashed, never stored as text', () => {
    const scan = scanDropboxContentPolicyText({ text: 'DB_PASSWORD=hunter2hunter2hunter2' });
    expect(JSON.stringify(scan)).not.toContain('hunter2');
    expect(scan.findings[0]?.finding_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('a credential inside a long document is still found', () => {
    const filler = 'The quarterly planning notes cover hiring, budget and the garden plan. '.repeat(200);
    const text = `${filler}\nservice config\nDB_PASSWORD=hunter2hunter2hunter2\n${filler}`;
    expect(detectSecretFindingKinds(text)).toEqual(['credential_assignment']);
  });
});

describe('Secrets floor: words about credentials are not credentials', () => {
  for (const [name, text] of NEGATIVES) {
    test(name, () => {
      expect(scanDropboxContentPolicyText({ text }).policy_decision).not.toBe('blocked_sensitive');
      expect(detectSecretFindingKinds(text)).toEqual([]);
    });
  }

  test('ordinary documents stay clear', () => {
    const doc = [
      'Meeting notes: we agreed the password policy needs a review, and that every API key',
      'should be rotated. The access token flow is described in the wiki. Ask the admin to',
      'reset the client secret in the console. Tokens expire after an hour.',
    ].join('\n');
    expect(detectSecretFindingKinds(doc)).toEqual([]);
  });
});

describe('Outbound guard shares the floor', () => {
  for (const [name, text] of POSITIVES) {
    test(`flags ${name}`, () => {
      expect(secretLabelsInText(text).length).toBeGreaterThan(0);
    });
  }

  test('keeps its own shapes', () => {
    expect(secretLabelsInText('OAuth refresh_token=ya29.a0AfH6SMBprivateTokenValue')).toContain('oauth_refresh_token');
    expect(secretLabelsInText('password: abcdefgh')).toContain('password');
  });

  for (const [name, text] of NEGATIVES) {
    test(`shared patterns clear ${name}`, () => {
      expect(SHARED_SECRET_PATTERNS.some((spec) => hasSecretPatternHit(text, spec))).toBe(false);
    });
  }

  test('prose is not flagged', () => {
    expect(secretLabelsInText('Remember to rotate your API key every 90 days.')).toEqual([]);
    expect(secretLabelsInText('The school visit is May 8, 2026 at 9:30 AM.')).toEqual([]);
  });
});

describe('the classifier sends these items to Secrets', () => {
  for (const text of [
    'DB_PASSWORD=hunter2hunter2hunter2',
    '{"client_secret": "' + GOOGLE_CLIENT_SECRET + '"}',
    'Password: correct horse battery staple',
    GITHUB.ghp,
  ]) {
    test(text.slice(0, 24), () => {
      const decision = classifyItemTiers(
        { signals: { title: 'Notes' }, provider: 'fixture', text },
        {},
      );
      expect(decision.contentTier).toBe('secrets');
      expect(decision.decidedBy).toBe('secret_detector');
    });
  }

  test('a note that only talks about passwords stays out of Secrets', () => {
    const decision = classifyItemTiers(
      { signals: { title: 'Notes' }, provider: 'fixture', text: 'Remember to reset your password at the link below.' },
      {},
    );
    expect(decision.contentTier).not.toBe('secrets');
  });
});

// --- The floor never loses what the previous floor caught -------------------

// Verbatim from origin/main (src/workers/dropbox-files/content-policy.ts before
// the shared patterns). Every string any of these matches must still be
// Secrets: widening the floor may add shapes, never drop one.
const OLD_FLOOR: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\b(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password)\b\s*[:=]\s*['"]?[^'"\s]{12,}/gi,
];

function oldFloorFlags(text: string): boolean {
  return OLD_FLOOR.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

function newFloorFlags(text: string): boolean {
  return scanDropboxContentPolicyText({ text }).policy_decision === 'blocked_sensitive';
}

describe('Secrets floor: a superset of the previous floor', () => {
  const corpus = [...POSITIVES, ...NEGATIVES, ...OLD_FLOOR_KEPT];

  test('every string the old floor matched in the corpus is still Secrets', () => {
    const lost = corpus.filter(([, text]) => oldFloorFlags(text) && !newFloorFlags(text)).map(([name]) => name);
    expect(lost).toEqual([]);
  });

  test('the corpus entries kept for the old floor really are old-floor hits', () => {
    for (const [name, text] of OLD_FLOOR_KEPT) {
      expect([name, oldFloorFlags(text)]).toEqual([name, true]);
      expect([name, newFloorFlags(text)]).toEqual([name, true]);
    }
  });

  test('a negative never hides an old-floor hit', () => {
    for (const [name, text] of NEGATIVES) expect([name, oldFloorFlags(text)]).toEqual([name, false]);
  });

  test('every old assignment shape x separator x value stays Secrets', () => {
    const keywords = [
      'api key', 'api_key', 'api-key', 'apikey', 'API_KEY', 'Api Key',
      'access token', 'access_token', 'access-token', 'accesstoken', 'ACCESS_TOKEN',
      'refresh token', 'refresh_token', 'refreshtoken',
      'client secret', 'client_secret', 'clientsecret', 'CLIENT_SECRET',
      'password', 'Password', 'PASSWORD',
    ];
    const separators = [': ', ':', '=', ' = ', ' : ', '= "', ': \'', ':\n  ', '=\t', '="'];
    const values = [
      '@Moonlight927!', 'correct.horse.battery.staple', 'user.passwordValue', '********************',
      'xxxxxxxxxxxxxxxx', '${SOME_VARIABLE_X}', '<your-token-here>', 'process.env.DB_PASSWORD_VALUE',
      'https://auth.example.com/x', '/run/secrets/db_password', 'YOUR_API_KEY_HERE', 'changeme-changeme',
      'getPasswordFromVault(request)', 'authentication-provider', 'abcdefghijkl', '12345678901234',
      '%(password_value)s', 'Optional[str]', 'password_confirmation', 'null,null,null,null', '$HOME/.secret/pw',
      '(hidden-by-admin)', '{{secrets.PW_VALUE}}', 'example_api_key_value', '....................',
    ];
    const lost: string[] = [];
    let checked = 0;
    for (const keyword of keywords) {
      for (const separator of separators) {
        for (const value of values) {
          const text = `${keyword}${separator}${value}`;
          if (!oldFloorFlags(text)) continue;
          checked += 1;
          if (!newFloorFlags(text)) lost.push(text);
        }
      }
    }
    expect(lost).toEqual([]);
    expect(checked).toBeGreaterThan(1000);
  });

  test('the old non-assignment shapes are unchanged', () => {
    for (const text of [
      join('-----BEGIN RSA ', 'PRIVATE KEY-----'),
      join('-----BEGIN ', 'PRIVATE KEY-----'),
      join('-----BEGIN ENCRYPTED ', 'PRIVATE KEY-----'),
      join('AK', 'IA', 'ABCDEFGHIJKLMNOP'),
      join('xo', 'xp-', '1234567890-abcdefghijklmnop'),
      join('xo', 'xs-', 'abcdefghijklmnopqrstuvwxyz'),
      join('s', 'k-', 'abcdefghijklmnopqrstuvwxyz'),
      join('s', 'k-', 'proj-abcdefghij_klmnopqrstuvwxyz'),
    ]) {
      expect([text.length, oldFloorFlags(text), newFloorFlags(text)]).toEqual([text.length, true, true]);
    }
  });
});

describe('Secrets floor: placeholders stay out under every key shape', () => {
  for (const placeholder of PLACEHOLDER_VALUES) {
    test(`env-style ${placeholder}`, () => {
      for (const text of [
        `DB_PASSWORD=${placeholder}`,
        `export DB_PASSWORD=${placeholder}`,
        `DB_PASSWORD="${placeholder}"`,
        `API_TOKEN=${placeholder}`,
        `APP_SECRET='${placeholder}'`,
        `{"password": "${placeholder}"}`,
        `{"client_secret": "${placeholder}"}`,
        `passphrase = "${placeholder}"`,
        `password: |-\n  ${placeholder}`,
      ]) {
        expect([text, newFloorFlags(text)]).toEqual([text, false]);
        expect([text, SHARED_SECRET_PATTERNS.some((spec) => hasSecretPatternHit(text, spec))]).toEqual([text, false]);
      }
    });
    if (placeholder.split(/\s+/)[0]!.length < 12) {
      test(`plain ${placeholder}`, () => {
        for (const text of [`db:\n  password: ${placeholder}`, `Password: ${placeholder}`, `password = ${placeholder}`]) {
          expect([text, newFloorFlags(text)]).toEqual([text, false]);
        }
      });
    }
  }

  test('an empty value is never a credential', () => {
    for (const text of ['DB_PASSWORD=', 'DB_PASSWORD=\nHOST=db', 'DB_PASSWORD=""', "DB_PASSWORD=''", 'password:\n', '{"password": ""}']) {
      expect([text, newFloorFlags(text)]).toEqual([text, false]);
    }
  });
});

describe('Secrets floor: linear-time on adversarial input', () => {
  const N = 200_000;
  const cases: Array<[string, string]> = [
    ['closing-bracket run after a value', `password=a${')'.repeat(N)}z`],
    ['dot run after a value', `password=a${'.'.repeat(N)}z`],
    ['mixed trailing punctuation', `password=a${';,)]}.'.repeat(N / 6)}z`],
    ['comma run', `DB_PASSWORD=a${','.repeat(N)}z`],
    ['equals run', '='.repeat(N)],
    ['letter then equals run', `a${'='.repeat(N)}`],
    ['keyword then equals run', `password${'='.repeat(N)}`],
    ['colon run', ':'.repeat(N)],
    ['keyword then colon run', `token${':'.repeat(N)}`],
    ['keyword then spaces', `password${' '.repeat(N)}z`],
    ['keyword colon then spaces', `password:${' '.repeat(N)}z`],
    ['keyword colon then newlines', `password:${'\n'.repeat(N)}z`],
    ['repeated keyword colon', 'password:'.repeat(N / 9)],
    ['repeated keyword equals space', 'password= '.repeat(N / 10)],
    ['repeated keyword', 'password'.repeat(N / 8)],
    ['repeated env key', 'DB_PASSWORD'.repeat(N / 11)],
    ['repeated token key then equals', `${'TOKEN'.repeat(N / 5)}=`],
    ['repeated quoted token', 'token:"'.repeat(N / 7)],
    ['unclosed quote after keyword', `password: "${'a'.repeat(N)}`],
    ['backslash run in a quote', `password: "${'\\'.repeat(N)}`],
    ['word run', 'correct horse battery staple '.repeat(N / 29)],
    ['word run after a label', `Password: ${'horse '.repeat(N / 6)}`],
    ['single long word', 'a'.repeat(N)],
    ['hyphen word', `${'a-'.repeat(N / 2)}!`],
    ['underscore identifier then bang', `password: ${'a_'.repeat(N / 2)}!`],
    ['dotted identifier then bang', `password: ${'a.'.repeat(N / 2)}!`],
    ['line of dashes and spaces', `${'- '.repeat(N / 2)}password: x`],
    ['block scalar header, many blank lines', `password: |\n${' \n'.repeat(N / 2)}`],
    ['block scalar header repeated', 'password: |\n'.repeat(N / 12)],
    ['block scalar with a long first line', `password: |\n  ${'a'.repeat(N)}`],
    ['AccountKey repeated', 'AccountKey='.repeat(N / 11)],
    ['AccountKey then a long base64 run', `AccountKey=${'A'.repeat(N)}`],
    ['sig repeated', '?sig='.repeat(N / 5)],
    ['sig then a long run', `?sig=${'a'.repeat(N)}`],
    ['url userinfo run', `postgres://a:${'b'.repeat(N)}`],
    ['scheme repeated', 'x://a:'.repeat(N / 6)],
    ['angle run', `password: ${'<'.repeat(N)}`],
    ['paren run', `password: (${'('.repeat(N)}`],
    ['dollar run', `password: ${'$'.repeat(N)}`],
    ['Authorization run', `Authorization: Bearer ${'a'.repeat(N)}`],
    ['many short pairs', 'a=b '.repeat(N / 4)],
    ['many short credential pairs', 'DB_PASSWORD=x '.repeat(N / 14)],
  ];
  for (const [name, text] of cases) {
    test(name, () => {
      const started = performance.now();
      scanDropboxContentPolicyText({ text });
      secretLabelsInText(text);
      const elapsed = performance.now() - started;
      expect([name, elapsed < 1000]).toEqual([name, true]);
    });
  }
});
