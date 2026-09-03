/**
 * The versioned private extension point.
 *
 * The public plugin must behave exactly as it does today when no overlay module
 * is present, must keep refusing the private config keys, and must fail closed
 * — not degrade to the public surface — when an overlay declares a contract
 * version this build does not implement. Those three properties are what make
 * a private deployment safe to build from the public entry point.
 *
 * The full state space — every layout, manifest state and overlay state, with
 * the number of times the overlay is allowed to be evaluated — is the table in
 * `test/private-extension-loader-probes.test.ts`. This file owns the reader's
 * schema semantics, the manifest composition rules, and the end-to-end wiring;
 * a few evaluation-count cases are asserted in both places on purpose, because
 * the named case is what a reader looks for and the table is what a change
 * cannot slip past.
 *
 * The wiring is proven against a real module graph: `src` is mirrored, the
 * overlay module is dropped in where a private checkout would put it, and the
 * mirrored `src/native-plugin.ts` is imported. A mock of the loader would prove
 * nothing about the entry point the gateway actually loads.
 */

import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';
import manifest from '../openclaw.plugin.json';
import plugin from '../src/native-plugin.ts';
import {
  V0_4_PUBLIC_NATIVE_TOOLS,
  V0_4_PUBLIC_PLUGIN_CONFIG_KEYS,
  isV04PublicOperation,
} from '../src/core/public-surface.ts';
import {
  OLYMPUS_PRIVATE_EXTENSION_CONTRACT_VERSION,
  PRIVATE_EXTENSION_BUILT_MODULE_BASENAME,
  PRIVATE_EXTENSION_MANIFEST_BASENAME,
  PRIVATE_EXTENSION_MANIFEST_KEY,
  PRIVATE_EXTENSION_MANIFEST_NAMESPACE,
  PRIVATE_EXTENSION_MODULE_BASENAMES,
  PRIVATE_EXTENSION_SOURCE_MODULE_BASENAME,
  assertPrivateExtensionContract,
  composePrivateManifest,
  loadPrivateExtensions,
  readPrivateExtensionRequirement,
  type OlympusPrivateExtensions,
} from '../src/private-extension-contract.ts';
import fixtureExtensions, {
  fixtureCalls,
  resetFixtureCalls,
} from './fixtures/private-extension-overlay/private-extensions.ts';

const ROOT = join(import.meta.dir, '..');
const FIXTURE_MODULE = join(ROOT, 'test/fixtures/private-extension-overlay/private-extensions.ts');
const mirrors: string[] = [];

afterAll(() => {
  for (const mirror of mirrors.splice(0)) rmSync(mirror, { recursive: true, force: true });
});

interface NativeTool {
  name: string;
  execute: (toolCallId: string, params: unknown) => Promise<unknown>;
}

interface RegisteredPlugin {
  register(api: Record<string, unknown>): void;
}

const TOOL_CONTEXT = {
  agentId: 'agent-1',
  sessionId: '019f6ff4-2fb0-70a3-91dd-3ef3ada9354f',
  requesterSenderId: 'owner-1',
  senderIsOwner: true,
  deliveryContext: { channel: 'telegram', to: '123456789', accountId: 'agent-1' },
};

function materializeTool(tool: NativeTool): NativeTool {
  if (typeof tool !== 'function') return tool;
  return (tool as unknown as (context: Record<string, unknown>) => NativeTool)(TOOL_CONTEXT);
}

function registerAndCollect(target: RegisteredPlugin, pluginConfig: unknown = {}): {
  names: string[];
  routes: string[];
} {
  const names: string[] = [];
  const routes: string[] = [];
  target.register({
    pluginConfig,
    config: {},
    registerTool(tool: NativeTool) {
      names.push(materializeTool(tool).name);
    },
    registerHttpRoute(route: { path: string }) {
      routes.push(route.path);
    },
  });
  return { names, routes };
}

/**
 * A private checkout is the public tree plus `src/private-extensions.ts`, so
 * that is exactly what the mirror is.
 */
async function mirrorWithOverlay(moduleSource: string): Promise<RegisteredPlugin> {
  const mirror = mkdtempSync(join(ROOT, '.private-extension-mirror-'));
  mirrors.push(mirror);
  cpSync(join(ROOT, 'src'), join(mirror, 'src'), { recursive: true });
  writeFileSync(join(mirror, 'src/private-extensions.ts'), moduleSource);
  const loaded = await import(join(mirror, 'src/native-plugin.ts')) as { default: RegisteredPlugin };
  return loaded.default;
}

