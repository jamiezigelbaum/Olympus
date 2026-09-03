export type OpenShellProbeCategory =
  | 'filesystem'
  | 'network'
  | 'process'
  | 'credential'
  | 'inference'
  | 'audit';

export type OpenShellProbeExpectation = 'allow' | 'deny' | 'require';

export type OpenShellProbeObservation = 'allowed' | 'denied' | 'present' | 'missing';

export interface OpenShellBypassProbe {
  id: string;
  category: OpenShellProbeCategory;
  surface: string;
  expectation: OpenShellProbeExpectation;
  observation: OpenShellProbeObservation;
  evidence: string;
}

export interface OpenShellPostureProof {
  proof_id: 'v0.9.openshell.posture-proof';
  mode: 'contract_fixture' | 'configured_runtime';
  actor: 'normal_agent_session';
  summary: {
    decision: 'pass' | 'fail';
    failed_probe_ids: string[];
    bypass_surfaces_denied: boolean;
    approved_surfaces_available: boolean;
    audit_surface_present: boolean;
  };
  probes: OpenShellBypassProbe[];
}

const REQUIRED_DENY_PROBES = [
  'direct_source_store_read',
  'direct_credential_store_read',
  'raw_connector_cli',
  'arbitrary_network_egress',
  'unapproved_model_provider',
  'privilege_escalation',
] as const;

const REQUIRED_ALLOW_PROBES = [
  'openclaw_gateway_endpoint',
  'olympus_source_worker_endpoint',
  'approved_model_provider',
] as const;

const REQUIRED_AUDIT_PROBES = [
  'policy_denial_audit',
  'policy_version_audit',
] as const;

export function createReferenceOpenShellPostureProof(): OpenShellPostureProof {
  return evaluateOpenShellPosture([
    {
      id: 'direct_source_store_read',
      category: 'filesystem',
      surface: 'normal agent reads local source-index stores directly',
      expectation: 'deny',
      observation: 'denied',
      evidence: 'source stores are reachable through Olympus workers/tools, not ambient session filesystem mounts',
    },
    {
      id: 'direct_credential_store_read',
      category: 'credential',
      surface: 'normal agent reads 1Password, OAuth, or service-account material directly',
      expectation: 'deny',
      observation: 'denied',
      evidence: 'credential use is mediated by runtime-owned wrappers, named references, or workers',
    },
    {
      id: 'raw_connector_cli',
      category: 'process',
      surface: 'normal agent invokes raw connector CLI to fetch source material',
      expectation: 'deny',
      observation: 'denied',
      evidence: 'normal source access flows through Olympus tools such as source_answer, not raw gog shell calls',
    },
    {
      id: 'arbitrary_network_egress',
      category: 'network',
      surface: 'normal agent sends data to arbitrary external endpoints',
      expectation: 'deny',
      observation: 'denied',
      evidence: 'network egress is intended to be deny-by-default with narrow OpenClaw/Olympus/model/provider endpoints',
    },
    {
      id: 'unapproved_model_provider',
      category: 'inference',
      surface: 'normal agent routes private material to an unapproved model/provider',
      expectation: 'deny',
      observation: 'denied',
      evidence: 'inference routing must be provider/model constrained by session policy',
    },
    {
      id: 'privilege_escalation',
      category: 'process',
      surface: 'normal agent escalates process privileges or starts dangerous host processes',
      expectation: 'deny',
      observation: 'denied',
      evidence: 'process policy denies privilege escalation and dangerous process behavior',
    },
    {
      id: 'openclaw_gateway_endpoint',
      category: 'network',
      surface: 'normal agent reaches the OpenClaw Gateway',
      expectation: 'allow',
      observation: 'allowed',
      evidence: 'approved product path needs Gateway access for effective tools and session routing',
    },
    {
      id: 'olympus_source_worker_endpoint',
      category: 'network',
      surface: 'normal agent reaches Olympus bounded source tools through Gateway/worker endpoints',
      expectation: 'allow',
      observation: 'allowed',
      evidence: 'approved product path uses bounded Olympus tools such as source_answer and email_answer',
    },
    {
      id: 'approved_model_provider',
      category: 'inference',
      surface: 'normal agent reaches approved model/provider routes for its session',
      expectation: 'allow',
      observation: 'allowed',
      evidence: 'approved Castor or Argus model routes stay explicit instead of ambient arbitrary provider access',
    },
    {
      id: 'policy_denial_audit',
      category: 'audit',
      surface: 'policy denial events are observable',
      expectation: 'require',
      observation: 'present',
      evidence: 'denials must be logged or inspectable enough for runtime proof review',
    },
    {
      id: 'policy_version_audit',
      category: 'audit',
      surface: 'policy version or deployment identity is observable',
      expectation: 'require',
      observation: 'present',
      evidence: 'runtime proof must record enough host/config identity to detect policy drift',
    },
  ]);
}

export function evaluateOpenShellPosture(probes: OpenShellBypassProbe[]): OpenShellPostureProof {
  const failedProbeIds = probes
    .filter((probe) => !probePassed(probe))
    .map((probe) => probe.id);
  const bypassSurfacesDenied = REQUIRED_DENY_PROBES.every((id) => {
    const probe = probes.find((item) => item.id === id);
    return probe?.expectation === 'deny' && probe.observation === 'denied';
  });
  const approvedSurfacesAvailable = REQUIRED_ALLOW_PROBES.every((id) => {
    const probe = probes.find((item) => item.id === id);
    return probe?.expectation === 'allow' && probe.observation === 'allowed';
  });
  const auditSurfacePresent = REQUIRED_AUDIT_PROBES.every((id) => {
    const probe = probes.find((item) => item.id === id);
    return probe?.expectation === 'require' && probe.observation === 'present';
  });

  return {
    proof_id: 'v0.9.openshell.posture-proof',
    mode: 'contract_fixture',
    actor: 'normal_agent_session',
    summary: {
      decision: failedProbeIds.length === 0
        && bypassSurfacesDenied
        && approvedSurfacesAvailable
        && auditSurfacePresent
        ? 'pass'
        : 'fail',
      failed_probe_ids: failedProbeIds,
      bypass_surfaces_denied: bypassSurfacesDenied,
      approved_surfaces_available: approvedSurfacesAvailable,
      audit_surface_present: auditSurfacePresent,
    },
    probes: [...probes],
  };
}

export function assertOpenShellPosturePass(proof: OpenShellPostureProof): void {
  if (proof.summary.decision !== 'pass') {
    const failed = proof.summary.failed_probe_ids.join(', ') || 'required posture summary flag';
    throw new Error(`OpenShell posture proof failed: ${failed}`);
  }
}

function probePassed(probe: OpenShellBypassProbe): boolean {
  if (probe.expectation === 'deny') {
    return probe.observation === 'denied';
  }
  if (probe.expectation === 'allow') {
    return probe.observation === 'allowed';
  }
  return probe.observation === 'present';
}
