// Model-id policy for local (loopback) model profiles.
//
// A loopback address does not prove a model runs locally. Ollama serves
// cloud-hosted models through the local daemon: a request to
// http://127.0.0.1:11434 naming such a model is forwarded to ollama.com.
// Ollama names these models with a tag of `cloud` or a tag ending in `-cloud`
// (`gemma4:cloud`, `gpt-oss:120b-cloud`; docs.ollama.com/cloud and the
// ollama.com library tag lists). A local-trust profile naming one would send
// Private evidence to the provider's cloud while every address check passes.
//
// The rule is on the TAG only: the text after the last `:` in the final path
// segment of the model id, compared case-insensitively. It matches when that
// tag is exactly `cloud` or ends in `-cloud`. A name that merely contains
// "cloud" elsewhere (`cloudllama:7b`, `my-cloud-model`, `qwen3:cloudy`,
// `org/cloud-tools:latest`) is not a cloud-forwarding id and is accepted. An
// id with no tag is never matched.

import { OperationError } from './operation-error.ts';

export function isCloudForwardingModelId(modelId: string): boolean {
  const trimmed = modelId.trim().toLowerCase();
  const lastSegment = trimmed.slice(trimmed.lastIndexOf('/') + 1);
  const colon = lastSegment.lastIndexOf(':');
  if (colon < 0) return false;
  const tag = lastSegment.slice(colon + 1);
  return tag === 'cloud' || tag.endsWith('-cloud');
}

/**
 * Throws a `config_error` when a model id configured for a local model lane
 * names a cloud-forwarding model. `label` says which setting is refused.
 */
export function assertLocalModelIdNotCloudForwarding(label: string, modelId: string): void {
  if (!isCloudForwardingModelId(modelId)) return;
  throw new OperationError(
    'config_error',
    `${label} names model "${modelId.trim()}", which runs in the provider's cloud and cannot serve as a local model.`,
    'Model tags ending in ":cloud" or "-cloud" (Ollama cloud models) are forwarded off this machine by the local daemon. Choose a model that runs locally, or configure the cloud model as a cloud profile.',
  );
}