describe('private extension point: the public tree', () => {
  test('ships no overlay module, so the loader resolves to nothing', () => {
    // Both directories the loader can resolve from: `src/` for a source
    // checkout and `dist/` for an installed plugin. An overlay committed into
    // either would make the public tree quietly private.
    for (const directory of ['src', 'dist']) {
      for (const basename of PRIVATE_EXTENSION_MODULE_BASENAMES) {
        expect(existsSync(join(ROOT, directory, basename)), `${directory}/${basename} must not exist here`)
          .toBe(false);
      }
    }
    // Synchronous by contract: the host loader cannot await a plugin entry.
    const loaded = loadPrivateExtensions();
    expect(loaded).toBeUndefined();
    expect(loaded).not.toBeInstanceOf(Promise);
  });

  test('the accepted overlay filenames stay synchronously loadable ones', () => {
    // `.js`/`.mjs` in a "type": "module" package are ESM, and requiring ESM
    // synchronously is the compatibility question this loader avoids asking.
    expect([...PRIVATE_EXTENSION_MODULE_BASENAMES])
      .toEqual(['private-extensions.cjs', 'private-extensions.ts']);
  });

  test('registers exactly the public native tools with no overlay present', () => {
    const { names } = registerAndCollect(plugin as unknown as RegisteredPlugin);
    expect(names).toEqual([...V0_4_PUBLIC_NATIVE_TOOLS]);
  });

  test('the public manifest still rejects every private config key', () => {
    expect(manifest.configSchema.additionalProperties).toBe(false);
    expect(Object.keys(manifest.configSchema.properties)).toEqual([...V0_4_PUBLIC_PLUGIN_CONFIG_KEYS]);
    // The five keys the gateway refused when a private overlay was installed
    // under the public manifest. They must stay refused by this artifact.
    const email = manifest.configSchema.properties.email as { properties: Record<string, unknown> };
    const sourceIndex = manifest.configSchema.properties.sourceIndex as { properties: Record<string, unknown> };
    for (const key of ['fileDelivery', 'castorWorkspace', 'domainExpert']) {
      expect(Object.keys(manifest.configSchema.properties)).not.toContain(key);
    }
    expect(Object.keys(email.properties)).not.toContain('localPacketsDevEnabled');
    expect(Object.keys(sourceIndex.properties)).not.toContain('answerDevEnabled');
  });

  test('composing with no overlay is the identity, so the public manifest stays the one source', () => {
    expect(composePrivateManifest(manifest)).toEqual(JSON.parse(JSON.stringify(manifest)));
  });
});

