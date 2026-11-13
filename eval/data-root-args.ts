import type { EvalDataRootOptions } from './data-root.ts';

/** Remove the shared offline boundary flags before a runner parses its own flags. */
export function parseDataRootArgs(argv: readonly string[]): { rest: string[]; isolation?: EvalDataRootOptions } {
  const rest: string[] = [];
  let dataRoot: string | undefined;
  const forbidRoots: string[] = [];
  let allowNoFdCheck = false;
  let allowUnreadableStores = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === '--allow-no-fd-check') { allowNoFdCheck = true; continue; }
    if (arg === '--allow-unreadable-stores') { allowUnreadableStores = true; continue; }
    const name = arg.split('=')[0]!;
    if (name === '--data-root' || name === '--forbid-root') {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[++index];
      if (!value || value.startsWith('--')) throw new Error('Offline root option requires a directory.');
      if (name === '--data-root') dataRoot = value; else forbidRoots.push(value);
    } else rest.push(arg);
  }
  if (!dataRoot && (forbidRoots.length || allowNoFdCheck || allowUnreadableStores)) throw new Error('--data-root is required with isolation options.');
  return { rest, ...(dataRoot ? { isolation: { dataRoot, forbidRoots, allowNoFdCheck, ...(allowUnreadableStores ? { allowUnreadableStores } : {}) } } : {}) };
}
export function dataRootArgv(options?: EvalDataRootOptions): string[] {
  return options ? ['--data-root', options.dataRoot, ...(options.forbidRoots ?? []).flatMap(root => ['--forbid-root', root]), ...(options.allowNoFdCheck ? ['--allow-no-fd-check'] : []), ...(options.allowUnreadableStores ? ['--allow-unreadable-stores'] : [])] : [];
}
