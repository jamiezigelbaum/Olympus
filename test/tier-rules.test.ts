// Owner tier rules and per-item overrides (design section 2.4), and the
// `olympus tier` CLI: the rules file (0600, validated like the sensitivity
// map), the @domain boundary sender matcher, rule precedence, stickiness
// across re-syncs, the installed inputs reaching a lane that passes none, and
// set / explain / rules / classifier.

import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import type { RawItem, SourceConnector, SourceConnectorListPage } from '../src/core/contracts.ts';
import { USER_FACING_TIER_MAPPING } from '../src/core/sensitivity-map.ts';
import { senderMatchesRule } from '../src/core/sender-rules.ts';
import {
  clearInstalledTierClassification,
  configureInstalledTierClassification,
} from '../src/workers/classification/installed-tier-classification.ts';
import { runTierCommand } from '../src/workers/classification/tier-cli.ts';
import { classifyItemTiers, type OwnerTierRule } from '../src/workers/classification/tier-classifier.ts';
import {
  addOwnerTierRule,
  loadOwnerTierRules,
  parseOwnerTierRules,
  removeOwnerTierRule,
  tierKeyFromDisplayName,
  validateTierRulesFile,
} from '../src/workers/classification/tier-rules.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { resolveStoreTierClassification } from '../src/workers/connector-store/tier-placement.ts';
import { writeConnectedHandleRegistry } from '../src/workers/credential-broker/connected-handles.ts';
import {
  approveMailSourceScope,
  defaultMailScopeSelection,
  defaultMailSourceScopeStatePath,
  readMailSourceScopeApproval,
} from '../src/core/mail-source-scope.ts';

const FAKE_AWS_KEY = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
const HEALTH = 'The lab results confirm the diagnosis; the patient starts treatment.';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-tier-rules-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  clearInstalledTierClassification();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function rulesFile(dir: string, rules: unknown[]): string {
  const path = join(dir, 'tier-rules.json');
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, rules }));
  return path;
}

describe('the rules file', () => {
  test('validates like the sensitivity map and tightens a readable file to 0600', () => {
    const dir = tempDir();
    const path = rulesFile(dir, [
      { id: 'published', match: { pathPrefix: '/work/published' }, tier: 'public', strength: 'prior' },
      { id: 'clinic', source: 'fixture-mail', match: { sender: '@clinic.example' }, tier: 'secure', strength: 'force' },
    ]);
    chmodSync(path, 0o644);
    const result = validateTierRulesFile({ path });
    expect(result).toMatchObject({ ok: true, rules: 2, ruleIds: ['published', 'clinic'], permissionsTightened: true, permissions: '0600' });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(loadOwnerTierRules({ path })[1]).toEqual({
      id: 'clinic', source: 'fixture-mail', match: { kind: 'sender', value: '@clinic.example' }, tier: 'secure', strength: 'force',
    });
  });

  test('refuses malformed rules instead of dropping them', () => {
    const bad = [
      [{ id: 'a', match: { pathPrefix: '/x', label: 'y' }, tier: 'public' }],
      [{ id: 'a', match: { sender: 'not an address' }, tier: 'secure' }],
      [{ id: 'a', match: { label: 'x' }, tier: 'personal' }],
      [{ id: 'a', match: { label: 'x' }, tier: 'secure', extra: true }],
      [{ id: 'a', match: { label: 'x' }, tier: 'secure' }, { id: 'a', match: { label: 'y' }, tier: 'secure' }],
      [{ id: 'Bad Id', match: { label: 'x' }, tier: 'secure' }],
    ];
    for (const rules of bad) expect(() => parseOwnerTierRules({ schemaVersion: 1, rules })).toThrow();
    expect(() => parseOwnerTierRules({ schemaVersion: 2, rules: [] })).toThrow();
    expect(loadOwnerTierRules({ path: join(tempDir(), 'missing.json'), allowMissing: true })).toEqual([]);
  });

  test('add and remove write an owner-only file the loader accepts', () => {
    const path = join(tempDir(), 'nested', 'tier-rules.json');
    addOwnerTierRule({ id: 'family', match: { kind: 'chat', value: 'chat:family' }, tier: 'secure', strength: 'prior' }, { path });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(() => addOwnerTierRule({ id: 'family', match: { kind: 'label', value: 'x' }, tier: 'secure', strength: 'prior' }, { path })).toThrow();
    expect(loadOwnerTierRules({ path })).toHaveLength(1);
    expect(removeOwnerTierRule('family', { path }).removed).toBe(true);
    expect(loadOwnerTierRules({ path })).toEqual([]);
  });

  test('CLI tier words are display names; the file keeps schema-v1 keys', () => {
    expect(tierKeyFromDisplayName('Personal')).toBe('private');
    expect(tierKeyFromDisplayName('private')).toBe('secure');
    expect(tierKeyFromDisplayName('public')).toBe('public');
    expect(tierKeyFromDisplayName('secrets')).toBe('secrets');
    expect(tierKeyFromDisplayName('internal')).toBeUndefined();
    expect(USER_FACING_TIER_MAPPING.private.targetTrustDomain).toBe('internal');
  });
});

