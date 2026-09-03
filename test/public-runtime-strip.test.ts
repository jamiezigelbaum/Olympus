// The public package is built by deleting marked text spans from real source
// files (scripts/public-runtime-strip.ts). Nothing downstream notices when a
// span deletes more than its author meant: `bun build` does not type-check, a
// call to a deleted method compiles to an ordinary property access, and the
// release gates never mint a token. That is how the v0.4 public package shipped
// with its OAuth2 mint path gone -- `issueOAuth2RefreshSession` survived while
// the `mintCachedBearerSession` and `issueFreshOAuth2RefreshSession` it calls
// were inside the block, so every Gmail/Drive/Dropbox/X sync in the installed
// plugin would have thrown TypeError.
//
// This test applies the real stripper to every stripped module and refuses any
// stripped result that still names a declaration the strip removed. It is a
// class gate, not a regression test for one span: a future marker that swallows
// a shared helper fails here regardless of which file or symbol it is.

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Glob } from 'bun';
import { afterAll, describe, expect, test } from 'bun:test';
import ts from 'typescript';
import {
  PUBLIC_RUNTIME_CREDENTIAL_BROKER_MODULE,
  PUBLIC_RUNTIME_EXCLUDE_START,
  PUBLIC_RUNTIME_STRIPPED_MODULES,
  PUBLIC_RUNTIME_STRIPPED_MODULE_FILTER,
  publicRuntimeExcludedSpans,
  replacePublicRuntimeCredentialHandles,
  stripPublicRuntimeExcludedBlocks,
} from '../scripts/public-runtime-strip.ts';

const ROOT = join(import.meta.dir, '..');
const temporaryRoots: string[] = [];

