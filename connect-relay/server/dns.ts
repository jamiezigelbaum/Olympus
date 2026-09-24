/**
 * DNS publication for ACME DNS-01. The relay controls the zone and publishes a
 * TXT value an authenticated install computed locally; the install's CSR,
 * certificate private key, and ACME account key never leave the install.
 */

export interface DnsProvider {
  /**
   * Makes `hostname` resolve explicitly to the relay. Called before the first
   * TXT under it: a record at `_acme-challenge.<id>.<zone>` turns `<id>.<zone>`
   * into an empty non-terminal, and RFC 4592 wildcard synthesis stops applying
   * to it, so a wildcard-only zone would break the install's own address
   * during every issuance and renewal.
   */
  ensureAddress(hostname: string): Promise<void>;
  setTxt(name: string, value: string): Promise<void>;
  clearTxt(name: string, value: string): Promise<void>;
}

export class MemoryDnsProvider implements DnsProvider {
  readonly txt = new Map<string, Set<string>>();
  readonly addresses = new Set<string>();

  async ensureAddress(hostname: string): Promise<void> {
    this.addresses.add(hostname);
  }

  async setTxt(name: string, value: string): Promise<void> {
    const values = this.txt.get(name) ?? new Set<string>();
    values.add(value);
    this.txt.set(name, values);
  }

  async clearTxt(name: string, value: string): Promise<void> {
    const values = this.txt.get(name);
    values?.delete(value);
    if (values && values.size === 0) this.txt.delete(name);
  }

  lookupTxt(name: string): string[] {
    return [...(this.txt.get(name) ?? [])];
  }
}

export interface CloudflareDnsOptions {
  readonly zoneId: string;
  /** API token scoped to Zone.DNS:Edit on the relay zone only. */
  readonly apiToken: string;
  readonly ipv4?: string;
  readonly ipv6?: string;
  readonly fetch?: typeof fetch;
  readonly apiBase?: string;
}

interface CloudflareRecord {
  id: string;
  type: string;
  name: string;
  content: string;
}

/** Cloudflare DNS API (v4) provider. DNS only: Cloudflare never proxies install traffic. */
export class CloudflareDnsProvider implements DnsProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly base: string;

  constructor(private readonly options: CloudflareDnsOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.base = `${options.apiBase ?? 'https://api.cloudflare.com/client/v4'}/zones/${encodeURIComponent(options.zoneId)}/dns_records`;
  }

  async ensureAddress(hostname: string): Promise<void> {
    const wanted: Array<[string, string]> = [];
    if (this.options.ipv4) wanted.push(['A', this.options.ipv4]);
    if (this.options.ipv6) wanted.push(['AAAA', this.options.ipv6]);
    for (const [type, content] of wanted) {
      const existing = await this.list(type, hostname);
      if (existing.some((record) => record.content === content)) continue;
      await this.call('POST', this.base, { type, name: hostname, content, ttl: 300, proxied: false });
    }
  }

  async setTxt(name: string, value: string): Promise<void> {
    const existing = await this.list('TXT', name);
    if (existing.some((record) => unquote(record.content) === value)) return;
    await this.call('POST', this.base, { type: 'TXT', name, content: `"${value}"`, ttl: 60 });
  }

  async clearTxt(name: string, value: string): Promise<void> {
    for (const record of await this.list('TXT', name)) {
      if (unquote(record.content) === value) await this.call('DELETE', `${this.base}/${encodeURIComponent(record.id)}`);
    }
  }

  private async list(type: string, name: string): Promise<CloudflareRecord[]> {
    const url = `${this.base}?type=${encodeURIComponent(type)}&name=${encodeURIComponent(name)}`;
    return (await this.call('GET', url)) as CloudflareRecord[];
  }

  private async call(method: string, url: string, body?: unknown): Promise<unknown> {
    const response = await this.fetchImpl(url, {
      method,
      headers: { authorization: `Bearer ${this.options.apiToken}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const parsed = (await response.json().catch(() => ({}))) as { success?: boolean; result?: unknown; errors?: unknown };
    if (!response.ok || parsed.success !== true) {
      throw new Error(`Cloudflare DNS ${method} failed with HTTP ${response.status}`);
    }
    return parsed.result;
  }
}

function unquote(content: string): string {
  return content.startsWith('"') && content.endsWith('"') ? content.slice(1, -1) : content;
}