describe('sender rules match on a domain boundary', () => {
  test('@domain covers subdomains and never a lookalike', () => {
    expect(senderMatchesRule('Dr <dr@clinic.example>', '@clinic.example')).toBe(true);
    expect(senderMatchesRule('appointments@mail.clinic.example', '@clinic.example')).toBe(true);
    expect(senderMatchesRule('x@evil-clinic.example', '@clinic.example')).toBe(false);
    expect(senderMatchesRule('x@clinic.example.evil', '@clinic.example')).toBe(false);
    expect(senderMatchesRule('dr@clinic.example', 'dr@clinic.example')).toBe(true);
    expect(senderMatchesRule('other@clinic.example', 'dr@clinic.example')).toBe(false);
  });

  test('the classifier uses the boundary matcher for sender rules', () => {
    const rule: OwnerTierRule = { id: 'clinic', match: { kind: 'sender', value: '@clinic.example' }, tier: 'secure', strength: 'prior' };
    expect(classifyItemTiers({ signals: { sender: 'x@mail.clinic.example' }, text: 'hello' }, { rules: [rule] }).contentTier).toBe('secure');
    expect(classifyItemTiers({ signals: { sender: 'x@evil-clinic.example' }, text: 'hello' }, { rules: [rule] }).contentTier).toBe('private');
  });
});

describe('precedence', () => {
  const publicPrior: OwnerTierRule = { id: 'pub', match: { kind: 'pathPrefix', value: '/work/published' }, tier: 'public', strength: 'prior' };
  const publicForce: OwnerTierRule = { ...publicPrior, id: 'pubforce', strength: 'force' };

  test('a prior rule sets the resting tier; item-level raises still apply', () => {
    expect(classifyItemTiers({ signals: { path: '/work/published/launch.md' }, text: 'hello world' }, { rules: [publicPrior] }).contentTier).toBe('public');
    expect(classifyItemTiers({ signals: { path: '/work/published/x.md' }, text: HEALTH }, { rules: [publicPrior] }).contentTier).toBe('secure');
  });

  test('a force rule fixes the tier; only Secrets still raise it; an override beats it', () => {
    expect(classifyItemTiers({ signals: { path: '/work/published/x.md' }, text: HEALTH }, { rules: [publicForce] }).contentTier).toBe('public');
    expect(classifyItemTiers({ signals: { path: '/work/published/x.md' }, text: `key ${FAKE_AWS_KEY}` }, { rules: [publicForce] }).contentTier).toBe('secrets');
    expect(classifyItemTiers({ signals: { path: '/work/published/x.md' }, text: 'x' }, { rules: [publicForce], override: { kind: 'tier', tier: 'secure' } }).contentTier).toBe('secure');
  });

  test('a rule naming another source does not apply', () => {
    const scoped: OwnerTierRule = { ...publicPrior, source: 'other-provider' };
    expect(classifyItemTiers({ signals: { path: '/work/published/x.md' }, provider: 'fixture', text: 'x' }, { rules: [scoped] }).contentTier).toBe('private');
  });
});

