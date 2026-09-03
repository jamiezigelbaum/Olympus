import { request as httpRequest } from 'node:http';

import type {
  ExpertHireRequest,
  ExpertHireResult,
  ExpertReportResult,
} from './broker.ts';
import type { LedgerSummary } from './ledger.ts';
import type { QuotedRawReport } from './membrane.ts';
import { HireBrokerError, type HireBrokerRefusalCode } from './types.ts';

export interface HireBrokerClientOptions {
  socketPath: string;
  timeoutMs?: number;
}

interface ErrorBody {
  error?: { code?: HireBrokerRefusalCode; message?: string };
}

export class HireBrokerClient {
  private readonly socketPath: string;
  private readonly timeoutMs: number;

  constructor(options: HireBrokerClientOptions) {
    if (!options.socketPath.startsWith('/') || /[\r\n\u0000]/.test(options.socketPath)) {
      throw new Error('Hire Broker socket path must be an absolute safe path.');
    }
    this.socketPath = options.socketPath;
    this.timeoutMs = options.timeoutMs ?? 35_000;
  }

  async hire(request: ExpertHireRequest): Promise<ExpertHireResult> {
    return this.send<ExpertHireResult>('POST', '/v1/hire', request);
  }

  async report(handle: string): Promise<ExpertReportResult> {
    return this.send<ExpertReportResult>('POST', '/v1/report', { handle });
  }

  async rawReport(handle: string, ownerAuthorized: boolean): Promise<QuotedRawReport> {
    return this.send<QuotedRawReport>('POST', '/v1/report/raw', { handle, ownerAuthorized });
  }

  async ledgerSummary(): Promise<LedgerSummary> {
    return this.send<LedgerSummary>('GET', '/v1/ledger/summary');
  }

  async health(): Promise<{ ok: true }> {
    return this.send<{ ok: true }>('GET', '/v1/health');
  }

  private async send<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
    return new Promise<T>((resolve, reject) => {
      const request = httpRequest({
        socketPath: this.socketPath,
        path,
        method,
        headers: encoded
          ? { 'content-type': 'application/json', 'content-length': String(encoded.length) }
          : undefined,
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown;
          try {
            parsed = text ? JSON.parse(text) : {};
          } catch {
            reject(new HireBrokerError('transport_failed', 'Hire Broker returned malformed JSON.', 502));
            return;
          }
          const status = response.statusCode ?? 500;
          if (status < 200 || status >= 300) {
            const error = parsed as ErrorBody;
            reject(new HireBrokerError(
              error.error?.code ?? 'transport_failed',
              error.error?.message || `Hire Broker request failed (${status}).`,
              status,
            ));
            return;
          }
          resolve(parsed as T);
        });
      });
      request.setTimeout(this.timeoutMs, () => {
        request.destroy(new HireBrokerError('transport_failed', 'Hire Broker request timed out.', 504));
      });
      request.on('error', (error) => reject(error));
      if (encoded) request.write(encoded);
      request.end();
    });
  }
}
