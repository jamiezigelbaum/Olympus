/** Real test-account fixtures. Credentials stay in memory; provider failures never echo response bodies. */
import { randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { readAgentKey } from './agents.ts';

export const ON_DEMAND_FOLDER = 'Olympus RC on demand';
export type TimingSource = 'dropbox' | 'google_drive';
/** Made-up topics, one per seeded file; no real people or places. */
const SEED_TOPICS: Record<'dropbox' | 'google_drive', Record<string, string>> = {
  dropbox: { text: 'the Ostrander greenhouse lease', long: 'the Vellmar ferry maintenance plan', scan: 'the Brask harbor mooring permit', owner: 'the Teodane bakery supply invoice' },
  google_drive: { text: 'the Quillon orchard survey', long: 'the Marrowind cooperative bylaws', native: 'the Halvik choir rehearsal schedule', scan: 'the Pellisan well inspection report' },
};

export interface TimingAccount { tokenCommand: string[]; accountId: string }
export interface TimingAccounts { dropbox: TimingAccount; drive: TimingAccount }
export interface TimingFile {
  id: string; source: TimingSource; name: string; providerItemId: string; version: string;
  fact: string; question: string; owner?: boolean;
}
export interface SeedFolder { source: TimingSource; id: string }
export interface TimingSeeds {
  folders(): Promise<SeedFolder[]>;
  upload(folder: SeedFolder): Promise<TimingFile[]>;
}

export function parseTimingAccounts(raw: unknown): TimingAccounts {
  const accounts = raw as TimingAccounts | undefined;
  for (const key of ['dropbox', 'drive'] as const) {
    const account = accounts?.[key];
    if (!account || !Array.isArray(account.tokenCommand) || !account.tokenCommand.length
      || account.tokenCommand.some(v => typeof v !== 'string' || !v) || typeof account.accountId !== 'string' || !account.accountId.trim()) {
      throw new Error(`on_demand_timing.${key} needs tokenCommand (argv) and accountId (the approved test account)`);
    }
  }
  return accounts!;
}

/** A small valid PDF writer; streams may contain binary data. */
function pdf(objects: Buffer[]): Buffer {
  const chunks = [Buffer.from('%PDF-1.4\n')];
  const offsets = [0];
  let size = chunks[0]!.length;
  objects.forEach((object, i) => {
    offsets.push(size);
    const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), object, Buffer.from('\nendobj\n')]);
    chunks.push(chunk); size += chunk.length;
  });
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`));
  return Buffer.concat(chunks);
}
const stream = (dict: string, bytes: Buffer): Buffer => Buffer.concat([Buffer.from(`<< ${dict} /Length ${bytes.length} >>\nstream\n`), bytes, Buffer.from('\nendstream')]);

export function textPdf(fact: string, pages = 1): Buffer {
  const objects: Buffer[] = [Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'), Buffer.alloc(0), Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')];
  const kids: string[] = [];
  for (let page = 1; page <= pages; page++) {
    const pageId = objects.length + 1;
    kids.push(`${pageId} 0 R`);
    objects.push(Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId + 1} 0 R >>`));
    const middle = page === Math.ceil(pages / 2);
    const lines = pages === 1 ? [fact] : Array.from({ length: 42 }, (_, line) => middle && line === 20 ? fact
      : `Archive survey page ${page}, entry ${line + 1}: imaginary pebbles were sorted into baskets.`);
    const escaped = lines.map(line => line.replace(/[\\()]/g, '\\$&'));
    objects.push(stream('', Buffer.from(`BT /F1 10 Tf 13 TL 36 750 Td ${escaped.map(line => `(${line}) Tj T*`).join('\n')} ET`)));
  }
  objects[1] = Buffer.from(`<< /Type /Pages /Count ${pages} /Kids [${kids.join(' ')}] >>`);
  return pdf(objects);
}

