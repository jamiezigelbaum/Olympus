/**
 * Where two pictures of a screen differ, as boxes: what the report outlines in red (with a light tint) on the old and the new picture,
 * the zoomed crops it shows above them, and one plain sentence about the change.
 *
 * Same size: the pixels that differ are grouped into regions (nearby ones merge). Different height (something was inserted or removed):
 * the rows that match at the top and at the bottom are found, and only the band between is boxed, so a pixel diff does not light up
 * everything below an insertion.
 */
import { PNG } from 'pngjs';

export interface Box { x: number; y: number; w: number; h: number }

export interface Change {
  /** Boxes on the old picture and on the new one (same count; an insertion has a thin box in the old picture where it went in). */
  oldBoxes: Box[];
  newBoxes: Box[];
  caption: string;
}

/** How far two channel values may be apart and still be the same pixel (anti-aliasing and font smoothing). */
const CHANNEL_TOLERANCE = 8;
/** Boxes closer than this many pixels are one region. */
const MERGE_DISTANCE = 24;
const PAD = 6;
const EDGE = 4;

const rowsEqual = (a: PNG, rowA: number, b: PNG, rowB: number): boolean => {
  const width = a.width * 4;
  const offsetA = rowA * width;
  const offsetB = rowB * width;
  for (let i = 0; i < width; i++) if (Math.abs(a.data[offsetA + i]! - b.data[offsetB + i]!) > CHANNEL_TOLERANCE) return false;
  return true;
};

const pixelsDiffer = (a: PNG, b: PNG, index: number): boolean => {
  for (let c = 0; c < 3; c++) if (Math.abs(a.data[index + c]! - b.data[index + c]!) > CHANNEL_TOLERANCE) return true;
  return false;
};

function merge(boxes: Box[]): Box[] {
  const list = boxes.map((box) => ({ ...box }));
  for (let changed = true; changed;) {
    changed = false;
    outer: for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!;
        const b = list[j]!;
        if (a.x - MERGE_DISTANCE <= b.x + b.w && b.x - MERGE_DISTANCE <= a.x + a.w && a.y - MERGE_DISTANCE <= b.y + b.h && b.y - MERGE_DISTANCE <= a.y + a.h) {
          const x = Math.min(a.x, b.x);
          const y = Math.min(a.y, b.y);
          list[i] = { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
          list.splice(j, 1);
          changed = true;
          break outer;
        }
      }
    }
  }
  return list.sort((a, b) => a.y - b.y || a.x - b.x);
}

/** The regions where two pictures of the same size differ. */
function regionsOfSameSize(a: PNG, b: PNG): Box[] {
  const cell = 8;
  const cols = Math.ceil(a.width / cell);
  const rows = Math.ceil(a.height / cell);
  const cells: Array<Box | undefined> = new Array(cols * rows);
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      if (!pixelsDiffer(a, b, (y * a.width + x) * 4)) continue;
      const slot = Math.floor(y / cell) * cols + Math.floor(x / cell);
      const box = cells[slot];
      if (!box) cells[slot] = { x, y, w: 1, h: 1 };
      else {
        const x2 = Math.max(box.x + box.w, x + 1);
        const y2 = Math.max(box.y + box.h, y + 1);
        box.x = Math.min(box.x, x); box.y = Math.min(box.y, y); box.w = x2 - box.x; box.h = y2 - box.y;
      }
    }
  }
  return merge(cells.filter((box): box is Box => box !== undefined));
}

