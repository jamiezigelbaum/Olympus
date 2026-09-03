/**
 * The adversarial matrix for the private extension loader.
 *
 * Four consecutive review rounds found a defect in `loadPrivateExtensions`,
 * each a narrower case of the same shape: something trusted before it had been
 * validated. The last two were only reachable by probing the state space, not
 * by reading the function. This file is that probe, committed, so the next
 * person to edit the loader inherits the adversary instead of rediscovering it.
 *
 * Every row states the whole answer: the verdict AND how many times the overlay
 * module was actually evaluated. The count is the half that inspection keeps
 * missing — a refusal that happens after evaluation has already run
 * module-scope private code (credential reads, global mutation, I/O) inside an
 * install it is about to declare invalid.
 *
 * The file is 41 probe rows plus 2 aggregate properties, so `bun test` reports
 * 43 tests. The rows are the state space; the aggregates are the two things
 * that must hold over all of it — the cross product is complete, and no
 * refusal evaluates the overlay except the one that has to.
 *
 * Cheap and deterministic on purpose: the filesystem, the manifest reader and
 * the module loader are all injected, so this needs no OpenClaw install and
 * runs in the fast lane on every change. The same properties are proven against
 * the real host, through a sentinel file the overlay writes when it evaluates,
 * in `test/plugin-host-loader-compatibility.test.ts` (deploy lane).
 *
 * `test/private-extension-contract.test.ts` owns the reader's schema semantics
 * and the manifest composition rules; this file owns the state space.
 */

import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  OLYMPUS_PRIVATE_EXTENSION_CONTRACT_VERSION as CONTRACT_VERSION,
  PRIVATE_EXTENSION_BUILT_MODULE_BASENAME,
  PRIVATE_EXTENSION_MANIFEST_BASENAME,
  PRIVATE_EXTENSION_MANIFEST_KEY,
  PRIVATE_EXTENSION_MANIFEST_NAMESPACE,
  PRIVATE_EXTENSION_SOURCE_MODULE_BASENAME,
  loadPrivateExtensions,
} from '../src/private-extension-contract.ts';

const INSTALLED_DIR = '/plugin/dist';
const SOURCE_DIR = '/checkout/src';

/**
 * The axes of the core cross product, exhaustive by construction.
 *
 * Declared here and consumed by both the completeness test and the case
 * builder, so adding a value to an axis makes the completeness test fail until
 * every cell it introduces is stated. Manifest states beyond these four are
 * malformed-marker variants; they are extra rows, not new cells.
 */
const LAYOUTS = ['installed', 'source'] as const;
const CORE_MANIFEST_STATES = ['absent', 'public', 'optedOut', 'required', 'requiredUnsupportedVersion'] as const;
const CORE_OVERLAY_STATES = ['none', 'cjs', 'ts'] as const;

type Layout = 'installed' | 'source';
type OverlayState = 'none' | 'cjs' | 'ts' | 'js';
type ManifestState =
  | 'absent'
  | 'public'
  | 'optedOut'
  | 'required'
  | 'requiredUnsupportedVersion'
  | 'optedOutWithFields'
  | 'misspelledRequired'
  | 'stringRequired'
  | 'scalarNamespace'
  | 'scalarMarker'
  | 'wrongModule'
  | 'protoNamespace'
  | 'protoRoot';

interface ProbeCase {
  readonly layout: Layout;
  readonly manifest: ManifestState;
  readonly overlay: OverlayState;
  /** Contract version the overlay module declares. Defaults to this build's. */
  readonly overlayVersion?: number;
  readonly verdict: 'loaded' | 'public' | 'refused';
  /** How many times the overlay module may be evaluated. */
  readonly evaluated: 0 | 1;
  readonly message?: RegExp;
}

const OVERLAY_FILENAME: Record<Exclude<OverlayState, 'none'>, string> = {
  cjs: PRIVATE_EXTENSION_BUILT_MODULE_BASENAME,
  ts: PRIVATE_EXTENSION_SOURCE_MODULE_BASENAME,
  js: 'private-extensions.js',
};

