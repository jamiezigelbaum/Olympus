/**
 * The real connect-page script (connect-relay/shared/connect-page.ts), run
 * against a minimal DOM built from a served page's form, the way a browser
 * would: type the values, press Connect, and read back the form body the
 * browser posts. Only the named hidden fields are part of it; the typed
 * inputs carry no name.
 */
import { expect } from 'bun:test';
import { CONNECT_PAGE_SCRIPT } from '../../shared/connect-page.ts';

interface FakeInput { value: string; field?: string; focus(): void }

/**
 * Runs CONNECT_PAGE_SCRIPT over the served page's form attributes, types
 * `values` into its fields, presses Connect and returns the form body the
 * browser would post (only the named hidden fields: the typed ones have no
 * name, so they are never part of it).
 */
export async function submitThroughScript(html: string, values: Record<string, string>): Promise<{ body: string; clearedInputs: boolean; actionUrl: string }> {
  const attr = (name: string) => {
    const match = new RegExp(`<form[^>]* ${name}="([^"]*)"`).exec(html);
    return match ? match[1]!.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>') : null;
  };
  const fieldNames = [...html.matchAll(/data-field="([a-z_]+)"/g)].map((match) => match[1]!);
  expect(html).not.toMatch(/<input[^>]*data-field[^>]* name=/);
  const inputs: FakeInput[] = fieldNames.map((field) => ({ value: values[field] ?? '', field, focus() {} }));
  const hidden: Record<string, { value: string }> = {
    'olympus-connect-epk': { value: '' },
    'olympus-connect-iv': { value: '' },
    'olympus-connect-ct': { value: '' },
  };
  let submitHandler: ((event: { preventDefault(): void }) => void) | undefined;
  let resolveSubmit!: () => void;
  const submitted = new Promise<void>((resolve) => { resolveSubmit = resolve; });
  const form = {
    getAttribute: (name: string) => attr(name),
    addEventListener: (type: string, handler: (event: { preventDefault(): void }) => void) => { if (type === 'submit') submitHandler = handler; },
    querySelectorAll: () => inputs.map((input) => ({ ...input, get value() { return input.value; }, set value(v: string) { input.value = v; }, getAttribute: () => input.field })),
    submit: () => resolveSubmit(),
  };
  const document = {
    getElementById: (id: string) => (id === 'olympus-connect' ? form : hidden[id] ?? null),
  };
  new Function('document', CONNECT_PAGE_SCRIPT)(document);
  expect(submitHandler).toBeDefined();
  submitHandler!({ preventDefault() {} });
  await submitted;
  const body = new URLSearchParams({
    epk: hidden['olympus-connect-epk']!.value,
    iv: hidden['olympus-connect-iv']!.value,
    ct: hidden['olympus-connect-ct']!.value,
  }).toString();
  return { body, clearedInputs: inputs.every((input) => input.value === ''), actionUrl: attr('action')! };
}

