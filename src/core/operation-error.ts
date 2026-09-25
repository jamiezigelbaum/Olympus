export type OperationErrorCode =
  | 'invalid_params'
  | 'config_error'
  | 'argus_unreachable'
  | 'argus_error'
  | 'email_not_configured'
  | 'email_unreachable'
  | 'email_error'
  | 'unsupported_filter'
  | 'invalid_request'
  | 'email_policy_violation'
  | 'source_index_not_enabled'
  | 'source_index_policy_violation'
  | 'source_index_error'
  | 'source_answer_busy'
  | 'source_answer_job_not_found';

export class OperationError extends Error {
  code: OperationErrorCode;
  suggestion: string | undefined;

  constructor(
    code: OperationErrorCode,
    message: string,
    suggestion?: string,
  ) {
    super(message);
    this.name = 'OperationError';
    this.code = code;
    this.suggestion = suggestion;
  }

  toJSON(): Record<string, string> {
    return {
      error: this.code,
      message: this.message,
      ...(this.suggestion ? { suggestion: this.suggestion } : {}),
    };
  }
}
