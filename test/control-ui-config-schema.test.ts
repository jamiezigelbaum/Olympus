/**
 * The plugin Settings page (Control UI → Plugins → Olympus → Settings) renders
 * `configSchema` with OpenClaw's schema-driven form. Its analyzer accepts a
 * fixed keyword subset and marks any node outside it "Unsupported schema node.
 * Use Raw mode." A root-level `$defs` (with `$ref` users) made the entire
 * Olympus form unsupported on OpenClaw 2026.9.5.
 *
 * The subset below mirrors the 2026.9.5 Control UI analyzer (config-form
 * chunk): annotation keywords, validation keywords, and structural keywords.
 * `$ref`, `$defs`, `patternProperties`, `dependentRequired`, `if/then/else` and
 * friends are not in it, so the schema must stay self-contained.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');

const ANNOTATION_KEYWORDS = [
  '$id', '$schema', 'title', 'description', 'default', 'deprecated', 'nullable',
  'enumIncludesNull', 'examples', 'readOnly', 'tags', 'writeOnly', 'x-tags',
];
const VALIDATION_KEYWORDS = [
  'const', 'required', 'additionalProperties', 'minimum', 'maximum',
  'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength',
  'pattern', 'format', 'minItems', 'maxItems', 'uniqueItems',
];
const STRUCTURAL_KEYWORDS = [
  'type', 'properties', 'items', 'additionalItems', 'enum', 'anyOf', 'oneOf', 'allOf', 'not',
];
const RENDERER_KEYWORDS = new Set([...ANNOTATION_KEYWORDS, ...VALIDATION_KEYWORDS, ...STRUCTURAL_KEYWORDS]);

type Schema = Record<string, unknown>;

function isSchema(value: unknown): value is Schema {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Every renderer-incompatible construct, as `<path>: <reason>`. */
function unsupportedConstructs(schema: Schema, path = '<root>'): string[] {
  const findings: string[] = [];
  for (const key of Object.keys(schema)) {
    if (!RENDERER_KEYWORDS.has(key)) findings.push(`${path}: keyword ${key}`);
  }
  if (isSchema(schema.properties)) {
    for (const [name, child] of Object.entries(schema.properties)) {
      if (isSchema(child)) findings.push(...unsupportedConstructs(child, `${path}.${name}`));
    }
  }
  for (const key of ['items', 'additionalItems', 'additionalProperties', 'not'] as const) {
    const child = schema[key];
    if (isSchema(child)) findings.push(...unsupportedConstructs(child, `${path}.${key}`));
  }
  for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
    const branches = schema[key];
    if (!Array.isArray(branches)) continue;
    branches.forEach((branch, index) => {
      const branchPath = `${path}.${key}[${index}]`;
      if (!isSchema(branch)) {
        findings.push(`${branchPath}: not a schema object`);
        return;
      }
      // A union renders only when each object/scalar branch names its type
      // (const/enum branches collapse into a select instead).
      if (key !== 'allOf' && branch.type === undefined && branch.const === undefined && branch.enum === undefined) {
        findings.push(`${branchPath}: union branch without a type`);
      }
      findings.push(...unsupportedConstructs(branch, branchPath));
    });
  }
  return findings;
}

function manifestSchema(): Schema {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'openclaw.plugin.json'), 'utf8')) as { configSchema: Schema };
  return manifest.configSchema;
}

describe('plugin configSchema renders as a Control UI form', () => {
  test('uses only keywords the Control UI form renderer supports', () => {
    expect(unsupportedConstructs(manifestSchema())).toEqual([]);
  });

  test('the check catches the constructs that broke the Settings page', () => {
    expect(unsupportedConstructs({
      type: 'object',
      $defs: { token: { type: 'string' } },
      properties: {
        token: { $ref: '#/$defs/token' },
        corpus: { type: 'object', oneOf: [{ properties: { id: { const: 'a' } } }] },
        byName: { type: 'object', patternProperties: { '^x': { type: 'string' } } },
      },
    })).toEqual([
      '<root>: keyword $defs',
      '<root>.token: keyword $ref',
      '<root>.corpus.oneOf[0]: union branch without a type',
      '<root>.byName: keyword patternProperties',
    ]);
  });
});
