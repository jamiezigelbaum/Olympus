/**
 * A media type from a file name, for sources whose provider does not say.
 * Unknown names get `application/octet-stream`, which the extraction factory
 * treats as "decide from the bytes".
 */
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  pdf: 'application/pdf',
  txt: 'text/plain', text: 'text/plain', md: 'text/plain', markdown: 'text/plain', log: 'text/plain',
  rst: 'text/plain', org: 'text/plain', tex: 'text/plain', srt: 'text/plain', vtt: 'text/plain',
  csv: 'text/csv', tsv: 'text/tab-separated-values',
  json: 'application/json', yaml: 'text/plain', yml: 'text/plain', toml: 'text/plain', xml: 'application/xml',
  html: 'text/html', htm: 'text/html',
  rtf: 'application/rtf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  heic: 'image/heic', heif: 'image/heif', tif: 'image/tiff', tiff: 'image/tiff', bmp: 'image/bmp',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', aac: 'audio/aac',
  mp4: 'video/mp4', m4v: 'video/x-m4v', mov: 'video/quicktime', mkv: 'video/x-matroska', webm: 'video/webm',
  avi: 'video/x-msvideo', mpg: 'video/mpeg', mpeg: 'video/mpeg', '3gp': 'video/3gpp',
});

const SOURCE_CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp',
  'cs', 'php', 'sh', 'bash', 'zsh', 'sql', 'css', 'scss', 'lua', 'pl', 'r', 'scala', 'ini', 'cfg', 'conf', 'env',
]);

export function fileMimeTypeFromName(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return 'application/octet-stream';
  const extension = name.slice(dot + 1).toLowerCase();
  return MIME_BY_EXTENSION[extension]
    ?? (SOURCE_CODE_EXTENSIONS.has(extension) ? 'text/plain' : 'application/octet-stream');
}
