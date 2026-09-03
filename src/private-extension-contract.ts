/**
 * Versioned private extension point for the Olympus OpenClaw plugin.
 *
 * The public repository ships no `src/private-extensions.ts`. A private overlay
 * adds one; `src/native-plugin.ts` loads it once at module scope. With the
 * module absent the plugin behaves exactly as the public build does. With it
 * present but declaring a different contract version, the plugin refuses to
 * load at all rather than registering a half-wired surface — a private lane
 * that silently disappears is the failure this point exists to prevent.
 *
 * This module is the only path an overlay may import from Olympus. Everything
 * an overlay needs — the parsed config, the raw plugin config, the operation
 * registry, the finished operation context, the host registration API —
 * arrives through the hook inputs declared here, so the private tree never
 * reaches into `src/**` and the two trees stay separable.
 *
 * OpenClaw validates the *static* `openclaw.plugin.json` `configSchema` with
 * `additionalProperties: false`. A hook therefore cannot make the gateway
 * accept an extra config key at runtime: the overlay must ship its own
 * manifest. `composePrivateManifest` below is that generator — the overlay
 * emits its manifest from the same schema fragments the runtime hooks declare,
 * so the manifest and the wiring cannot drift apart.
 *
 * How an overlay ships. The module is resolved at runtime from an absolute path
 * next to the loading module, so the bundler never sees it: `dist/index.js` is
 * byte-identical whether or not an overlay exists, and an overlay adds
 * `dist/private-extensions.cjs` (built from its own `src/private-extensions.ts`
 * with `--format=cjs`) beside it. That second bundle carries its own copy of
 * this module, which is safe precisely because everything crossing the boundary
 * is plain data and host-supplied objects — no hook result is ever compared by
 * identity or with `instanceof`.
 *
 * The load is SYNCHRONOUS, and must stay that way. OpenClaw's plugin loader is
 * synchronous end to end: it `require()`s the plugin entry and, when that
 * fails, falls back to a jiti source transform. Top-level `await` anywhere in
 * the entry's graph makes the bundle unloadable on both legs
 * (`ERR_REQUIRE_ASYNC_MODULE`, then "await is only valid in async functions"),
 * so a dynamic `import()` here would break every install — public and overlay —
 * before `register` is ever reached. `.cjs` is the shipped extension because it
 * is unambiguously CommonJS regardless of the package's `type` field.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OlympusConfig } from './core/config.ts';
import type { Operation, OperationContext } from './core/operations.ts';

export type { OlympusConfig, Operation, OperationContext };

/**
 * Bumped whenever a hook signature, hook contract, or input shape changes in a
 * way an existing overlay would not survive. An overlay pins this number; a
 * mismatch fails the plugin load with an actionable message.
 */
export const OLYMPUS_PRIVATE_EXTENSION_CONTRACT_VERSION = 1;

/**
 * Files, in order of preference, that may supply the overlay module.
 *
 * `.cjs` is what a built overlay ships beside `dist/index.js`; `.ts` is what a
 * source checkout carries beside this module. Neither `.js` nor `.mjs` is
 * accepted: in a `"type": "module"` package both are ESM, and requiring ESM
 * synchronously is exactly the compatibility question this loader exists to
 * avoid asking.
 */
export const PRIVATE_EXTENSION_MODULE_BASENAMES = [
  'private-extensions.cjs',
  'private-extensions.ts',
] as const;

/**
 * Whether a missing plugin manifest is survivable.
 *
 * An installed plugin without a root `openclaw.plugin.json` is not a valid
 * OpenClaw install — the host reads that file to load the plugin at all — so a
 * bundle loaded from `dist/` with no manifest above it is a tree someone has
 * taken apart, and guessing "public" there is the same fail-open this whole
 * mechanism removes. A source checkout is different: mirrored trees and
 * previews legitimately load `src/native-plugin.ts` with no manifest, and that
 * is the only case allowed to proceed as public.
 */

/**
 * One config-schema addition the overlay's manifest must declare.
 *
 * `path` is the property path from `configSchema` downwards, so an overlay can
 * add a whole top-level section (`['section']`) or a single flag inside an
 * existing public section (`['email', 'someFlag']`). `uiHint` is keyed by the
 * dotted form of the same path.
 */
