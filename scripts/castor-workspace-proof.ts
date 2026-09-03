import { withWorkerAuthHeader } from '../src/core/worker-auth.ts';

interface CastorWorkspaceProofRequest {
  action: 'health' | 'list' | 'read' | 'write' | 'delete' | 'export_gcs';
  root_id?: string;
  relative_path?: string;
  content?: string;
  content_encoding?: 'utf8' | 'base64';
  destination_uri?: string;
  recursive?: boolean;
  dry_run?: boolean;
  idempotency_key?: string;
  actor_id?: string;
  session_id?: string;
}

export interface CastorWorkspaceProofResponse {
  status: number;
  body: unknown;
}

export type CastorWorkspaceProofTransport = (request: CastorWorkspaceProofRequest) => Promise<CastorWorkspaceProofResponse>;

export interface CastorWorkspaceProofOptions {
  baseUrl?: string;
  rootId?: string;
  destinationUri?: string;
  runId?: string;
  actorId?: string;
  sessionId?: string;
  transport?: CastorWorkspaceProofTransport;
}

export interface CastorWorkspaceProofStep {
  name: string;
  status: 'pass' | 'fail';
  http_status: number;
  code?: string;
  detail?: string;
}

export interface CastorWorkspaceProofReport {
  kind: 'castor_workspace_operational_proof';
  status: 'pass' | 'fail';
  base_url: string;
  root_id: string;
  run_id: string;
  proof_relative_root: string;
  destination_uri: string;
  summary: {
    health: boolean;
    write_read_list_delete: boolean;
    gcs_dry_run: boolean;
    absolute_path_denied: boolean;
    traversal_denied: boolean;
    cleanup: boolean;
  };
  safety: {
    castor_workspace_delegated: boolean;
    shell_exposed_to_agent: boolean;
    absolute_path_exposed: boolean;
    host_path_leak_detected: boolean;
  };
  steps: CastorWorkspaceProofStep[];
  next_actions: string[];
}

