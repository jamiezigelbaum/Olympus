/**
 * The shipped example config must satisfy the plugin's own configSchema.
 *
 * `config/olympus.example.json` is a public package file (see
 * `V0_4_PUBLIC_PACKAGE_FILES`), so a pilot copies it into their OpenClaw
 * config. The host validates that config against `openclaw.plugin.json`'s
 * configSchema, which sets `additionalProperties: false` on every declared
 * object. Olympus's own `loadConfig` is deliberately lenient — it ignores keys
 * it does not know — so nothing in the repository noticed when a key was
 * removed from the manifest and left behind in the example. The result is an
 * example that fails host validation and a plugin that does not load.
 *
 * The validator below covers the JSON Schema subset the manifest actually uses
 * rather than pulling in a dependency: $ref/$defs, type, properties,
 * additionalProperties, required, items, uniqueItems, enum, const, oneOf, and
 * minimum. An unsupported keyword is a hard error, so extending the manifest
 * with a construct this gate cannot check fails loudly instead of silently
 * passing everything.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

const ROOT = join(import.meta.dir, '..');

type Schema = Record<string, unknown>;
type Defs = Record<string, Schema>;

/** Keywords the validator understands. Anything else is refused. */
const SUPPORTED_KEYWORDS = new Set([
  '$ref',
  '$defs',
  'type',
  'properties',
  'additionalProperties',
  'required',
  'items',
  'uniqueItems',
  'enum',
  'const',
  'oneOf',
  'minimum',
  'description',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolveRef(schema: Schema, defs: Defs): Schema {
  const ref = schema.$ref;
  if (typeof ref !== 'string') return schema;
  const name = /^#\/\$defs\/(.+)$/.exec(ref)?.[1];
  const target = name === undefined ? undefined : defs[name];
  if (!target) throw new Error(`Unsupported or unknown $ref: ${ref}`);
  return resolveRef(target, defs);
}

function validate(value: unknown, rawSchema: Schema, defs: Defs, path: string, errors: string[]): void {
  const schema = resolveRef(rawSchema, defs);
  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(keyword)) {
      throw new Error(`${path}: schema keyword "${keyword}" is not covered by this gate`);
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value as never)) {
    errors.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
    return;
  }
  if ('const' in schema && schema.const !== value) {
    errors.push(`${path}: ${JSON.stringify(value)} is not ${JSON.stringify(schema.const)}`);
    return;
  }

  if (Array.isArray(schema.oneOf)) {
    const matches = (schema.oneOf as Schema[]).filter((branch) => {
      const branchErrors: string[] = [];
      validate(value, branch, defs, path, branchErrors);
      return branchErrors.length === 0;
    });
    if (matches.length !== 1) {
      errors.push(`${path}: matched ${matches.length} oneOf branches, expected exactly one`);
      return;
    }
  }

  if (schema.type === 'object') {
    if (!isRecord(value)) {
      errors.push(`${path}: expected an object`);
      return;
    }
    const properties = isRecord(schema.properties) ? (schema.properties as Record<string, Schema>) : {};
    for (const key of (schema.required as string[] | undefined) ?? []) {
      if (!(key in value)) errors.push(`${path}: missing required key "${key}"`);
    }
    for (const [key, child] of Object.entries(value)) {
      const childSchema = properties[key];
      if (childSchema) {
        validate(child, childSchema, defs, `${path}.${key}`, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}.${key}: not declared in the configSchema (additionalProperties is false)`);
      } else if (isRecord(schema.additionalProperties)) {
        validate(child, schema.additionalProperties as Schema, defs, `${path}.${key}`, errors);
      }
    }
    return;
  }

  if (schema.type === 'array') {
    if (!Array.isArray(value)) {
      errors.push(`${path}: expected an array`);
      return;
    }
    if (schema.uniqueItems === true) {
      const seen = new Set(value.map((item) => JSON.stringify(item)));
      if (seen.size !== value.length) errors.push(`${path}: items must be unique`);
    }
    if (isRecord(schema.items)) {
      value.forEach((item, index) => validate(item, schema.items as Schema, defs, `${path}[${index}]`, errors));
    }
    return;
  }

  if (schema.type === 'string' && typeof value !== 'string') {
    errors.push(`${path}: expected a string`);
    return;
  }
  if (schema.type === 'boolean' && typeof value !== 'boolean') {
    errors.push(`${path}: expected a boolean`);
    return;
  }
  if (schema.type === 'number') {
    if (typeof value !== 'number') {
      errors.push(`${path}: expected a number`);
      return;
    }
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      errors.push(`${path}: ${value} is below the minimum ${schema.minimum}`);
    }
  }
}

function configSchema(): { schema: Schema; defs: Defs } {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'openclaw.plugin.json'), 'utf8')) as {
    configSchema: Schema;
  };
  const schema = manifest.configSchema;
  const defs = (schema.$defs as Defs | undefined) ?? {};
  return { schema, defs };
}

function exampleConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(ROOT, 'config', 'olympus.example.json'), 'utf8')) as Record<string, unknown>;
}

function validationErrors(config: unknown): string[] {
  const { schema, defs } = configSchema();
  const errors: string[] = [];
  validate(config, schema, defs, 'config', errors);
  return errors;
}

describe('shipped example config', () => {
  test('validates against the plugin configSchema', () => {
    expect(validationErrors(exampleConfig())).toEqual([]);
  });

  test('the gate rejects a key the configSchema does not declare', () => {
    const withDrift = exampleConfig();
    const email = { ...(withDrift.email as Record<string, unknown>), notDeclaredByTheManifest: false };
    expect(validationErrors({ ...withDrift, email })).toEqual([
      'config.email.notDeclaredByTheManifest: not declared in the configSchema (additionalProperties is false)',
    ]);
  });
});
