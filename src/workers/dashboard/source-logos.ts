/**
 * Product logos for source rows and the Add a source catalog (owner,
 * 2026-11-07: "let's do the proper logos"; mockup sources-logos.png).
 * Paths are from Simple Icons 13.21.0 (CC0). Sources without a well-known
 * logo get a letter tile (Readwise) or a plain Olympus glyph (files, archives).
 */
import { escapeHtml } from './components.ts';

const BRANDS: Readonly<Record<string, { color: string; path: string }>> = {
  'gmail.email': { color: '#EA4335', path: 'M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z' },
  'google_drive.docs': { color: '#4285F4', path: 'M12.01 1.485c-2.082 0-3.754.02-3.743.047.01.02 1.708 3.001 3.774 6.62l3.76 6.574h3.76c2.081 0 3.753-.02 3.742-.047-.005-.02-1.708-3.001-3.775-6.62l-3.76-6.574zm-4.76 1.73a789.828 789.861 0 0 0-3.63 6.319L0 15.868l1.89 3.298 1.885 3.297 3.62-6.335 3.618-6.33-1.88-3.287C8.1 4.704 7.255 3.22 7.25 3.214zm2.259 12.653-.203.348c-.114.198-.96 1.672-1.88 3.287a423.93 423.948 0 0 1-1.698 2.97c-.01.026 3.24.042 7.222.042h7.244l1.796-3.157c.992-1.734 1.85-3.23 1.906-3.323l.104-.167h-7.249z' },
  'dropbox.files': { color: '#0061FF', path: 'M6 1.807L0 5.629l6 3.822 6.001-3.822L6 1.807zM18 1.807l-6 3.822 6 3.822 6-3.822-6-3.822zM0 13.274l6 3.822 6.001-3.822L6 9.452l-6 3.822zM18 9.452l-6 3.822 6 3.822 6-3.822-6-3.822zM6 18.371l6.001 3.822 6-3.822-6-3.822L6 18.371z' },
  'x.bookmarks': { color: '#000000', path: 'M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z' },
  'telegram.messages': { color: '#26A5E4', path: 'M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z' },
  'whatsapp.personal.messages': { color: '#25D366', path: 'M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z' },
  'evernote.notes': { color: '#00A82D', path: 'M8.222 5.393c0 .239-.02.637-.256.895-.257.24-.652.259-.888.259H4.552c-.73 0-1.165 0-1.46.04-.159.02-.356.1-.455.14-.04.019-.04 0-.02-.02L8.38.796c.02-.02.04-.02.02.02-.04.099-.118.298-.138.457-.04.298-.04.736-.04 1.472v2.647zm5.348 17.869c-.67-.438-1.026-1.015-1.164-1.373a2.924 2.924 0 01-.217-1.095 3.007 3.007 0 013-3.004c.493 0 .888.398.888.895a.88.88 0 01-.454.776c-.099.06-.237.1-.336.12-.098.02-.473.06-.65.218-.198.16-.356.418-.356.697 0 .298.118.577.316.776.355.358.829.557 1.342.557a2.436 2.436 0 002.427-2.447c0-1.214-.809-2.29-1.875-2.766-.158-.08-.414-.14-.651-.2a8.04 8.04 0 00-.592-.1c-.829-.1-2.901-.755-3.04-2.605 0 0-.611 2.785-1.835 3.54-.118.06-.276.12-.454.16-.177.04-.374.06-.434.06-1.993.12-4.105-.517-5.565-2.03 0 0-.987-.815-1.5-3.103-.118-.558-.355-1.553-.493-2.488-.06-.338-.08-.597-.099-.836 0-.975.592-1.631 1.342-1.73h4.026c.69 0 1.086-.18 1.342-.42.336-.317.415-.775.415-1.312V1.354C9.05.617 9.703 0 10.669 0h.474c.197 0 .434.02.651.04.158.02.296.06.533.12 1.204.298 1.46 1.532 1.46 1.532s2.27.398 3.415.597c1.085.199 3.77.378 4.282 3.104 1.204 6.487.474 12.775.415 12.775-.849 6.129-5.901 5.83-5.901 5.83a4.1 4.1 0 01-2.428-.736zm4.54-13.034c-.652-.06-1.204.2-1.402.697-.04.1-.079.219-.059.278.02.06.06.08.099.1.237.12.631.179 1.204.239.572.06.967.1 1.223.06.04 0 .08-.02.119-.08.04-.06.02-.18.02-.28-.06-.536-.553-.934-1.204-1.014z' },
};

/** Plain glyphs (24x24) for sources with no brand mark. */
const GLYPHS: Readonly<Record<string, string>> = {
  'local.files': 'M3 6.5A1.5 1.5 0 0 1 4.5 5h5l2 2h8A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z',
  'archive.imports': 'M3 7l9-4 9 4v10l-9 4-9-4zm9 2.2L5.4 6.6 12 9.4l6.6-2.8zM5 8.6v7.1l6 2.7v-7.1zm14 0-6 2.7v7.1l6-2.7z',
};

const LETTERS: Readonly<Record<string, { letter: string; color: string }>> = {
  'readwise.library': { letter: 'R', color: '#111111' },
};

/**
 * The logo tile: the product's mark on a small rounded tile, with the status
 * dot on its corner when a status is given ('ok' green, 'attention' orange,
 * 'off' grey).
 */
export function sourceLogoTile(sourceId: string, status?: 'ok' | 'attention' | 'off'): string {
  const brand = BRANDS[sourceId];
  const glyph = GLYPHS[sourceId];
  const letter = LETTERS[sourceId];
  const inner = brand
    ? `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="${brand.color}" d="${brand.path}"/></svg>`
    : glyph
      ? `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" fill-rule="evenodd" d="${glyph}"/></svg>`
      : `<span class="logoletter" style="background:${letter?.color ?? '#5b5bd6'}">${escapeHtml(letter?.letter ?? (sourceId[0] ?? '?').toUpperCase())}</span>`;
  const kind = brand ? 'brand' : glyph ? 'glyph' : 'letter';
  return `<span class="logotile ${kind}" aria-hidden="true">${inner}${status ? `<span class="logodot ${status}"></span>` : ''}</span>`;
}

/** Each provider's logo tile (gmail, dropbox, ...), for pages that know an item's provider but not its source id. */
export function sourceLogoTilesByProvider(): Record<string, string> {
  const tiles: Record<string, string> = {};
  for (const id of [...Object.keys(BRANDS), ...Object.keys(GLYPHS), ...Object.keys(LETTERS)]) {
    const provider = id.split('.')[0]!;
    if (!(provider in tiles)) tiles[provider] = sourceLogoTile(id);
  }
  return tiles;
}

export const SOURCE_LOGO_CSS = `
.logotile { position: relative; flex: none; display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; border-radius: 9px; background: #fff; }
.logotile svg { width: 22px; height: 22px; }
.logotile.glyph { background: color-mix(in srgb, var(--t2, #888) 22%, transparent); color: var(--t1, #eee); }
.logotile.letter { background: transparent; }
.logoletter { display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; border-radius: 9px; color: #fff; font-weight: 700; }
.logodot { position: absolute; right: -3px; bottom: -3px; width: 11px; height: 11px; border-radius: 50%; border: 2px solid var(--bg, #111); }
.logodot.ok { background: #3fb950; }
.logodot.attention { background: #e3a03a; }
.logodot.off { background: #8b8b8b; }
`;
