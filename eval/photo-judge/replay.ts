// Photo judge calibration: replays prompt sets and thresholds over score
// matrices from eval/photo-judge/scores.ts, without pictures or the model.
//
//   bun eval/photo-judge/replay.ts <scores.json>...
//
// For each judge below it prints, per group, how many pictures it calls
// sensitive, and every picture whose verdict disagrees with its label.

import { readFileSync } from 'node:fs';

interface ScoredImage { id: string; label: string; group: string; scores?: Record<string, number>; error?: string }
interface Judge { name: string; sensitive: string[]; ordinary: string[]; margin: number; intimateMargin: number }

const SENSITIVE = ['id_document', 'bank_card', 'financial_document', 'medical_document', 'intimate'];
const WRITING = ['whiteboard', 'handwritten_notes', 'screenshot', 'slide', 'printed_page', 'poster_menu'];
export const JUDGES: Judge[] = [
  { name: 'shipped (photo-judge-2026-10-08)', sensitive: SENSITIVE, ordinary: ['ordinary'], margin: 0.04, intimateMargin: 0.025 },
  { name: 'ordinary + writing', sensitive: SENSITIVE, ordinary: ['ordinary', ...WRITING], margin: 0.04, intimateMargin: 0.025 },
  { name: 'ordinary + writing + split photos', sensitive: SENSITIVE, ordinary: ['ordinary', ...WRITING, 'ordinary_people', 'ordinary_place', 'ordinary_things'], margin: 0.04, intimateMargin: 0.025 },
  { name: 'ordinary + writing, sharper records', sensitive: ['id_document', 'bank_card', 'financial_record', 'medical_record', 'intimate'], ordinary: ['ordinary', ...WRITING], margin: 0.04, intimateMargin: 0.025 },
];

export function verdict(scores: Record<string, number>, judge: Judge): { sensitive: boolean; category: string; margin: number } {
  const ordinary = Math.max(...judge.ordinary.map((key) => scores[key]!));
  let category = judge.sensitive[0]!;
  for (const key of judge.sensitive) if (scores[key]! > scores[category]!) category = key;
  const margin = scores[category]! - ordinary;
  if (margin >= judge.margin) return { sensitive: true, category, margin };
  if (scores.intimate! - ordinary >= judge.intimateMargin) return { sensitive: true, category: 'intimate', margin };
  return { sensitive: false, category, margin };
}

if (import.meta.main) {
  const images = process.argv.slice(2).flatMap((file) => (JSON.parse(readFileSync(file, 'utf8')) as { images: ScoredImage[] }).images);
  const scored = images.filter((image) => image.scores);
  for (const failed of images.filter((image) => !image.scores)) console.log(`unscored: ${failed.group}/${failed.id} (${failed.error})`);
  for (const judge of JUDGES) {
    console.log(`\n## ${judge.name} (margin ${judge.margin}, intimate ${judge.intimateMargin})`);
    const groups = new Map<string, { total: number; sensitive: number; label: string }>();
    const wrong: string[] = [];
    for (const image of scored) {
      const result = verdict(image.scores!, judge);
      const group = groups.get(image.group) ?? { total: 0, sensitive: 0, label: image.label };
      group.total += 1;
      if (result.sensitive) group.sensitive += 1;
      groups.set(image.group, group);
      if (result.sensitive !== (image.label === 'sensitive')) {
        wrong.push(`  ${image.label} ${image.group}/${image.id}: ${result.sensitive ? `sensitive as ${result.category}` : 'ordinary'} (margin ${result.margin.toFixed(3)})`);
      }
    }
    for (const [name, group] of groups) console.log(`- ${name} (${group.label}): ${group.sensitive}/${group.total} sensitive`);
    console.log(wrong.length ? `wrong:\n${wrong.join('\n')}` : 'wrong: none');
  }
}
