/**
 * Standalone Venice credit-status probe.
 *
 * The reusable billing/report/pause logic lives in
 * `src/core/provider-credit-status.ts` so the Gateway-supervised monitor
 * (src/core/native-credit-monitor-service.ts) and this CLI share one
 * implementation. This file owns only argument parsing and the operator-facing
 * stdout/exit-code surface.
 */
import {
  fetchVeniceCreditStatus,
  formatTextReport,
  reconcileProviderPauseFile,
  writeReport,
} from '../src/core/provider-credit-status.ts';

export * from '../src/core/provider-credit-status.ts';

function parseArgs(argv: string[]): {
  reportPath?: string;
  pauseFile?: string;
  text: boolean;
} {
  const options: { reportPath?: string; pauseFile?: string; text: boolean } = { text: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const next = () => {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value.`);
      index += 1;
      return value;
    };
    if (arg === '--report') options.reportPath = next();
    else if (arg === '--pause-file') options.pauseFile = next();
    else if (arg === '--text') options.text = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  const report = await fetchVeniceCreditStatus();
  const reportPath = args.reportPath ?? process.env.OLYMPUS_VENICE_CREDIT_STATUS_REPORT_PATH;
  const pauseFile = args.pauseFile ?? process.env.OLYMPUS_VENICE_CREDIT_STATUS_PROVIDER_PAUSE_FILE;
  if (reportPath) writeReport(reportPath, report);
  if (pauseFile) reconcileProviderPauseFile(pauseFile, report);
  console.log(args.text ? formatTextReport(report) : JSON.stringify(report, null, 2));
  if (report.status === 'auth_failed' || report.status === 'unavailable') process.exitCode = 1;
}
