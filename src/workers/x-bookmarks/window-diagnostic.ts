import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import {
  createEnvCredentialBroker,
  requireBearerTokenCredentialSession,
  type CredentialBroker,
} from '../credential-broker/index.ts';
import {
  XApiClient,
  XApiError,
  type XApiClientOptions,
  type XApiRateLimit,
  type XBookmarkPostPage,
} from './api.ts';
import type { XBookmarksLiveSourceClient } from './api-connector.ts';
import {
  LocalXBookmarksApiUsageStore,
  XApiUsageGuardError,
  defaultXBookmarksLiveSyncConfig,
  xApiInvocationProvenance,
  type XApiInvocationProvenance,
  type XApiUsageStatus,
  type XBookmarksLiveSyncConfig,
} from './live-control.ts';

const MAX_DIAGNOSTIC_PAGES = 3;

export type XBookmarksWindowDiagnosticProbeName =
  | 'fresh_root_global'
  | 'identical_cursor_retry'
  | 'id_only_traversal'
  | 'rich_traversal';

export interface XBookmarksWindowDiagnosticRequestObservation {
  status: 'success' | 'provider_error' | 'network_error' | 'usage_guard' | 'skipped';
  http_status?: number;
  provider_error?: {
    type?: string;
    title?: string;
    code?: string;
  };
  items_returned: number;
  request_cursor_present: boolean;
  response_cursor_present: boolean;
  rate_limit?: XApiRateLimit;
  guard_kind?: string;
}

export interface XBookmarksWindowDiagnosticProbe {
  name: XBookmarksWindowDiagnosticProbeName;
  status: 'completed' | 'failed' | 'mixed' | 'skipped';
  pages_attempted: number;
  pages_succeeded: number;
  items_returned: number;
  terminal_cursor_present: boolean;
  requests: XBookmarksWindowDiagnosticRequestObservation[];
}

export interface XBookmarksWindowDiagnosticReport {
  kind: 'x_bookmarks_window_diagnostic';
  version: 1;
  generated_at: string;
  account_sha256: string;
  page_size: number;
  max_pages_per_traversal: 3;
  probes: [
    XBookmarksWindowDiagnosticProbe,
    XBookmarksWindowDiagnosticProbe,
    XBookmarksWindowDiagnosticProbe,
    XBookmarksWindowDiagnosticProbe,
  ];
  api_usage: XApiUsageStatus;
  policy: {
    admin_gated: true;
    budget_accounted: true;
    content_free: true;
    file_mode: '0600';
    raw_source_exposed: false;
    source_text_returned: false;
    resource_ids_exposed: false;
    provider_cursor_exposed: false;
    provider_error_body_exposed: false;
  };
}

export interface XBookmarksWindowDiagnosticResult {
  report: XBookmarksWindowDiagnosticReport;
  report_path: string;
  report_sha256: string;
}

export interface XBookmarksWindowDiagnosticOptions {
  account: string;
  attemptedAt: Date;
  usageStore: LocalXBookmarksApiUsageStore;
  reportPath: string;
  /**
   * Who asked. The diagnostic exists to answer an operator's question about a
   * misbehaving provider window, and its probes are sub-requests of that one
   * invocation: they inherit its provenance, so an operator diagnostic is not
   * refused by the routine daily guard it was run to investigate.
   */
  provenance?: XApiInvocationProvenance;
  config?: XBookmarksLiveSyncConfig;
  sourceClient?: XBookmarksLiveSourceClient;
  credentialBroker?: CredentialBroker;
  credentialHandle?: string;
  userId?: string;
  fetch?: XApiClientOptions['fetch'];
  apiBaseUrl?: string;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
}

