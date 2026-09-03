import { describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultConfig } from '../src/core/config.ts';
import { exposedOperations } from '../src/core/operation-exposure.ts';
import { operations } from '../src/core/operations.ts';
import {
  V0_4_CANONICAL_DOCUMENTS,
  V0_4_HERMES_MCP_TOOLS,
  V0_4_PUBLIC_CLI_OPERATIONS,
  V0_4_PUBLIC_CLI_GLOBALS,
  V0_4_PUBLIC_CONNECT_SOURCES,
  V0_4_PUBLIC_MCP_TOOLS,
  V0_4_PUBLIC_NATIVE_TOOLS,
  V0_4_PUBLIC_PACKAGE_FILES,
  V0_4_PUBLIC_PACKAGE_BUILD_READY,
  V0_4_SOURCE_CHECKOUT_PACKAGE_FILES,
  V0_4_SOURCE_CHECKOUT_PACKAGE_NAME,
  V0_4_PUBLIC_PLUGIN_CONFIG_KEYS,
  V0_4_PUBLIC_SKILL_DIRS,
  V0_4_PUBLIC_SOURCE_IDS,
  V0_4_PUBLIC_DASHBOARD_ROUTES,
  isV04PublicDashboardRoute,
} from '../src/core/public-surface.ts';
import { DASHBOARD_SUPPORTED_SOURCES } from '../src/workers/source-dashboard.ts';
import { defaultSourceCorpusRegistryConfig } from '../src/core/source-corpus-registry.ts';
import {
  V0_4_PUBLIC_SOURCE_CAPABILITIES,
  publicSourceDoctorLanes,
  renderPublicSourceCapabilitiesMarkdown,
} from '../src/core/public-source-capabilities.ts';

const ROOT = join(import.meta.dir, '..');