/** Where the old and the new picture differ, or undefined when they do not differ (beyond the pixel tolerance). */
export function findChange(oldPng: PNG, newPng: PNG): Change | undefined {
  if (oldPng.width !== newPng.width) {
    return {
      oldBoxes: [{ x: 0, y: 0, w: oldPng.width, h: oldPng.height }], newBoxes: [{ x: 0, y: 0, w: newPng.width, h: newPng.height }],
      caption: `the page width changed from ${oldPng.width} px to ${newPng.width} px`,
    };
  }
  if (oldPng.height === newPng.height) {
    const regions = regionsOfSameSize(oldPng, newPng);
    if (regions.length === 0) return undefined;
    const largest = [...regions].sort((a, b) => b.w * b.h - a.w * a.h)[0]!;
    return {
      oldBoxes: regions, newBoxes: regions,
      caption: `${regions.length} changed region${regions.length === 1 ? '' : 's'}${regions.length === 1 ? '' : `, the largest ${largest.w}x${largest.h} px`} at y=${regions[0]!.y}; the rest is identical`,
    };
  }
  let top = 0;
  while (top < oldPng.height && top < newPng.height && rowsEqual(oldPng, top, newPng, top)) top++;
  let tail = 0;
  while (tail < oldPng.height - top && tail < newPng.height - top && rowsEqual(oldPng, oldPng.height - 1 - tail, newPng, newPng.height - 1 - tail)) tail++;
  const oldEnd = oldPng.height - tail;
  const newEnd = newPng.height - tail;
  const w = newPng.width;
  const delta = newPng.height - oldPng.height;
  const inserted = oldEnd === top;
  const removed = newEnd === top;
  const caption = inserted ? `${delta} px added at y=${top}; the rest is identical`
    : removed ? `${-delta} px removed at y=${top}; the rest is identical`
      : `the band y=${top} to y=${newEnd} changed and the page is ${Math.abs(delta)} px ${delta > 0 ? 'taller' : 'shorter'}; the rest is identical`;
  return { oldBoxes: [{ x: 0, y: top, w, h: oldEnd - top }], newBoxes: [{ x: 0, y: top, w, h: newEnd - top }], caption };
}

/** The picture with each box outlined in red and lightly tinted (a copy; the original is untouched). */
export function outline(source: PNG, boxes: readonly Box[]): PNG {
  const img = new PNG({ width: source.width, height: source.height });
  source.data.copy(img.data);
  for (const box of boxes) {
    const x0 = Math.max(0, box.x - PAD);
    const x1 = Math.min(img.width - 1, box.x + Math.max(box.w, 2) + PAD);
    const y0 = Math.max(0, box.y - PAD);
    const y1 = Math.min(img.height - 1, box.y + Math.max(box.h, 2) + PAD);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = (y * img.width + x) * 4;
        if (y - y0 < EDGE || y1 - y < EDGE || x - x0 < EDGE || x1 - x < EDGE) { img.data[i] = 230; img.data[i + 1] = 20; img.data[i + 2] = 60; } else {
          img.data[i] = Math.min(255, Math.round(img.data[i]! * 0.75 + 60));
          img.data[i + 1] = Math.round(img.data[i + 1]! * 0.8);
          img.data[i + 2] = Math.round(img.data[i + 2]! * 0.8);
        }
      }
    }
  }
  return img;
}

/** The part of the picture inside the boxes' union (with padding), scaled up so a small change can be seen. At most `maxHeight` tall. */
export function zoomCrop(source: PNG, boxes: readonly Box[], maxHeight = 480): PNG {
  const x0 = Math.max(0, Math.min(...boxes.map((box) => box.x)) - PAD);
  const y0 = Math.max(0, Math.min(...boxes.map((box) => box.y)) - PAD);
  const x1 = Math.min(source.width, Math.max(...boxes.map((box) => box.x + Math.max(box.w, 2))) + PAD);
  const y1 = Math.min(source.height, Math.max(...boxes.map((box) => box.y + Math.max(box.h, 2))) + PAD);
  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, Math.min(y1 - y0, maxHeight));
  const scale = w <= 300 ? 2 : 1;
  const out = new PNG({ width: w * scale, height: h * scale });
  for (let y = 0; y < h * scale; y++) {
    for (let x = 0; x < w * scale; x++) {
      const from = ((y0 + Math.floor(y / scale)) * source.width + x0 + Math.floor(x / scale)) * 4;
      const to = (y * out.width + x) * 4;
      for (let c = 0; c < 4; c++) out.data[to + c] = source.data[from + c]!;
    }
  }
  return out;
}
