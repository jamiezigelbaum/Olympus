import { describe, expect, test } from 'bun:test';
import { judgeInput } from './judge-input.ts';
import { longMessageView } from './long-message-view.ts';

const filler = (words: number, word = 'garden') => Array.from({ length: words }, () => word).join(' ');
const asked = (text: string) => {
  const input = judgeInput({ title: 'Note' }, text, 'telegram');
  if (!input.material) throw new Error('the judge was not asked');
  return input.material;
};
const read = (view: NonNullable<ReturnType<typeof longMessageView>>) => view.parts.filter((part) => part.read).map((part) => part.text);

describe('longMessageView', () => {
  test('leaves a message the judge reads whole alone', () => {
    expect(longMessageView('a short note', 'Names: x\nExcerpt: a short note', 6_000)).toBeUndefined();
  });

  test('the whole message survives, split into what the judge reads and what it does not', () => {
    const text = filler(600);
    const view = longMessageView(text, asked(text), 6_000)!;
    expect(view.located).toBe(true);
    expect(view.parts.map((part) => part.text).join('')).toBe(text);
    expect(view.parts[0]!.read).toBe(true);
    expect(view.parts.at(-1)!.read).toBe(false);
  });

  test('highlights the passage around a matched term past the opening, from the real judge input', () => {
    const text = `${filler(300)} the diagnosis was confirmed and the prescription changes the medication dosage ${filler(300, 'orchard')}`;
    const material = asked(text);
    const view = longMessageView(text, material, 6_000)!;
    expect(view.located).toBe(true);
    expect(read(view).length).toBeGreaterThan(1);
    expect(read(view).slice(1).join(' ')).toContain('diagnosis');
    expect(view.parts.some((part) => !part.read)).toBe(true);
  });

  test('flags a message cut at the display limit', () => {
    const text = filler(1_500);
    const view = longMessageView(text, asked(text), 6_000)!;
    expect(view.cutOff).toBe(true);
    expect(view.parts.map((part) => part.text).join('').length).toBe(6_000);
    expect(view.totalChars).toBe(text.length);
  });

  test('highlights nothing when the judge input does not match the text', () => {
    const view = longMessageView(filler(600), 'Names: x\nExcerpt: something else entirely', 6_000)!;
    expect(view.located).toBe(false);
    expect(view.parts.every((part) => !part.read)).toBe(true);
  });
});
