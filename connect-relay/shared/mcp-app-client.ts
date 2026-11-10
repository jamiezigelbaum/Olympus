/** Host-specific presentation for the shared MCP App. Never apply copy rewriting to user data. */
import { createHash } from 'node:crypto';

export interface McpAppClient {
  host: 'claude';
  /** The public connector URL, including /mcp (not the directory endpoint). */
  connectorUrl: string;
}

/** Claude's ui.domain format: https://claude.com/docs/connectors/building/mcp-apps/getting-started */
export function claudeAppDomain(connectorUrl: string): string {
  return `${createHash('sha256').update(connectorUrl).digest('hex').slice(0, 32)}.claudemcpcontent.com`;
}

/** Static tool definitions, panel HTML and fixed product copy only; metadata keys stay intact. */
export function appClientCopy<T>(value: T, client?: McpAppClient): T {
  if (!client) return value;
  if (typeof value === 'string') {
    // The archive importer still reads conversations.json; do not invent support for a different export format.
    return value.replaceAll('a ChatGPT data export (the .zip from Settings, Data controls, Export data, or the conversations.json in it)',
      'a chat data export (a conversations.json file or the .zip containing it)').replaceAll('ChatGPT', 'Claude') as T;
  }
  if (Array.isArray(value)) return value.map(item => appClientCopy(item, client)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, appClientCopy(item, client)])) as T;
  }
  return value;
}

export function appResourceMeta(meta: Record<string, unknown>, client?: McpAppClient): Record<string, unknown> {
  if (!client) return meta;
  return {
    ...appClientCopy(meta, client),
    ui: { ...(meta.ui as object), domain: claudeAppDomain(client.connectorUrl) },
  };
}
