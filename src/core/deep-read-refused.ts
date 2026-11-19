export class DeepReadRefused extends Error {
  readonly sectionsTotal?: number;
  readonly estimateSeconds?: number;

  constructor(...[code, message, estimate]:
    | [code: 'no_private_model' | 'model_unavailable' | 'not_found' | 'nothing_readable' | 'invalid_set', message: string]
    | [code: 'too_long', message: string, estimate: { sectionsTotal: number; estimateSeconds: number }]) {
    super(message);
    this.code = code;
    if (estimate) {
      this.sectionsTotal = estimate.sectionsTotal;
      this.estimateSeconds = estimate.estimateSeconds;
    }
  }

  readonly code: 'no_private_model' | 'model_unavailable' | 'not_found' | 'nothing_readable' | 'invalid_set' | 'too_long';
}
