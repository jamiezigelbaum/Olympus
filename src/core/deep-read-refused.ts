export class DeepReadRefused extends Error {
  constructor(readonly code: 'no_private_model' | 'model_unavailable' | 'not_found' | 'nothing_readable' | 'invalid_set', message: string) { super(message); }
}
