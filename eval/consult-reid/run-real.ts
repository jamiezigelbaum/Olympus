// Records the REAL local writer's outputs for the re-identification cases
// (eval/consult-reid/cases.ts) and the unnamed-level gate set
// (eval/consult-leak/unnamed-questions.ts), for score.ts and
// unnamed-level.ts to grade deterministically in CI.
//
// The writer is exactly the product's: runConsultWriter on its own
// createConsultWriterServer process (src/core/consult-writer.ts), over the
// real prompt for the chosen level, the real token bound and the product's
// memory rule, on the built-in model already installed on this Mac (read
// only; nothing is downloaded). It is the same model file as the answer
// server, as in the product.
//
// Safety: it refuses to start if any llama-server process is running (the
// live engine's answer server, or another writer), so it never competes with
// a private answer; the writer server is started by this script, kept warm
// for the run, and SIGKILLed at the end, including on failure or Ctrl-C.
// No consult is sent anywhere: nothing here talks to zkAPI or any network.
//
// Apple silicon only (the built-in model's Metal build). Run:
//   bun eval/consult-reid/run-real.ts [--level unnamed|general] [--set reid|unnamed|both]
// It writes eval/consult-reid/recorded.json (reid set) and
// eval/consult-reid/recorded-unnamed-set.json (unnamed gate set) for the
// level `unnamed`, or the same names with `-general` for the general level.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createConsultWriterServer,
  consultWriterSystem,
  defaultConsultMemoryProbe,
  runConsultWriter,
  type ConsultWriterInput,
  type ConsultWriterOutcome,
} from '../../src/core/consult-writer.ts';
import type { ConsultLevel } from '../../src/core/consult-gate.ts';
import { LLAMA_SERVER_RUNTIME, QWEN35_4B } from '../../src/workers/source-index/built-in-reasoning/manifest.ts';
import { UNNAMED_CASES } from '../consult-leak/unnamed-questions.ts';
import { REID_CASES } from './cases.ts';
import { writerPromptSha256, type ReidOutput, type ReidRecording } from './score.ts';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const LEVEL = (arg('level') ?? 'unnamed') as ConsultLevel;
const SET = arg('set') ?? 'both';
if (LEVEL !== 'unnamed' && LEVEL !== 'general') throw new Error('--level must be unnamed or general');

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  console.error('The built-in writer runs on Apple silicon only. Not run.');
  process.exit(2);
}

/** Every llama-server process now (read-only ps; shells that only mention the name do not count). */
function llamaServers(): number[] {
  const out = execFileSync('/bin/ps', ['-axo', 'pid=,comm='], { encoding: 'utf8' });
  return out.split('\n').map((line) => line.trim().split(/\s+/)).filter(([, comm]) => comm !== undefined && /(^|\/)llama-server$/.test(comm)).map(([pid]) => Number(pid));
}

const others = llamaServers();
if (others.length > 0) {
  console.error(`Refusing: ${others.length} llama-server process(es) already running (the live engine or another writer). Not run.`);
  process.exit(3);
}

const root = join(process.env.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share'), 'openclaw', 'olympus', 'models', 'built-in-reasoning');
const modelPath = join(root, QWEN35_4B.modelId, QWEN35_4B.file.name);
const runtimeDir = join(root, `llama.cpp-${LLAMA_SERVER_RUNTIME.release}-darwin-arm64`);
let serverPath = '';
try {
  const marker = JSON.parse(readFileSync(join(runtimeDir, 'olympus-runtime.json'), 'utf8')) as { serverPath?: string };
  serverPath = marker.serverPath ? join(runtimeDir, marker.serverPath) : '';
} catch {
  serverPath = '';
}
if (!existsSync(modelPath) || !serverPath || !existsSync(serverPath)) {
  console.error('The built-in model or its server is not installed on this Mac. Nothing is downloaded. Not run.');
  process.exit(2);
}

const scratch = mkdtempSync(join(tmpdir(), 'olympus-reid-'));
const server = createConsultWriterServer({ serverPath, modelPath, gpu: true }, { env: { ...process.env, TMPDIR: scratch }, warm: true });
const memory = defaultConsultMemoryProbe();
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await server.kill().catch(() => undefined);
  rmSync(scratch, { recursive: true, force: true });
};
process.on('SIGINT', () => void stop().then(() => process.exit(130)));
process.on('SIGTERM', () => void stop().then(() => process.exit(143)));

async function write(input: ConsultWriterInput): Promise<ReidOutput> {
  // Between calls: never beside a server this script did not start.
  const foreign = llamaServers().filter((pid) => pid !== server.pid);
  if (foreign.length > 0) throw new Error('another llama-server started during the run; stopping');
  const outcome: ConsultWriterOutcome = await runConsultWriter(input, {
    server,
    memory,
    kill: new AbortController().signal,
    keepWarm: true,
    level: LEVEL,
  });
  if (outcome.kind === 'questions') return { kind: 'questions', questions: [...outcome.questions], ms: outcome.ms };
  if (outcome.kind === 'declined') return { kind: 'declined', ms: outcome.ms };
  return { kind: outcome.kind, reason: outcome.reason };
}

async function record(cases: ReadonlyArray<{ id: string; userQuestion: string; answer: string; gaps: readonly string[] }>, file: string): Promise<void> {
  const outputs: Record<string, ReidOutput> = {};
  for (const entry of cases) {
    outputs[entry.id] = await write({ question: entry.userQuestion, answer: entry.answer, gaps: entry.gaps });
    console.log(`${entry.id}: ${JSON.stringify(outputs[entry.id])}`);
  }
  const recording: ReidRecording = {
    source: 'real-writer',
    model: `${QWEN35_4B.modelId} (llama.cpp ${LLAMA_SERVER_RUNTIME.release})`,
    promptSha256: writerPromptSha256(consultWriterSystem(LEVEL)),
    recordedAt: new Date().toISOString(),
    level: LEVEL,
    outputs,
  };
  writeFileSync(join(import.meta.dir, file), `${JSON.stringify(recording, null, 2)}\n`);
}

const suffix = LEVEL === 'unnamed' ? '' : '-general';
try {
  if (SET === 'reid' || SET === 'both') await record(REID_CASES, `recorded${suffix}.json`);
  if (SET === 'unnamed' || SET === 'both') await record(UNNAMED_CASES, `recorded-unnamed-set${suffix}.json`);
} finally {
  await stop();
}
