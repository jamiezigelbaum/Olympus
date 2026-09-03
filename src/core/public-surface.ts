/**
 * Olympus v0.4 public product surface.
 *
 * Positive lists are the release contract: repository-only and private-ops
 * capabilities may continue to exist in source while they are being moved or
 * deleted, but they cannot become public merely because a registry, directory,
 * or command dispatcher grows.
 */

export const V0_4_PUBLIC_NATIVE_TOOLS = [
  'argus_ping',
  'argus_list_models',
  'argus_complete',
  'source_answer',
  'source_index_status',
  'source_index_search',
  'source_watch_create',
  'source_watches',
  'source_watch_cancel',
  'olympus_doctor',
] as const;

export const V0_4_PUBLIC_MCP_TOOLS = [
  'argus_ping',
  'argus_list_models',
  'argus_complete',
  'source_answer',
  'source_index_status',
  'source_index_search',
  'olympus_doctor',
] as const;

// Operation names, not typed command lines. `olympus_doctor` is exposed to the
// CLI as the command `olympus doctor` through its cliHints; see
// V0_4_PUBLIC_CLI_COMMANDS for the user-facing command roster.
export const V0_4_PUBLIC_CLI_OPERATIONS = V0_4_PUBLIC_MCP_TOOLS;

export const V0_4_HERMES_MCP_TOOLS = [
  'source_answer',
  'source_index_status',
] as const;

export const V0_4_PUBLIC_SKILL_DIRS = [
  'skills/ask-argus',
  'skills/ask-sources',
] as const;

export const V0_4_PUBLIC_PACKAGE_NAME = 'olympus' as const;

// The source checkout is deliberately a different, private npm package. Even
// `npm pack --ignore-scripts` therefore cannot mint a same-name public artifact
// or select the repository's committed private runtime bundles.
export const V0_4_SOURCE_CHECKOUT_PACKAGE_NAME = 'olympus-source-checkout' as const;
export const V0_4_SOURCE_CHECKOUT_PACKAGE_FILES = [
  'LICENSE',
  'README.md',
] as const;

// Slice 3D builds public-only entrypoints and scans the exact npm archive for
// private code and tenant identities before these bytes can advance.
export const V0_4_PUBLIC_PACKAGE_BUILD_READY = true;

export const V0_4_PUBLIC_PLUGIN_CONFIG_KEYS = [
  'sovereignty',
  'worker',
  'identity',
  'argus',
  'email',
  'sourceIndex',
] as const;

export const V0_4_PUBLIC_CONNECT_SOURCES = [
  'google',
  'gmail',
  'google-drive',
  'dropbox',
  'telegram',
  'whatsapp',
  'venice',
  'readwise',
] as const;

export const V0_4_PUBLIC_SOURCE_IDS = [
  'gmail.email',
  'google_drive.docs',
  'dropbox.files',
  'x.bookmarks',
  'telegram.messages',
  'whatsapp.personal.messages',
  'readwise.library',
] as const;

export const V0_4_PUBLIC_CLI_COMMANDS = [
  'setup',
  'sovereignty init',
  'sensitivity validate',
  'worker install',
  'worker status',
  'worker start',
  'worker stop',
  'worker restart',
  'worker foreground',
  'worker upgrade',
  'worker uninstall',
  'worker run',
  'connect google',
  'connect gmail',
  'connect google-drive',
  'connect dropbox',
  'connect telegram',
  'connect whatsapp',
  'connect venice',
  'connect readwise',
  'connect status',
  'dashboard',
  'source answer',
  'source index status',
  'source index search',
  'data export',
  'data verify',
  'data delete',
  'doctor',
  'argus ping',
  'argus list',
  'argus complete',
  'serve',
] as const;

export const V0_4_PUBLIC_CLI_GLOBALS = [
  '--help',
  '-h',
  '--version',
  'version',
  '--tools-json',
] as const;