export interface OlympusPrivateConfigFragment {
  readonly path: readonly string[];
  readonly schema: Readonly<Record<string, unknown>>;
  readonly uiHint?: Readonly<{ label?: string; help?: string; sensitive?: boolean }>;
}

/**
 * What the overlay expects of the host it is installed on. Declarative on
 * purpose: the plugin never reads an environment variable or touches a service
 * on the overlay's behalf, but the deployment runbook and the overlay's own
 * tests need one machine-readable statement of what must be present.
 */
export interface OlympusPrivateRuntimeExpectations {
  readonly env: ReadonlyArray<{
    readonly name: string;
    readonly required: boolean;
    readonly description: string;
  }>;
  readonly services: ReadonlyArray<{
    readonly unit: string;
    readonly description: string;
  }>;
  readonly schedulerTasks?: readonly string[];
}

/** The subset of the OpenClaw plugin API an overlay may use. */
export interface OlympusPrivateHostApi {
  registerTool(tool: unknown): void;
  registerHttpRoute?(route: {
    path: string;
    auth: 'plugin';
    match: 'exact';
    handler(request: never, response: never): Promise<void>;
  }): void;
}

/** Input to the context hook, which runs before any tool is registered. */
export interface OlympusPrivateContextInput {
  readonly pluginConfig: unknown;
  readonly config: OlympusConfig;
}

/**
 * Registers one operation as a native tool through the plugin's own tool
 * factory, so an overlay lane is built exactly the way a public lane is.
 *
 * `toolContextExtension` mirrors the per-call factory the plugin uses for
 * operations that need trusted caller context; when it is omitted the tool is
 * registered against the shared operation context.
 */
export type OlympusPrivateOperationToolRegistrar = (
  operation: Operation,
  options?: {
    toolContextExtension?: (toolContext: Readonly<Record<string, unknown>>) => Partial<OperationContext>;
  },
) => void;

/** Input to the registration hook. */
export interface OlympusPrivateRegistrationInput {
  readonly api: OlympusPrivateHostApi;
  readonly pluginConfig: unknown;
  readonly config: OlympusConfig;
  readonly activeModel: unknown;
  /** The same operation registry the plugin itself iterates. */
  readonly operations: readonly Operation[];
  /** The finished operation context, including anything the context hook added. */
  readonly context: OperationContext;
  /** Tool names the plugin already registered. An overlay may not shadow them. */
  readonly registeredToolNames: readonly string[];
  /**
   * Whether a name belongs to the public native surface.
   *
   * `registeredToolNames` is not a substitute: a public tool the install has
   * turned off is absent from it but still public, and an overlay that
   * iterated the registry without this predicate would try to claim it.
   */
  isPublicNativeOperation(operationName: string): boolean;
  readonly registerOperationTool: OlympusPrivateOperationToolRegistrar;
}

/**
 * The contract a private overlay's default export must satisfy.
 *
 * `configFragments` and `runtimeExpectations` are declarations the overlay's
 * manifest generator and deployment runbook read; `extendOperationContext` and
 * `register` are the runtime wiring.
 */
export interface OlympusPrivateExtensions {
  readonly contractVersion: number;
  /** Stable identifier for the overlay, used in refusal messages. */
  readonly id: string;
  configFragments(): readonly OlympusPrivateConfigFragment[];
  runtimeExpectations(): OlympusPrivateRuntimeExpectations;
  extendOperationContext?(input: OlympusPrivateContextInput): Partial<OperationContext> | undefined;
  register?(input: OlympusPrivateRegistrationInput): void;
  /** Extra native tool names the overlay's manifest declares. */
  contractTools?(): readonly string[];
  /** Extra skill directories the overlay's manifest declares. */
  skillDirs?(): readonly string[];
}

export class OlympusPrivateExtensionError extends Error {}

/**
 * Validates a loaded module and fails closed.
 *
 * Every refusal here is preferred over a partially wired plugin: a version
 * mismatch, a missing required hook, or a non-object export means the overlay
 * and this build disagree about what the private surface is.
 */
