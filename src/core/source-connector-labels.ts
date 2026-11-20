/** The classification label capabilities of connectors and archive formats. */
interface ConnectorLabelCapability {
  readonly provider: string;
  /** Absent when the connector computes labels from its provider context. */
  readonly metadataKey?: string;
}

export const NOTE_TAGS_METADATA_KEY = 'tags';
export const GMAIL_LABEL_CAPABILITY = { provider: 'gmail', metadataKey: 'labels' } as const;
export const MBOX_LABEL_CAPABILITY = { provider: 'mbox', metadataKey: 'labels' } as const;
export const EVERNOTE_LABEL_CAPABILITY = { provider: 'evernote', metadataKey: NOTE_TAGS_METADATA_KEY } as const;
export const READWISE_LABEL_CAPABILITY = { provider: 'readwise', metadataKey: NOTE_TAGS_METADATA_KEY } as const;
export const REFLECT_LABEL_CAPABILITY = { provider: 'reflect', metadataKey: NOTE_TAGS_METADATA_KEY } as const;
export const TELEGRAM_LABEL_CAPABILITY = { provider: 'telegram' } as const;

const capabilities: readonly ConnectorLabelCapability[] = [
  GMAIL_LABEL_CAPABILITY,
  MBOX_LABEL_CAPABILITY,
  EVERNOTE_LABEL_CAPABILITY,
  READWISE_LABEL_CAPABILITY,
  REFLECT_LABEL_CAPABILITY,
  TELEGRAM_LABEL_CAPABILITY,
];
const byProvider = new Map(capabilities.map(capability => [capability.provider, capability]));

export function connectorLabelCapability(provider: string): ConnectorLabelCapability | undefined {
  return byProvider.get(provider);
}
