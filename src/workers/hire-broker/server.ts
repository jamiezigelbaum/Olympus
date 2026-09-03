import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createConnection } from 'node:net';
import { dirname } from 'node:path';

import type { ExpertHireRequest, HireBroker } from './broker.ts';
import { HireBrokerError } from './types.ts';

export interface HireBrokerServerOptions {
  broker: HireBroker;
  socketPath: string;
  requestBodyLimitBytes?: number;
}

export interface HireBrokerServer {
  socketPath: string;
  close(): Promise<void>;
}

export async function startHireBrokerServer(options: HireBrokerServerOptions): Promise<HireBrokerServer> {
  if (!options.socketPath.startsWith('/') || /[\r\n\u0000]/.test(options.socketPath)) {
    throw new Error('Hire Broker socket path must be an absolute safe path.');
  }
  await mkdir(dirname(options.socketPath), { recursive: true, mode: 0o700 });
  await chmod(dirname(options.socketPath), 0o700);
  if (await socketAcceptsConnections(options.socketPath)) {
    throw new Error(`Hire Broker socket is already active: ${options.socketPath}`);
  }
  await removeSocketFile(options.socketPath);
  await options.broker.initialize();

  const server = createServer(async (request, response) => {
    try {
      await routeRequest(options, request, response);
    } catch (error) {
      writeError(response, error);
    }
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(options.socketPath, () => {
      server.off('error', onError);
      resolve();
    });
  });
  await chmod(options.socketPath, 0o600);

  return {
    socketPath: options.socketPath,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      await removeSocketFile(options.socketPath);
    },
  };
}

async function routeRequest(
  options: HireBrokerServerOptions,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://hire-broker.local');
  if (request.method === 'GET' && url.pathname === '/v1/health') {
    writeJson(response, 200, { ok: true });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/v1/ledger/summary') {
    writeJson(response, 200, await options.broker.ledgerSummary());
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v1/hire') {
    const body = await readJsonBody(request, options.requestBodyLimitBytes ?? 32 * 1024);
    assertHireRequest(body);
    writeJson(response, 200, await options.broker.hire(body));
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v1/report') {
    const body = await readJsonBody(request, options.requestBodyLimitBytes ?? 32 * 1024);
    const handle = exactBody(body, ['handle']).handle;
    writeJson(response, 200, await options.broker.report(handle));
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v1/report/raw') {
    const body = exactBody(await readJsonBody(request, options.requestBodyLimitBytes ?? 32 * 1024), [
      'handle',
      'ownerAuthorized',
    ]);
    if (typeof body.ownerAuthorized !== 'boolean') throw invalidRequest();
    writeJson(response, 200, await options.broker.rawReport(body.handle, body.ownerAuthorized));
    return;
  }
  throw new HireBrokerError('invalid_request', 'Hire Broker route was not found.', 404);
}

function assertHireRequest(value: unknown): asserts value is ExpertHireRequest {
  const body = exactBody(value, ['listing', 'brief', 'context', 'budget', 'ownerConfirmed', 'ownerAuthorized']);
  if (typeof body.brief !== 'string'
    || (body.context !== undefined && typeof body.context !== 'string')
    || (body.ownerConfirmed !== undefined && typeof body.ownerConfirmed !== 'boolean')
    || (body.ownerAuthorized !== undefined && typeof body.ownerAuthorized !== 'boolean')) {
    throw invalidRequest();
  }
}

function exactBody(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidRequest();
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !allowed.includes(key))) throw invalidRequest();
  return body;
}

async function readJsonBody(request: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > limit) throw new HireBrokerError('invalid_request', 'Hire Broker request is too large.', 413);
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw invalidRequest();
  }
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(value));
}

function writeError(response: ServerResponse, error: unknown): void {
  const refusal = error instanceof HireBrokerError
    ? error
    : new HireBrokerError('transport_failed', 'Hire Broker request failed.', 500);
  writeJson(response, refusal.status, { error: { code: refusal.code, message: refusal.message } });
}

function invalidRequest(): HireBrokerError {
  return new HireBrokerError('invalid_request', 'Hire Broker request is invalid.', 400);
}

async function socketAcceptsConnections(path: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection(path);
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}

async function removeSocketFile(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (!info.isSocket()) throw new Error(`Refusing to remove non-socket Hire Broker path: ${path}`);
    await unlink(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
}
