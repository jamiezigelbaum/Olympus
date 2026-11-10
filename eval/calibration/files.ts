// Shared shapes and paths for the calibration kit. The kit's data lives in an
// owner-only directory outside the repository and outside Olympus's own data
// directory, so nothing here can change what Olympus stores or serves.

import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SourceClassificationSignals } from '../../src/core/contracts.ts';

export const CALIBRATION_DIR_DEFAULT = process.env.OLYMPUS_CALIBRATION_DIR?.trim()
  || join(homedir(), '.local', 'share', 'olympus-calibration');
export const SAMPLE_FILE = 'sample.json';
export const LABELS_FILE = 'labels.json';
export const IMPORTANCE_FILE = 'importance.json';

/** A neighbouring message shown to the owner as context. Never judged, never labeled. */
export interface CalibrationContextMessage {
  at: string;
  sender: string;
  text: string;
}

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
  /** Message and email items: the source the classifier is told. Files leave it out. */
  source?: string;
  /** How the item was sampled, for reweighting a score to the natural mix. Never shown when labeling. */
  stratum?: string;
  /** The item's stored names, as the classifier reads them. */
  signals?: SourceClassificationSignals;
  /** The private judge's exact input for this item: what the labeling page shows. */
  judgeSees?: string;
  /** True when `judgeSees` is the production question itself, false when it was rebuilt from the store. */
  judgeSeesExact?: boolean;
  /** The messages either side of this one, for the owner only: judge runs ignore this. */
  context?: { before: CalibrationContextMessage[]; after: CalibrationContextMessage[] };
  /** Whole-item samples: the half this item scores in, chosen by its related group, not its id. */
  split?: 'dev' | 'test';
  /** Whole-item samples: the chance this item had of being drawn (its cell's drawn / population). */
  inclusionProbability?: number;
  /** Whole-item samples: everything else the owner sees and the scorer counts. */
  whole?: WholeItemDetail;
}

/** How an item's text was read, by kinds and statuses only. */
export interface ExtractionNote {
  /** read: text extracted; ocr: read from a scan or picture; failed: no usable text; pending: not read yet. */
  outcome: 'read' | 'ocr' | 'transcript' | 'failed' | 'pending';
  status: string;
  extractorKind: string;
  errorKind?: string;
  artifactKinds: string[];
  warnings: string[];
}

export interface WholeItemChild {
  name: string;
  mimeType: string;
  text: string;
  truncatedChars: number;
  extraction?: ExtractionNote;
}

export interface WholeItemDetail {
  /** Conversation, folder or (for email) sender keys: related items share one. */
  groups: string[];
  /** The item's own text was longer than the page keeps; this many characters are not shown. */
  truncatedChars: number;
  /** Attachments and other child items, each whole. */
  children: WholeItemChild[];
  extraction?: ExtractionNote;
  /** The judge reads all of the item's own text (false: only an excerpt). */
  judgeReadsAll: boolean;
  /** The shared injection screen holds this item's judge input: no model reads it. */
  injection: boolean;
}

export interface CalibrationSample {
  version: 1;
  createdAt: string;
  root: string;
  seed: number;
  candidates: number;
  items: CalibrationSampleItem[];
  /** How a message sample was drawn. */
  recipe?: unknown;
}

export type CalibrationLabel = 'personal' | 'private' | 'secret' | 'unsure' | 'skip';

/**
 * The side a label is scored on by score.ts and judge-run.ts: Secret counts as
 * Private (it must never be Personal); Not sure, Skip and no label are not scored.
 */
export function scoredTier(label: string | undefined): 'personal' | 'private' | undefined {
  if (label === 'personal') return 'personal';
  return label === 'private' || label === 'secret' ? 'private' : undefined;
}

/** Whole-item pass: where the sensitive part of a Private or Secret item is. */
export type SensitiveWhere = 'excerpt' | 'outside' | 'attachment' | 'names';

export interface CalibrationLabels {
  version: 1;
  labels: Record<string, {
    label: CalibrationLabel;
    at: string;
    correctedInImportancePass?: true;
    /** Whole-item pass: how much a Private item matters, given with the label. */
    importance?: PrivateImportance;
    where?: SensitiveWhere;
  }>;
}

/** How much an item the owner called Private matters: a second pass, kept apart from the labels. */
export type PrivateImportance = 'important' | 'minor' | 'unsure';

export interface CalibrationImportance {
  version: 1;
  labels: Record<string, { label: PrivateImportance; at: string }>;
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

export function readImportance(dir: string): CalibrationImportance {
  const path = join(dir, IMPORTANCE_FILE);
  if (!existsSync(path)) return { version: 1, labels: {} };
  return JSON.parse(readFileSync(path, 'utf8')) as CalibrationImportance;
}

/** Atomic, owner-only write: a crash mid-write never loses earlier labels. */
function writeOwnerOnly(path: string, value: unknown): void {
  const temp = `${path}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 1), { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

export function writeLabels(dir: string, labels: CalibrationLabels): void {
  writeOwnerOnly(join(dir, LABELS_FILE), labels);
}

export function writeImportance(dir: string, importance: CalibrationImportance): void {
  writeOwnerOnly(join(dir, IMPORTANCE_FILE), importance);
}
