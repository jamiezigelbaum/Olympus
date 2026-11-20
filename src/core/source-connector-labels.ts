import { signalText, signalTexts } from './classification-signals.ts';
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

export const storedLabelProviders = capabilities.filter(capability => capability.proof === 'stored').map(capability => capability.provider);

export type LabelProofByProvider = {
  [Capability in (typeof capabilities)[number] as Capability['provider']]: Capability['proof'];
};

const byProvider = new Map<string, ConnectorLabelCapability>(capabilities.map(capability => [capability.provider, capability]));

export function connectorLabelCapability(provider: string): ConnectorLabelCapability | undefined {
  return byProvider.get(provider);
}

/**
 * The names in an item's search context that are neither its chat nor its
 * sender: who a forward came from, and the names of its attachments. They
 * reach search and embedding input, so they are judged as the item's names.
 */
export function telegramContextNames({ metadata }: Pick<RawItem, 'metadata'>): string[] {
  const names: string[] = [];
  const forwardedFrom = signalText(metadata, 'forwardedFrom');
  if (forwardedFrom) names.push(`Forwarded from ${forwardedFrom}`);
  const attachmentNames = metadata['attachmentNames'];
  if (Array.isArray(attachmentNames)) {
    for (const name of attachmentNames) {
      if (typeof name === 'string' && name.trim() && !names.includes(name.trim())) names.push(name.trim());
    }
  }
  return names;
}

/** The same provider fields are read on listing and on recovery of retained names. */
export function providerMetadataLabels(provider: string, metadata: RawItem['metadata']): readonly string[] | undefined {
  const capability = connectorLabelCapability(provider);
  if (capability?.proof !== 'stored') return undefined;
  if (capability.metadataKey) {
    const values = metadata[capability.metadataKey];
    if (!Array.isArray(values)) return undefined;
    if (capability === MBOX_LABEL_CAPABILITY) return values.filter((entry): entry is string => typeof entry === 'string');
    return signalTexts(metadata, capability.metadataKey);
  }
  if (!Array.isArray(metadata.attachmentNames) && typeof metadata.forwardedFrom !== 'string') return undefined;
  return telegramContextNames({ metadata });
}

export function encodeLabelObservation(labels: readonly string[]): string {
  return JSON.stringify([...new Set(labels.map(label => label.trim().toLowerCase()))].sort());
}

/** Capture the exact listed signals, including labels computed from item context. */
export function listedLabelObservation(connector: Pick<SourceConnector, 'classificationSignals'>, item: RawItem): string | undefined {
  if (connectorLabelCapability(item.identity.provider)?.proof !== 'stored') return undefined;
  return encodeLabelObservation(connector.classificationSignals(item).labels ?? []);
}