describe('installed inputs, stickiness across re-sync, and the CLI', () => {
  function item(n: number, path: string, text: string): RawItem {
    return {
      identity: { family: 'file', provider: 'fixture', accountScope: 'personal', providerItemId: `file-${n}`, localItemId: `personal:file-${n}`, sourceVersion: 'v1' },
      mimeType: 'text/plain',
      content: { kind: 'text', text },
      metadata: { name: path.split('/').pop()!, pathDisplay: path, locatorUri: `fixture://files${path}` },
      fetchedAt: '2026-09-23T00:00:00.000Z',
    };
  }

  function connectorFor(items: readonly RawItem[]): SourceConnector {
    return {
      id: 'fixture',
      family: 'file',
      async authenticate() {},
      listItems(): AsyncIterable<SourceConnectorListPage> {
        return (async function* () { yield { items, done: true }; })();
      },
      async fetchItem(localItemId) {
        const found = items.find((entry) => entry.identity.localItemId === localItemId);
        if (!found) throw new Error('missing');
        return found;
      },
      classificationSignals(raw) {
        return { title: String(raw.metadata['name'] ?? ''), path: String(raw.metadata['pathDisplay'] ?? '') };
      },
    };
  }

  function setup() {
    const dir = tempDir();
    const env = {
      OLYMPUS_TIER_RULES_PATH: join(dir, 'tier-rules.json'),
      OLYMPUS_SENSITIVITY_MAP_PATH: join(dir, 'sensitivity-map.json'),
      OLYMPUS_CLASSIFICATION_LEDGER_PATH: join(dir, 'classification-ledger.jsonl'),
    };
    const dbPath = join(dir, 'store.sqlite');
    const store = new LocalConnectorStore({ dbPath, corpusId: 'internal.fixture.files', family: 'file', trustDomain: 'internal' });
    return { dir, env, dbPath, store };
  }

  test('a lane that passes no classification inputs records with the owner map and rules', async () => {
    const { env, store } = setup();
    try {
      writeFileSync(env.OLYMPUS_SENSITIVITY_MAP_PATH, JSON.stringify({
        schemaVersion: 2,
        userFacingTiers: USER_FACING_TIER_MAPPING,
        categories: [{
          id: 'garden-club',
          label: 'Garden club',
          targetTierName: 'secure',
          targetTrustTier: 'S4',
          targetTrustDomain: 'secure_local',
          examples: ['garden club minutes'],
          match: { keywords: ['zebracorn'], senderPatterns: [], pathPatterns: [] },
        }],
      }));
      rulesFile(join(env.OLYMPUS_TIER_RULES_PATH, '..'), [
        { id: 'published', match: { pathPrefix: '/work/published' }, tier: 'public', strength: 'prior' },
      ]);
      configureInstalledTierClassification({ env });
      await store.syncFromConnector(connectorFor([
        item(1, '/notes/minutes.txt', 'the zebracorn met on tuesday'),
        item(2, '/work/published/launch.txt', 'we launched'),
      ]), { fetchContent: true });
      const ledger = store.tierLedger()!;
      expect(ledger.getCurrent({ provider: 'fixture', accountScope: 'personal', providerItemId: 'file-1' })).toMatchObject({ contentTier: 'secure' });
      expect(ledger.getCurrent({ provider: 'fixture', accountScope: 'personal', providerItemId: 'file-1' })?.reasons).toContain('content:sensitivity_map:garden-club');
      expect(ledger.getCurrent({ provider: 'fixture', accountScope: 'personal', providerItemId: 'file-2' })).toMatchObject({ contentTier: 'public', decidedBy: 'owner_rule' });
    } finally {
      store.close();
    }
  });

  test('rules and overrides stick across re-syncs; an invalid rules file records nothing', async () => {
    const { env, dbPath, store } = setup();
    try {
      rulesFile(join(env.OLYMPUS_TIER_RULES_PATH, '..'), [
        { id: 'published', match: { pathPrefix: '/work/published' }, tier: 'public', strength: 'prior' },
      ]);
      configureInstalledTierClassification({ env });
      const items = [item(1, '/work/published/a.txt', 'hello'), item(2, '/notes/b.txt', 'garden plans')];
      await store.syncFromConnector(connectorFor(items), { fetchContent: true });
      const ledger = store.tierLedger()!;
      const id1 = { provider: 'fixture', accountScope: 'personal', providerItemId: 'file-1' };
      const id2 = { provider: 'fixture', accountScope: 'personal', providerItemId: 'file-2' };
      expect(ledger.getCurrent(id1)).toMatchObject({ contentTier: 'public', generation: 1 });

      // Owner override through the CLI, by locator.
      const set = await runTierCommand(['set', 'fixture://files/notes/b.txt', 'private'], { storePaths: [dbPath], env });
      expect(set).toMatchObject({ stores: 1, results: [{ override: 'Private', contentTier: 'Private' }] });

      await store.syncFromConnector(connectorFor(items), { fetchContent: true });
      await store.syncFromConnector(connectorFor(items), { fetchContent: true });
      expect(ledger.getCurrent(id1)).toMatchObject({ contentTier: 'public', generation: 1, decidedBy: 'owner_rule' });
      expect(ledger.getCurrent(id2)).toMatchObject({ contentTier: 'secure', decidedBy: 'override' });

      const explained = await runTierCommand(['explain', 'fixture://files/notes/b.txt'], { storePaths: [dbPath], env });
      expect(explained).toMatchObject({ stores: [{ recorded: true, contentTier: 'Private', override: 'Private', decidedBy: 'override' }] });
      expect(JSON.stringify(explained)).not.toContain('garden plans');

      // An invalid rules file stops recording (fail safe) and says so.
      writeFileSync(env.OLYMPUS_TIER_RULES_PATH, '{"schemaVersion":1,"rules":[{"id":"x"}]}');
      const summary = await store.syncFromConnector(connectorFor([item(3, '/notes/c.txt', 'new')]), { fetchContent: true });
      expect(summary.gaps.some((gap) => gap.startsWith('tier_rules_invalid'))).toBe(true);
      expect(ledger.getCurrent({ provider: 'fixture', accountScope: 'personal', providerItemId: 'file-3' })).toBeUndefined();

      await runTierCommand(['set', 'file-2', 'clear'], { storePaths: [dbPath], env });
      expect(ledger.getOverride(id2)).toBeUndefined();
    } finally {
      store.close();
    }
  });

  test('tier rules add / list / remove, and unknown locators are refused', async () => {
    const { env, dbPath, store } = setup();
    try {
      const added = await runTierCommand(['rules', 'add', '--id', 'clinic', '--match', 'sender=@clinic.example', '--tier', 'Private', '--strength', 'force'], { env });
      expect(added).toMatchObject({ added: { id: 'clinic', tier: 'Private', strength: 'force' }, rules: 1 });
      const listed = await runTierCommand(['rules', 'list'], { env });
      expect(listed).toMatchObject({ ok: true, rules: [{ id: 'clinic', match: { sender: '@clinic.example' }, tier: 'Private' }] });
      await expect(runTierCommand(['rules', 'add', '--id', 'bad', '--match', 'sender=clinic', '--tier', 'Private'], { env })).rejects.toThrow();
      expect(await runTierCommand(['rules', 'remove', 'clinic'], { env })).toMatchObject({ removed: 'clinic', rules: 0 });
      await expect(runTierCommand(['set', 'fixture://nothing', 'public'], { storePaths: [dbPath], env })).rejects.toThrow('No stored item');
      await expect(runTierCommand(['set', 'x', 'internal'], { storePaths: [dbPath], env })).rejects.toThrow('Unknown tier');
    } finally {
      store.close();
    }
  });

  test('tier rules list shows the mail scope picker rules, read-only', async () => {
    const { dir, env } = setup();
    const registryPath = join(dir, 'handles.json');
    const registry = {
      version: 1 as const,
      handles: [{
        handle: 'gmail.personal',
        provider: 'gmail' as const,
        allowedCapabilities: ['gmail.email.sync'],
        scopes: [],
        connectedAt: '2026-09-23T10:00:00.000Z',
        accountRole: 'personal',
        providerAccountId: 'account-gmail.personal',
      }],
    };
    writeConnectedHandleRegistry(registry, registryPath);
    const statePath = defaultMailSourceScopeStatePath(registryPath);
    const pending = readMailSourceScopeApproval({ registry, statePath });
    approveMailSourceScope({
      registry,
      statePath,
      accountGeneration: pending.accountGeneration!,
      expectedRevision: pending.revision,
      scope: { ...defaultMailScopeSelection(), alwaysPrivateSenders: ['@clinic.example'] },
      now: new Date('2026-09-23T12:00:00.000Z'),
    });
    const listed = await runTierCommand(['rules', 'list'], { env: { ...env, OLYMPUS_CREDENTIAL_HANDLE_REGISTRY_PATH: registryPath } });
    expect(listed).toMatchObject({
      rules: [],
      mailScopeRules: [{ source: 'gmail', match: { sender: '@clinic.example' }, tier: 'Private', strength: 'force', origin: 'mail_scope_picker', readOnly: true }],
    });
  });

  test('a lane that brings its own rules keeps them, merged with the owner rules file and the sniffer', async () => {
    const { env, dbPath } = setup();
    rulesFile(join(env.OLYMPUS_TIER_RULES_PATH, '..'), [
      { id: 'published', match: { pathPrefix: '/work/published' }, tier: 'public', strength: 'prior' },
    ]);
    configureInstalledTierClassification({ env, lane: { kind: 'local', modelId: 'fixture' } });
    const laneRule: OwnerTierRule = { id: 'lane', match: { kind: 'pathPrefix', value: '/notes' }, tier: 'secure', strength: 'force' };
    const merged = resolveStoreTierClassification({ rules: [laneRule] }, dbPath, undefined)!;
    expect(merged.rules?.map((rule) => rule.id)).toEqual(['lane', 'published']);
    expect(merged.sniffer?.id).toMatch(/^local:p-[0-9a-f]{12}$/);
    clearInstalledTierClassification();
    expect(resolveStoreTierClassification({ rules: [laneRule] }, dbPath, undefined)).toEqual({ rules: [laneRule] });
  });

  test('tier classifier approve records the owner approval; status reads it back', async () => {
    const { dir, env } = setup();
    const sovereigntyPath = join(dir, 'sovereignty.json');
    const { loadSovereigntyPreset } = await import('../src/core/sovereignty.ts');
    writeFileSync(sovereigntyPath, JSON.stringify(loadSovereigntyPreset('local-first')));
    const withPolicy = { ...env, OLYMPUS_SOVEREIGNTY_CONFIG_PATH: sovereigntyPath };
    expect(await runTierCommand(['classifier', 'status'], { env: withPolicy })).toMatchObject({ lane: 'local', approved: false });
    await expect(runTierCommand(['classifier', 'approve'], { env: withPolicy })).rejects.toThrow('--why');
    const approved = await runTierCommand(['classifier', 'approve', '--why', 'Owner chose the local model for the sniffer.'], { env: withPolicy });
    expect(approved).toMatchObject({ recorded: { approved_by: 'owner', status: 'complete', kind: 'classifier_model_decision' } });
    expect(await runTierCommand(['classifier', 'status'], { env: withPolicy })).toMatchObject({ approved: true });
  });
});
