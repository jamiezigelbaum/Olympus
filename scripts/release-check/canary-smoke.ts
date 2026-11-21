import type { ModelSetupView } from '../../src/core/model-setup.ts';
import type { SovereigntyResolvedProfile } from '../../src/core/sovereignty.ts';

const STALL_MS = 5 * 60_000;
const MODEL_WAIT_MS = 30 * 60_000;
const POLL_MS = 3_000;

type ModelReadiness = Pick<ModelSetupView, 'ready' | 'private_model'>;

/** A retry resets the byte count. Only forward movement or the start of verification resets the stall clock. */
export async function waitForCanaryModels(
  probe: (remainingMs: number) => Promise<ModelReadiness | undefined>,
  clock: { now: () => number; sleep: (ms: number) => Promise<void> },
): Promise<{ ms: number; problem?: string }> {
  const started = clock.now();
  let lastProgress = started;
  let bytes = 0;
  let verifying = false;
  for (;;) {
    const deadline = Math.min(started + MODEL_WAIT_MS, lastProgress + STALL_MS);
    const before = clock.now();
    if (before < deadline) {
      const setup = await probe(deadline - before);
      const now = clock.now();
      if (now < started + MODEL_WAIT_MS) {
        if (setup?.ready) return { ms: now - started };
        const state = setup?.private_model;
        const done = state?.bytesDone ?? 0;
        if (done > bytes || (state?.state === 'verifying' && !verifying)) lastProgress = now;
        if (state?.bytesDone !== undefined) bytes = done;
        if (state?.state === 'verifying') verifying = true;
      }
    }
    const now = clock.now();
    const ms = now - started;
    if (ms >= MODEL_WAIT_MS) return { ms, problem: 'Private models were not ready within 30 minutes' };
    if (now - lastProgress >= STALL_MS) return { ms, problem: `Private models made no progress for 5 minutes (${bytes} download bytes seen)` };
    await clock.sleep(Math.min(POLL_MS, started + MODEL_WAIT_MS - now, lastProgress + STALL_MS - now));
  }
}

export interface CanarySmokeSettings {
  private_answer_mode?: { id?: string };
  models?: { local?: { current?: string } };
}

/** Report only the selected model, mode and endpoint host. Credentials in a URL never cross the machine boundary. */
export function describeCanaryPrivateModel(settings: CanarySmokeSettings | undefined, member: SovereigntyResolvedProfile | undefined): string {
  const mode = settings?.private_answer_mode?.id ?? 'unknown';
  const selected = settings?.models?.local?.current;
  if (selected?.startsWith('builtin:')) return `${selected} (built into Olympus; mode ${mode})`;
  const profile = member?.profile;
  const model = profile?.provider === 'local-openai-compatible' ? selected || profile.model : profile?.model ?? selected;
  let host: string | undefined;
  try { if (profile?.baseUrl) host = new URL(profile.baseUrl).host; } catch { /* no usable endpoint */ }
  return `${model || 'unknown'} (${[profile?.provider, host].filter(Boolean).join(' via ') || 'endpoint unknown'}; mode ${mode})`;
}