function manifestJson(state: Exclude<ManifestState, 'absent'>): string {
  const base = { id: 'olympus', configSchema: { type: 'object', properties: {} } };
  const marker = (value: unknown) => JSON.stringify({
    ...base,
    [PRIVATE_EXTENSION_MANIFEST_NAMESPACE]: { [PRIVATE_EXTENSION_MANIFEST_KEY]: value },
  });
  switch (state) {
    case 'public': return JSON.stringify(base);
    case 'optedOut': return marker({ required: false });
    case 'required': return marker({
      required: true,
      contractVersion: CONTRACT_VERSION,
      module: PRIVATE_EXTENSION_BUILT_MODULE_BASENAME,
    });
    case 'requiredUnsupportedVersion': return marker({
      required: true,
      contractVersion: CONTRACT_VERSION + 1,
      module: PRIVATE_EXTENSION_BUILT_MODULE_BASENAME,
    });
    case 'optedOutWithFields': return marker({ required: false, contractVersion: 'bad', module: 'evil.js' });
    case 'misspelledRequired': return marker({ require: true });
    case 'stringRequired': return marker({
      required: 'true',
      contractVersion: CONTRACT_VERSION,
      module: PRIVATE_EXTENSION_BUILT_MODULE_BASENAME,
    });
    case 'scalarNamespace': return JSON.stringify({ ...base, [PRIVATE_EXTENSION_MANIFEST_NAMESPACE]: 'private' });
    case 'scalarMarker': return marker(true);
    case 'wrongModule': return marker({
      required: true,
      contractVersion: CONTRACT_VERSION,
      module: 'private-extensions.js',
    });
    case 'protoNamespace':
      return '{"id":"olympus","olympus":{"__proto__":{"privateExtensions":{"required":true}}}}';
    case 'protoRoot':
      return '{"id":"olympus","__proto__":{"olympus":{"privateExtensions":'
        + `{"required":true,"contractVersion":${CONTRACT_VERSION},"module":"private-extensions.cjs"}}}}`;
  }
}

interface ProbeResult {
  verdict: 'loaded' | 'public' | 'refused';
  evaluated: number;
  message: string;
}