export async function runXBookmarksWindowDiagnostic(
  options: XBookmarksWindowDiagnosticOptions,
): Promise<XBookmarksWindowDiagnosticResult> {
  const env = options.env ?? process.env;
  const config = options.config ?? defaultXBookmarksLiveSyncConfig(env);
  const account = options.account.trim();
  if (!account) throw new TypeError('X bookmark diagnostic account must be non-empty.');
  const attemptedAt = validDate(options.attemptedAt);
  const provenance = xApiInvocationProvenance(options.provenance);
  const client = await diagnosticClient(options, env);
  const request = (
    paginationToken: string | undefined,
    headOnly: boolean,
  ) => diagnosticRequest({
    client,
    usageStore: options.usageStore,
    account,
    config,
    attemptedAt,
    provenance,
    pageSize: config.reconcilePageSize,
    ...(paginationToken ? { paginationToken } : {}),
    headOnly,
  });

  const rootObservation = await request(undefined, false);
  const freshRoot = summarizeProbe('fresh_root_global', [rootObservation.observation]);

  const retryObservations: XBookmarksWindowDiagnosticRequestObservation[] = [];
  if (rootObservation.page?.nextToken) {
    const failingToken = rootObservation.page.nextToken;
    retryObservations.push((await request(failingToken, false)).observation);
    retryObservations.push((await request(failingToken, false)).observation);
  } else {
    retryObservations.push(skippedObservation(false));
  }
  const identicalCursorRetry = summarizeProbe(
    'identical_cursor_retry',
    retryObservations,
  );

  const idOnlyTraversal = await traversalProbe('id_only_traversal', true, request);
  const richTraversal = await traversalProbe('rich_traversal', false, request);
  const report: XBookmarksWindowDiagnosticReport = {
    kind: 'x_bookmarks_window_diagnostic',
    version: 1,
    generated_at: attemptedAt.toISOString(),
    account_sha256: createHash('sha256').update(account).digest('hex'),
    page_size: config.reconcilePageSize,
    max_pages_per_traversal: MAX_DIAGNOSTIC_PAGES,
    probes: [freshRoot, identicalCursorRetry, idOnlyTraversal, richTraversal],
    api_usage: options.usageStore.status({ account, config, now: attemptedAt }),
    policy: {
      admin_gated: true,
      budget_accounted: true,
      content_free: true,
      file_mode: '0600',
      raw_source_exposed: false,
      source_text_returned: false,
      resource_ids_exposed: false,
      provider_cursor_exposed: false,
      provider_error_body_exposed: false,
    },
  };
  const reportJson = `${JSON.stringify(report, null, 2)}\n`;
  writePrivateReport(options.reportPath, reportJson);
  return {
    report,
    report_path: options.reportPath,
    report_sha256: createHash('sha256').update(reportJson).digest('hex'),
  };
}

