# Focused independent review of the parallel experiment

Reviewed runtime commit: `03d87c1f47cc99ad73cb7d03487be66c52d7ee89`
Comparison baseline: `911caf3f834433f3547049ca07a7bb8d8d268ee7`

Result: **PASS for the focused public-boundary scope**, with three minor findings.
The earlier broad repository review timed out after 600 seconds and returned
no verdict. The focused review is not a substitute for real-provider or
release qualification, and it did not audit every retained implementation.

Follow-up commit `ab38fea7e86d5d9223487b291c99226f5e140694` addresses the findings:

1. The archive test now rejects an unresolved packaged Google client constant,
   in addition to requiring the fixture client identity.
2. A custom clean-home plan requires explicit `--fixture`; the proof labels
   fixture mode and hashes the exact plan bytes parsed. Qualification receipt
   formats and real-provider gates are unchanged.
3. The unused GCP and Notion members are removed from the connect-source type.

The follow-up passed typecheck and 30 focused tests. Its committed runtime
bundles are identical to those in the reviewed commit. These follow-up edits
were locally verified; the reviewer did not review that later commit.

## Reviewer report

**Verdict: PASS for this focused scope.** No blocking regression found in public-boundaries.diff or the supplied boundary modules. Three low-severity, actionable items follow, then what checked out, then limits.

## Findings

**1. Low. Packaged Google client identity is asserted by string presence only.**
Candidate `src/core/google-pilot-client.ts:22-27` guards the compile-time constant with a `typeof` check on an undeclared identifier. Correct behaviour depends on the bundler substituting the identifier inside the `typeof` operand and folding it. The only packaging assertion, `test/release-artifact.test.ts:135-136`, checks that the fixture id string appears in the bundle and the old sentinel does not. Scenario: if the identifier inside the `typeof` operand were left unsubstituted, the literal would still be present and the test would pass, but at runtime the guard would evaluate to undefined and every packaged install would silently fall back to the BYO-OAuth path. I expect Bun's esbuild-derived define to fold this correctly, so this is a coverage gap rather than a confirmed defect. Fix: add an assertion that the packaged bundle no longer contains the identifier name at all, or avoid the `typeof` guard.

```ts
expect(packagedRuntime).not.toContain('OLYMPUS_PACKAGED_GOOGLE_PILOT_CLIENT_ID');
```

**2. Low. The new plan override weakens receipt binding in the clean-home rehearsal.**
Candidate `scripts/qualification/simulated-clean-home.ts:19-28` accepts an arbitrary plan file. Artifact identity verification and the per-check assertion counts at lines 123-125 are then taken from the caller-supplied plan, and neither the receipts at lines 126-134 nor the proof line at line 139 record which plan was used. Scenario: a rehearsal run against an ad hoc plan emits receipts indistinguishable from ones produced against the committed plan. This is not a product regression, but the brief leans on these receipts as evidence. Fix: emit the plan path and sha256 into the proof line and each receipt, or refuse the override unless a fixture flag is set.

**3. Info. Residual type references to removed connect sources.**
Candidate `src/core/connect.ts:53` and `:61` still list `gcp` and `notion` in the connect source union. Neither is in the public credential provider roster at `src/workers/credential-broker/index.ts:42-50` nor in the public connect list, and the CLI gate at `src/cli.ts:1048-1050` prevents reaching them. No runtime effect. Fix: drop the two members so the type matches the runtime roster.

## What checked out

- **Native, MCP, CLI scope.** The public allowlists in `public-surface.ts` are unchanged except a header comment. The plugin manifest is byte-identical. Exposure logic drops only the dev-only branch and an unused parameter. The private extension loader and active-model plumbing are gone from the native plugin.
- **Credentials.** The public provider roster equals what the baseline public build produced after stripping. The Gmail and Drive publisher-exchange refresh path is intact. The removed service-account lane and Castor env fallbacks were already excluded from the public build. The removed credential-health probe and alarm were never reachable from the public CLI, and the report reader remains.
- **Data and history.** The ledger store stops creating and writing the two retired tables, with no DELETE or ALTER against them. Tests confirm pre-existing rows are untouched and dashboard samples still accumulate. Data lifecycle removed only the Reflect and Roam specs.
- **Doctor.** Corpora are now filtered to the public registry's status-eligible set. All ten default corpora carry that capability, legacy ids canonicalise, and tests cover hidden unregistered corpora and config-driven eligibility. This narrows what Doctor shows relative to the baseline public build, which is the safer direction.
- **Build.** Terser and the strip plugin are removed. The manifest guard, owner-identifier scan on staged and extracted files, exact inventory check, and top-level-await scan remain. The client id is still required and format-validated at `scripts/release-artifact.ts:210-216`.

## Review limits

- The strip module and its stripped-module list were not supplied. I verified the eight supplied modules carry no leftover exclusion markers, but cannot confirm every formerly stripped module was cleaned. Tool-definition byte equivalence covers the operations registry, not dashboard or email-client modules.
- Call sites of the credential-health report reader and consumers of qualification receipts were not supplied.
- Nothing was executed. Bun define and `typeof` folding semantics are inferred, not observed.
- Private-install migration behaviour is out of scope by the brief, for example registry entries with retired providers or leftover Reflect and Roam stores under a root that full delete removes.
- Dashboard acceptance remains pending per the brief.