interface SafetyEvaluation {
  hostPathLeak: boolean;
  shellExposed: boolean;
  absolutePathExposed: boolean;
  delegatedMissing: boolean;
  detail: string | undefined;
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:8030/v1';
const DEFAULT_ROOT_ID = 'castor_workspace';
const FORBIDDEN_PATH_KEYS = new Set(['absolute_path', 'target_path', 'root_path', 'host_path', 'filesystem_path']);
const HOST_PATH_PATTERNS = [
  /\/Users\/[^"'\s]+/u,
  /\/home\/[^"'\s]+/u,
  /\/private\/[^"'\s]+/u,
  /\/var\/folders\/[^"'\s]+/u,
  /\/tmp\/[^"'\s]+/u,
  /[A-Za-z]:\\[^"'\s]+/u,
];

export async function runCastorWorkspaceProof(options: CastorWorkspaceProofOptions = {}): Promise<CastorWorkspaceProofReport> {
  const baseUrl = trimTrailingSlash(options.baseUrl ?? process.env.OLYMPUS_CASTOR_WORKSPACE_BASE_URL ?? DEFAULT_BASE_URL);
  const rootId = options.rootId ?? process.env.OLYMPUS_CASTOR_WORKSPACE_PROOF_ROOT_ID ?? DEFAULT_ROOT_ID;
  // The staging bucket names the operator's cloud tenant, so it has no
  // committed default: the proof refuses to run rather than aim its dry-run
  // export at a guessed destination.
  const destinationUri = (options.destinationUri ?? process.env.OLYMPUS_CASTOR_WORKSPACE_PROOF_GCS_DESTINATION_URI ?? '').trim();
  if (!destinationUri) {
    throw new Error('No GCS destination is configured. Set OLYMPUS_CASTOR_WORKSPACE_PROOF_GCS_DESTINATION_URI (or pass destinationUri) to the gs:// prefix this proof may stage into.');
  }
  const runId = sanitizeRunId(options.runId ?? new Date().toISOString().replaceAll(':', '').replaceAll('.', '-'));
  const proofRelativeRoot = `__olympus_proof__/${runId}`;
  const proofFile = `${proofRelativeRoot}/proof.txt`;
  const content = `Olympus Castor Workspace proof ${runId}\n`;
  const transport = options.transport ?? createHttpTransport(baseUrl, process.env.OLYMPUS_WORKER_AUTH_TOKEN);
  const actorId = options.actorId ?? 'olympus-castor-workspace-proof';
  const sessionId = options.sessionId ?? runId;
  const steps: CastorWorkspaceProofStep[] = [];
  const summary = {
    health: false,
    write_read_list_delete: false,
    gcs_dry_run: false,
    absolute_path_denied: false,
    traversal_denied: false,
    cleanup: false,
  };
  const safety = {
    castor_workspace_delegated: true,
    shell_exposed_to_agent: false,
    absolute_path_exposed: false,
    host_path_leak_detected: false,
  };

  const call = async (
    name: string,
    request: CastorWorkspaceProofRequest,
    validate: (response: CastorWorkspaceProofResponse) => string | undefined,
  ): Promise<CastorWorkspaceProofResponse> => {
    let response: CastorWorkspaceProofResponse;
    try {
      response = await transport({
        ...request,
        ...(request.action !== 'health' ? { root_id: rootId } : {}),
        actor_id: actorId,
        session_id: sessionId,
      });
    } catch (error) {
      response = {
        status: 0,
        body: {
          error: {
            code: 'worker_unreachable',
            message: error instanceof Error ? error.message : String(error),
          },
        },
      };
    }

    const safetyIssue = evaluateSafety(response.body);
    if (safetyIssue.hostPathLeak) safety.host_path_leak_detected = true;
    if (safetyIssue.shellExposed) safety.shell_exposed_to_agent = true;
    if (safetyIssue.absolutePathExposed) safety.absolute_path_exposed = true;
    if (safetyIssue.delegatedMissing) safety.castor_workspace_delegated = false;

    const validationError = validate(response);
    const detail = validationError ?? safetyIssue.detail;
    steps.push({
      name,
      status: detail ? 'fail' : 'pass',
      http_status: response.status,
      ...errorCode(response.body),
      ...(detail ? { detail } : {}),
    });
    return response;
  };

  await call('health', { action: 'health' }, (response) => {
    const body = asRecord(response.body);
    if (response.status !== 200) return 'health did not return HTTP 200';
    if (body?.kind !== 'castor_workspace_health') return 'health response kind was not castor_workspace_health';
    if (body.configured !== true) return 'Castor Workspace worker has no configured roots';
    const roots = Array.isArray(body.roots) ? body.roots : [];
    if (!roots.some((root) => asRecord(root)?.root_id === rootId)) return `root ${rootId} was not configured`;
    summary.health = true;
    return undefined;
  });

  await call('write', {
    action: 'write',
    relative_path: proofFile,
    content,
    content_encoding: 'utf8',
    idempotency_key: `write-${runId}`,
  }, (response) => {
    const body = asRecord(response.body);
    if (response.status !== 200 || body?.kind !== 'castor_workspace_write') return 'write did not succeed';
    if (body.relative_path !== proofFile) return 'write response did not preserve the relative path';
    return undefined;
  });

  await call('read', { action: 'read', relative_path: proofFile }, (response) => {
    const body = asRecord(response.body);
    if (response.status !== 200 || body?.kind !== 'castor_workspace_read') return 'read did not succeed';
    if (body.content !== content) return 'read content did not match the proof payload';
    return undefined;
  });

  await call('list', { action: 'list', relative_path: proofRelativeRoot }, (response) => {
    const body = asRecord(response.body);
    if (response.status !== 200 || body?.kind !== 'castor_workspace_list') return 'list did not succeed';
    const entries = Array.isArray(body.entries) ? body.entries : [];
    if (!entries.some((entry) => asRecord(entry)?.relative_path === proofFile)) return 'list did not include the proof file';
    return undefined;
  });

  await call('export_gcs_dry_run', {
    action: 'export_gcs',
    relative_path: proofRelativeRoot,
    destination_uri: destinationUri,
    dry_run: true,
  }, (response) => {
    const body = asRecord(response.body);
    if (response.status !== 200 || body?.kind !== 'castor_workspace_export_gcs') return 'GCS dry-run did not succeed';
    if (body.dry_run !== true) return 'GCS proof must be a dry-run';
    summary.gcs_dry_run = true;
    return undefined;
  });

  await call('absolute_path_denial', { action: 'list', relative_path: '/tmp/castor-workspace-proof' }, (response) => {
    if (response.status < 400) return 'absolute host path was accepted';
    if (errorCode(response.body).code !== 'absolute_path_denied') return 'absolute host path returned the wrong error code';
    summary.absolute_path_denied = true;
    return undefined;
  });

  await call('traversal_denial', { action: 'list', relative_path: '../castor-workspace-proof' }, (response) => {
    if (response.status < 400) return 'path traversal was accepted';
    if (errorCode(response.body).code !== 'path_traversal_denied') return 'path traversal returned the wrong error code';
    summary.traversal_denied = true;
    return undefined;
  });

  await call('cleanup', {
    action: 'delete',
    relative_path: proofRelativeRoot,
    recursive: true,
    idempotency_key: `cleanup-${runId}`,
  }, (response) => {
    const body = asRecord(response.body);
    if (response.status !== 200 || body?.kind !== 'castor_workspace_delete') return 'cleanup delete did not succeed';
    summary.cleanup = true;
    return undefined;
  });

  summary.write_read_list_delete = ['write', 'read', 'list', 'cleanup']
    .every((name) => steps.find((step) => step.name === name)?.status === 'pass');

  const failedSteps = steps.filter((step) => step.status === 'fail');
  const status = failedSteps.length === 0 && !safety.host_path_leak_detected && !safety.shell_exposed_to_agent && !safety.absolute_path_exposed
    ? 'pass'
    : 'fail';

  return {
    kind: 'castor_workspace_operational_proof',
    status,
    base_url: baseUrl,
    root_id: rootId,
    run_id: runId,
    proof_relative_root: proofRelativeRoot,
    destination_uri: destinationUri,
    summary,
    safety,
    steps,
    next_actions: status === 'pass'
      ? []
      : failedSteps.map((step) => `Fix Castor Workspace proof step "${step.name}": ${step.detail ?? step.code ?? `HTTP ${step.http_status}`}.`),
  };
}

export function hasForbiddenHostPathLeak(value: unknown): boolean {
  return evaluateSafety(value).hostPathLeak;
}

function createHttpTransport(baseUrl: string, authToken: string | undefined): CastorWorkspaceProofTransport {
  return async (request) => {
    const init = withWorkerAuthHeader({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    }, authToken);
    const response = await fetch(`${baseUrl}/workspace`, init);
    return {
      status: response.status,
      body: await parseBody(response),
    };
  };
}

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {
      error: {
        code: 'non_json_response',
        message: `Worker returned non-JSON response with ${text.length} bytes.`,
      },
    };
  }
}

function evaluateSafety(value: unknown, path: string[] = []): SafetyEvaluation {
  const policy = asRecord(value)?.policy;
  const policyRecord = asRecord(policy);
  let result = {
    hostPathLeak: false,
    shellExposed: policyRecord?.shell_exposed_to_agent === true,
    absolutePathExposed: policyRecord?.absolute_path_exposed === true,
    delegatedMissing: policyRecord !== undefined && policyRecord.castor_workspace_delegated !== true,
    detail: undefined as string | undefined,
  };

  if (value === null || value === undefined) return result;
  if (typeof value === 'string') {
    if (HOST_PATH_PATTERNS.some((pattern) => pattern.test(value))) {
      return { ...result, hostPathLeak: true, detail: `response leaked a host path at ${path.join('.') || 'body'}` };
    }
    return result;
  }
  if (typeof value !== 'object') return result;
  if (Array.isArray(value)) {
    for (const [index, nested] of value.entries()) {
      result = mergeSafety(result, evaluateSafety(nested, [...path, String(index)]));
    }
    return result;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_PATH_KEYS.has(key)) {
      result = mergeSafety(result, {
        hostPathLeak: true,
        shellExposed: false,
        absolutePathExposed: false,
        delegatedMissing: false,
        detail: `response contained forbidden host path field ${[...path, key].join('.')}`,
      });
    }
    result = mergeSafety(result, evaluateSafety(nested, [...path, key]));
  }
  return result;
}

function mergeSafety(left: SafetyEvaluation, right: SafetyEvaluation): SafetyEvaluation {
  return {
    hostPathLeak: left.hostPathLeak || right.hostPathLeak,
    shellExposed: left.shellExposed || right.shellExposed,
    absolutePathExposed: left.absolutePathExposed || right.absolutePathExposed,
    delegatedMissing: left.delegatedMissing || right.delegatedMissing,
    detail: left.detail ?? right.detail,
  };
}

function errorCode(value: unknown): { code?: string } {
  const error = asRecord(asRecord(value)?.error);
  return typeof error?.code === 'string' ? { code: error.code } : {};
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function sanitizeRunId(value: string): string {
  const normalized = value.trim().replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '');
  return normalized || 'manual-proof';
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, '');
}

if (import.meta.main) {
  const report = await runCastorWorkspaceProof();
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== 'pass') process.exit(1);
}
