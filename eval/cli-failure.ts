// How the passage CLIs end: a failure names the stage it was in and the
// error's class (plus a code such as SQLITE_BUSY or ENOMEM), never its message,
// which can carry item text. Each stage is also printed to stderr as it
// starts, so a run that hangs shows where.

const CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

export interface EvalStage { name: string }

/** Only bounded machine codes may cross the content-free receipt/log boundary. */
export function failureCode(error: unknown): string | undefined {
  const code = error instanceof Error ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && CODE.test(code) ? code : undefined;
}

export function failureLine(label: string, stage: string, error: unknown): string {
  const kind = error instanceof Error ? (error.constructor?.name || error.name || 'Error') : typeof error;
  const code = failureCode(error);
  return `${label} failed at ${stage}: ${kind}${code ? ` (${code})` : ''}; no content is logged.`;
}

/** Run a CLI's main with a shared stage, then exit: 0 on success, 1 with the failure line. */
export function runEvalCli(label: string, main: (stage: EvalStage) => Promise<void>): void {
  const stage: EvalStage = { name: 'start' };
  // The embedding and reranker helpers keep the event loop alive after the
  // work is done, so the CLI exits itself once main settles.
  main(stage).then(() => process.exit(process.exitCode ?? 0), (error: unknown) => {
    console.error(failureLine(label, stage.name, error));
    process.exit(1);
  });
}

/** Set the stage and print it (counts and step names only). */
export function enterStage(stage: EvalStage | undefined, name: string, label: string): void {
  if (!stage) return;
  stage.name = name;
  console.error(`${label}: ${name}`);
}
