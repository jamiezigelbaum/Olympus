// Shared shapes and paths for the calibration kit. The kit's data lives in an
// owner-only directory outside the repository and outside Olympus's own data
// directory, so nothing here can change what Olympus stores or serves.

import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const CALIBRATION_DIR_DEFAULT = process.env.OLYMPUS_CALIBRATION_DIR?.trim()
  || join(homedir(), '.local', 'share', 'olympus-calibration');
export const SAMPLE_FILE = 'sample.json';
export const LABELS_FILE = 'labels.json';

export interface CalibrationSampleItem {
  id: string;
  path: string;
  /** Path relative to the sampled root: the folder path the classifier sees. */
  rel: string;
  name: string;
  area: string;
  mimeType: string;
  sizeBytes: number;
  modifiedAt: string;
  recordsHint: boolean;
  /** Extracted text, bounded. */
  text: string;
}

export interface CalibrationSample {
  version: 1;
  createdAt: string;
  root: string;
  seed: number;
  candidates: number;
  items: CalibrationSampleItem[];
}

export type CalibrationLabel = 'personal' | 'private' | 'unsure' | 'skip';

export interface CalibrationLabels {
  version: 1;
  labels: Record<string, { label: CalibrationLabel; at: string }>;
}

export function readSample(dir: string): CalibrationSample {
  const path = join(dir, SAMPLE_FILE);
  if (!existsSync(path)) throw new Error(`No sample at ${path}. Run: bun eval/calibration/sample.ts`);
  return JSON.parse(readFileSync(path, 'utf8')) as CalibrationSample;
}

export function readLabels(dir: string): CalibrationLabels {
  const path = join(dir, LABELS_FILE);
  if (!existsSync(path)) return { version: 1, labels: {} };
  return JSON.parse(readFileSync(path, 'utf8')) as CalibrationLabels;
}

/** Atomic, owner-only write: a crash mid-write never loses earlier labels. */
export function writeLabels(dir: string, labels: CalibrationLabels): void {
  const path = join(dir, LABELS_FILE);
  const temp = `${path}.tmp`;
  writeFileSync(temp, JSON.stringify(labels, null, 1), { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}