export function assertPrivateExtensionContract(
  moduleNamespace: unknown,
  source: string,
): OlympusPrivateExtensions {
  const namespace = asRecord(moduleNamespace);
  if (!namespace) {
    throw new OlympusPrivateExtensionError(
      `Olympus private extension module at ${source} did not export a module namespace.`,
    );
  }
  const candidate = asRecord(namespace.default) ?? namespace;
  const contractVersion = candidate.contractVersion;
  if (typeof contractVersion !== 'number' || !Number.isInteger(contractVersion)) {
    throw new OlympusPrivateExtensionError(
      `Olympus private extension module at ${source} must export an integer contractVersion. `
      + `This build implements contract version ${OLYMPUS_PRIVATE_EXTENSION_CONTRACT_VERSION}.`,
    );
  }
  if (contractVersion !== OLYMPUS_PRIVATE_EXTENSION_CONTRACT_VERSION) {
    throw new OlympusPrivateExtensionError(
      `Olympus private extension contract mismatch at ${source}: the module declares contract `
      + `version ${contractVersion} and this build implements `
      + `${OLYMPUS_PRIVATE_EXTENSION_CONTRACT_VERSION}. Rebuild the private overlay against this `
      + 'Olympus revision, or install the Olympus revision the overlay was built for. The plugin '
      + 'refuses to load rather than register a partial private surface.',
    );
  }
  if (typeof candidate.id !== 'string' || candidate.id.trim() === '') {
    throw new OlympusPrivateExtensionError(
      `Olympus private extension module at ${source} must export a non-empty id.`,
    );
  }
  for (const hook of ['configFragments', 'runtimeExpectations'] as const) {
    if (typeof candidate[hook] !== 'function') {
      throw new OlympusPrivateExtensionError(
        `Olympus private extension module at ${source} must implement ${hook}().`,
      );
    }
  }
  for (const hook of ['extendOperationContext', 'register', 'contractTools', 'skillDirs'] as const) {
    if (candidate[hook] !== undefined && typeof candidate[hook] !== 'function') {
      throw new OlympusPrivateExtensionError(
        `Olympus private extension module at ${source} declared ${hook} but it is not a function.`,
      );
    }
  }
  return candidate as unknown as OlympusPrivateExtensions;
}

/** The manifest an installed plugin is validated against, beside its bundle. */
export const PRIVATE_EXTENSION_MANIFEST_BASENAME = 'openclaw.plugin.json';

/** The overlay filename a built private install ships. */
export const PRIVATE_EXTENSION_BUILT_MODULE_BASENAME = 'private-extensions.cjs';

/** The overlay filename a private source checkout carries. */
export const PRIVATE_EXTENSION_SOURCE_MODULE_BASENAME = 'private-extensions.ts';

/**
 * Where the overlay requirement lives in the manifest.
 *
 * Namespaced under the plugin id because OpenClaw's manifest loader reads the
 * keys it knows off a plain JSON record and ignores the rest, so an unknown
 * top-level key is tolerated but a generic name could one day collide.
 */
export const PRIVATE_EXTENSION_MANIFEST_NAMESPACE = 'olympus';
export const PRIVATE_EXTENSION_MANIFEST_KEY = 'privateExtensions';

/**
 * The private manifest's declaration that this install is not a public one.
 *
 * OpenClaw validates config against the manifest's static `configSchema`. A
 * private manifest therefore ACCEPTS the private config keys — which means an
 * install that carries it but loses the overlay module would come up with the
 * public surface while the operator's private config validated cleanly. That
 * is the 2026-09-02 incident shape wearing a green hat, and a doc or a
 * preflight cannot prevent it because nothing at load time would disagree.
 *
 * So the manifest states the requirement, and the plugin refuses to load
 * without it.
 */
export interface OlympusPrivateExtensionRequirement {
  readonly required: true;
  readonly contractVersion: number;
  readonly module: string;
}

/** The only fields a marker may carry. Anything else is a manifest error. */
const PRIVATE_EXTENSION_MARKER_FIELDS = ['required', 'contractVersion', 'module'] as const;

/** The directory name that means "this is a source checkout, not an install". */
const SOURCE_CHECKOUT_DIRNAME = 'src';

