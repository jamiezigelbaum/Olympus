const FORBIDDEN_SELECTED_ITEM_CONTENT_FIELDS = new Set([
  'body',
  'boundedtext',
  'chunk',
  'chunks',
  'content',
  'document',
  'html',
  'markdown',
  'message',
  'messages',
  'packet',
  'passage',
  'raw',
  'rawpacket',
  'rawsource',
  'rawtext',
  'snippet',
  'sourcepacket',
  'sourcesnippet',
  'sourcetext',
  'text',
]);

export function selectedItemContentFieldPath(value: unknown): string | undefined {
  return selectedItemContentFieldPathInner(value, 'selected_items');
}

function selectedItemContentFieldPathInner(value: unknown, path: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const nested = selectedItemContentFieldPathInner(value[index], `${path}.${index}`);
      if (nested) return nested;
    }
    return undefined;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    if (FORBIDDEN_SELECTED_ITEM_CONTENT_FIELDS.has(normalizeSelectedItemField(key))) {
      return `${path}.${key}`;
    }
    const nested = selectedItemContentFieldPathInner(nestedValue, `${path}.${key}`);
    if (nested) return nested;
  }
  return undefined;
}

function normalizeSelectedItemField(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}