describe('private extension point: an overlay module', () => {
  test('drives every hook through the real plugin entry point', async () => {
    resetFixtureCalls();
    const overlayPlugin = await mirrorWithOverlay(
      `export { default } from ${JSON.stringify(FIXTURE_MODULE)};\n`,
    );
    const { names, routes } = registerAndCollect(overlayPlugin, { fixtureLane: { enabled: true } });

    // (b) lane registration: the overlay's tools are appended to the public set
    // through the plugin's own tool factory, and none of them is a public tool.
    expect(names.slice(0, V0_4_PUBLIC_NATIVE_TOOLS.length)).toEqual([...V0_4_PUBLIC_NATIVE_TOOLS]);
    const overlayNames = names.slice(V0_4_PUBLIC_NATIVE_TOOLS.length);
    expect(overlayNames).toEqual(fixtureCalls.registeredOperationNames);
    expect(overlayNames.length).toBe(2);
    for (const name of overlayNames) expect(isV04PublicOperation('native', name)).toBe(false);

    // The per-call factory receives the trusted OpenClaw tool context.
    expect(fixtureCalls.toolContextSeen).toHaveLength(1);
    expect(fixtureCalls.toolContextSeen[0]).toMatchObject({ senderIsOwner: true });

    // Routes are registered against the same host object the plugin uses.
    expect(routes).toContain('/olympus/fixture-lane');

    // (a) the context hook ran once, before any tool was built.
    expect(fixtureCalls.extendOperationContext).toBe(1);
    expect(fixtureCalls.register).toBe(1);
  });

  test('contributes config-schema fragments the private manifest is generated from', () => {
    const composed = composePrivateManifest(manifest, fixtureExtensions) as {
      configSchema: {
        properties: Record<string, unknown> & {
          email: { properties: Record<string, unknown> };
        };
      };
      uiHints: Record<string, unknown>;
    };
    expect(Object.keys(composed.configSchema.properties)).toEqual([
      ...V0_4_PUBLIC_PLUGIN_CONFIG_KEYS,
      'fixtureLane',
    ]);
    expect(composed.configSchema.properties.email.properties.fixtureDevEnabled)
      .toEqual({ type: 'boolean', description: 'Proof-only fixture gate nested in a public section.' });
    expect(composed.uiHints.fixtureLane).toMatchObject({ label: 'Fixture Lane' });
    // Composition must not mutate the public manifest it was handed.
    expect(Object.keys(manifest.configSchema.properties)).toEqual([...V0_4_PUBLIC_PLUGIN_CONFIG_KEYS]);
  });

  test('declares its host expectations so the deployment runbook can read them', () => {
    const expectations = fixtureExtensions.runtimeExpectations();
    expect(expectations.env.map((entry) => entry.name)).toContain('OLYMPUS_FIXTURE_LANE_BASE_URL');
    expect(expectations.services.map((entry) => entry.unit)).toContain('olympus-fixture-lane.service');
    expect(expectations.schedulerTasks).toEqual(['fixture.lane.refresh']);
  });

  test('may not redefine a key the public manifest already declares', () => {
    const shadowing: OlympusPrivateExtensions = {
      contractVersion: OLYMPUS_PRIVATE_EXTENSION_CONTRACT_VERSION,
      id: 'shadowing-overlay',
      configFragments: () => [{ path: ['email'], schema: { type: 'object' } }],
      runtimeExpectations: () => ({ env: [], services: [] }),
    };
    expect(() => composePrivateManifest(manifest, shadowing)).toThrow(/may only add keys/);
  });

  test('may not shadow or re-register a public native tool', async () => {
    const overlayPlugin = await mirrorWithOverlay(
      'const extensions = {\n'
      + `  contractVersion: ${OLYMPUS_PRIVATE_EXTENSION_CONTRACT_VERSION},\n`
      + "  id: 'shadowing-overlay',\n"
      + '  configFragments: () => [],\n'
      + '  runtimeExpectations: () => ({ env: [], services: [] }),\n'
      + '  register(input) {\n'
      + "    const target = input.operations.find((operation) => operation.name === 'source_answer');\n"
      + '    input.registerOperationTool(target);\n'
      + '  },\n'
      + '};\n'
      + 'export default extensions;\n',
    );
    expect(() => registerAndCollect(overlayPlugin)).toThrow(/may not register the already-registered or public/);
  });
});

/**
 * The required-overlay marker.
 *
 * A private manifest ACCEPTS the private config keys, so an install that
 * carries it but loses the overlay module would come up with the public
 * surface while the operator's private configuration validated cleanly —
 * silently, with nothing at load time to disagree. The manifest therefore
 * states that the overlay is mandatory and the plugin refuses to load without
 * it. These tests drive the loader with an injected directory, so they need no
 * host and run in the fast lane.
 */
