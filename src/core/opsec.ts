import type {
  SourceIndexProvenance,
  SourceSensitivity,
  SourceTrustDomain,
  SourceTrustTier,
} from './source-index/types.ts';

export type EvidenceConfidence = 'low' | 'medium' | 'high';
export type EvidenceExtractionKind = 'quoted_fact' | 'paraphrase' | 'inference' | 'metadata';
export type EvidenceReleaseSurface = 'castor_answer' | 'user_review' | 'local_only';

export type SourceInstructionFlag =
  | 'ignore_previous_instructions'
  | 'role_or_policy_override'
  | 'credential_exfiltration_request'
  | 'external_communication_request'
  | 'tool_escalation_request'
  | 'general_source_instruction';

export interface StructuredEvidenceFact {
  factId: string;
  claim: string;
  sourceProvenance: readonly SourceIndexProvenance[];
  sensitivity: SourceSensitivity;
  confidence: EvidenceConfidence;
  extractionKind: EvidenceExtractionKind;
  sourceInstructionFlags: readonly SourceInstructionFlag[];
  releaseSurface: EvidenceReleaseSurface;
}

export interface StructuredEvidenceFactInput {
  factId: string;
  claim: string;
  sourceProvenance: readonly SourceIndexProvenance[];
  sensitivity: SourceSensitivity;
  confidence: EvidenceConfidence;
  extractionKind: EvidenceExtractionKind;
  releaseSurface?: EvidenceReleaseSurface;
}

export type ReleaseDecisionKind = 'allow' | 'redact' | 'needs_approval' | 'deny';
export type ReleaseApprovalKind = 'user_review' | 's4_release' | 's5_secret_use' | 'write_action';
export type ReleaseActionClass = 'read' | 'answer' | 'persist' | 'send' | 'write' | 'delete' | 'execute';
export type ReleaseDestination = 'argus' | 'castor' | 'user' | 'tool' | 'log' | 'memory';

export interface ReleaseRedaction {
  label: string;
  reason: string;
}

export interface ReleaseDecision {
  decision: ReleaseDecisionKind;
  reasons: readonly string[];
  allowedText?: string;
  redactions?: readonly ReleaseRedaction[];
  requiredApproval?: ReleaseApprovalKind;
}

export interface ReleaseGateInput {
  facts: readonly StructuredEvidenceFact[];
  draftAnswer: string;
  destination: ReleaseDestination;
  action: ReleaseActionClass;
  caller?: 'argus' | 'castor' | 'worker' | 'user';
}

export interface StructuredEvidenceAuditItem {
  fact_id: string;
  trust_tier: SourceTrustTier;
  trust_domain: SourceTrustDomain;
  confidence: EvidenceConfidence;
  extraction_kind: EvidenceExtractionKind;
  source_instruction_flags: readonly SourceInstructionFlag[];
  release_surface: EvidenceReleaseSurface;
  provenance_count: number;
}

export interface ReleaseDecisionAudit {
  decision: ReleaseDecisionKind;
  reasons: readonly string[];
  redactions?: readonly ReleaseRedaction[];
  required_approval?: ReleaseApprovalKind;
}

export interface OpsecReleaseAudit {
  structured_evidence: readonly StructuredEvidenceAuditItem[];
  release_decision: ReleaseDecisionAudit;
  raw_source_exposed: false;
}