describe('v0.4 positive public surface', () => {
  test('declared operation surfaces exist, are unique, and are the only exposed operations', () => {
    const known = new Set(operations.map((operation) => operation.name));
    const config = defaultConfig();

    for (const [surface, names] of [
      ['native', V0_4_PUBLIC_NATIVE_TOOLS],
      ['mcp', V0_4_PUBLIC_MCP_TOOLS],
      ['cli', V0_4_PUBLIC_CLI_OPERATIONS],
    ] as const) {
      expect(new Set(names).size).toBe(names.length);
      for (const name of names) expect(known.has(name)).toBe(true);
      expect(exposedOperations(operations, { config, surface }).map((operation) => operation.name))
        .toEqual([...names]);
    }
    expect(V0_4_HERMES_MCP_TOOLS.every((name) => V0_4_PUBLIC_MCP_TOOLS.includes(name))).toBe(true);
    expect(new Set(V0_4_PUBLIC_CLI_GLOBALS).size).toBe(V0_4_PUBLIC_CLI_GLOBALS.length);
  });

  test('OpenClaw manifests publish exactly the positive tool and skill lists', () => {
    const plugin = JSON.parse(readFileSync(join(ROOT, 'openclaw.plugin.json'), 'utf8')) as {
      contracts: { tools: string[] };
      skills: string[];
      configSchema: {
        properties: Record<string, unknown>;
        $defs: {
          sourceCorpus: {
            properties: Record<string, { enum?: string[] }>;
            required: string[];
            oneOf: Array<{
              properties: {
                corpusId: { const: string };
                sourceId: { const: string };
                provider: { const: string };
                family: { const: string };
                trustDomain: { const: string };
                capabilities: { items: { enum: string[] } };
              };
            }>;
          };
        };
      };
      uiHints: Record<string, { label?: string; help?: string; sensitive?: boolean }>;
    };
    const skillManifest = JSON.parse(readFileSync(join(ROOT, 'skills/manifest.json'), 'utf8')) as {
      skills: Array<{ path: string }>;
    };

    expect(plugin.contracts.tools).toEqual([...V0_4_PUBLIC_NATIVE_TOOLS]);
    expect(plugin.skills).toEqual([...V0_4_PUBLIC_SKILL_DIRS]);
    expect(Object.keys(plugin.configSchema.properties)).toEqual([...V0_4_PUBLIC_PLUGIN_CONFIG_KEYS]);
    expect(Object.keys(plugin.uiHints)).toEqual(['argus', 'sovereignty', 'email', 'sourceIndex', 'worker.authToken']);
    // A bearer token must never render in the clear in Control UI or a config read.
    expect(plugin.uiHints['worker.authToken']).toMatchObject({ sensitive: true });
    expect(plugin.configSchema.$defs.sourceCorpus.properties.sourceId?.enum).toEqual([...V0_4_PUBLIC_SOURCE_IDS]);
    expect(plugin.configSchema.$defs.sourceCorpus.properties.provider?.enum)
      .toEqual(['gmail', 'google_drive', 'dropbox', 'x', 'telegram', 'whatsapp', 'readwise']);
    expect(plugin.configSchema.$defs.sourceCorpus.properties.family?.enum)
      .toEqual(['email', 'file', 'chat', 'readwise', 'x']);
    expect(plugin.configSchema.$defs.sourceCorpus.properties.activationMode?.enum)
      .toEqual(['lexical_only', 'hybrid_shadow', 'hybrid_primary']);
    expect(plugin.configSchema.$defs.sourceCorpus.required)
      .toEqual(['corpusId', 'sourceId', 'provider', 'family', 'trustDomain', 'capabilities']);
    const schemaCorpora = plugin.configSchema.$defs.sourceCorpus.oneOf.map((branch) => ({
      corpusId: branch.properties.corpusId.const,
      sourceId: branch.properties.sourceId.const,
      provider: branch.properties.provider.const,
      family: branch.properties.family.const,
      trustDomain: branch.properties.trustDomain.const,
      capabilities: branch.properties.capabilities.items.enum,
    }));
    const runtimeCorpora = defaultSourceCorpusRegistryConfig().corpora.map((corpus) => ({
      corpusId: corpus.corpusId,
      sourceId: corpus.sourceId,
      provider: corpus.provider,
      family: corpus.family,
      trustDomain: corpus.trustDomain,
      capabilities: corpus.capabilities,
    }));
    expect(schemaCorpora).toEqual(runtimeCorpora);
    const worker = plugin.configSchema.properties.worker as {
      properties: {
        scheduler: {
          properties: { sourceIds: { items: { enum: string[] } } };
        };
      };
    };
    expect(worker.properties.scheduler.properties.sourceIds.items.enum)
      .toEqual([...V0_4_PUBLIC_SOURCE_IDS]);
    expect(skillManifest.skills.map((skill) => skill.path.replace(/\/SKILL\.md$/, '')))
      .toEqual([...V0_4_PUBLIC_SKILL_DIRS]);
  });

  test('package and canonical-document allowlists contain exact existing files only', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      files?: string[];
      scripts?: Record<string, string>;
    };
    expect(new Set(V0_4_PUBLIC_PACKAGE_FILES).size).toBe(V0_4_PUBLIC_PACKAGE_FILES.length);
    for (const path of V0_4_PUBLIC_PACKAGE_FILES) {
      expect(existsSync(join(ROOT, path))).toBe(true);
      expect(path.endsWith('/')).toBe(false);
      const stat = lstatSync(join(ROOT, path));
      expect(stat.isFile()).toBe(true);
      expect(stat.isSymbolicLink()).toBe(false);
    }
    for (const path of V0_4_CANONICAL_DOCUMENTS) {
      expect(V0_4_PUBLIC_PACKAGE_FILES.includes(path)).toBe(true);
    }
    expect(V0_4_CANONICAL_DOCUMENTS).not.toContain('docs/ARCHITECTURE.md');
    expect(V0_4_PUBLIC_PACKAGE_FILES).not.toContain('docs/ARCHITECTURE.md');
    expect(pkg).toMatchObject({
      name: V0_4_SOURCE_CHECKOUT_PACKAGE_NAME,
      private: true,
      files: [...V0_4_SOURCE_CHECKOUT_PACKAGE_FILES],
    });
    expect(pkg.scripts?.prepack).toBe('bun scripts/standard-pack-guard.ts');
  });

  test('dashboard and connection rosters are exactly the seven declared sources', () => {
    expect(DASHBOARD_SUPPORTED_SOURCES.map((source) => source.source_id))
      .toEqual([...V0_4_PUBLIC_SOURCE_IDS]);
    expect(V0_4_PUBLIC_CONNECT_SOURCES).not.toContain('gcp');
    expect(V0_4_PUBLIC_CONNECT_SOURCES).not.toContain('notion');
    expect(V0_4_PUBLIC_CONNECT_SOURCES).not.toContain('x');
  });

  test('dashboard routing fails closed outside the exact positive route list', () => {
    for (const route of V0_4_PUBLIC_DASHBOARD_ROUTES) {
      const samplePath = route.prefix ? `${route.path}gmail` : route.path;
      expect(isV04PublicDashboardRoute(route.method, samplePath)).toBe(true);
    }
    expect(isV04PublicDashboardRoute('POST', '/dashboard')).toBe(false);
    expect(isV04PublicDashboardRoute('GET', '/dashboard/private-ops')).toBe(false);
    expect(isV04PublicDashboardRoute('POST', '/dashboard/data/delete')).toBe(false);
    expect(isV04PublicDashboardRoute('POST', '/oauth/callback/gmail')).toBe(false);
  });

  test('one complete connector-owned catalog feeds dashboard, doctor, and docs', () => {
    expect(V0_4_PUBLIC_SOURCE_CAPABILITIES.map((source) => source.source_id))
      .toEqual([...V0_4_PUBLIC_SOURCE_IDS]);
    const doctorLanes = publicSourceDoctorLanes();
    expect([...new Set(doctorLanes.map((lane) => lane.sourceId))])
      .toEqual([...V0_4_PUBLIC_SOURCE_IDS]);
    expect(doctorLanes.filter((lane) => lane.sourceId === 'gmail.email').map((lane) => lane.corpusId).sort())
      .toEqual(['internal.email', 'secure_local.email.private']);
    expect(doctorLanes.filter((lane) => lane.sourceId === 'google_drive.docs').map((lane) => lane.corpusId).sort())
      .toEqual(['internal.drive.docs', 'secure_local.drive.docs']);
    expect(doctorLanes.filter((lane) => lane.sourceId === 'telegram.messages').map((lane) => lane.corpusId).sort())
      .toEqual(['internal.telegram.messages', 'secure_local.telegram.protected.messages']);
    for (const source of V0_4_PUBLIC_SOURCE_CAPABILITIES) {
      expect(source.authentication.type.length).toBeGreaterThan(0);
      expect(source.authentication.ownership.length).toBeGreaterThan(0);
      expect(source.contextual_scopes.length).toBeGreaterThan(0);
      expect(source.dependencies.length).toBeGreaterThan(0);
      expect(source.provider_ceiling.length).toBeGreaterThan(0);
      expect(source.supported_formats.length).toBeGreaterThan(0);
    }

    const docs = readFileSync(join(ROOT, 'docs/SOURCE_CAPABILITIES.md'), 'utf8');
    const rendered = docs.match(
      /<!-- V0_4_PUBLIC_SOURCE_CAPABILITIES_START -->\n([\s\S]*?)\n<!-- V0_4_PUBLIC_SOURCE_CAPABILITIES_END -->/,
    )?.[1];
    expect(rendered).toBe(renderPublicSourceCapabilitiesMarkdown());

    const dashboardSource = readFileSync(join(ROOT, 'src/workers/source-dashboard.ts'), 'utf8');
    expect(dashboardSource).toContain('renderPublicSourceCapabilityForDashboard');
    const doctorSource = readFileSync(join(ROOT, 'src/core/doctor.ts'), 'utf8');
    expect(doctorSource).toContain('publicSourceDoctorLanes');
  });

  test('release builder consumes the one exact-file allowlist', () => {
    const source = readFileSync(join(ROOT, 'scripts/release-artifact.ts'), 'utf8');
    expect(source).toContain('V0_4_PUBLIC_PACKAGE_FILES');
    expect(source).toContain("from '../src/core/public-surface.ts';");
    expect(source).toContain('for (const path of V0_4_PUBLIC_PACKAGE_FILES)');
    expect(source).not.toContain("'skills',");
    expect(source).not.toContain("'dist',");
    expect(source).not.toContain("'bin',");
    expect(V0_4_PUBLIC_PACKAGE_BUILD_READY).toBe(true);
    expect(source).toContain('if (!V0_4_PUBLIC_PACKAGE_BUILD_READY)');
  });
});
