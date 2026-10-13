#!/usr/bin/env node
/**
 * `npm run api:check` — the mechanical contract + parity gate (D10, D11, ADR-009).
 *
 * Stages:
 *   1. Generate `api/openapi.yaml` from the decorators, into a temp file.
 *   2. Generate `docs/types/api.ts` from that spec, into a temp file.
 *   3. Spec drift  — committed spec  vs regenerated. Fail (1).
 *   4. Type drift  — committed types vs regenerated. Fail (2).
 *   5. Convention  — internal namespace, action/mutation-never-GET, identity
 *                    fields in the spec. Fail (3).
 *                    Identity semantics (orchestrator ruling, 2026-10-01,
 *                    Phase 05 regen pass): ADR-007 governs CLIENT-SUPPLIED
 *                    identity, so the fatal scan covers only `parameters[]`
 *                    (path/query/header) and `requestBody` content schemas,
 *                    with `$ref` resolution into `components.schemas`.
 *                    Identity field names found ONLY in response schemas are
 *                    reported as a non-fatal advisory — the frozen guard
 *                    matrix (docs/endpoints/content-guard-matrix.md §3)
 *                    explicitly permits admin response projections such as
 *                    `ActivityItemDto.userId` (frozen parity,
 *                    `web/convex/admin.ts:76`). A rename would break parity;
 *                    the scan's original all-`properties` walk predated any
 *                    response schema existing.
 *   6. Parity      — forward: phase-scoped (see below). Fail (3).
 *   7. Reverse     — spec routes that trace to no ownership row. Advisory only.
 *
 * Phase-scoped parity (the Phase-03 zero-routes answer):
 *   With no controllers the spec has no paths, so a naive "every ownership row
 *   must appear" gate would fail every one of the 127 rows. Instead a row
 *   becomes REQUIRED — and fails the build if uncovered — only once its owning
 *   phase has landed. `CURRENT_PHASE` is bumped as each phase closes; rows whose
 *   phase is still ahead are reported as pending, not failed.
 *   See `docs/endpoints/README.md` § "Contract enforcement (`api:check`)".
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
const API_DIR = resolve(HERE, '..');
const REPO_ROOT = resolve(API_DIR, '..');

const OWNERSHIP_PATH = join(REPO_ROOT, 'docs', 'convex-ownership.md');
const COMMITTED_SPEC = join(API_DIR, 'openapi.yaml');
const COMMITTED_TYPES = join(REPO_ROOT, 'docs', 'types', 'api.ts');
const GENERATOR = join(HERE, 'generate-openapi.ts');
const TS_NODE_BIN = join(API_DIR, 'node_modules', 'ts-node', 'dist', 'bin.js');
const OPENAPI_TYPES_BIN = join(API_DIR, 'node_modules', 'openapi-typescript', 'bin', 'cli.js');

const EXIT = { clean: 0, specDrift: 1, typeDrift: 2, parity: 3, generator: 4 };

/**
 * Bump when a phase's routes have landed. A parity row is enforced only when
 * `row.phase <= CURRENT_PHASE`. Overridable with `MIGRATION_PHASE=<n>` so CI can
 * exercise a future gate without editing this file.
 */
const CURRENT_PHASE = Number.parseInt(process.env.MIGRATION_PHASE ?? '10', 10);

const EXPECTED_OWNERSHIP_ROWS = 127;
const FORBIDDEN_IDENTITY_FIELDS = ['adminEmail', 'userEmail', 'userId', 'actorId'];
const INTERNAL_PREFIX = '/api/v1/internal/';
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

