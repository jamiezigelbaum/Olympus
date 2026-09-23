import { loadSensitivityMap, type SensitivityMap } from '../../core/sensitivity-map.ts';

export function loadGoogleSensitivityMap(
  env: Record<string, string | undefined> = process.env,
): SensitivityMap | undefined {
  return loadSensitivityMap({ env, allowMissing: true, ignoreInvalid: true });
}

export function accountFromGoogleHandle(handle: string | undefined, fallback = 'personal'): string {
  const trimmed = handle?.trim();
  if (!trimmed) return fallback;
  const match = /^[a-z_]+\.([a-z0-9_-]+)(?:\.|$)/i.exec(trimmed);
  return match?.[1] ?? fallback;
}

export function metadataString(metadata: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function metadataStringArray(metadata: Readonly<Record<string, unknown>>, key: string): string[] {
  const value = metadata[key];
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => typeof item === 'string' ? item.trim() : '')
    .filter(Boolean);
}
