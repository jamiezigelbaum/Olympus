import { OperationError } from '../operation-error.ts';
import type { SourceAnswerSelectedItemOption } from '../email.ts';
import { selectedItemContentFieldPath } from './selected-item-safety.ts';

export function optionalSourceAnswerSelectedItems(
  value: unknown,
  fallbackCorpusId?: SourceAnswerSelectedItemOption['corpus_id'],
): SourceAnswerSelectedItemOption[] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (!Array.isArray(value)) {
    throw new OperationError('invalid_params', 'selected_items must be an array.');
  }
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new OperationError('invalid_params', `selected_items.${index} must be an object.`);
    }
    const initialRecord = item as Record<string, unknown>;
    const forbiddenPath = selectedItemContentFieldPath(initialRecord);
    if (forbiddenPath) {
      throw new OperationError('invalid_params', `selected_items.${index} must not include source content field ${forbiddenPath}.`);
    }
    const record = selectedItemRecord(initialRecord, fallbackCorpusId);
    return {
      corpus_id: requiredSelectedItemString(record.corpus_id, `selected_items.${index}.corpus_id`),
      family: requiredSelectedItemString(record.family, `selected_items.${index}.family`),
      provider: requiredSelectedItemString(record.provider, `selected_items.${index}.provider`),
      account_scope: requiredSelectedItemString(record.account_scope, `selected_items.${index}.account_scope`),
      provider_item_id: requiredSelectedItemString(record.provider_item_id, `selected_items.${index}.provider_item_id`),
      local_item_id: requiredSelectedItemString(record.local_item_id, `selected_items.${index}.local_item_id`),
      ...optionalSelectedItemString(record.provider_thread_id, 'provider_thread_id'),
      ...optionalSelectedItemString(record.provider_conversation_id, 'provider_conversation_id'),
      ...optionalSelectedItemString(record.provider_file_id, 'provider_file_id'),
      ...optionalSelectedItemString(record.source_version, 'source_version'),
      ...optionalSelectedItemString(record.conversation_label, 'conversation_label'),
      ...optionalSelectedItemString(record.author_label, 'author_label'),
      ...optionalSelectedItemString(record.authored_at, 'authored_at'),
    };
  });
}

function selectedItemRecord(record: Record<string, unknown>, fallbackCorpusId?: string): Record<string, unknown> {
  const selectedItem = record.selected_item;
  if (selectedItem && typeof selectedItem === 'object' && !Array.isArray(selectedItem)) {
    return selectedItem as Record<string, unknown>;
  }
  const sourceItem = record.sourceItem;
  if (sourceItem && typeof sourceItem === 'object' && !Array.isArray(sourceItem)) {
    const source = sourceItem as Record<string, unknown>;
    return {
      corpus_id: record.corpus_id ?? fallbackCorpusId,
      family: source.family,
      provider: source.provider,
      account_scope: source.accountScope,
      provider_item_id: source.providerItemId,
      local_item_id: source.localItemId,
      provider_thread_id: source.providerThreadId,
      provider_conversation_id: source.providerConversationId,
      provider_file_id: source.providerFileId,
      source_version: source.sourceVersion,
    };
  }
  return {
    ...record,
    account_scope: record.account_scope ?? record.accountScope,
    provider_item_id: record.provider_item_id ?? record.providerItemId,
    local_item_id: record.local_item_id ?? record.localItemId,
    provider_thread_id: record.provider_thread_id ?? record.providerThreadId,
    provider_conversation_id: record.provider_conversation_id ?? record.providerConversationId,
    provider_file_id: record.provider_file_id ?? record.providerFileId,
    source_version: record.source_version ?? record.sourceVersion,
  };
}

function requiredSelectedItemString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 500) {
    throw new OperationError('invalid_params', `${name} must be a non-empty safe identifier string.`);
  }
  return value.trim();
}

function optionalSelectedItemString(value: unknown, key: keyof SourceAnswerSelectedItemOption): Partial<SourceAnswerSelectedItemOption> {
  if (value === undefined || value === null || value === '') return {};
  if (typeof value !== 'string' || value.length > 1_000) {
    throw new OperationError('invalid_params', `selected_items.${key} must be a safe string.`);
  }
  return { [key]: value.trim() };
}


export function sourceItemReadSelectedItem(value: unknown): SourceAnswerSelectedItemOption {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OperationError('invalid_params', 'selected_item is required.');
  return optionalSourceAnswerSelectedItems([value])![0]!;
}
export function sourceItemReadPage(value: unknown, name: string, max = Number.MAX_SAFE_INTEGER): number {
  if (value === undefined) return 1;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new OperationError('invalid_params', `${name} must be an integer from 1 to ${max}.`);
  }
  return value;
}