/**
 * Reads the overlay requirement from a plugin manifest.
 *
 * The ONLY thing that implicitly means "public" is the complete absence of
 * `olympus.privateExtensions`. Everything else — a scalar where an object
 * belongs, a missing or mistyped `required`, a misspelled field, a module name
 * this build cannot load — THROWS. A marker that is present but unreadable is
 * the most dangerous state there is: it is written by someone who meant to
 * require the overlay, and reading it as "requires nothing" is precisely the
 * fail-open this mechanism exists to remove. `required: false` is the one
 * explicit opt-out, and it has to be the boolean, spelled correctly.
 */
export function readPrivateExtensionRequirement(
  manifestPath: string,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): OlympusPrivateExtensionRequirement | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFile(manifestPath));
  } catch (error) {
    throw new OlympusPrivateExtensionError(
      `Could not read the plugin manifest at ${manifestPath} to check for a private extension `
      + `requirement: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  const refuse = (detail: string): never => {
    throw new OlympusPrivateExtensionError(
      `The plugin manifest at ${manifestPath} declares `
      + `${PRIVATE_EXTENSION_MANIFEST_NAMESPACE}.${PRIVATE_EXTENSION_MANIFEST_KEY}, but ${detail}. `
      + 'A malformed requirement is refused rather than read as requiring nothing. Regenerate the '
      + 'manifest from the private extension module.',
    );
  };

  const root = asRecord(parsed);
  if (!root) {
    throw new OlympusPrivateExtensionError(`The plugin manifest at ${manifestPath} is not a JSON object.`);
  }
  if (!Object.hasOwn(root, PRIVATE_EXTENSION_MANIFEST_NAMESPACE)) return undefined;
  const namespace = asRecord(root[PRIVATE_EXTENSION_MANIFEST_NAMESPACE]);
  if (!namespace) {
    throw new OlympusPrivateExtensionError(
      `The plugin manifest at ${manifestPath} has a ${PRIVATE_EXTENSION_MANIFEST_NAMESPACE} key that `
      + 'is not an object. Regenerate the manifest from the private extension module.',
    );
  }
  if (!Object.hasOwn(namespace, PRIVATE_EXTENSION_MANIFEST_KEY)) return undefined;
  const marker = asRecord(namespace[PRIVATE_EXTENSION_MANIFEST_KEY]);
  if (!marker) return refuse('it is not an object');

  const unknownFields = Object.keys(marker)
    .filter((field) => !(PRIVATE_EXTENSION_MARKER_FIELDS as readonly string[]).includes(field));
  if (unknownFields.length > 0) {
    // A misspelling like `require` is exactly how this would fail open.
    return refuse(`it carries unknown field(s) ${unknownFields.join(', ')}`);
  }
  if (!Object.hasOwn(marker, 'required')) return refuse('it does not declare `required`');
  if (typeof marker.required !== 'boolean') {
    return refuse(`\`required\` is ${typeof marker.required}, not a boolean`);
  }
  if (marker.required === false) {
    // The opt-out is the whole declaration, not a flag alongside fields that
    // describe a requirement. `{required:false, module:"evil.js"}` is someone
    // editing a live manifest, not a public install.
    const extra = Object.keys(marker).filter((field) => field !== 'required');
    if (extra.length > 0) {
      return refuse(`\`required\` is false but it also carries ${extra.join(', ')}`);
    }
    return undefined;
  }

  const contractVersion = marker.contractVersion;
  if (typeof contractVersion !== 'number' || !Number.isInteger(contractVersion)) {
    return refuse('`contractVersion` is not an integer');
  }
  const module = marker.module;
  if (module !== PRIVATE_EXTENSION_BUILT_MODULE_BASENAME) {
    return refuse(
      `\`module\` is ${JSON.stringify(module)}; this build can only load `
      + `"${PRIVATE_EXTENSION_BUILT_MODULE_BASENAME}"`,
    );
  }
  return { required: true, contractVersion, module };
}

/**
 * The ONE overlay filename this layout may load. Exactly one per layout.
 *
 * An installed plugin loads `dist/index.js` and may only be satisfied by the
 * built CommonJS overlay; a source checkout loads `src/native-plugin.ts` and
 * may only be satisfied by the TypeScript one. Binding each layout to a single
 * name means a manifest can never be satisfied by a file that layout's install
 * would not contain, and — because the rule is applied to the filesystem rather
 * than to the manifest — it holds whatever the manifest says.
 */