// Opaque subprocess entrypoints required by a declared public command. They
// are packaged implementation details, not advertised user commands.
export const V0_4_PACKAGE_INTERNAL_CLI_HELPERS = [
  '__oauth-detached-child',
  '__worker-service-run',
] as const;

export interface PublicDashboardRoute {
  method: 'GET' | 'POST';
  path: string;
  prefix?: true;
}

export const V0_4_PUBLIC_DASHBOARD_ROUTES: readonly PublicDashboardRoute[] = [
  { method: 'GET', path: '/dashboard' },
  { method: 'GET', path: '/dashboard.json' },
  { method: 'GET', path: '/dashboard/auth-check' },
  { method: 'POST', path: '/dashboard/control/session' },
  { method: 'GET', path: '/dashboard/dispositions' },
  { method: 'GET', path: '/dashboard/dispositions.json' },
  { method: 'POST', path: '/dashboard/dispositions' },
  { method: 'GET', path: '/oauth/callback/', prefix: true },
  { method: 'POST', path: '/dashboard/connect/oauth/start' },
  { method: 'POST', path: '/dashboard/connect/oauth/cancel' },
  { method: 'POST', path: '/dashboard/connect/api-key' },
  { method: 'POST', path: '/dashboard/sync-now' },
  { method: 'POST', path: '/dashboard/embedding-priority' },
  { method: 'POST', path: '/dashboard/disconnect' },
  { method: 'POST', path: '/dashboard/unpair' },
] as const;

export const V0_4_CANONICAL_DOCUMENTS = [
  'README.md',
  'INSTALL_FOR_AGENTS.md',
  'CONTRIBUTING.md',
  'docs/QUICKSTART.md',
  'docs/CONTRACTS.md',
  'docs/SOURCE_CAPABILITIES.md',
  'docs/TRUST_MODEL.md',
  'docs/SOVEREIGNTY_CONFIG.md',
  'docs/UNINSTALL.md',
  'docs/V0_4_RELEASE.md',
] as const;

export const V0_4_PUBLIC_PACKAGE_FILES = [
  'package.json',
  'openclaw.plugin.json',
  'index.js',
  'LICENSE',
  'CHANGELOG.md',
  'README.md',
  'INSTALL_FOR_AGENTS.md',
  'CONTRIBUTING.md',
  'bin/olympus',
  'dist/index.js',
  'dist/cli.js',
  'skills/manifest.json',
  'skills/ask-argus/SKILL.md',
  'skills/ask-sources/SKILL.md',
  'config/olympus.example.json',
  'config/source-ingestion/dropbox.personal.ingestion.json',
  'config/sovereignty/presets/local-first.json',
  'config/sovereignty/presets/local-only.json',
  'config/sovereignty/presets/private-cloud-only.json',
  'config/sovereignty/presets/no-sensitive.json',
  'config/hermes/olympus.mcp.yaml',
  'integrations/hermes/ask-sources/SKILL.md',
  'docs/QUICKSTART.md',
  'docs/CONTRACTS.md',
  'docs/SOURCE_CAPABILITIES.md',
  'docs/TRUST_MODEL.md',
  'docs/SOVEREIGNTY_CONFIG.md',
  'docs/UNINSTALL.md',
  'docs/V0_4_RELEASE.md',
] as const;

const PUBLIC_OPERATION_NAMES = {
  native: new Set<string>(V0_4_PUBLIC_NATIVE_TOOLS),
  mcp: new Set<string>(V0_4_PUBLIC_MCP_TOOLS),
  cli: new Set<string>(V0_4_PUBLIC_CLI_OPERATIONS),
} as const;

export function isV04PublicOperation(
  surface: keyof typeof PUBLIC_OPERATION_NAMES,
  operationName: string,
): boolean {
  return PUBLIC_OPERATION_NAMES[surface].has(operationName);
}

export function isV04PublicDashboardRoute(method: string, pathname: string): boolean {
  return V0_4_PUBLIC_DASHBOARD_ROUTES.some((route) =>
    route.method === method
    && (route.prefix === true ? pathname.startsWith(route.path) : pathname === route.path));
}