const SECRET_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'private_key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/i },
  { label: 'oauth_refresh_token', pattern: /\brefresh[_ -]?token\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}/i },
  { label: 'client_secret', pattern: /\bclient[_ -]?secret\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}/i },
  { label: 'api_key', pattern: /\bapi[_ -]?key\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{12,}/i },
  { label: 'password', pattern: /\bpassword\s*[:=]\s*["']?\S{8,}/i },
  { label: 'openai_key', pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/ },
  { label: 'github_token', pattern: /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{16,}\b/ },
  { label: 'slack_token', pattern: /\bxox[abp]-[A-Za-z0-9-]{16,}\b/ },
];

export function createStructuredEvidenceFact(input: StructuredEvidenceFactInput): StructuredEvidenceFact {
  const factId = input.factId.trim();
  const claim = input.claim.trim();
  if (!factId) throw new Error('Structured evidence facts require a factId.');
  if (!claim) throw new Error('Structured evidence facts require a claim.');
  if (input.sourceProvenance.length === 0) {
    throw new Error('Structured evidence facts require source provenance.');
  }

  return {
    factId,
    claim,
    sourceProvenance: [...input.sourceProvenance],
    sensitivity: input.sensitivity,
    confidence: input.confidence,
    extractionKind: input.extractionKind,
    sourceInstructionFlags: detectSourceInstructionFlags(claim),
    releaseSurface: input.releaseSurface ?? defaultReleaseSurfaceForSensitivity(input.sensitivity),
  };
}

export function evaluateReleaseGate(input: ReleaseGateInput): ReleaseDecision {
  const reasons = new Set<string>();
  const redactions: ReleaseRedaction[] = [];

  if (input.action !== 'read' && input.action !== 'answer') {
    return {
      decision: 'needs_approval',
      reasons: ['high_impact_action_requires_approval'],
      requiredApproval: input.action === 'send' || input.action === 'write' || input.action === 'delete'
        ? 'write_action'
        : 'user_review',
    };
  }

  const secretLabels = secretLabelsInText([
    input.draftAnswer,
    ...input.facts.map((fact) => fact.claim),
  ].join('\n'));
  for (const label of secretLabels) {
    redactions.push({ label, reason: 's5_like_secret_detected' });
  }
  if (secretLabels.length > 0 || input.facts.some((fact) => fact.sensitivity.trustTier === 'S5')) {
    return {
      decision: 'deny',
      reasons: ['s5_secret_denied_from_ordinary_output'],
      ...(redactions.length > 0 ? { redactions } : {}),
      requiredApproval: 's5_secret_use',
    };
  }

  const allInstructionFlags = new Set(input.facts.flatMap((fact) => [...fact.sourceInstructionFlags]));
  if (allInstructionFlags.size > 0) {
    reasons.add('hostile_source_instruction_treated_as_data');
  }

  const crossingToCastor = input.destination === 'castor';
  const secureFacts = input.facts.filter((fact) => fact.sensitivity.trustDomain === 'secure_local');
  if (crossingToCastor && secureFacts.some((fact) => fact.releaseSurface === 'local_only')) {
    return {
      decision: 'needs_approval',
      reasons: [...reasons, 'secure_local_fact_not_marked_for_castor_release'],
      requiredApproval: 's4_release',
    };
  }

  if (crossingToCastor && secureFacts.length > 0) {
    reasons.add('bounded_secure_derivative_allowed');
  }

  return {
    decision: 'allow',
    reasons: [...reasons, 'release_gate_passed'],
    allowedText: input.draftAnswer,
  };
}

export function buildOpsecReleaseAudit(
  facts: readonly StructuredEvidenceFact[],
  decision: ReleaseDecision,
): OpsecReleaseAudit {
  return {
    structured_evidence: facts.map((fact) => ({
      fact_id: fact.factId,
      trust_tier: fact.sensitivity.trustTier,
      trust_domain: fact.sensitivity.trustDomain,
      confidence: fact.confidence,
      extraction_kind: fact.extractionKind,
      source_instruction_flags: [...fact.sourceInstructionFlags],
      release_surface: fact.releaseSurface,
      provenance_count: fact.sourceProvenance.length,
    })),
    release_decision: {
      decision: decision.decision,
      reasons: [...decision.reasons],
      ...(decision.redactions ? { redactions: [...decision.redactions] } : {}),
      ...(decision.requiredApproval ? { required_approval: decision.requiredApproval } : {}),
    },
    raw_source_exposed: false,
  };
}

export function answerForReleaseDecision(decision: ReleaseDecision): string {
  if ((decision.decision === 'allow' || decision.decision === 'redact') && decision.allowedText) {
    return decision.allowedText;
  }
  if (decision.decision === 'needs_approval') {
    return 'I found matching source material, but this needs review before I can summarize it in this calling-assistant-safe path.';
  }
  return 'I found matching source material, but it cannot be summarized in this calling-assistant-safe path.';
}

export function detectSourceInstructionFlags(text: string): SourceInstructionFlag[] {
  const flags = new Set<SourceInstructionFlag>();
  if (/\b(ignore|disregard)\s+(all\s+)?(previous|prior|above)\s+instructions?\b/i.test(text)) {
    flags.add('ignore_previous_instructions');
  }
  if (/\b(system|developer|policy)\s+(prompt|message|instructions?)\b/i.test(text) || /\byou are now\b/i.test(text)) {
    flags.add('role_or_policy_override');
  }
  if (/\b(send|exfiltrate|upload|forward|post)\b.{0,80}\b(secret|token|password|key|credential|email|gmail|document|file)s?\b/i.test(text)) {
    flags.add('credential_exfiltration_request');
  }
  if (/\b(send|forward|email|post|upload|webhook|dm|slack)\b.{0,100}\b(attacker|external|http|https|@)\b/i.test(text)) {
    flags.add('external_communication_request');
  }
  if (/\b(call|use|invoke)\b.{0,60}\btool\b/i.test(text) || /\bdelete\b.{0,80}\b(log|file|email|message|record)s?\b/i.test(text)) {
    flags.add('tool_escalation_request');
  }
  if (/\b(as an ai|assistant|model)\b/i.test(text)) {
    flags.add('general_source_instruction');
  }
  return [...flags].sort();
}

function defaultReleaseSurfaceForSensitivity(sensitivity: SourceSensitivity): EvidenceReleaseSurface {
  if (sensitivity.trustTier === 'S5') return 'local_only';
  return 'castor_answer';
}

function secretLabelsInText(text: string): string[] {
  return SECRET_PATTERNS
    .filter(({ pattern }) => pattern.test(text))
    .map(({ label }) => label);
}