function permittedOverlayBasename(baseDir: string): string {
  return basename(baseDir) === SOURCE_CHECKOUT_DIRNAME
    ? PRIVATE_EXTENSION_SOURCE_MODULE_BASENAME
    : PRIVATE_EXTENSION_BUILT_MODULE_BASENAME;
}

function isSourceCheckoutLayout(baseDir: string): boolean {
  return basename(baseDir) === SOURCE_CHECKOUT_DIRNAME;
}

/**
 * The manifest that governs a plugin loaded from `baseDir`.
 *
 * Exactly one location: the parent directory. Both supported layouts put it
 * there — `<root>/openclaw.plugin.json` beside `<root>/dist/index.js` and
 * beside `<root>/src/native-plugin.ts`. A same-directory fallback was removed
 * because it let a manifest in a directory no install ever uses decide whether
 * the private surface is required.
 */
function resolveSiblingManifestPath(
  baseDir: string,
  fileExists: (path: string) => boolean,
): string | undefined {
  const candidate = join(baseDir, '..', PRIVATE_EXTENSION_MANIFEST_BASENAME);
  return fileExists(candidate) ? candidate : undefined;
}

export interface LoadPrivateExtensionsOptions {
  /** Directory searched for the overlay module. Defaults to this module's own directory. */
  baseDir?: string;
  fileExists?: (path: string) => boolean;
  /** Synchronous module loader. Defaults to `createRequire` against this module. */
  loadModule?: (path: string) => unknown;
  /** Reads the sibling plugin manifest. Defaults to `readFileSync`. */
  readFile?: (path: string) => string;
}

const requireFromThisModule = createRequire(import.meta.url);

/**
 * Resolves the overlay module, or `undefined` when the public tree is intact.
 *
 * Synchronous by contract — see the module header. Absence is decided by the
 * filesystem rather than by catching a load failure, so an overlay whose own
 * dependency is missing raises a hard error instead of degrading silently to
 * the public surface.
 */
