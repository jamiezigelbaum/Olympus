import { describe, expect, test } from 'bun:test';
import {
  assertOpenShellPosturePass,
  createReferenceOpenShellPostureProof,
  evaluateOpenShellPosture,
} from '../src/core/openshell-posture.ts';

describe('OpenShell posture proof contract', () => {
  test('passes only when normal agent bypass surfaces are denied and product paths remain available', () => {
    const proof = createReferenceOpenShellPostureProof();

    expect(proof).toMatchObject({
      proof_id: 'v0.9.openshell.posture-proof',
      mode: 'contract_fixture',
      actor: 'normal_agent_session',
      summary: {
        decision: 'pass',
        failed_probe_ids: [],
        bypass_surfaces_denied: true,
        approved_surfaces_available: true,
        audit_surface_present: true,
      },
    });
    expect(proof.probes.map((probe) => probe.id)).toEqual(expect.arrayContaining([
      'direct_source_store_read',
      'direct_credential_store_read',
      'raw_connector_cli',
      'arbitrary_network_egress',
      'unapproved_model_provider',
      'privilege_escalation',
      'openclaw_gateway_endpoint',
      'olympus_source_worker_endpoint',
      'approved_model_provider',
      'policy_denial_audit',
      'policy_version_audit',
    ]));
    assertOpenShellPosturePass(proof);
  });

  test('fails closed if raw connector CLI access is available to a normal session', () => {
    const proof = createReferenceOpenShellPostureProof();
    const weakened = evaluateOpenShellPosture(proof.probes.map((probe) => (
      probe.id === 'raw_connector_cli'
        ? { ...probe, observation: 'allowed' as const }
        : probe
    )));

    expect(weakened.summary).toMatchObject({
      decision: 'fail',
      bypass_surfaces_denied: false,
      approved_surfaces_available: true,
      audit_surface_present: true,
    });
    expect(weakened.summary.failed_probe_ids).toContain('raw_connector_cli');
    expect(() => assertOpenShellPosturePass(weakened)).toThrow('raw_connector_cli');
  });
});
