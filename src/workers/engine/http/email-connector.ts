import type { WorkerCredentialDegradation } from '../../credential-degradation.ts';

export interface EmailAnswerRequest {
  question: string;
  account?: string;
  after?: string;
  before?: string;
  from?: string;
  to?: string;
  max_messages?: number;
}

export interface EmailSearchRequest {
  question?: string;
  query?: string;
  account?: string;
  after?: string;
  before?: string;
  from?: string;
  to?: string;
  max_messages?: number;
  include_sanitized_text?: boolean;
}

export interface EmailSafeEvidence {
  source: 'gmail';
  account?: string;
  thread_id?: string;
  message_id?: string;
  subject?: string;
  from?: string;
  to?: string;
  date?: string;
}

export interface EmailSafeAudit {
  request_id: string;
  queries_attempted: number;
  metadata_hits: number;
  evidence_count: number;
  reasoner_ms: number;
  fallback_used: boolean;
  planner_used?: boolean;
  planner_fallback_used?: boolean;
  planned_search_count?: number;
  planner_failure_reason?: EmailPlannerFailureReason;
  retrieval_searches_attempted?: number;
  retrieval_search_summaries?: EmailRetrievalSearchSummary[];
}

export type EmailPlannerFailureReason = 'timeout' | 'http_error' | 'invalid_json' | 'invalid_plan' | 'empty_plan' | 'error';

export interface EmailRetrievalSearchSummary {
  source: 'baseline' | 'planner';
  index: number;
  hits: number;
  new_candidates_after_dedupe: number;
  capped: boolean;
}

export interface EmailSourceHealth {
  reachable: true;
  configured: boolean;
  connector: string;
  status?: 'ok' | 'degraded';
  degraded_credentials?: WorkerCredentialDegradation[];
  raw_email_exposed: false;
  detail?: string;
  dependency_check?: 'not_run';
}

export interface EmailSourceAnswer {
  answer: string;
  evidence?: EmailSafeEvidence[];
  audit?: EmailSafeAudit;
  policy: {
    raw_email_exposed: false;
    reasoning_lane: 'delphi_local';
  };
}

export interface EmailSourcePacketItem {
  item_id?: string;
  thread_id?: string;
  subject?: string;
  from?: string;
  to?: string;
  date?: string;
  sanitized_text?: string;
  provenance: {
    source: 'gmail';
    message_id?: string;
    thread_id?: string;
  };
}

export interface EmailSourceSearch {
  packet: {
    kind: 'email_source_packet';
    packet_id: string;
    source: 'gmail';
    account?: string;
    items: EmailSourcePacketItem[];
  };
  audit: {
    request_id: string;
    queries_attempted: number;
    metadata_hits: number;
    items_returned: number;
    sanitized_reads_attempted: number;
    sanitized_reads_succeeded: number;
    truncated: boolean;
    local_packet: true;
    raw_email_exposed: false;
  };
  policy: {
    raw_email_exposed: false;
    local_only: true;
    requires_local_session: true;
  };
}

export interface EmailSourceConnector {
  name: string;
  health(): Promise<EmailSourceHealth>;
}

/**
 * What the worker says about email answers before an email account exists.
 *
 * The old sentence — "gogcli is not wired yet. Configure the Gateway-side
 * connector before enabling email answers." — named an internal component and a
 * Gateway the reader does not have, on a clean install where the true and only
 * fact is that no mail account is connected yet (clean-install rehearsal,
 * 2026-09-05).
 */
export const EMAIL_CONNECTOR_NOT_CONNECTED_DETAIL =
  'No email account is connected yet. Connect Gmail from the Olympus dashboard to enable email answers.';

export class GogcliEmailConnectorStub implements EmailSourceConnector {
  name = 'gogcli';

  async health(): Promise<EmailSourceHealth> {
    return {
      reachable: true,
      configured: false,
      connector: this.name,
      raw_email_exposed: false,
      detail: EMAIL_CONNECTOR_NOT_CONNECTED_DETAIL,
    };
  }

}

export function cheapWorkerHealth(
  connector: EmailSourceConnector,
  degradedCredentials: WorkerCredentialDegradation[] = [],
): EmailSourceHealth {
  const configured = !(connector instanceof GogcliEmailConnectorStub);
  return {
    reachable: true,
    configured,
    connector: connector.name,
    status: degradedCredentials.length > 0 ? 'degraded' : 'ok',
    ...(degradedCredentials.length > 0 ? { degraded_credentials: degradedCredentials } : {}),
    raw_email_exposed: false,
    dependency_check: 'not_run',
    detail: configured
      ? 'Worker process is alive; connector dependency health was not checked on this cheap liveness path.'
      : EMAIL_CONNECTOR_NOT_CONNECTED_DETAIL,
  };
}