export function loadPrivateExtensions(
  options: LoadPrivateExtensionsOptions = {},
): OlympusPrivateExtensions | undefined {
  const baseDir = options.baseDir ?? dirname(fileURLToPath(import.meta.url));
  const fileExists = options.fileExists ?? existsSync;
  const loadModule = options.loadModule ?? requireFromThisModule;
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
  const sourceCheckout = isSourceCheckoutLayout(baseDir);
  const permitted = permittedOverlayBasename(baseDir);

  // NOTHING below evaluates the overlay until the manifest has been located,
  // read, and found to require it. Evaluating first and refusing afterwards
  // would still have run module-scope private code — credential reads, global
  // mutation, I/O — inside an install that was then declared invalid, which is
  // exactly what a rollback or a half-finished install leaves behind. Every
  // decision up to the `loadModule` calls below is filesystem and JSON only.

  // Refused on the filesystem, without consulting the manifest at all. An
  // overlay this layout cannot legitimately contain is never silently ignored:
  // ignoring it would mean a stray file either runs or is skipped depending on
  // a file it has no relationship to.
  for (const candidate of PRIVATE_EXTENSION_MODULE_BASENAMES) {
    if (candidate === permitted) continue;
    if (!fileExists(join(baseDir, candidate))) continue;
    throw new OlympusPrivateExtensionError(
      `${candidate} is present in ${baseDir}, but ${sourceCheckout ? 'a source checkout' : 'an installed plugin'} `
      + `may only load ${permitted}. Remove it, or install the overlay this layout expects. The `
      + 'plugin refuses to load rather than run an overlay this layout would never ship.',
    );
  }

  const permittedPath = join(baseDir, permitted);
  const overlayPresent = fileExists(permittedPath);
  const evaluateOverlay = (): OlympusPrivateExtensions =>
    assertPrivateExtensionContract(loadModule(permittedPath), permittedPath);

  const manifestPath = resolveSiblingManifestPath(baseDir, fileExists);
  if (!manifestPath) {
    // See PRIVATE_EXTENSION_MODULE_BASENAMES above for why the two layouts
    // differ here.
    if (!sourceCheckout) {
      throw new OlympusPrivateExtensionError(
        `No ${PRIVATE_EXTENSION_MANIFEST_BASENAME} was found above ${baseDir}. An installed plugin `
        + 'always has one — the host reads it to load the plugin at all — so this tree has been '
        + 'taken apart, and whether the private surface is required cannot be determined. The '
        + 'plugin refuses to load rather than guess that it is public.',
      );
    }
    return overlayPresent ? evaluateOverlay() : undefined;
  }

  const requirement = readPrivateExtensionRequirement(manifestPath, readFile);
  if (!requirement) {
    // On an installed plugin the manifest and the overlay must agree in BOTH
    // directions. An overlay running under a manifest that does not declare it
    // is the same mismatched install as the reverse, just quieter: the lanes
    // register while the manifest rejects the config keys that would enable
    // them. A source checkout stays permissive, because a development tree
    // legitimately has an overlay before its manifest is regenerated.
    if (overlayPresent && !sourceCheckout) {
      throw new OlympusPrivateExtensionError(
        `An overlay module is installed in ${baseDir}, but the manifest at ${manifestPath} does not `
        + 'require private extensions. An installed plugin\'s manifest and overlay must agree: '
        + 'install the private manifest, or remove the overlay. The plugin refuses to load — '
        + 'without evaluating the overlay — rather than run private lanes under a manifest that '
        + 'rejects their configuration.',
      );
    }
    // A public manifest, or one that explicitly opts out, leaves the public
    // behaviour exactly as it was.
    return overlayPresent ? evaluateOverlay() : undefined;
  }

  // The manifest names a contract version this build does not implement, so no
  // overlay it could point at can satisfy it. Checked HERE, before the overlay
  // is located or evaluated, because a manifest/build disagreement is knowable
  // from two static facts — running the module first to discover what it
  // declares would execute private code to learn something already decided.
  if (requirement.contractVersion !== OLYMPUS_PRIVATE_EXTENSION_CONTRACT_VERSION) {
    throw new OlympusPrivateExtensionError(
      `Olympus private extension contract mismatch: the manifest at ${manifestPath} requires `
      + `contract version ${requirement.contractVersion} and this build implements `
      + `${OLYMPUS_PRIVATE_EXTENSION_CONTRACT_VERSION}. Regenerate the manifest and rebuild the `
      + 'overlay against this Olympus revision, or install the revision the overlay was built for. '
      + 'The overlay is not evaluated.',
    );
  }

  if (!overlayPresent) {
    throw new OlympusPrivateExtensionError(
      `The plugin manifest at ${manifestPath} declares required private extensions `
      + `(module "${requirement.module}", contract version ${requirement.contractVersion}), but no `
      + `overlay module is present in ${baseDir}. This layout accepts only ${permitted}; note that `
      + '.js and .mjs are never accepted. Build the overlay bundle next to this module and '
      + 'reinstall. The plugin refuses to load rather than come up with the public surface while '
      + 'this manifest accepts private configuration keys.',
    );
  }

  // The manifest requires this exact module, at the version this build
  // implements, and this layout permits it. First and only point at which
  // overlay code runs.
  //
  // No manifest-versus-module version check follows: the check above proved
  // manifest === build, and assertPrivateExtensionContract refuses any module
  // whose own contractVersion is not build. A third comparison here could only
  // ever be true, and dead code in a fail-closed path is a liability.
  return evaluateOverlay();
}

interface ComposableManifest {
  configSchema: { properties: Record<string, unknown>; [key: string]: unknown };
  uiHints?: Record<string, unknown>;
  contracts?: { tools?: string[]; [key: string]: unknown };
  skills?: string[];
  [key: string]: unknown;
}

/**
 * Emits the overlay's manifest from the public manifest plus the overlay's own
 * schema fragments.
 *
 * With no extensions this is the identity function, which is what keeps the
 * public manifest the single source of every shared key. A fragment may only
 * ADD: redefining a property the public manifest already declares is refused,
 * because that is how an overlay would quietly loosen a public constraint.
 */
