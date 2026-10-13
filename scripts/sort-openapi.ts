import type { ComponentsObject, OpenAPIObject, PathsObject } from '@nestjs/swagger';

type SchemaMap = NonNullable<ComponentsObject['schemas']>;

/**
 * Byte-stable string order. Deliberately not `localeCompare`, which varies with
 * the host locale and would make the spec non-deterministic across machines
 * (`docs/types/README.md`).
 */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortSchemaProperties(schemas: SchemaMap): SchemaMap {
  const sorted: SchemaMap = {};
  for (const name of Object.keys(schemas).sort(compare)) {
    const schema = schemas[name];
    if (typeof schema === 'object' && schema !== null && 'properties' in schema && schema.properties) {
      const entries = Object.entries(schema.properties).sort(([a], [b]) => compare(a, b));
      schema.properties = Object.fromEntries(entries);
    }
    sorted[name] = schema;
  }
  return sorted;
}

function sortPaths(paths: PathsObject): PathsObject {
  const sorted: PathsObject = {};
  for (const path of Object.keys(paths).sort(compare)) {
    sorted[path] = paths[path];
  }
  return sorted;
}

/**
 * Sort paths, schema names, and schema properties so that regenerating the
 * spec on any machine produces an identical file. Without this, a reorder —
 * from module scan order or a dependency change — shows up as drift on an
 * unchanged contract, and the drift check becomes noise (ADR-009).
 *
 * Returns a new document; the input is not mutated at the top level.
 */
export function sortOpenApiDocument(document: OpenAPIObject): OpenAPIObject {
  const sorted: OpenAPIObject = { ...document, paths: sortPaths(document.paths) };
  const components = sorted.components;
  if (components?.schemas) {
    sorted.components = { ...components, schemas: sortSchemaProperties(components.schemas) };
  }
  return sorted;
}