// Five-by-seven bitmap glyphs. The scan has pixels only: no text operator, hidden OCR layer or metadata fact.
const GLYPHS = 'A:01110,10001,10001,11111,10001,10001,10001 B:11110,10001,10001,11110,10001,10001,11110 C:01111,10000,10000,10000,10000,10000,01111 D:11110,10001,10001,10001,10001,10001,11110 E:11111,10000,10000,11110,10000,10000,11111 F:11111,10000,10000,11110,10000,10000,10000 G:01111,10000,10000,10111,10001,10001,01111 H:10001,10001,10001,11111,10001,10001,10001 I:11111,00100,00100,00100,00100,00100,11111 J:00111,00010,00010,00010,10010,10010,01100 K:10001,10010,10100,11000,10100,10010,10001 L:10000,10000,10000,10000,10000,10000,11111 M:10001,11011,10101,10101,10001,10001,10001 N:10001,11001,10101,10011,10001,10001,10001 O:01110,10001,10001,10001,10001,10001,01110 P:11110,10001,10001,11110,10000,10000,10000 Q:01110,10001,10001,10001,10101,10010,01101 R:11110,10001,10001,11110,10100,10010,10001 S:01111,10000,10000,01110,00001,00001,11110 T:11111,00100,00100,00100,00100,00100,00100 U:10001,10001,10001,10001,10001,10001,01110 V:10001,10001,10001,10001,10001,01010,00100 W:10001,10001,10001,10101,10101,10101,01010 X:10001,10001,01010,00100,01010,10001,10001 Y:10001,10001,01010,00100,00100,00100,00100 Z:11111,00001,00010,00100,01000,10000,11111 0:01110,10001,10011,10101,11001,10001,01110 1:00100,01100,00100,00100,00100,00100,01110 2:01110,10001,00001,00010,00100,01000,11111 3:11110,00001,00001,01110,00001,00001,11110 4:00010,00110,01010,10010,11111,00010,00010 5:11111,10000,10000,11110,00001,00001,11110 6:01110,10000,10000,11110,10001,10001,01110 7:11111,00001,00010,00100,01000,01000,01000 8:01110,10001,10001,01110,10001,10001,01110 9:01110,10001,10001,01111,00001,00001,01110';
export function scannedPdf(fact: string): Buffer {
  const glyphs = new Map(GLYPHS.split(' ').map(entry => { const [letter, rows] = entry.split(':'); return [letter!, rows!.split(',')]; }));
  const width = 1200, height = 500, scale = 4;
  const pixels = Buffer.alloc(width * height, 255);
  const lines = fact.toUpperCase().match(/.{1,42}(?:\s|$)|.{1,42}/g) ?? [];
  lines.forEach((line, y) => [...line.trim()].forEach((letter, x) => {
    glyphs.get(letter)?.forEach((row, gy) => [...row].forEach((bit, gx) => {
      if (bit !== '1') return;
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
        pixels[(40 + y * 48 + gy * scale + dy) * width + 40 + x * 24 + gx * scale + dx] = 0;
      }
    }));
  }));
  return pdf([
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'), Buffer.from('<< /Type /Pages /Count 1 /Kids [3 0 R] >>'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>'),
    stream('', Buffer.from('q 550 0 0 230 30 500 cm /Im0 Do Q')),
    stream(`/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`, deflateSync(pixels)),
  ]);
}

