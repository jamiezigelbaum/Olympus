import type { RawItem, SourceConnector } from './contracts.ts';

/** The classification label capabilities of connectors and archive formats. */
interface ConnectorLabelCapability {
  readonly provider: string;
  /** Where the mover gets current label membership for this item. */
  readonly proof: 'stored' | 'provider_walk';
  /** Absent when the connector computes labels from its provider context. */
  readonly metadataKey?: string;
}

export const NOTE_TAGS_METADATA_KEY = 'tags';
export const GMAIL_LABEL_CAPABILITY = { provider: 'gmail', proof: 'provider_walk', metadataKey: 'labels' } as const;
export const MBOX_LABEL_CAPABILITY = { provider: 'mbox', proof: 'stored', metadataKey: 'labels' } as const;
export const EVERNOTE_LABEL_CAPABILITY = { provider: 'evernote', proof: 'stored', metadataKey: NOTE_TAGS_METADATA_KEY } as const;
export const READWISE_LABEL_CAPABILITY = { provider: 'readwise', proof: 'stored', metadataKey: NOTE_TAGS_METADATA_KEY } as const;
export const REFLECT_LABEL_CAPABILITY = { provider: 'reflect', proof: 'stored', metadataKey: NOTE_TAGS_METADATA_KEY } as const;
export const TELEGRAM_LABEL_CAPABILITY = { provider: 'telegram', proof: 'stored' } as const;

const capabilities = [
  GMAIL_LABEL_CAPABILITY,
  MBOX_LABEL_CAPABILITY,
  EVERNOTE_LABEL_CAPABILITY,
  READWISE_LABEL_CAPABILITY,
  REFLECT_LABEL_CAPABILITY,
  TELEGRAM_LABEL_CAPABILITY,
] as const satisfies readonly ConnectorLabelCapability[];

export type LabelProofByProvider = {
  [Capability in (typeof capabilities)[number] as Capability['provider']]: Capability['proof'];
};

const byProvider = new Map<string, ConnectorLabelCapability>(capabilities.map(capability => [capability.provider, capability]));

export function connectorLabelCapability(provider: string): ConnectorLabelCapability | undefined {
  return byProvider.get(provider);
}

/** Only a provider's listing can attest an empty label set. Capture the exact
 * signals its classifier sees, including labels computed from item context. */
export function listedLabelObservation(connector: Pick<SourceConnector, 'classificationSignals'>, item: RawItem): string | undefined {
  if (connectorLabelCapability(item.identity.provider)?.proof !== 'stored') return undefined;
  return JSON.stringify([...new Set((connector.classificationSignals(item).labels ?? []).map(label => label.trim().toLowerCase()))].sort());
}