afterAll(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface ExcludedDeclarations {
  /** Module-scope names (imports, functions, classes, types, variables). */
  values: Set<string>;
  /** Class member names, referenced through `this.<name>`. */
  members: Set<string>;
}

interface SurvivingReferences {
  declared: Set<string>;
  members: Set<string>;
  referenced: Set<string>;
  thisMembers: Set<string>;
}

describe('public runtime source stripping', () => {
  test('the stripped module list, the build filter, and the markers in src agree', () => {
    const marked = [...new Glob('src/**/*.ts').scanSync({ cwd: ROOT })]
      .filter((path) => readFileSync(join(ROOT, path), 'utf8').includes(PUBLIC_RUNTIME_EXCLUDE_START))
      .map((path) => path.split('\\').join('/'))
      .sort();

    // A module that grows exclusion markers without joining the list would ship
    // its private branches; a module on the list the bundler filter misses would
    // ship them too. Both are the same silent failure, so both are checked here.
    expect(marked).toEqual([...PUBLIC_RUNTIME_STRIPPED_MODULES].sort());
    for (const module of PUBLIC_RUNTIME_STRIPPED_MODULES) {
      expect(PUBLIC_RUNTIME_STRIPPED_MODULE_FILTER.test(join(ROOT, module))).toBe(true);
    }
  });

  test('no surviving code references a declaration the public runtime strips away', () => {
    const orphans: string[] = [];
    for (const module of PUBLIC_RUNTIME_STRIPPED_MODULES) {
      const path = join(ROOT, module);
      const source = readFileSync(path, 'utf8');
      const excluded = excludedDeclarations(path, source);
      const surviving = survivingReferences(path, stripPublicRuntimeExcludedBlocks(source, path));

      for (const name of excluded.values) {
        if (surviving.referenced.has(name) && !surviving.declared.has(name)) {
          orphans.push(`${module}: stripped declaration \`${name}\` is still referenced`);
        }
      }
      for (const name of excluded.members) {
        if (surviving.thisMembers.has(name) && !surviving.members.has(name)) {
          orphans.push(`${module}: stripped member \`this.${name}\` is still called`);
        }
      }
    }
    expect(orphans).toEqual([]);
  });

  test('the stripped credential broker still mints an oauth2Refresh bearer session', async () => {
    // The strip is the transform under test, so the mirror applies exactly the
    // two source rewrites the release performs on this module and leaves the
    // build-flavor constant alone.
    const mirror = mkdtempSync(join(ROOT, '.public-runtime-stripped-'));
    temporaryRoots.push(mirror);
    cpSync(join(ROOT, 'src'), join(mirror, 'src'), { recursive: true });
    const brokerPath = join(ROOT, PUBLIC_RUNTIME_CREDENTIAL_BROKER_MODULE);
    const brokerSource = readFileSync(brokerPath, 'utf8');
    writeFileSync(
      join(mirror, PUBLIC_RUNTIME_CREDENTIAL_BROKER_MODULE),
      replacePublicRuntimeCredentialHandles(
        stripPublicRuntimeExcludedBlocks(brokerSource, brokerPath),
        brokerPath,
      ),
    );

    const stripped = await import(join(mirror, PUBLIC_RUNTIME_CREDENTIAL_BROKER_MODULE)) as {
      createEnvCredentialBroker: (options: Record<string, unknown>) => {
        issueSession: (request: Record<string, unknown>) => Promise<{ kind: string; token: string }>;
      };
    };

    const registryPath = join(mirror, 'handles.json');
    writeFileSync(registryPath, JSON.stringify({
      version: 1,
      handles: [{
        handle: 'x.bookmarks.personal',
        provider: 'x',
        accountRole: 'personal',
        trustDomain: 'internal',
        allowedCapabilities: ['x.bookmarks.sync'],
        scopes: ['tweet.read', 'bookmark.read', 'offline.access'],
        connectedAt: '2026-07-20T12:00:00.000Z',
        providerAccountId: '1234567890',
      }],
    }));

    const states = new Map<string, Record<string, unknown>>([
      ['x.bookmarks.personal', { refreshToken: 'refresh-token-generation-1', status: 'available' }],
    ]);
    let refreshCalls = 0;
    const broker = stripped.createEnvCredentialBroker({
      env: {
        OLYMPUS_CREDENTIAL_X_BOOKMARKS_PERSONAL_OAUTH2_CLIENT_ID: 'x-client-id-fixture',
        OLYMPUS_CREDENTIAL_X_BOOKMARKS_PERSONAL_OAUTH2_CLIENT_SECRET: 'x-client-secret-fixture',
      },
      handleRegistryPath: registryPath,
      oauth2StateStore: {
        load: async (handle: string) => states.get(handle),
        save: async (handle: string, state: Record<string, unknown>) => {
          states.set(handle, { ...states.get(handle), ...state });
        },
      },
      oauth2CacheNamespace: `stripped-public-runtime-${mirror}`,
      fetch: async () => {
        refreshCalls += 1;
        return new Response(JSON.stringify({
          access_token: 'access-token-generation-2',
          expires_in: 7200,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      },
    });

    const session = await broker.issueSession({
      handle: 'x.bookmarks.personal',
      provider: 'x',
      capability: 'x.bookmarks.sync',
      trustDomain: 'internal',
    });

    expect(session.kind).toBe('bearer_token');
    expect(session.token).toBe('access-token-generation-2');
    expect(refreshCalls).toBe(1);
  });
});

/** Names a stripped module declares only inside its excluded spans. */
function excludedDeclarations(path: string, source: string): ExcludedDeclarations {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const spans = publicRuntimeExcludedSpans(source);
  const values = new Set<string>();
  const members = new Set<string>();
  const inExcludedSpan = (node: ts.Node): boolean =>
    spans.some((span) => node.getStart(file) >= span.start && node.getEnd() <= span.end);

  const visit = (node: ts.Node): void => {
    if (inExcludedSpan(node)) {
      if (isClassMemberDeclaration(node) && ts.isIdentifier(node.name)) {
        members.add(node.name.text);
      } else {
        for (const name of declaredNames(node)) values.add(name);
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(file, visit);
  return { values, members };
}

/** What the stripped source still declares and still names. */
function survivingReferences(path: string, source: string): SurvivingReferences {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declared = new Set<string>();
  const members = new Set<string>();
  const referenced = new Set<string>();
  const thisMembers = new Set<string>();

  const visit = (node: ts.Node): void => {
    if (isClassMemberDeclaration(node) && ts.isIdentifier(node.name)) members.add(node.name.text);
    for (const name of declaredNames(node)) declared.add(name);
    if (ts.isParameter(node) && ts.isIdentifier(node.name)) declared.add(node.name.text);
    if (ts.isIdentifier(node)) {
      const parent = node.parent as ts.Node | undefined;
      if (parent && ts.isPropertyAccessExpression(parent) && parent.name === node) {
        if (parent.expression.kind === ts.SyntaxKind.ThisKeyword) thisMembers.add(node.text);
      } else if (isReferencePosition(node, parent)) {
        referenced.add(node.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(file, visit);
  return { declared, members, referenced, thisMembers };
}

function isClassMemberDeclaration(
  node: ts.Node,
): node is ts.MethodDeclaration | ts.PropertyDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration {
  return ts.isMethodDeclaration(node)
    || ts.isPropertyDeclaration(node)
    || ts.isGetAccessorDeclaration(node)
    || ts.isSetAccessorDeclaration(node);
}

function declaredNames(node: ts.Node): string[] {
  if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node)) return [node.name.text];
  if (ts.isImportClause(node) && node.name) return [node.name.text];
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) return [node.name.text];
  if ((ts.isFunctionDeclaration(node)
    || ts.isClassDeclaration(node)
    || ts.isInterfaceDeclaration(node)
    || ts.isTypeAliasDeclaration(node)
    || ts.isEnumDeclaration(node)) && node.name) {
    return [node.name.text];
  }
  if (ts.isBindingElement(node) && ts.isIdentifier(node.name)) return [node.name.text];
  return [];
}

/**
 * True when this identifier names something the module must still resolve, as
 * opposed to a declaration name, an object literal key, or a member name.
 */
function isReferencePosition(node: ts.Identifier, parent: ts.Node | undefined): boolean {
  if (!parent) return false;
  if (declaredNames(parent).includes(node.text) && (parent as { name?: ts.Node }).name === node) return false;
  if (isClassMemberDeclaration(parent) && parent.name === node) return false;
  if (ts.isPropertySignature(parent) && parent.name === node) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  if (ts.isMethodSignature(parent) && parent.name === node) return false;
  if (ts.isEnumMember(parent) && parent.name === node) return false;
  if (ts.isParameter(parent) && parent.name === node) return false;
  if (ts.isQualifiedName(parent) && parent.right === node) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  return true;
}