export async function realTimingSeeds(accounts: TimingAccounts, fetchImpl: typeof fetch = fetch): Promise<TimingSeeds> {
  const dropbox = await readAgentKey({ keyCommand: accounts.dropbox.tokenCommand });
  const drive = await readAgentKey({ keyCommand: accounts.drive.tokenCommand });
  if (!dropbox || !drive) throw new Error('test-account tokenCommand did not return a token');
  const request = async (url: string, token: string, init: RequestInit = {}): Promise<any> => {
    const response = await fetchImpl(url, { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers }, signal: AbortSignal.timeout(120_000) });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`test-account API ${new URL(url).pathname}: HTTP ${response.status}`); }
    return response.json();
  };
  const db = (route: string, body: unknown) => request(`https://api.dropboxapi.com/2/${route}`, dropbox, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const google = (route: string, init?: RequestInit) => request(`https://www.googleapis.com/drive/v3/${route}`, drive, init);
  const whoDb = await db('users/get_current_account', null);
  const whoDrive = await google('about?fields=user(emailAddress)');
  if (whoDb.account_id !== accounts.dropbox.accountId || whoDrive.user?.emailAddress?.toLowerCase() !== accounts.drive.accountId.toLowerCase()) {
    throw new Error('seed credential does not belong to the configured test account');
  }
  const listDrive = async (parent: string): Promise<any[]> => {
    const rows: any[] = [];
    let pageToken = '';
    do {
      const query = new URLSearchParams({ q: `'${parent.replace(/['\\]/g, '\\$&')}' in parents and trashed = false`, fields: 'nextPageToken,files(id,name,mimeType)', pageSize: '1000', ...(pageToken ? { pageToken } : {}) });
      const page = await google(`files?${query}`); rows.push(...page.files); pageToken = page.nextPageToken ?? '';
    } while (pageToken);
    return rows;
  };
  return {
    folders: async () => {
      let listed = await db('files/list_folder', { path: '' });
      const entries = [...listed.entries];
      while (listed.has_more) { listed = await db('files/list_folder/continue', { cursor: listed.cursor }); entries.push(...listed.entries); }
      let folder = entries.find((entry: any) => entry.name === ON_DEMAND_FOLDER);
      if (!folder) folder = { ...(await db('files/create_folder_v2', { path: `/${ON_DEMAND_FOLDER}`, autorename: false })).metadata, '.tag': 'folder' };
      if (folder['.tag'] !== 'folder') throw new Error('Dropbox seed path is not a folder');
      const roots = (await listDrive('root')).filter(entry => entry.name === ON_DEMAND_FOLDER);
      if (roots.length > 1) throw new Error('multiple Drive seed folders have the same name');
      const gFolder = roots[0] ?? await google('files?fields=id,mimeType', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: ON_DEMAND_FOLDER, mimeType: 'application/vnd.google-apps.folder' }) });
      if (gFolder.mimeType !== 'application/vnd.google-apps.folder') throw new Error('Drive seed path is not a folder');
      return [{ source: 'dropbox', id: folder.id }, { source: 'google_drive', id: gFolder.id }];
    },
    upload: async folder => {
      const files: TimingFile[] = [];
      const existing = folder.source === 'google_drive' ? await listDrive(folder.id) : [];
      for (const kind of folder.source === 'dropbox' ? ['text', 'long', 'scan', 'owner'] : ['text', 'long', 'native', 'scan']) {
        // Named and asked as an owner would: by topic, never by file name or by "the file".
        const topic = SEED_TOPICS[folder.source === 'dropbox' ? 'dropbox' : 'google_drive'][kind]!;
        const name = `${topic.replace(/^the /, '').replace(/^./, (c) => c.toUpperCase())}${kind === 'native' ? '' : '.pdf'}`;
        const fact = `ZUL${randomBytes(6).toString('hex').toUpperCase()}`;
        const sentence = `The reference code for ${topic} is ${fact}.`;
        const bytes = kind === 'scan' ? scannedPdf(sentence) : kind === 'native' ? Buffer.from(sentence) : textPdf(sentence, kind === 'long' ? 200 : 1);
        let uploaded: any;
        if (folder.source === 'dropbox') {
          uploaded = await request('https://content.dropboxapi.com/2/files/upload', dropbox, {
            method: 'POST', headers: { 'content-type': 'application/octet-stream', 'Dropbox-API-Arg': JSON.stringify({ path: `/${ON_DEMAND_FOLDER}/${name}`, mode: 'overwrite', autorename: false, mute: true }) }, body: new Uint8Array(bytes),
          });
        } else {
          const matches = existing.filter(entry => entry.name === name);
          if (matches.length > 1) throw new Error(`duplicate seed file: ${name}`);
          const previous = matches[0];
          const boundary = `rc${randomBytes(8).toString('hex')}`;
          const metadata = { name, mimeType: kind === 'native' ? 'application/vnd.google-apps.document' : 'application/pdf', ...(!previous ? { parents: [folder.id] } : {}) };
          const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${kind === 'native' ? 'text/plain' : 'application/pdf'}\r\n\r\n`), bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]);
          uploaded = await request(`https://www.googleapis.com/upload/drive/v3/files${previous ? `/${encodeURIComponent(previous.id)}` : ''}?uploadType=multipart&fields=id,version`, drive, { method: previous ? 'PATCH' : 'POST', headers: { 'content-type': `multipart/related; boundary=${boundary}` }, body: new Uint8Array(body) });
        }
        if (typeof uploaded.id !== 'string' || !(uploaded.rev ?? uploaded.version)) throw new Error(`seed upload returned no identity or version: ${name}`);
        files.push({ id: `${folder.source}-${kind}`, source: folder.source, name, providerItemId: uploaded.id, version: String(uploaded.rev ?? uploaded.version), fact,
          question: `What is the reference code for ${topic}?`, ...(kind === 'owner' ? { owner: true } : {}) });
      }
      return files;
    },
  };
}