export function composePrivateManifest(
  publicManifest: unknown,
  extensions?: Pick<
    OlympusPrivateExtensions,
    'contractVersion' | 'configFragments' | 'contractTools' | 'skillDirs'
  >,
): Record<string, unknown> {
  const manifest = structuredClone(publicManifest) as ComposableManifest;
  if (!asRecord(manifest?.configSchema) || !asRecord(manifest.configSchema.properties)) {
    throw new OlympusPrivateExtensionError('Base manifest must declare configSchema.properties.');
  }
  const baseNamespace = asRecord(manifest[PRIVATE_EXTENSION_MANIFEST_NAMESPACE]);
  if (baseNamespace && baseNamespace[PRIVATE_EXTENSION_MANIFEST_KEY] !== undefined) {
    throw new OlympusPrivateExtensionError(
      'The base manifest already declares a private extension requirement. Compose from the '
      + 'public manifest, not from a generated private one.',
    );
  }
  if (!extensions) return manifest as unknown as Record<string, unknown>;

  // Stamped here rather than contributed as a fragment so it cannot be
  // forgotten: a manifest that accepts the private config keys always also
  // states that the overlay is mandatory, and the loader refuses without it.
  manifest[PRIVATE_EXTENSION_MANIFEST_NAMESPACE] = {
    ...(baseNamespace ?? {}),
    [PRIVATE_EXTENSION_MANIFEST_KEY]: {
      required: true,
      contractVersion: extensions.contractVersion,
      module: PRIVATE_EXTENSION_BUILT_MODULE_BASENAME,
    },
  };

  for (const fragment of extensions.configFragments()) {
    if (fragment.path.length === 0) {
      throw new OlympusPrivateExtensionError('A private config fragment must declare a property path.');
    }
    let node = manifest.configSchema as Record<string, unknown>;
    for (const segment of fragment.path.slice(0, -1)) {
      const properties = asRecord(node.properties);
      const child = properties ? asRecord(properties[segment]) : undefined;
      if (!child) {
        throw new OlympusPrivateExtensionError(
          `Private config fragment ${fragment.path.join('.')} needs an existing parent section `
          + `${segment} in the base manifest.`,
        );
      }
      node = child;
    }
    const properties = asRecord(node.properties);
    if (!properties) {
      throw new OlympusPrivateExtensionError(
        `Private config fragment ${fragment.path.join('.')} targets a section with no properties map.`,
      );
    }
    const leaf = fragment.path[fragment.path.length - 1]!;
    if (leaf in properties) {
      throw new OlympusPrivateExtensionError(
        `Private config fragment ${fragment.path.join('.')} would redefine a key the public manifest `
        + 'already declares. An overlay may only add keys.',
      );
    }
    properties[leaf] = structuredClone(fragment.schema);
    if (fragment.uiHint) {
      const hints = { ...(asRecord(manifest.uiHints) ?? {}) };
      const hintKey = fragment.path.join('.');
      if (hintKey in hints) {
        throw new OlympusPrivateExtensionError(
          `Private config fragment ${hintKey} would replace a uiHint the public manifest declares.`,
        );
      }
      hints[hintKey] = structuredClone(fragment.uiHint);
      manifest.uiHints = hints;
    }
  }

  const extraTools = extensions.contractTools?.() ?? [];
  if (extraTools.length > 0) {
    const contracts = asRecord(manifest.contracts) ?? {};
    const tools = Array.isArray(contracts.tools) ? [...contracts.tools as string[]] : [];
    for (const tool of extraTools) {
      if (tools.includes(tool)) {
        throw new OlympusPrivateExtensionError(`Private manifest tool ${tool} is already declared publicly.`);
      }
      tools.push(tool);
    }
    manifest.contracts = { ...contracts, tools };
  }

  const extraSkills = extensions.skillDirs?.() ?? [];
  if (extraSkills.length > 0) {
    const skills = Array.isArray(manifest.skills) ? [...manifest.skills] : [];
    for (const skill of extraSkills) {
      if (skills.includes(skill)) {
        throw new OlympusPrivateExtensionError(`Private manifest skill ${skill} is already declared publicly.`);
      }
      skills.push(skill);
    }
    manifest.skills = skills;
  }

  return manifest as unknown as Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
