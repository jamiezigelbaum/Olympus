import type {
  EmailSourceConnector,
  EmailSourceHealth,
} from './index.ts';

const COMMAND_TIMEOUT_EXIT_CODE = 124;
const COMMAND_TIMEOUT_KILL_GRACE_MS = 500;

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(command: string, args: string[], options?: { timeoutMs?: number }): Promise<CommandResult>;
}

export interface GogcliEmailConnectorOptions {
  command?: string;
  account?: string;
  authMode?: GogcliAuthMode;
  runner?: CommandRunner;
}

export type GogcliAuthMode = 'oauth' | 'service-account';

/**
 * Health-only Gmail connector probe.
 *
 * Ingestion belongs to GoogleGmailSourceConnector and answers belong to the
 * shared Analyst. Keeping gogcli here only preserves the local-session health
 * signal without recreating a second retrieval or reasoning path.
 */
export class GogcliEmailConnector implements EmailSourceConnector {
  readonly name = 'gogcli';

  private readonly command: string;
  private readonly account: string | undefined;
  private readonly authMode: GogcliAuthMode;
  private readonly runner: CommandRunner;

  constructor(options: GogcliEmailConnectorOptions = {}) {
    this.command = options.command ?? 'gog';
    this.account = options.account?.trim() || undefined;
    this.authMode = options.authMode ?? 'oauth';
    this.runner = options.runner ?? new SpawnCommandRunner();
  }

  async health(): Promise<EmailSourceHealth> {
    const args = this.healthArgs();
    // OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_START
    if (!args) {
      return {
        reachable: true,
        configured: false,
        connector: this.name,
        raw_email_exposed: false,
        detail: 'Set OLYMPUS_EMAIL_SOURCE_ACCOUNT when using service-account auth mode.',
      };
    }
    // OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_END

    const result = await this.run(args);
    if (result.code !== 0) {
      return {
        reachable: true,
        configured: false,
        connector: this.name,
        raw_email_exposed: false,
        detail: safeDetail(result.stderr || result.stdout || 'gog auth list failed.'),
      };
    }

    return {
      reachable: true,
      configured: true,
      connector: this.name,
      raw_email_exposed: false,
      detail: this.account
        ? 'gog is available for the configured account.'
        : 'gog is available. Set OLYMPUS_EMAIL_SOURCE_ACCOUNT to pin an account.',
    };
  }

  // `undefined` comes only from the service-account branch below, so the
  // union member strips out of the public runtime together with it — the
  // stripped method must type-check as always returning args.
  private healthArgs(): string[]
  // OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_START
    | undefined
  // OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_END
  {
    // OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_START
    if (this.authMode === 'service-account') {
      if (!this.account) return undefined;
      return ['auth', 'service-account', 'status', this.account, '--json', '--no-input'];
    }
    // OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_END
    return ['auth', 'list', '--check', '--json', '--no-input'];
  }

  private async run(args: string[]): Promise<CommandResult> {
    try {
      return await this.runner.run(this.command, args, { timeoutMs: 30_000 });
    } catch (error) {
      return {
        code: 127,
        stdout: '',
        stderr: error instanceof Error ? error.message : 'gog command failed.',
      };
    }
  }
}

export class SpawnCommandRunner implements CommandRunner {
  async run(command: string, args: string[], options: { timeoutMs?: number } = {}): Promise<CommandResult> {
    const child = Bun.spawn([command, ...args], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const completed = Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]).then(([stdout, stderr, code]) => ({ code, stdout, stderr }));
    const timeoutMs = options.timeoutMs;
    if (!timeoutMs) return await completed;

    let termTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        completed,
        new Promise<CommandResult>((resolve) => {
          termTimer = setTimeout(() => {
            child.kill();
            killTimer = setTimeout(() => {
              child.kill('SIGKILL');
              resolve({
                code: COMMAND_TIMEOUT_EXIT_CODE,
                stdout: '',
                stderr: command + ' timed out after ' + timeoutMs + 'ms.',
              });
            }, COMMAND_TIMEOUT_KILL_GRACE_MS);
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (termTimer) clearTimeout(termTimer);
      if (killTimer) clearTimeout(killTimer);
    }
  }
}

function safeDetail(value: string): string {
  const firstLine = value.split(/\r?\n/).find((line) => line.trim().length > 0);
  return firstLine?.trim() ?? 'gog is not ready.';
}
