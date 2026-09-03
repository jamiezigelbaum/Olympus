import { randomUUID } from 'node:crypto';

import type { FetchLike } from './identity.ts';
import { HireBrokerError } from './types.ts';

const MAX_RESPONSE_BYTES = 512 * 1024;
const SAFE_REMOTE_ID = /^[A-Za-z0-9._:-]{1,200}$/;

export interface A2aSubmitInput {
  endpoint: string;
  brief: string;
  context?: string;
}

export interface A2aSubmission {
  remoteTaskId: string;
  status: string;
}

export interface A2aTaskReport {
  status: 'pending' | 'completed' | 'failed';
  report?: string;
}

export interface A2aTransport {
  submit(input: A2aSubmitInput): Promise<A2aSubmission>;
  getReport(endpoint: string, remoteTaskId: string): Promise<A2aTaskReport>;
}

export class JsonRpcA2aTransport implements A2aTransport {
  constructor(private readonly fetchImpl: FetchLike = globalThis.fetch) {}

  async submit(input: A2aSubmitInput): Promise<A2aSubmission> {
    const text = input.context ? `${input.brief}\n\nContext:\n${input.context}` : input.brief;
    const result = await this.call(input.endpoint, 'message:send', {
      message: {
        role: 'user',
        messageId: randomUUID(),
        parts: [{ kind: 'text', text }],
      },
    });
    const record = asRecord(result);
    const task = asRecord(record?.task) ?? record;
    const remoteTaskId = firstString(task?.id, task?.taskId);
    if (!remoteTaskId || !SAFE_REMOTE_ID.test(remoteTaskId)) {
      throw new HireBrokerError('transport_failed', 'Consultant returned an invalid task handle.', 502);
    }
    return {
      remoteTaskId,
      status: taskState(task) ?? 'submitted',
    };
  }

  async getReport(endpoint: string, remoteTaskId: string): Promise<A2aTaskReport> {
    if (!SAFE_REMOTE_ID.test(remoteTaskId)) {
      throw new HireBrokerError('report_unavailable', 'Stored consultant task handle is invalid.', 503);
    }
    const result = await this.call(endpoint, 'tasks:get', { id: remoteTaskId });
    const task = asRecord(result);
    const state = taskState(task);
    if (state === 'failed' || state === 'canceled' || state === 'cancelled' || state === 'rejected') {
      return { status: 'failed' };
    }
    const report = extractReportText(task);
    if (!report) return { status: 'pending' };
    return { status: 'completed', report };
  }

  private async call(endpoint: string, method: 'message:send' | 'tasks:get', params: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }),
      });
    } catch {
      throw new HireBrokerError('transport_failed', 'Consultant transport is unavailable.', 502);
    }
    if (!response.ok) {
      throw new HireBrokerError('transport_failed', `Consultant transport failed with status ${response.status}.`, 502);
    }
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
      throw new HireBrokerError('transport_failed', 'Consultant response exceeded the broker limit.', 502);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      throw new HireBrokerError('transport_failed', 'Consultant returned malformed protocol data.', 502);
    }
    const record = asRecord(payload);
    if (!record || record.jsonrpc !== '2.0' || record.error !== undefined || !('result' in record)) {
      throw new HireBrokerError('transport_failed', 'Consultant returned a protocol error.', 502);
    }
    return record.result;
  }
}

function extractReportText(task: Record<string, unknown> | undefined): string | undefined {
  if (!task) return undefined;
  const texts: string[] = [];
  collectTextParts(texts, task.artifacts);
  collectTextParts(texts, task.messages);
  const direct = firstString(task.report, task.text, task.output);
  if (direct) texts.push(direct);
  const combined = texts.join('\n\n').trim();
  if (!combined) return undefined;
  if (Buffer.byteLength(combined, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new HireBrokerError('transport_failed', 'Consultant report exceeded the broker limit.', 502);
  }
  return combined;
}

function collectTextParts(target: string[], value: unknown): void {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    const record = asRecord(item);
    if (!record) continue;
    const direct = firstString(record.text);
    if (direct) target.push(direct);
    if (Array.isArray(record.parts)) {
      for (const part of record.parts) {
        const text = firstString(asRecord(part)?.text);
        if (text) target.push(text);
      }
    }
  }
}

function taskState(task: Record<string, unknown> | undefined): string | undefined {
  return firstString(task?.state, task?.status, asRecord(task?.status)?.state)?.toLowerCase();
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
