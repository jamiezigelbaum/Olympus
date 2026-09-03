import { createHash } from 'node:crypto';

export const DROPBOX_CONTENT_POLICY_CLASSIFIER_KIND = 'dropbox_deterministic_content_policy';
export const DROPBOX_CONTENT_POLICY_CLASSIFIER_VERSION = '2026-05-22';

export type DropboxContentPolicyTrustTier = 'S0' | 'S1' | 'S2' | 'S3' | 'S4' | 'S4+' | 'S5';
export type DropboxContentPolicyClassificationDecision =
  | 'index_allowed'
  | 'metadata_only'
  | 'blocked_sensitive'
  | 'needs_review';

export type DropboxContentPolicyFindingType =
  | 'private_key_material'
  | 'aws_access_key_id'
  | 'slack_token'
  | 'api_secret_token'
  | 'credential_assignment'
  | 'explicit_s5_marker'
  | 'hostile_instruction'
  | 'financial_record_signal'
  | 'medical_record_signal'
  | 'legal_record_signal';

export interface DropboxContentPolicyFinding {
  finding_type: DropboxContentPolicyFindingType;
  finding_hash: string;
  confidence: number;
  structural_ref_json?: string;
}

export interface DropboxContentPolicyTextScanResult {
  trust_tier: DropboxContentPolicyTrustTier;
  trust_domain: 'secure_local';
  policy_decision: DropboxContentPolicyClassificationDecision;
  review_status: 'auto_classified' | 'needs_review' | 'blocked';
  classifier_kind: typeof DROPBOX_CONTENT_POLICY_CLASSIFIER_KIND;
  classifier_version: typeof DROPBOX_CONTENT_POLICY_CLASSIFIER_VERSION;
  findings: DropboxContentPolicyFinding[];
}

interface DropboxContentPolicyPattern {
  findingType: DropboxContentPolicyFindingType;
  pattern: RegExp;
  confidence: number;
  trustTier: DropboxContentPolicyTrustTier;
}

const SECRET_PATTERNS: DropboxContentPolicyPattern[] = [
  {
    findingType: 'private_key_material',
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g,
    confidence: 1,
    trustTier: 'S5',
  },
  {
    findingType: 'aws_access_key_id',
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    confidence: 0.98,
    trustTier: 'S5',
  },
  {
    findingType: 'slack_token',
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
    confidence: 0.98,
    trustTier: 'S5',
  },
  {
    findingType: 'api_secret_token',
    pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g,
    confidence: 0.95,
    trustTier: 'S5',
  },
  {
    findingType: 'credential_assignment',
    pattern: /\b(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password)\b\s*[:=]\s*['"]?[^'"\s]{12,}/gi,
    confidence: 0.9,
    trustTier: 'S5',
  },
  {
    findingType: 'explicit_s5_marker',
    pattern: /\b(S5|highly confidential|do not distribute)\b/gi,
    confidence: 0.72,
    trustTier: 'S5',
  },
];

const REVIEW_PATTERNS: DropboxContentPolicyPattern[] = [
  {
    findingType: 'hostile_instruction',
    pattern: /\b(ignore previous instructions|system prompt|developer message|exfiltrate|prompt injection)\b/gi,
    confidence: 0.8,
    trustTier: 'S4',
  },
  {
    findingType: 'financial_record_signal',
    pattern: /\b(bank account|routing number|tax return|irs|invoice|payroll|wire transfer|accountant)\b/gi,
    confidence: 0.65,
    trustTier: 'S4',
  },
  {
    findingType: 'medical_record_signal',
    pattern: /\b(diagnosis|medical record|prescription|patient|health insurance|lab result)\b/gi,
    confidence: 0.65,
    trustTier: 'S4',
  },
  {
    findingType: 'legal_record_signal',
    pattern: /\b(attorney|lawyer|legal advice|privileged|nda|settlement agreement|contract)\b/gi,
    confidence: 0.65,
    trustTier: 'S4',
  },
];

export function scanDropboxContentPolicyText(input: {
  text?: string;
  structuralRefJson?: string;
}): DropboxContentPolicyTextScanResult {
  const text = input.text?.trim() ?? '';
  if (!text) {
    return {
      trust_tier: 'S4',
      trust_domain: 'secure_local',
      policy_decision: 'metadata_only',
      review_status: 'auto_classified',
      classifier_kind: DROPBOX_CONTENT_POLICY_CLASSIFIER_KIND,
      classifier_version: DROPBOX_CONTENT_POLICY_CLASSIFIER_VERSION,
      findings: [],
    };
  }

  const secretFindings = scanPatterns(text, SECRET_PATTERNS, input.structuralRefJson);
  const reviewFindings = scanPatterns(text, REVIEW_PATTERNS, input.structuralRefJson);
  const findings = dedupeFindings([...secretFindings, ...reviewFindings]);
  const hasSecret = secretFindings.length > 0;
  const hasReview = reviewFindings.length > 0;

  return {
    trust_tier: hasSecret ? 'S5' : 'S4',
    trust_domain: 'secure_local',
    policy_decision: hasSecret ? 'blocked_sensitive' : hasReview ? 'needs_review' : 'index_allowed',
    review_status: hasSecret ? 'blocked' : hasReview ? 'needs_review' : 'auto_classified',
    classifier_kind: DROPBOX_CONTENT_POLICY_CLASSIFIER_KIND,
    classifier_version: DROPBOX_CONTENT_POLICY_CLASSIFIER_VERSION,
    findings,
  };
}

function scanPatterns(
  text: string,
  patterns: DropboxContentPolicyPattern[],
  structuralRefJson: string | undefined,
): DropboxContentPolicyFinding[] {
  const findings: DropboxContentPolicyFinding[] = [];
  for (const pattern of patterns) {
    pattern.pattern.lastIndex = 0;
    const matches = text.matchAll(pattern.pattern);
    for (const match of matches) {
      const matchedText = match[0]?.trim();
      if (!matchedText) continue;
      findings.push({
        finding_type: pattern.findingType,
        finding_hash: hashFinding(pattern.findingType, matchedText),
        confidence: pattern.confidence,
        ...(structuralRefJson ? { structural_ref_json: structuralRefJson } : {}),
      });
    }
  }
  return findings;
}

function dedupeFindings(findings: DropboxContentPolicyFinding[]): DropboxContentPolicyFinding[] {
  const seen = new Set<string>();
  const unique: DropboxContentPolicyFinding[] = [];
  for (const finding of findings) {
    const key = `${finding.finding_type}:${finding.finding_hash}:${finding.structural_ref_json ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(finding);
  }
  return unique;
}

function hashFinding(type: DropboxContentPolicyFindingType, matchedText: string): string {
  return createHash('sha256')
    .update(type)
    .update('\0')
    .update(matchedText)
    .digest('hex');
}
