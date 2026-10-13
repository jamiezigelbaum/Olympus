// The deterministic Secrets floor: what counts as a credential and what is only
// a word about one.
//
// The floor (`SHARED_SECRET_PATTERNS`, read by scanDropboxContentPolicyText and
// by the outbound guard in src/core/opsec.ts) is the only thing that classes an
// item as Secrets, and Personal content can reach cloud models by design, so a
// miss leaks a credential. These tests pin both sides: the shapes that must be
// caught, and the prose, placeholders and masks that must not be.
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
  ['private key header', '-----BEGIN OPENSSH PRIVATE KEY-----'],
  ['Slack token', join('xo', 'xb-', '1234567890-abcdefghijklmnop')],
  // Connection strings and headers.
  ['URL with password', 'postgres://admin:Xk29fjQ81z@db.internal:5432/app'],
  ['Authorization Bearer', 'curl -H "Authorization: Bearer 8c1f3a9d5e7b2c4a6d8f0e1b3a5c7d9e"'],
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
  ['star mask', 'password: ********************'],
  ['x mask', 'API_TOKEN=xxxxxxxxxxxxxxxxxxxx'],
  ['dot elision', 'GITHUB_TOKEN=ghp_abc...wxyz1234'],
  // Documentation placeholders.
  ['YOUR_API_KEY', 'export API_KEY=YOUR_API_KEY'],
  ['my_api_key placeholder', 'api_key=my_api_key_value'],
  ['your-api-key-here', '{"api_key": "your-api-key-here"}'],
  ['angle placeholder', 'api_key: <token>'],
  ['angle long placeholder', 'client_secret = <your client secret goes here>'],
  ['env var placeholder', 'SECRET=${SECRET_FROM_VAULT}'],
  ['shell variable', 'GITHUB_TOKEN=$GITHUB_TOKEN_VALUE'],
  ['template placeholder', 'API_KEY={{ secrets.API_KEY_VALUE }}'],
  ['python format', 'password: %(password_value)s'],
  ['process.env', 'const password = process.env.DB_PASSWORD_VALUE;'],
  ['os.environ', 'token = os.environ["SERVICE_API_TOKEN"]'],
  ['os.getenv call', 'password = os.getenv("DB_PASSWORD_VALUE")'],
  ['function call', 'const password = getPasswordFromVault(request);'],
  ['property chain', 'password: user.password'],
  ['type annotation', 'password: Optional[str] = None'],
  ['Django call', 'token = models.CharField(max_length=40)'],
  ['GitHub Actions secret', 'with:\n  token: ${{ secrets.DEPLOY_PAT }}'],
  ['TypeScript type', 'apiKey: string | undefined;'],
  ['field name value', 'password: password_confirmation'],
  ['token field name', 'token: access-token-header'],
  ['path value', 'password: /run/secrets/db_password'],
  ['url value', 'token: https://auth.example.com/oauth/token'],
  ['example literal', 'api_key=example_api_key_value'],
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