class CheckFailure extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function runNode(binPath, args, label) {
  if (!existsSync(binPath)) {
    throw new CheckFailure(EXIT.generator, `${label}: missing executable ${binPath} (run npm ci)`);
  }
  const result = spawnSync(process.execPath, [binPath, ...args], {
    cwd: API_DIR,
    encoding: 'utf8',
  });
  if (result.error) {
    throw new CheckFailure(EXIT.generator, `${label}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    throw new CheckFailure(EXIT.generator, `${label} exited ${result.status}\n${detail}`);
  }
}

function splitRow(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) return null;
  const parts = trimmed.split('|');
  return parts.slice(1, -1).map((cell) => cell.trim());
}

/** Parse the function-parity table only — never the feature or correction tables. */
function parseOwnership(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === '## Function parity table');
  const end = lines.findIndex((line) => line.trim() === '## Correction log');
  if (start < 0 || end < 0 || end <= start) {
    throw new CheckFailure(
      EXIT.generator,
      'convex-ownership.md: could not locate the "## Function parity table" / "## Correction log" bounds',
    );
  }

  const rows = [];
  for (let i = start + 1; i < end; i += 1) {
    const cells = splitRow(lines[i]);
    if (!cells || cells.length !== 5) continue;
    const fn = cells[0].match(/`([^`]+)`/);
    const phase = Number.parseInt(cells[3], 10);
    if (!fn || !Number.isInteger(phase)) continue;
    const target = cells[2].match(/`([A-Z]+)\s+([^`]+)`/);
    rows.push({
      fn: fn[1],
      type: cells[1],
      method: target ? target[1] : null,
      path: target ? target[2].split('?')[0].trim() : null,
      phase,
      status: cells[4],
    });
  }
  return rows;
}

function loadSpec(specPath) {
  const spec = load(readFileSync(specPath, 'utf8'));
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new CheckFailure(EXIT.generator, `spec at ${specPath} did not parse to an object`);
  }
  const paths = spec.paths && typeof spec.paths === 'object' && !Array.isArray(spec.paths) ? spec.paths : {};
  return { spec, paths };
}

function isCovered(paths, row) {
  const item = paths[row.path];
  if (!item || typeof item !== 'object') return false;
  return hasOwn(item, row.method.toLowerCase());
}

function resolveRef(root, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return undefined;
  let node = root;
  for (const segment of ref.slice(2).split('/')) {
    if (!node || typeof node !== 'object') return undefined;
    const key = segment.replace(/~1/g, '/').replace(/~0/g, '~');
    node = node[key];
  }
  return node;
}

/** Walk a schema subtree, following local $refs into components (cycle-guarded). */
function walkSchema(node, root, into, seen) {
  if (Array.isArray(node)) {
    for (const value of node) walkSchema(value, root, into, seen);
    return;
  }
  if (!node || typeof node !== 'object') return;
  if (typeof node.$ref === 'string') {
    if (seen.has(node.$ref)) return;
    seen.add(node.$ref);
    walkSchema(resolveRef(root, node.$ref), root, into, seen);
    return;
  }
  if (node.properties && typeof node.properties === 'object' && !Array.isArray(node.properties)) {
    for (const name of Object.keys(node.properties)) into.add(name);
  }
  for (const value of Object.values(node)) walkSchema(value, root, into, seen);
}

function* forEachOperation(spec) {
  const paths = spec.paths && typeof spec.paths === 'object' ? spec.paths : {};
  for (const item of Object.values(paths)) {
    if (!item || typeof item !== 'object') continue;
    const shared = Array.isArray(item.parameters) ? item.parameters : [];
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (operation && typeof operation === 'object') yield { item, method, operation, shared };
    }
  }
}

/**
 * Request-surface property names — the fatal ADR-007 scope: every declared
 * parameter (path/query/header/cookie, operation- and path-item-level) plus
 * every requestBody content schema, $refs resolved.
 */
function collectRequestPropertyNames(spec) {
  const into = new Set();
  for (const { shared, operation } of forEachOperation(spec)) {
    for (const parameter of [...shared, ...(Array.isArray(operation.parameters) ? operation.parameters : [])]) {
      if (parameter && typeof parameter === 'object') {
        if (typeof parameter.name === 'string') into.add(parameter.name);
        if (parameter.schema) walkSchema(parameter.schema, spec, into, new Set());
      }
    }
    if (operation.requestBody) walkSchema(operation.requestBody, spec, into, new Set());
  }
  return into;
}

/** Response-surface property names — advisory scope only. */
function collectResponsePropertyNames(spec) {
  const into = new Set();
  for (const { operation } of forEachOperation(spec)) {
    if (operation.responses) walkSchema(operation.responses, spec, into, new Set());
  }
  return into;
}

function diffAgainstCommitted(generatedPath, committedPath, label, code) {
  // `--no-index` also compares when the committed file is untracked or absent,
  // which plain `git diff --exit-code` would silently pass (docs/types/README.md).
  const result = spawnSync('git', ['diff', '--no-index', '--', committedPath, generatedPath], {
    encoding: 'utf8',
  });
  const identical = result.status === 0;
  if (!identical) {
    const body = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    throw new CheckFailure(code, `${label} drift detected\n${body}`);
  }
}

function main(tempDir) {
  if (!existsSync(OWNERSHIP_PATH)) {
    throw new CheckFailure(EXIT.generator, `ownership table not found at ${OWNERSHIP_PATH}`);
  }
  if (!existsSync(GENERATOR)) {
    throw new CheckFailure(EXIT.generator, `generator not found at ${GENERATOR}`);
  }

  const tempSpec = join(tempDir, 'openapi.yaml');
  const tempTypes = join(tempDir, 'api.ts');

  runNode(TS_NODE_BIN, ['--transpile-only', GENERATOR, '--out', tempSpec], 'generate:openapi');
  runNode(OPENAPI_TYPES_BIN, [tempSpec, '-o', tempTypes], 'generate:types');

  diffAgainstCommitted(tempSpec, COMMITTED_SPEC, 'api/openapi.yaml', EXIT.specDrift);
  diffAgainstCommitted(tempTypes, COMMITTED_TYPES, 'docs/types/api.ts', EXIT.typeDrift);

  const rows = parseOwnership(readFileSync(OWNERSHIP_PATH, 'utf8'));
  if (rows.length !== EXPECTED_OWNERSHIP_ROWS) {
    throw new CheckFailure(
      EXIT.generator,
      `parsed ${rows.length} ownership rows, expected ${EXPECTED_OWNERSHIP_ROWS} — table shape changed`,
    );
  }

  const { spec, paths } = loadSpec(tempSpec);
  const specPaths = Object.keys(paths);

  // ── Convention lint ──────────────────────────────────────────────────────
  const violations = [];
  for (const row of rows) {
    if (row.method === null) continue;
    if (row.type.startsWith('internal') && !row.path.startsWith(INTERNAL_PREFIX)) {
      violations.push(`internal function ${row.fn} mapped to public path ${row.path}`);
    }
    if ((row.type === 'action' || row.type === 'mutation') && row.method === 'GET') {
      violations.push(`${row.fn} is a ${row.type} mapped to GET`);
    }
  }
  if (violations.length > 0) {
    throw new CheckFailure(EXIT.parity, `convention violations:\n  - ${violations.join('\n  - ')}`);
  }

  const requestNames = collectRequestPropertyNames(spec);
  const identityFields = FORBIDDEN_IDENTITY_FIELDS.filter((field) => requestNames.has(field));
  if (identityFields.length > 0) {
    throw new CheckFailure(
      EXIT.parity,
      `request-surface caller-identity field(s) in the spec — ADR-007 violation: ${identityFields.join(', ')}`,
    );
  }
  const responseNames = collectResponsePropertyNames(spec);
  const responseIdentityFields = FORBIDDEN_IDENTITY_FIELDS.filter((field) => responseNames.has(field));

  // ── Parity, forward (phase-scoped) ───────────────────────────────────────
  const withTarget = rows.filter((row) => row.method !== null && !row.status.includes('Removed'));
  const required = withTarget.filter((row) => row.phase <= CURRENT_PHASE);
  const uncoveredRequired = required.filter((row) => !isCovered(paths, row));
  if (uncoveredRequired.length > 0) {
    const listed = uncoveredRequired.map((row) => `${row.fn} (phase ${row.phase})`).join(', ');
    throw new CheckFailure(
      EXIT.parity,
      `uncovered ownership rows due at phase ${CURRENT_PHASE}: ${listed}`,
    );
  }
  const pending = withTarget.filter((row) => row.phase > CURRENT_PHASE && !isCovered(paths, row));

  // ── Parity, reverse (advisory only) ──────────────────────────────────────
  const claimed = new Set(withTarget.map((row) => `${row.method} ${row.path}`));
  const unclaimed = [];
  for (const [path, item] of Object.entries(paths)) {
    if (!item || typeof item !== 'object') continue;
    for (const method of HTTP_METHODS) {
      if (hasOwn(item, method)) {
        const key = `${method.toUpperCase()} ${path}`;
        if (!claimed.has(key)) unclaimed.push(key);
      }
    }
  }

  const internalRows = rows.filter((row) => row.type.startsWith('internal')).length;
  const writeRows = rows.filter((row) => row.type === 'action' || row.type === 'mutation').length;

  process.stdout.write(
    [
      `api:check — owning phase ${CURRENT_PHASE}`,
      `  ownership rows parsed : ${rows.length}/${EXPECTED_OWNERSHIP_ROWS}`,
      `  spec paths            : ${specPaths.length}`,
      `  required at phase     : ${required.length} (${uncoveredRequired.length} uncovered)`,
      `  pending (phase ahead) : ${pending.length}`,
      `  reverse parity        : ${unclaimed.length} unclaimed spec route(s) (advisory)`,
      `  identity fields       : ${identityFields.length === 0 ? 'none' : identityFields.join(', ')} (request surface — ADR-007)`,
      `  response-side identity fields (advisory): ${responseIdentityFields.length === 0 ? 'none' : responseIdentityFields.join(', ')}`,
      `  internal rows checked : ${internalRows}`,
      `  action/mutation rows  : ${writeRows} (none mapped to GET)`,
      '✅ api:check clean',
      '',
    ].join('\n'),
  );
  return EXIT.clean;
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const tempDir = mkdtempSync(join(tmpdir(), 'tp-api-check-'));
  let exitCode = EXIT.clean;
  try {
    exitCode = main(tempDir);
  } catch (error) {
    if (error instanceof CheckFailure) {
      process.stderr.write(`\n❌ api:check failed: ${error.message}\n`);
      exitCode = error.code;
    } else {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`\n❌ api:check error: ${message}\n`);
      exitCode = EXIT.generator;
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
  process.exit(exitCode);
}

export {
  EXIT,
  FORBIDDEN_IDENTITY_FIELDS,
  collectRequestPropertyNames,
  collectResponsePropertyNames,
  resolveRef,
  walkSchema,
};
