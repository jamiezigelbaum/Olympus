// Optional transport for the same pinned LiteRT model. No remote error body,
// URL, credentials or input is included in diagnostics.
import { readFileSync } from 'node:fs';
import type { LiteRtDevice, LiteRtEmbedder, LiteRtEmbedItem } from './litert-runtime.ts';

export interface RemoteLiteRtIdentity {
  modelId: string;
  weightsSha256: string;
  runtime: string;
  dimension: number;
  maxTokens: number;
  overflow: 'chunk-and-average';
}

export class RemoteLiteRtEmbedder implements LiteRtEmbedder {
  device: LiteRtDevice = 'cpu';
  readonly vision = false;
  private verified = false;
  private retryAt = 0;
  private state: 'unused' | 'remote' | 'local' = 'unused';
  private slot: Promise<void> = Promise.resolve();
  private url: URL;

  constructor(private options: {
    url: string;
    tokenFile?: string | undefined;
    identity: RemoteLiteRtIdentity;
    now?: () => number;
    requestTimeoutMs?: number | undefined;
  }) {
    try {
      this.url = new URL(options.url);
    } catch {
      throw new Error('Invalid built-in embedding remote URL.');
    }
    const loopback = this.url.hostname === 'localhost' || this.url.hostname === '[::1]'
      || /^127(?:\.\d{1,3}){3}$/.test(this.url.hostname);
    if ((this.url.protocol !== 'https:' && !(this.url.protocol === 'http:' && loopback))
      || this.url.username || this.url.password || this.url.search || this.url.hash) {
      throw new Error('Built-in embedding remote requires HTTPS or loopback HTTP, without URL credentials, query or fragment.');
    }
  }

  get active(): boolean { return this.state === 'remote'; }

  async embed(items: readonly LiteRtEmbedItem[]): Promise<Float32Array[]> {
    const previous = this.slot;
    let unlock!: () => void;
    this.slot = new Promise<void>((resolve) => { unlock = resolve; });
    await previous;
    try {
      const now = this.options.now ?? Date.now;
      if (now() < this.retryAt) throw new Error('Remote embedding cooling down.');
      try {
        if (items.length === 0 || items.length > 8 || items.some((item) => typeof item !== 'string')) {
          throw new Error('Remote embedding requires a text-only batch.');
        }
        if (!this.verified) {
          const handshake = await this.request('/v1/handshake');
          for (const [field, value] of Object.entries(this.options.identity)) {
            if (handshake[field] !== value) throw new Error('Remote embedding identity mismatch.');
          }
          if (handshake.device !== 'cpu' && handshake.device !== 'gpu') throw new Error('Invalid remote device.');
          if (handshake.vision !== false) throw new Error('Invalid remote vision capability.');
          this.device = handshake.device;
          this.verified = true;
        }
        const response = await this.request('/v1/embed', items as readonly string[]);
        const identity = this.options.identity;
        if (response.weightsSha256 !== identity.weightsSha256 || response.runtime !== identity.runtime
          || response.dimension !== identity.dimension || typeof response.vectors !== 'string') {
          throw new Error('Remote embedding identity mismatch.');
        }
        const bytes = Buffer.from(response.vectors, 'base64');
        if (bytes.length !== items.length * identity.dimension * 4) throw new Error('Invalid remote vector length.');
        const vectors = items.map((_, row) => Float32Array.from({ length: identity.dimension }, (_, column) =>
          bytes.readFloatLE((row * identity.dimension + column) * 4)));
        if (vectors.some((vector) => vector.some((value) => !Number.isFinite(value)) || !vector.some((value) => value !== 0))) {
          throw new Error('Invalid remote vector values.');
        }
        this.transition('remote');
        return vectors;
      } catch {
        this.verified = false;
        this.retryAt = now() + 60_000;
        this.transition('local');
        throw new Error('Remote embedding unavailable; using local helper.');
      }
    } finally { unlock(); }
  }

  async release(): Promise<void> { this.verified = false; }

  private transition(state: 'remote' | 'local'): void {
    if (this.state === state) return;
    this.state = state;
    console.warn(state === 'remote'
      ? '[built-in embedding] document text embedding is using the remote helper.'
      : '[built-in embedding] remote helper unavailable; document text embedding is using the local helper.');
  }

  private async request(path: string, texts?: readonly string[]): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = {};
    if (this.options.tokenFile) {
      const token = readFileSync(this.options.tokenFile, 'utf8').trim();
      if (!token) throw new Error('Empty remote token file.');
      headers.Authorization = `Bearer ${token}`;
    }
    if (texts) headers['Content-Type'] = 'application/json';
    const response = await fetch(new URL(path, this.url), {
      method: texts ? 'POST' : 'GET', headers,
      ...(texts ? { body: JSON.stringify({ texts }) } : {}),
      signal: AbortSignal.timeout(this.options.requestTimeoutMs ?? 30_000),
      redirect: 'error',
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error('Remote request failed.'); }
    return await response.json() as Record<string, unknown>;
  }
}