async function diagnosticClient(
  options: XBookmarksWindowDiagnosticOptions,
  env: Record<string, string | undefined>,
): Promise<XBookmarksLiveSourceClient> {
  if (options.sourceClient) return options.sourceClient;
  const userId = options.userId?.trim() || env.OLYMPUS_SOURCE_INDEX_X_USER_ID?.trim();
  if (!userId) {
    throw new Error('X bookmarks window diagnostic requires an explicit provider user id.');
  }
  const credentialHandle = options.credentialHandle?.trim()
    || env.OLYMPUS_SOURCE_INDEX_X_BOOKMARKS_CREDENTIAL_HANDLE?.trim()
    || 'x.bookmarks.personal';
  const broker = options.credentialBroker ?? createEnvCredentialBroker({
    env,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const session = requireBearerTokenCredentialSession(await broker.issueSession({
    handle: credentialHandle,
    provider: 'x',
    capability: 'x.bookmarks.sync',
    trustDomain: 'internal',
    purpose: 'Run the bounded content-free X bookmarks window diagnostic.',
  }), credentialHandle);
  return new XApiClient({
    token: session.token,
    userId,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.apiBaseUrl ? { baseUrl: options.apiBaseUrl } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  });
}

async function traversalProbe(
  name: Extract<XBookmarksWindowDiagnosticProbeName, 'id_only_traversal' | 'rich_traversal'>,
  headOnly: boolean,
  request: (
    paginationToken: string | undefined,
    headOnly: boolean,
  ) => Promise<DiagnosticRequestResult>,
): Promise<XBookmarksWindowDiagnosticProbe> {
  const observations: XBookmarksWindowDiagnosticRequestObservation[] = [];
  let token: string | undefined;
  for (let page = 0; page < MAX_DIAGNOSTIC_PAGES; page += 1) {
    const result = await request(token, headOnly);
    observations.push(result.observation);
    if (!result.page?.nextToken || result.observation.status !== 'success') break;
    token = result.page.nextToken;
  }
  return summarizeProbe(name, observations);
}

interface DiagnosticRequestResult {
  observation: XBookmarksWindowDiagnosticRequestObservation;
  page?: XBookmarkPostPage;
}

async function diagnosticRequest(input: {
  client: XBookmarksLiveSourceClient;
  usageStore: LocalXBookmarksApiUsageStore;
  account: string;
  config: XBookmarksLiveSyncConfig;
  attemptedAt: Date;
  provenance: XApiInvocationProvenance;
  pageSize: number;
  paginationToken?: string;
  headOnly: boolean;
}): Promise<DiagnosticRequestResult> {
  const multiplier = input.headOnly ? 1 : input.config.richResourceExpansionMultiplier;
  let reservation;
  try {
    reservation = input.usageStore.reserveRequest({
      account: input.account,
      requestedMaxResources: input.pageSize * multiplier,
      minimumResources: multiplier,
      preserveHeadReserve: true,
      provenance: input.provenance,
      config: input.config,
      now: input.attemptedAt,
    });
  } catch (error) {
    if (!(error instanceof XApiUsageGuardError)) throw error;
    return {
      observation: {
        status: 'usage_guard',
        items_returned: 0,
        request_cursor_present: Boolean(input.paginationToken),
        response_cursor_present: false,
        guard_kind: error.guardKind,
      },
    };
  }
  const providerMaxResults = Math.min(
    input.pageSize,
    Math.floor(reservation.maxResources / multiplier),
  );
  try {
    const page = await input.client.fetchBookmarks({
      maxResults: providerMaxResults,
      headOnly: input.headOnly,
      strictSnapshot: true,
      ...(input.paginationToken ? { paginationToken: input.paginationToken } : {}),
    });
    input.usageStore.settleSuccess({
      reservation,
      resourceIds: diagnosticResourceIds(page, input.headOnly),
      ...(page.rateLimit ? { rateLimit: page.rateLimit } : {}),
      config: input.config,
      now: input.attemptedAt,
    });
    return {
      observation: {
        status: 'success',
        items_returned: page.posts.length,
        request_cursor_present: Boolean(input.paginationToken),
        response_cursor_present: Boolean(page.nextToken),
        ...(page.rateLimit ? { rate_limit: page.rateLimit } : {}),
      },
      page,
    };
  } catch (error) {
    const rateLimit = error instanceof XApiError ? error.rateLimit : undefined;
    input.usageStore.settleFailure({
      reservation,
      ...(rateLimit ? { rateLimit } : {}),
      potentiallyBillable: !(error instanceof XApiError && error.status !== undefined),
      config: input.config,
      now: input.attemptedAt,
    });
    if (!(error instanceof XApiError)) {
      return {
        observation: {
          status: 'network_error',
          items_returned: 0,
          request_cursor_present: Boolean(input.paginationToken),
          response_cursor_present: false,
        },
      };
    }
    const providerError = {
      ...(error.providerErrorType ? { type: error.providerErrorType } : {}),
      ...(error.providerErrorTitle ? { title: error.providerErrorTitle } : {}),
      ...(error.providerErrorCode ? { code: error.providerErrorCode } : {}),
    };
    return {
      observation: {
        status: 'provider_error',
        ...(error.status !== undefined ? { http_status: error.status } : {}),
        ...(Object.keys(providerError).length > 0 ? { provider_error: providerError } : {}),
        items_returned: 0,
        request_cursor_present: Boolean(input.paginationToken),
        response_cursor_present: false,
        ...(rateLimit ? { rate_limit: rateLimit } : {}),
      },
    };
  }
}

function summarizeProbe(
  name: XBookmarksWindowDiagnosticProbeName,
  requests: XBookmarksWindowDiagnosticRequestObservation[],
): XBookmarksWindowDiagnosticProbe {
  const attempted = requests.filter((request) => request.status !== 'skipped');
  const succeeded = attempted.filter((request) => request.status === 'success');
  const statuses = new Set(attempted.map((request) => request.status));
  const status = attempted.length === 0
    ? 'skipped'
    : statuses.size > 1
      ? 'mixed'
      : statuses.has('success')
        ? 'completed'
        : 'failed';
  return {
    name,
    status,
    pages_attempted: attempted.length,
    pages_succeeded: succeeded.length,
    items_returned: requests.reduce((sum, request) => sum + request.items_returned, 0),
    terminal_cursor_present: requests.at(-1)?.response_cursor_present ?? false,
    requests,
  };
}

function skippedObservation(requestCursorPresent: boolean):
  XBookmarksWindowDiagnosticRequestObservation {
  return {
    status: 'skipped',
    items_returned: 0,
    request_cursor_present: requestCursorPresent,
    response_cursor_present: false,
  };
}

function diagnosticResourceIds(page: XBookmarkPostPage, headOnly: boolean): string[] {
  const ids = new Set<string>();
  for (const post of page.posts) {
    ids.add(`post:${post.id}`);
    if (headOnly) continue;
    if (post.authorId?.trim()) ids.add(`author:${post.authorId.trim()}`);
    for (const mediaKey of post.mediaKeys ?? []) {
      if (mediaKey.trim()) ids.add(`media:${mediaKey.trim()}`);
    }
  }
  return [...ids];
}

function writePrivateReport(pathValue: string, contents: string): void {
  const reportPath = pathValue.trim();
  if (!reportPath) throw new TypeError('X bookmark diagnostic report path is required.');
  const parent = dirname(reportPath);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporaryPath = `${reportPath}.tmp-${randomUUID()}`;
  try {
    writeFileSync(temporaryPath, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, reportPath);
    chmodSync(reportPath, 0o600);
    if ((statSync(reportPath).mode & 0o777) !== 0o600) {
      throw new Error('X bookmark diagnostic report permissions are not 0600.');
    }
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}

function validDate(value: Date): Date {
  if (!Number.isFinite(value.getTime())) {
    throw new TypeError('X bookmark diagnostic timestamp must be valid.');
  }
  return value;
}