function runProbe(probe: ProbeCase): ProbeResult {
  const baseDir = probe.layout === 'source' ? SOURCE_DIR : INSTALLED_DIR;
  const manifestPath = join(baseDir, '..', PRIVATE_EXTENSION_MANIFEST_BASENAME);
  const present = new Set<string>();
  if (probe.manifest !== 'absent') present.add(manifestPath);
  if (probe.overlay !== 'none') present.add(join(baseDir, OVERLAY_FILENAME[probe.overlay]));

  let evaluated = 0;
  try {
    const loaded = loadPrivateExtensions({
      baseDir,
      fileExists: (path) => present.has(path),
      readFile: (path) => {
        if (path !== manifestPath || probe.manifest === 'absent') {
          throw new Error(`unexpected manifest read: ${path}`);
        }
        return manifestJson(probe.manifest);
      },
      loadModule: () => {
        evaluated += 1;
        return {
          default: {
            contractVersion: probe.overlayVersion ?? CONTRACT_VERSION,
            id: 'probe-overlay',
            configFragments: () => [],
            runtimeExpectations: () => ({ env: [], services: [] }),
          },
        };
      },
    });
    return { verdict: loaded ? 'loaded' : 'public', evaluated, message: '' };
  } catch (error) {
    return { verdict: 'refused', evaluated, message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The matrix.
 *
 * The rules it encodes, in one place:
 *  - Each layout has exactly ONE permitted overlay filename. Any other
 *    candidate that exists is refused on the filesystem, whatever the manifest
 *    says, before anything is read or executed.
 *  - An installed plugin with no manifest above it is refused: the host reads
 *    that file to load the plugin at all, so its absence means the tree has
 *    been taken apart and "public" would be a guess. A source checkout may
 *    proceed, because mirrored trees and previews load `src/` that way.
 *  - On an installed plugin the manifest and the overlay must agree in BOTH
 *    directions. A source checkout stays permissive.
 *  - A marker that exists in any form must be well formed. Only its complete
 *    absence implicitly means public.
 *  - Nothing is evaluated until a manifest has required it.
 */
const PROBES: readonly ProbeCase[] = [
  // Installed layout, permitted overlay absent.
  { layout: 'installed', manifest: 'absent', overlay: 'none', verdict: 'refused', evaluated: 0, message: /No openclaw\.plugin\.json was found/ },
  { layout: 'installed', manifest: 'public', overlay: 'none', verdict: 'public', evaluated: 0 },
  { layout: 'installed', manifest: 'optedOut', overlay: 'none', verdict: 'public', evaluated: 0 },
  { layout: 'installed', manifest: 'required', overlay: 'none', verdict: 'refused', evaluated: 0, message: /no overlay module is present/ },

  // Installed layout, the permitted overlay present.
  { layout: 'installed', manifest: 'absent', overlay: 'cjs', verdict: 'refused', evaluated: 0, message: /No openclaw\.plugin\.json was found/ },
  { layout: 'installed', manifest: 'public', overlay: 'cjs', verdict: 'refused', evaluated: 0, message: /does not require private extensions/ },
  { layout: 'installed', manifest: 'optedOut', overlay: 'cjs', verdict: 'refused', evaluated: 0, message: /does not require private extensions/ },
  { layout: 'installed', manifest: 'required', overlay: 'cjs', verdict: 'loaded', evaluated: 1 },

  // Installed layout, the overlay this layout may never load.
  { layout: 'installed', manifest: 'absent', overlay: 'ts', verdict: 'refused', evaluated: 0, message: /may only load private-extensions\.cjs/ },
  { layout: 'installed', manifest: 'public', overlay: 'ts', verdict: 'refused', evaluated: 0, message: /may only load private-extensions\.cjs/ },
  { layout: 'installed', manifest: 'optedOut', overlay: 'ts', verdict: 'refused', evaluated: 0, message: /may only load private-extensions\.cjs/ },
  { layout: 'installed', manifest: 'required', overlay: 'ts', verdict: 'refused', evaluated: 0, message: /may only load private-extensions\.cjs/ },

  // Source layout, permitted overlay absent.
  { layout: 'source', manifest: 'absent', overlay: 'none', verdict: 'public', evaluated: 0 },
  { layout: 'source', manifest: 'public', overlay: 'none', verdict: 'public', evaluated: 0 },
  { layout: 'source', manifest: 'optedOut', overlay: 'none', verdict: 'public', evaluated: 0 },
  { layout: 'source', manifest: 'required', overlay: 'none', verdict: 'refused', evaluated: 0, message: /no overlay module is present/ },

  // Source layout, the permitted overlay present. Permissive by design: a
  // development tree legitimately has an overlay before its manifest is
  // regenerated.
  { layout: 'source', manifest: 'absent', overlay: 'ts', verdict: 'loaded', evaluated: 1 },
  { layout: 'source', manifest: 'public', overlay: 'ts', verdict: 'loaded', evaluated: 1 },
  { layout: 'source', manifest: 'optedOut', overlay: 'ts', verdict: 'loaded', evaluated: 1 },
  { layout: 'source', manifest: 'required', overlay: 'ts', verdict: 'loaded', evaluated: 1 },

  // Source layout, the built overlay it may never load.
  { layout: 'source', manifest: 'absent', overlay: 'cjs', verdict: 'refused', evaluated: 0, message: /may only load private-extensions\.ts/ },
  { layout: 'source', manifest: 'public', overlay: 'cjs', verdict: 'refused', evaluated: 0, message: /may only load private-extensions\.ts/ },
  { layout: 'source', manifest: 'optedOut', overlay: 'cjs', verdict: 'refused', evaluated: 0, message: /may only load private-extensions\.ts/ },
  { layout: 'source', manifest: 'required', overlay: 'cjs', verdict: 'refused', evaluated: 0, message: /may only load private-extensions\.ts/ },

  // A manifest naming a contract version this build does not implement. No
  // overlay it could point at can satisfy it, and that is knowable from two
  // static facts, so nothing is evaluated to discover it.
  { layout: 'installed', manifest: 'requiredUnsupportedVersion', overlay: 'none', verdict: 'refused', evaluated: 0, message: /this build implements/ },
  { layout: 'installed', manifest: 'requiredUnsupportedVersion', overlay: 'cjs', verdict: 'refused', evaluated: 0, message: /this build implements/ },
  { layout: 'installed', manifest: 'requiredUnsupportedVersion', overlay: 'ts', verdict: 'refused', evaluated: 0, message: /may only load private-extensions\.cjs/ },
  { layout: 'source', manifest: 'requiredUnsupportedVersion', overlay: 'none', verdict: 'refused', evaluated: 0, message: /this build implements/ },
  { layout: 'source', manifest: 'requiredUnsupportedVersion', overlay: 'ts', verdict: 'refused', evaluated: 0, message: /this build implements/ },
  { layout: 'source', manifest: 'requiredUnsupportedVersion', overlay: 'cjs', verdict: 'refused', evaluated: 0, message: /may only load private-extensions\.ts/ },

  // A `.js` overlay is not a candidate at all, so it cannot satisfy a
  // requirement and cannot trip the disallowed-candidate check either.
  { layout: 'installed', manifest: 'required', overlay: 'js', verdict: 'refused', evaluated: 0, message: /no overlay module is present/ },
  { layout: 'installed', manifest: 'public', overlay: 'js', verdict: 'public', evaluated: 0 },

  // Malformed markers, with the permitted overlay present so a fail-open would
  // visibly evaluate it.
  { layout: 'installed', manifest: 'optedOutWithFields', overlay: 'cjs', verdict: 'refused', evaluated: 0, message: /`required` is false but it also carries/ },
  { layout: 'installed', manifest: 'misspelledRequired', overlay: 'cjs', verdict: 'refused', evaluated: 0, message: /unknown field\(s\) require/ },
  { layout: 'installed', manifest: 'stringRequired', overlay: 'cjs', verdict: 'refused', evaluated: 0, message: /`required` is string, not a boolean/ },
  { layout: 'installed', manifest: 'scalarNamespace', overlay: 'cjs', verdict: 'refused', evaluated: 0, message: /is not an object/ },
  { layout: 'installed', manifest: 'scalarMarker', overlay: 'cjs', verdict: 'refused', evaluated: 0, message: /it is not an object/ },
  { layout: 'installed', manifest: 'wrongModule', overlay: 'cjs', verdict: 'refused', evaluated: 0, message: /this build can only load/ },

  // `JSON.parse` makes `__proto__` an own data property rather than polluting
  // the prototype, and the reader uses `Object.hasOwn`, so neither position
  // becomes a marker. With no marker, the installed both-ways rule applies.
  { layout: 'installed', manifest: 'protoNamespace', overlay: 'cjs', verdict: 'refused', evaluated: 0, message: /does not require private extensions/ },
  { layout: 'installed', manifest: 'protoRoot', overlay: 'none', verdict: 'public', evaluated: 0 },

  // The one refusal that must still evaluate. The manifest is supported and the
  // overlay is permitted, so the disagreement is between the MODULE and this
  // build — and the only way to learn which version a module declares is to
  // read it. Distinct from the manifest-version row above, which is decidable
  // without running anything.
  { layout: 'installed', manifest: 'required', overlay: 'cjs', overlayVersion: CONTRACT_VERSION + 99, verdict: 'refused', evaluated: 1, message: /must export an integer contractVersion|contract mismatch/ },
];

function label(probe: ProbeCase): string {
  const version = probe.overlayVersion === undefined ? '' : ` (overlay v${probe.overlayVersion})`;
  return `${probe.layout} + ${probe.manifest} manifest + ${probe.overlay} overlay${version}`;
}

describe('private extension loader: adversarial matrix', () => {
  for (const probe of PROBES) {
    test(`${label(probe)} -> ${probe.verdict}, evaluated=${probe.evaluated}`, () => {
      const result = runProbe(probe);
      expect(result.verdict, `${label(probe)}: ${result.message}`).toBe(probe.verdict);
      expect(result.evaluated, `${label(probe)} evaluated the overlay ${result.evaluated} time(s)`)
        .toBe(probe.evaluated);
      if (probe.message) expect(result.message).toMatch(probe.message);
    });
  }

  test('the matrix covers every layout, manifest and overlay combination', () => {
    // The core cross product must be complete, so a rule change cannot leave a
    // cell unstated. Extra rows beyond it are welcome; missing ones are not.
    const covered = new Set(PROBES.filter((probe) => probe.overlayVersion === undefined)
      .map((probe) => `${probe.layout}/${probe.manifest}/${probe.overlay}`));
    const missing: string[] = [];
    for (const layout of LAYOUTS) {
      for (const manifest of CORE_MANIFEST_STATES) {
        for (const overlay of CORE_OVERLAY_STATES) {
          const cell = `${layout}/${manifest}/${overlay}`;
          if (!covered.has(cell)) missing.push(cell);
        }
      }
    }
    expect(missing, `uncovered cells: ${missing.join(', ')}`).toEqual([]);
    expect(LAYOUTS.length * CORE_MANIFEST_STATES.length * CORE_OVERLAY_STATES.length).toBe(30);
  });

  test('no refusal evaluates the overlay, except the one that must read it', () => {
    // Driven by actually running every probe. Reading the table's declared
    // `evaluated` fields here would only restate the rows: the property has to
    // be measured against the loader, or a row and its expectation could drift
    // together and this would still pass.
    //
    // The single exemption is identified by an INPUT, not by an expectation: a
    // probe that supplies its own `overlayVersion` is deliberately staging a
    // module whose declared version differs from this build's, and the only way
    // to discover that is to read the module.
    const offenders: string[] = [];
    for (const probe of PROBES) {
      const result = runProbe(probe);
      if (result.verdict !== 'refused') continue;
      const mustRead = probe.overlayVersion !== undefined;
      const allowed = mustRead ? 1 : 0;
      if (result.evaluated !== allowed) {
        offenders.push(`${label(probe)}: evaluated ${result.evaluated}, allowed ${allowed}`);
      }
    }
    expect(offenders, 'refusals that ran the overlay when they should not have').toEqual([]);
  });
});
