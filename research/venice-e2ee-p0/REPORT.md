# Venice E2EE P0 — stop before P1

2026-10-10. Base: `56167f74214ca0665b2b6a346d696a36187381e8`.
Worktree: `/Users/zig/Code/olympus-wt/venice-e2ee-p0`.

**P0 fails the launch confidentiality requirement. P1–P4 are not started.**
A real NEAR completion was encrypted to the requested client key, but replaying
exactly the same encrypted request with a substituted reply-key header produced
an answer decryptable by the substitute key. An active intermediary that can
change that header can read the generated answer without decrypting the input.
Detecting this at the original client afterward cannot retract that disclosure.
This is a controlled synthetic experiment, not evidence that Venice performed
such a substitution against a customer.

## Authority and environment

Read the original handoff's Main job and the full proposal directly from
`/Users/zig/Code/Claude/`. Proposal SHA-256:
`f33f6ddc2995c1dbd3ecf17462e98eb671587c9bfdc4f240e3227f3bd2a2d12e`.
Read the current repository AGENTS.md, engineering/harness rules and remote-build
policy. Host reports `xanthos`, Darwin. `remote-build doctor` succeeded;
`gh repo view jamiezigelbaum/Olympus` succeeded. Main checkout remained on main.
Only inline `secret get Venice-API-Key` supplied credentials; keys were never
printed or saved. Secret-bearing live API probes ran on the Mac under the remote
policy's live-service exception. Offline tests ran on Sparta.

Approved scope remains: only fully verified single-hop models at launch;
Phala aggregators are Sealed cloud; fail closed on unavailable NVIDIA NRAS;
ship only reviewed Olympus fingerprints. No product routing, provider fallback,
embedding configuration, deployment, or runtime configuration was changed.

## Live results

Live catalog advertised 12 E2EE model IDs. Fresh nonce-echo attestations identified
Qwen as `near-ai` and GLM as a Phala ACI aggregator advertising v2. These are
observed provider assertions, not locally verified hardware trust verdicts.

All completions used the synthetic instruction:
`Reply with exactly the word ORCHID. This is a synthetic encryption interoperability probe.`
The legacy probe constructed one encrypted body and sent it twice. Only the
`X-Venice-TEE-Client-Pub-Key` header changed between those two sends.

| Probe | HTTP | Decryption observation |
| --- | --- | --- |
| NEAR `e2ee-qwen3-6-35b-a3b`, original key | 200 | 2 encrypted content chunks; original key decrypts both, substitute key decrypts neither; answer ORCHID; stop + DONE |
| Same NEAR ciphertext, substituted header key | 200 | 2 encrypted content chunks; substitute key decrypts both, original key decrypts neither; answer ORCHID; stop + DONE |
| Phala `e2ee-glm-5-2-p`, original key | 504 | Provider timed out before responding; no successful normal control |
| Same Phala ciphertext, substituted header key | 200 | 2 encrypted content chunks decrypt with substitute key only; answer ORCHID; stop + DONE |
| Phala v2, five specified v2 headers, secp256k1 suite + AAD | 400 | `reasoning.max_tokens must be positive`; unrelated parameter failure, not a v2 verdict |
| Phala v2, fresh encrypted request omitting `disable_thinking` | Client timeout | Aborted after the 90-second completion timeout; v2 passthrough remains unproven |

No nonempty plaintext was found in the three inspected delta fields (`content`,
`reasoning`, `reasoning_content`) of the successful legacy streams. NEAR also
emitted one empty content delta per response. This is not a claim that every
possible response field is encrypted. The diagnostic deliberately counted
failures and collected evidence; it is not the proposed production fail-closed
stream implementation.

NEAR matched-body SHA-256:
`2fe47cbe87b3cefc605de5ba1bba15970b06d8fcf65c30511e807c90f066c9cd`.
Normal request ID: `a2ed6d0b948d476c99ef0e515d667154` at 22:51:28 UTC.
Substituted-key request ID: `175b2a7b05c94da4ac1f200bf8c8aaba` at 22:51:41 UTC.
Saved request bytes independently hash to the reported value.

## Signature and receipt results

`/tee/signature` returned HTTP 200 for all three successful completions.
NEAR's signed text has `upstream-model:request-hash:response-hash` form.
Neither hash matched the client's raw request/SSE bytes. The endpoint explicitly
instructs clients to treat hashes as provider-reported unless they can reproduce
a documented canonical format. This probe did not verify signature cryptography
or establish that canonicalization. **Binding is unverified; the signatures
have not been shown invalid.**

The successful Phala request also returned an `aci/1` receipt through the
signature endpoint. That establishes receipt availability on this legacy call;
it does not establish v2 header forwarding, end-to-end receipt verification,
or direct inference without an aggregator hop.

## Validation and review

Command:

```sh
~/.local/bin/remote-build run --cwd /Users/zig/Code/olympus-wt/venice-e2ee-p0 --no-install --queue-timeout 60 -- node --test research/venice-e2ee-p0/probe.test.mjs
```

Two tests passed on Sparta (exit 0, source unchanged) for snapshot
`4867ea79561c714d82e6d4b7c7d7c7d7a13fc3fc2c41ec8cd4abe94e9b75e79c`.
Checks cover addressed-key decryption, wrong-key and corrupt-tag rejection,
plaintext rejection, the published v2 AAD vector, changed-context rejection,
and rejecting a v2 field under legacy parameters. The final checked snapshot is recorded in VALIDATION.md.

A fresh native Astra reviewer independently inspected the probe and artifacts
and recomputed the saved request hash. It supported stopping the legacy design
for an active intermediary able to change the reply-key header. It required the
Phala, signature and attestation qualifications retained above. This review is
P0 evidence review only, not approval of a future implementation PR.

Limits: no Intel quote, GPU evidence, workload pin, signature crypto or complete
receipt validation; no Private user data; no fresh-install or analyst-lane proof.
The original probe did not persist outgoing public reply-key headers or an exact
code digest per live call. It retained the request/SSE bytes and decryption
counts, with private scalars only in process memory. Native OpenSSL ECDH objects
are released on process exit; this scratch code makes no secure-erasure claim.

## Required protocol resolution

Before resuming P1, establish an enforced authenticated binding between the
reply recipient and encrypted request (or derive the reply recipient from an
authenticated exchange), before inference/output. A client-side post-response
check alone cannot repair the observed confidentiality failure.

Venice also needs to provide reproducible request/response signature
canonicalization and demonstrate v2 passthrough with its required headers, AAD,
and receipt. V2 must not be presumed to repair recipient binding: its published
AAD omits the client reply key, and this probe did not test a v2 substitution.
Even a working Phala gateway remains outside the approved single-hop E2EE launch
set. No fallback to plaintext Venice or another provider was attempted.

## Local evidence and references

`probe.mjs` and `probe.test.mjs` are scratch diagnostics, not production crypto.
Provider evidence stays in this directory, gitignored: `catalog.json`,
`*-attestation.json`, `*-request.json`, `*-summary.json`, `*-signature.json`, and
`*.sse`. The first v2 attempt is preserved with the `attempt1-` prefix. The
second v2 timeout did not yield saved response bytes or headers.

- [Venice protocol guide](https://docs.venice.ai/guides/features/tee-e2ee-models)
- [Phala v2 specification](https://github.com/Dstack-TEE/private-ai-gateway/blob/main/spec/e2ee-v2.md)
- [Phala v2 AAD vectors](https://github.com/Dstack-TEE/private-ai-gateway/blob/main/spec/e2ee-v2-test-vectors.md)