describe('private extension point: the required-overlay marker', () => {
  const OVERLAY = '/plugin/dist/private-extensions.cjs';
  const MANIFEST = join('/plugin/dist', '..', PRIVATE_EXTENSION_MANIFEST_BASENAME);

  function overlayModule(contractVersion: number): OlympusPrivateExtensions {
    return {
      contractVersion,
      id: 'marker-fixture',
      configFragments: () => [],
      runtimeExpectations: () => ({ env: [], services: [] }),
    };
  }

  function privateManifest(contractVersion: number, module = PRIVATE_EXTENSION_BUILT_MODULE_BASENAME): string {
    return JSON.stringify({
      id: 'olympus',
      configSchema: { type: 'object', additionalProperties: false, properties: {} },
      [PRIVATE_EXTENSION_MANIFEST_NAMESPACE]: {
        [PRIVATE_EXTENSION_MANIFEST_KEY]: { required: true, contractVersion, module },
      },
    });
  }

  /** Counts how many times the overlay module was actually evaluated. */
  let evaluations = 0;

  function load(options: {
    manifest?: string;
    presentOverlays?: readonly string[];
    overlayVersion?: number;
    baseDir?: string;
    /** Extra manifest files that must NOT influence the decision. */
    decoyManifests?: Readonly<Record<string, string>>;
  }) {
    const baseDir = options.baseDir ?? '/plugin/dist';
    const manifestPath = join(baseDir, '..', PRIVATE_EXTENSION_MANIFEST_BASENAME);
    const readable = new Map<string, string>([
      ...(options.manifest === undefined ? [] : [[manifestPath, options.manifest] as const]),
      ...Object.entries(options.decoyManifests ?? {}),
    ]);
    const present = new Set<string>([
      ...readable.keys(),
      ...(options.presentOverlays ?? []).map((name) => join(baseDir, name)),
    ]);
    return loadPrivateExtensions({
      baseDir,
      fileExists: (path) => present.has(path),
      readFile: (path) => {
        const contents = readable.get(path);
        if (contents === undefined) throw new Error(`unexpected read ${path}`);
        return contents;
      },
      loadModule: () => {
        evaluations += 1;
        return { default: overlayModule(options.overlayVersion ?? OLYMPUS_PRIVATE_EXTENSION_CONTRACT_VERSION) };
      },
    });
  }

  test('a manifest with no marker keeps exactly the public behaviour', () => {
    const publicJson = JSON.stringify({ id: 'olympus', configSchema: { properties: {} } });
    expect(load({ manifest: publicJson })).toBeUndefined();
    expect(readPrivateExtensionRequirement(MANIFEST, () => publicJson)).toBeUndefined();
  });

  test('an installed bundle with no manifest above it refuses to load', () => {
    // An installed plugin always has one — the host reads it to load the plugin
    // at all — so this tree has been taken apart and "public" would be a guess.
    expect(() => load({})).toThrow(/No openclaw\.plugin\.json was found/);
  });

  test('a source checkout with no manifest is still the public behaviour', () => {
    // Mirrored trees and previews legitimately load src/ with no manifest.
    expect(load({ baseDir: '/checkout/src' })).toBeUndefined();
  });

  test('an overlay under a manifest that does not require it refuses to load', () => {
    // The agreement runs both ways on an installed plugin: private lanes must
    // not register under a manifest that rejects their configuration.
    expect(() => load({
      manifest: JSON.stringify({ id: 'olympus', configSchema: { properties: {} } }),
      presentOverlays: [PRIVATE_EXTENSION_BUILT_MODULE_BASENAME],
    })).toThrow(/does not require private extensions/);
    expect(() => load({
      manifest: JSON.stringify({
        id: 'olympus',
        [PRIVATE_EXTENSION_MANIFEST_NAMESPACE]: { [PRIVATE_EXTENSION_MANIFEST_KEY]: { required: false } },
      }),
      presentOverlays: [PRIVATE_EXTENSION_BUILT_MODULE_BASENAME],
    })).toThrow(/does not require private extensions/);
  });

  test('a manifest that requires the overlay refuses to load without it', () => {
    expect(() => load({ manifest: privateManifest(OLYMPUS_PRIVATE_EXTENSION_CONTRACT_VERSION) }))
      .toThrow(/declares required private extensions/);
  });

  test('the refusal names the module, the directory, and the rejected extensions', () => {
    let message = '';
    try {
      load({ manifest: privateManifest(OLYMPUS_PRIVATE_EXTENSION_CONTRACT_VERSION) });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain(PRIVATE_EXTENSION_BUILT_MODULE_BASENAME);
    expect(message).toContain('/plugin/dist');
    expect(message).toContain('.js and .mjs are never accepted');
    expect(message).toContain('This layout accepts only private-extensions.cjs');
    expect(message).toContain('refuses');
  });

  test('an overlay named .js is the same refusal, because the loader cannot accept it', () => {
    expect(() => load({
      manifest: privateManifest(OLYMPUS_PRIVATE_EXTENSION_CONTRACT_VERSION),
      presentOverlays: ['private-extensions.js'],
    })).toThrow(/declares required private extensions/);
  });

  test('a present overlay on the declared contract version loads', () => {
    const loaded = load({
      manifest: privateManifest(OLYMPUS_PRIVATE_EXTENSION_CONTRACT_VERSION),
      presentOverlays: [PRIVATE_EXTENSION_BUILT_MODULE_BASENAME],
    });
    expect(loaded?.id).toBe('marker-fixture');
  });

  test('a source checkout may be satisfied by the TypeScript overlay', () => {
    const loaded = load({
      baseDir: '/checkout/src',
      manifest: privateManifest(OLYMPUS_PRIVATE_EXTENSION_CONTRACT_VERSION),
      presentOverlays: ['private-extensions.ts'],
    });
    expect(loaded?.id).toBe('marker-fixture');
  });

  test('a disallowed overlay is refused on the filesystem, whatever the manifest says', () => {
    // The check runs before anything is read or executed, so which of the four
    // manifest states applies cannot change the answer. Ignoring the file would
    // mean a .ts dropped beside an installed bundle either runs or is silently
    // skipped depending on a file it has no relationship to.
    const states: Array<[string, string | undefined]> = [
      ['required', privateManifest(OLYMPUS_PRIVATE_EXTENSION_CONTRACT_VERSION)],
      ['public', JSON.stringify({ id: 'olympus', configSchema: { properties: {} } })],
      ['opted out', JSON.stringify({
        id: 'olympus',
        [PRIVATE_EXTENSION_MANIFEST_NAMESPACE]: { [PRIVATE_EXTENSION_MANIFEST_KEY]: { required: false } },
      })],
      ['absent', undefined],
    ];
    for (const [label, manifest] of states) {
      expect(() => load({
        ...(manifest === undefined ? {} : { manifest }),
        presentOverlays: [PRIVATE_EXTENSION_SOURCE_MODULE_BASENAME],
      }), `installed layout, ${label} manifest`).toThrow(/may only load private-extensions\.cjs/);
    }
    // And the mirror image: one permitted basename per layout.
    expect(() => load({
      baseDir: '/checkout/src',
      presentOverlays: [PRIVATE_EXTENSION_BUILT_MODULE_BASENAME],
    })).toThrow(/may only load private-extensions\.ts/);
  });

  test('only the parent-directory manifest decides; one beside the module is ignored', () => {
    // Both supported layouts put the manifest one level up. A manifest sitting
    // in src/ is in a directory no install uses, and must not be able to turn
    // the private surface on or off.
    const loaded = load({
      baseDir: '/checkout/src',
      decoyManifests: {
        [join('/checkout/src', PRIVATE_EXTENSION_MANIFEST_BASENAME)]:
          privateManifest(OLYMPUS_PRIVATE_EXTENSION_CONTRACT_VERSION),
      },
    });
    expect(loaded).toBeUndefined();
  });

  test('a root __proto__ key cannot masquerade as the namespace', () => {
    // JSON.parse makes `__proto__` an own data property rather than polluting
    // the prototype, and the reader uses Object.hasOwn, so neither path turns
    // it into a marker.
    expect(readPrivateExtensionRequirement(
      MANIFEST,
      () => '{"id":"olympus","__proto__":{"olympus":{"privateExtensions":{"required":true}}}}',
    )).toBeUndefined();
    expect(({} as Record<string, unknown>).olympus).toBeUndefined();
  });

  test('a manifest and an overlay on different contract versions refuse to load', () => {
    expect(() => load({
      manifest: privateManifest(OLYMPUS_PRIVATE_EXTENSION_CONTRACT_VERSION + 7),
      presentOverlays: [PRIVATE_EXTENSION_BUILT_MODULE_BASENAME],
      overlayVersion: OLYMPUS_PRIVATE_EXTENSION_CONTRACT_VERSION,
    })).toThrow(/contract mismatch/);
  });

  test('the only implicit public no-op is the complete absence of the marker', () => {
    const withNamespace = (namespace: unknown) => JSON.stringify({
      id: 'olympus',
      configSchema: { properties: {} },
      [PRIVATE_EXTENSION_MANIFEST_NAMESPACE]: namespace,
    });
    const withMarker = (marker: unknown) =>
      withNamespace({ [PRIVATE_EXTENSION_MANIFEST_KEY]: marker });

    // Absent entirely, at either level: public.
    expect(readPrivateExtensionRequirement(MANIFEST, () => JSON.stringify({ id: 'olympus' })))
      .toBeUndefined();
    expect(readPrivateExtensionRequirement(MANIFEST, () => withNamespace({ other: 1 })))
      .toBeUndefined();

    // Present in any other unreadable form: refused.
    const version = OLYMPUS_PRIVATE_EXTENSION_CONTRACT_VERSION;
    const good = { required: true, contractVersion: version, module: PRIVATE_EXTENSION_BUILT_MODULE_BASENAME };
    for (const [label, source, pattern] of [
      ['scalar namespace', withNamespace('private'), /is not an object/],
      ['null namespace', withNamespace(null), /is not an object/],
      ['array namespace', withNamespace([]), /is not an object/],
      ['scalar marker', withMarker(true), /it is not an object/],
      ['null marker', withMarker(null), /it is not an object/],
      ['misspelled required', withMarker({ require: true, contractVersion: version, module: good.module }), /unknown field\(s\) require/],
      ['extra field', withMarker({ ...good, extra: 1 }), /unknown field\(s\) extra/],
      ['missing required', withMarker({ contractVersion: version, module: good.module }), /does not declare `required`/],
      ['string required', withMarker({ ...good, required: 'true' }), /`required` is string, not a boolean/],
      ['numeric required', withMarker({ ...good, required: 1 }), /`required` is number, not a boolean/],
      ['missing contractVersion', withMarker({ required: true, module: good.module }), /`contractVersion` is not an integer/],
      ['float contractVersion', withMarker({ ...good, contractVersion: 1.5 }), /`contractVersion` is not an integer/],
      ['missing module', withMarker({ required: true, contractVersion: version }), /this build can only load/],
      ['wrong module', withMarker({ ...good, module: 'private-extensions.js' }), /this build can only load/],
      ['path module', withMarker({ ...good, module: '../elsewhere/private-extensions.cjs' }), /this build can only load/],
    ] as const) {
      expect(() => readPrivateExtensionRequirement(MANIFEST, () => source), label).toThrow(pattern);
    }

    expect(() => readPrivateExtensionRequirement(MANIFEST, () => 'not json'))
      .toThrow(/Could not read the plugin manifest/);
    expect(() => readPrivateExtensionRequirement(MANIFEST, () => '[]'))
      .toThrow(/is not a JSON object/);

    // The one explicit opt-out, and it must be the boolean.
    expect(readPrivateExtensionRequirement(MANIFEST, () => withMarker({ required: false })))
      .toBeUndefined();
  });

  test('a manifest whose marker is unreadable stops the load, not just the read', () => {
    expect(() => load({
      manifest: JSON.stringify({
        id: 'olympus',
        [PRIVATE_EXTENSION_MANIFEST_NAMESPACE]: { [PRIVATE_EXTENSION_MANIFEST_KEY]: { require: true } },
      }),
      presentOverlays: [PRIVATE_EXTENSION_BUILT_MODULE_BASENAME],
    })).toThrow(/unknown field\(s\) require/);
  });

  test('required:false must be the whole declaration, not a flag beside a requirement', () => {
    const optOut = (extra: Record<string, unknown>) => JSON.stringify({
      id: 'olympus',
      [PRIVATE_EXTENSION_MANIFEST_NAMESPACE]: {
        [PRIVATE_EXTENSION_MANIFEST_KEY]: { required: false, ...extra },
      },
    });
    expect(() => readPrivateExtensionRequirement(
      MANIFEST,
      () => optOut({ contractVersion: 'bad', module: 'evil.js' }),
    )).toThrow(/`required` is false but it also carries contractVersion, module/);
    expect(() => readPrivateExtensionRequirement(MANIFEST, () => optOut({ module: 'evil.js' })))
      .toThrow(/`required` is false but it also carries module/);
    expect(readPrivateExtensionRequirement(MANIFEST, () => optOut({}))).toBeUndefined();
  });

  test('a refused installed layout never evaluates the overlay', () => {
    // The refusal has to happen BEFORE the module runs. Evaluating first and
    // refusing afterwards still executes module-scope private code — credential
    // reads, global mutation, I/O — inside an install being declared invalid,
    // which is exactly what a rollback or half-finished install leaves behind.
    const optedOut = JSON.stringify({
      id: 'olympus',
      [PRIVATE_EXTENSION_MANIFEST_NAMESPACE]: { [PRIVATE_EXTENSION_MANIFEST_KEY]: { required: false } },
    });
    const states: Array<[string, string | undefined]> = [
      ['manifest absent', undefined],
      ['public manifest', JSON.stringify({ id: 'olympus', configSchema: { properties: {} } })],
      ['opted-out manifest', optedOut],
    ];
    for (const [label, manifest] of states) {
      evaluations = 0;
      expect(() => load({
        ...(manifest === undefined ? {} : { manifest }),
        presentOverlays: [PRIVATE_EXTENSION_BUILT_MODULE_BASENAME],
      }), label).toThrow();
      expect(evaluations, `${label} must not evaluate the overlay`).toBe(0);
    }
  });

  test('a required overlay is evaluated exactly once', () => {
    evaluations = 0;
    const loaded = load({
      manifest: privateManifest(OLYMPUS_PRIVATE_EXTENSION_CONTRACT_VERSION),
      presentOverlays: [PRIVATE_EXTENSION_BUILT_MODULE_BASENAME],
    });
    expect(loaded?.id).toBe('marker-fixture');
    expect(evaluations).toBe(1);
  });

  test('a malformed marker refuses before the overlay is evaluated', () => {
    evaluations = 0;
    expect(() => load({
      manifest: JSON.stringify({
        id: 'olympus',
        [PRIVATE_EXTENSION_MANIFEST_NAMESPACE]: { [PRIVATE_EXTENSION_MANIFEST_KEY]: { require: true } },
      }),
      presentOverlays: [PRIVATE_EXTENSION_BUILT_MODULE_BASENAME],
    })).toThrow(/unknown field\(s\) require/);
    expect(evaluations).toBe(0);
  });

  test('the public manifest in this repository carries no marker', () => {
    expect((manifest as unknown as Record<string, unknown>)[PRIVATE_EXTENSION_MANIFEST_NAMESPACE])
      .toBeUndefined();
  });

  test('composing stamps the marker, and refuses to compose over one', () => {
    const composed = composePrivateManifest(manifest, fixtureExtensions) as Record<string, unknown>;
    expect((composed[PRIVATE_EXTENSION_MANIFEST_NAMESPACE] as Record<string, unknown>)[PRIVATE_EXTENSION_MANIFEST_KEY])
      .toEqual({
        required: true,
        contractVersion: OLYMPUS_PRIVATE_EXTENSION_CONTRACT_VERSION,
        module: PRIVATE_EXTENSION_BUILT_MODULE_BASENAME,
      });
    expect(composePrivateManifest(manifest)[PRIVATE_EXTENSION_MANIFEST_NAMESPACE]).toBeUndefined();
    expect(() => composePrivateManifest(composed, fixtureExtensions))
      .toThrow(/already declares a private extension requirement/);
  });
});

describe('private extension point: fail-closed version gate', () => {
  test('refuses a module built against a different contract version', () => {
    expect(() => assertPrivateExtensionContract(
      { default: { ...fixtureExtensions, contractVersion: OLYMPUS_PRIVATE_EXTENSION_CONTRACT_VERSION + 1 } },
      '/overlay/private-extensions.ts',
    )).toThrow(/contract mismatch/);
  });

  test('the refusal names both versions and what to do about it', () => {
    let message = '';
    try {
      assertPrivateExtensionContract({ default: { ...fixtureExtensions, contractVersion: 99 } }, '/overlay.ts');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('declares contract version 99');
    expect(message).toContain(`implements ${OLYMPUS_PRIVATE_EXTENSION_CONTRACT_VERSION}`);
    expect(message).toContain('Rebuild the private overlay');
  });

  test('rejects a module that is not shaped like the contract at all', () => {
    expect(() => assertPrivateExtensionContract({ default: {} }, '/overlay.ts'))
      .toThrow(/must export an integer contractVersion/);
    expect(() => assertPrivateExtensionContract(
      { default: { contractVersion: OLYMPUS_PRIVATE_EXTENSION_CONTRACT_VERSION, id: 'x' } },
      '/overlay.ts',
    )).toThrow(/must implement configFragments/);
    expect(() => assertPrivateExtensionContract(
      {
        default: {
          contractVersion: OLYMPUS_PRIVATE_EXTENSION_CONTRACT_VERSION,
          id: 'x',
          configFragments: () => [],
          runtimeExpectations: () => ({ env: [], services: [] }),
          register: 'not a function',
        },
      },
      '/overlay.ts',
    )).toThrow(/declared register but it is not a function/);
  });

  test('a mismatched overlay stops the plugin loading instead of coming up public', async () => {
    await expect(mirrorWithOverlay(
      `import fixture from ${JSON.stringify(FIXTURE_MODULE)};\n`
      + 'export default { ...fixture, contractVersion: 4242 };\n',
    )).rejects.toThrow(/contract mismatch/);
  });
});
