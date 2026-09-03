import {
  buildOpsecReleaseAudit,
  createStructuredEvidenceFact,
  evaluateReleaseGate,
  type OpsecReleaseAudit,
  type ReleaseDecision,
} from '../../core/opsec.ts';
import { buildSourceSensitivity, type SourceTrustTier } from '../../core/source-index/types.ts';

import { HireBrokerError } from './types.ts';

const MAX_OUTBOUND_TEXT_LENGTH = 12_000;

const OUTBOUND_PRIVACY_PATTERNS: Array<{ reason: string; pattern: RegExp }> = [
  { reason: 'email_identifier', pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i },
  { reason: 'social_handle', pattern: /(^|\s)@[a-z0-9_]{2,32}\b/i },
  { reason: 'phone_identifier', pattern: /(?:^|\D)\+?\d[\d\s().-]{6,}\d(?:\D|$)/ },
  { reason: 'private_resource_url', pattern: /\bhttps?:\/\/\S+/i },
  { reason: 'posix_filesystem_path', pattern: /(?:^|\s)(?:~\/|\/(?:Users|home|var|private|Volumes)\/)\S+/i },
  { reason: 'windows_filesystem_path', pattern: /\b[A-Z]:\\(?:Users|Documents and Settings|ProgramData)\\\S+/i },
  { reason: 'credential_material', pattern: /\b(?:bearer|authorization)\s+[A-Za-z0-9._~+\/-]{12,}/i },
];

const EXPLICIT_S4_PATTERN = /(?:^|[\s[(])S4\+?(?:[\s\]):]|$)|\b(?:therapy notes?|medical records?|tax returns?|bank statements?|legal case files?)\b/i;
const EXPLICIT_S5_PATTERN = /(?:^|[\s[(])S5(?:[\s\]):]|$)|\b(?:private key|seed phrase|recovery phrase|wallet key)\b/i;

export interface OutboundReleaseInput {
  brief: string;
  context?: string;
  sensitivity?: SourceTrustTier;
}

export interface OutboundReleaseResult {
  gate: ReleaseDecision;
  audit: OpsecReleaseAudit;
  sensitivity: SourceTrustTier;
  privacyFindings: string[];
}

export function evaluateOutboundRelease(input: OutboundReleaseInput): OutboundReleaseResult {
  const brief = validateOutboundText(input.brief, 'brief');
  const context = input.context === undefined ? undefined : validateOutboundText(input.context, 'context');
  const combined = context ? `${brief}\n${context}` : brief;
  const sensitivity = input.sensitivity ?? classifyOutboundSensitivity(combined);
  const fact = createStructuredEvidenceFact({
    factId: 'hire-brief',
    claim: combined,
    sourceProvenance: [{
      sourceItem: {
        family: 'x-hire-broker',
        provider: 'owner-brief',
        accountScope: 'local-owner',
        providerItemId: 'outbound-brief',
        localItemId: 'outbound-brief',
      },
    }],
    sensitivity: buildSourceSensitivity({ trustTier: sensitivity }),
    confidence: 'high',
    extractionKind: 'quoted_fact',
    releaseSurface: sensitivity === 'S4' || sensitivity === 'S4+' || sensitivity === 'S5'
      ? 'local_only'
      : 'castor_answer',
  });
  // This invocation evaluates whether content may cross the assistant-safe
  // boundary. Payment/send authorization is enforced separately by the broker.
  const gate = evaluateReleaseGate({
    facts: [fact],
    draftAnswer: combined,
    destination: 'castor',
    action: 'answer',
    caller: 'worker',
  });
  const privacyFindings = OUTBOUND_PRIVACY_PATTERNS
    .filter(({ pattern }) => pattern.test(combined))
    .map(({ reason }) => reason);
  return {
    gate,
    audit: buildOpsecReleaseAudit([fact], gate),
    sensitivity,
    privacyFindings,
  };
}

export function assertOutboundReleaseAllowed(result: OutboundReleaseResult): void {
  if (result.privacyFindings.length > 0) {
    throw new HireBrokerError(
      'release_denied',
      `Outbound brief violates privacy rules: ${result.privacyFindings.join(', ')}.`,
      409,
    );
  }
  if (result.sensitivity === 'S4' || result.sensitivity === 'S4+' || result.sensitivity === 'S5') {
    throw new HireBrokerError('release_denied', 'S4-or-higher content must stay local.', 409);
  }
  if (result.gate.decision === 'deny') {
    throw new HireBrokerError('release_denied', 'Release Gate denied the outbound brief.', 409);
  }
  if (result.gate.decision === 'needs_approval') {
    throw new HireBrokerError('release_approval_required', 'Release Gate requires owner approval.', 409);
  }
  if (result.gate.decision !== 'allow' && result.gate.decision !== 'redact') {
    throw new HireBrokerError('release_denied', 'Release Gate returned an unsupported decision.', 409);
  }
}

function classifyOutboundSensitivity(text: string): SourceTrustTier {
  if (EXPLICIT_S5_PATTERN.test(text)) return 'S5';
  if (EXPLICIT_S4_PATTERN.test(text)) return 'S4';
  return 'S1';
}

function validateOutboundText(value: string, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new HireBrokerError('invalid_request', `${field} must be non-empty.`, 400);
  }
  if (value.length > MAX_OUTBOUND_TEXT_LENGTH || /\u0000/.test(value)) {
    throw new HireBrokerError('invalid_request', `${field} is too large or malformed.`, 400);
  }
  return value.trim();
}
