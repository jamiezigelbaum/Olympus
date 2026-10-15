/**
 * Which machines the installed product opened connections to while a check ran.
 *
 * The in-machine agent samples the operating system's own table of TCP
 * connections (Linux: /proc/net/tcp and tcp6; macOS: lsof) while the dashboard's
 * Ask page is used. Anything that was not already connected when the watch
 * began, is not loopback, and does not belong to the headless browser the
 * check itself drives is "fresh egress". A local-model answer has to produce
 * none; a destination that is not set up (Venice, zkAPI) must not produce any
 * either.
 *
 * Only the parsing lives here, so it is testable without a machine. A sample is
 * a point in time: a connection that opens and closes between two samples is
 * not seen (the sampler's interval is part of every report line).
 */

export interface Connection {
  /** The remote end as `ip:port` (IPv6 without brackets). */
  remote: string;
  /** The socket's inode (Linux); used to find the owning process. */
  inode?: string;
  pid?: number;
  /** The owning process's name, when known. */
  comm?: string;
}

/** TCP states a connection that is open or being opened can be in (Linux numbering). */
const LIVE_STATES = new Set(['01', '02', '04', '05', '08']);

function hexBytes(hex: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hex.length; i += 2) out.push(Number.parseInt(hex.slice(i, i + 2), 16));
  return out;
}

/** An address as /proc/net prints it: each 32-bit word in the machine's own (little-endian) byte order. */
export function procAddress(hex: string): string | undefined {
  if (hex.length !== 8 && hex.length !== 32) return undefined;
  const bytes: number[] = [];
  for (let i = 0; i < hex.length; i += 8) bytes.push(...hexBytes(hex.slice(i, i + 8)).reverse());
  if (bytes.some((b) => Number.isNaN(b))) return undefined;
  if (bytes.length === 4) return bytes.join('.');
  const mapped = bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  if (mapped) return bytes.slice(12).join('.');
  if (bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1) return '::1';
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(((bytes[i]! << 8) | bytes[i + 1]!).toString(16));
  return groups.join(':');
}

/**
 * An address in the form `procAddress` prints: IPv4 as is, IPv6 as eight groups without leading zeros (`::` expanded), so an address a
 * resolver returned compares equal to one read from the connection table.
 */
export function normalizeIp(ip: string): string {
  if (!ip.includes(':')) return ip;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1]!;
  const [head = '', tail = ''] = ip.split('::');
  const left = head === '' ? [] : head.split(':');
  const right = ip.includes('::') && tail !== '' ? tail.split(':') : [];
  const fill = ip.includes('::') ? Array.from({ length: Math.max(0, 8 - left.length - right.length) }, () => '0') : [];
  const groups = ip.includes('::') ? [...left, ...fill, ...right] : ip.split(':');
  return groups.map((group) => Number.parseInt(group || '0', 16).toString(16)).join(':');
}

export function isLoopbackAddress(ip: string): boolean {
  return ip === '::1' || ip === '0.0.0.0' || ip === '::' || /^127\./.test(ip);
}

/** The live, non-loopback connections in one /proc/net/tcp or tcp6 table. */
export function outboundFromProcNet(table: string): Connection[] {
  const out: Connection[] = [];
  for (const line of table.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10) continue;
    const [remoteHex, state, inode] = [fields[2], fields[3], fields[9]];
    if (!remoteHex || !state || !LIVE_STATES.has(state.toUpperCase())) continue;
    const [addrHex, portHex] = remoteHex.split(':');
    if (!addrHex || !portHex) continue;
    const ip = procAddress(addrHex);
    const port = Number.parseInt(portHex, 16);
    if (!ip || !Number.isFinite(port) || port === 0 || isLoopbackAddress(ip)) continue;
    out.push({ remote: `${ip}:${port}`, ...(inode ? { inode } : {}) });
  }
  return out;
}

/** The live, non-loopback connections in `lsof -nP -iTCP -sTCP:ESTABLISHED,SYN_SENT -F pcn` output (macOS). */
export function outboundFromLsof(output: string): Connection[] {
  const out: Connection[] = [];
  let pid: number | undefined;
  let comm: string | undefined;
  for (const line of output.split('\n')) {
    const tag = line[0];
    const value = line.slice(1);
    if (tag === 'p') { pid = Number.parseInt(value, 10); comm = undefined; continue; }
    if (tag === 'c') { comm = value; continue; }
    if (tag !== 'n') continue;
    const arrow = value.indexOf('->');
    if (arrow < 0) continue;
    const remote = value.slice(arrow + 2).replace(/\s*\(.*\)$/, '');
    const split = remote.lastIndexOf(':');
    if (split < 0) continue;
    const ip = remote.slice(0, split).replace(/^\[|\]$/g, '');
    const port = Number.parseInt(remote.slice(split + 1), 10);
    if (!ip || !Number.isFinite(port) || isLoopbackAddress(ip)) continue;
    out.push({ remote: `${normalizeIp(ip)}:${port}`, ...(pid !== undefined ? { pid } : {}), ...(comm ? { comm } : {}) });
  }
  return out;
}

/** The browser the check drives: its own traffic is judged separately (every request the page made), not as Olympus's. */
export function isBrowserProcess(comm: string | undefined): boolean {
  return comm !== undefined && /chrom|google/i.test(comm);
}

export interface EgressVerdictInput {
  /** `ip:port` pairs connected when the watch began. */
  baseline: ReadonlySet<string>;
  /** Everything seen after that, with its owner when known. */
  seen: readonly Connection[];
  /** Addresses that are expected to be reachable at any time (the relay a connected agent uses). */
  allowedIps?: ReadonlySet<string>;
}

/** `ip:port (process)` for each destination the product newly connected to. Sorted and unique. */
export function freshEgress(input: EgressVerdictInput): string[] {
  const out = new Set<string>();
  for (const connection of input.seen) {
    if (input.baseline.has(connection.remote)) continue;
    if (isBrowserProcess(connection.comm)) continue;
    const ip = normalizeIp(connection.remote.slice(0, connection.remote.lastIndexOf(':')));
    if (input.allowedIps?.has(ip)) continue;
    out.add(`${connection.remote}${connection.comm ? ` (${connection.comm})` : ' (owner unknown)'}`);
  }
  return [...out].sort();
}

/** Page requests that left the machine: any URL that is not served by the loopback address the dashboard is on. */
export function requestsOutsideMachine(urls: readonly string[]): string[] {
  const outside = new Set<string>();
  for (const url of urls) {
    if (/^(data|blob|about|chrome-extension):/i.test(url)) continue;
    let host: string;
    try { host = new URL(url).hostname.toLowerCase(); } catch { outside.add('(unparseable address)'); continue; }
    if (host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1') continue;
    outside.add(host);
  }
  return [...outside].sort();
}
