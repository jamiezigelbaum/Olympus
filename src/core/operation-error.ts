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

/**
 * An unknown, expired, or another caller's source-answer job: one refusal, so
 * a caller cannot tell a job it may not read from one that does not exist.
 */
export function sourceAnswerJobNotFound(): OperationError {
  return new OperationError(
    'source_answer_job_not_found',
    'No Olympus answer with that job_id is available to this connection. It may have expired or Olympus may have restarted.',
    'Ask the question again with source_answer.',
  );
}
