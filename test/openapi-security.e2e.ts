/**
 * DEV-058 spec-contract test (`truth-pill-backend`, Phase 10 support).
 *
 * DEV-058: the five token-optional operations must publish **both** alternatives
 * in `api/openapi.yaml` — anonymous *and* bearer — so a generated client knows a
 * credential is accepted and will not silently degrade to anonymous. The fix is
 * `OptionalAuthOperation()` in `src/shared/swagger/security.ts`; this test asserts
 * the **published contract** (the committed spec), not the runtime, because the
 * runtime was already correct.
 *
 * It reads `api/openapi.yaml` directly — no DB, no env, no port — so it runs
 * anywhere `api:check` does.
 *
 * Run: `npm run test:spec-security`.
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

/** The five `@Public()` + `@OptionalAuth()` operations (DEV-058). */
const EXPECTED_OPTIONAL_AUTH = [
  'POST /api/v1/analytics/log-article-view',
  'POST /api/v1/analytics/log-heartbeat',
  'POST /api/v1/analytics/log-page-visit',
  'GET /api/v1/engagement/engagement',
  'POST /api/v1/stream/tickets',
].sort();

const BEARER = 'bearerAuth';

interface OperationRef {
  key: string;
  path: string;
  method: string;
  security: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The optional-auth Security Requirement Object set: `[{}, {bearerAuth: []}]`. */
function isOptionalAuth(security: unknown): boolean {
  if (!Array.isArray(security) || security.length !== 2) return false;
  const [anonymous, bearer] = security as [unknown, unknown];
  if (!isRecord(anonymous) || Object.keys(anonymous).length !== 0) return false;
  if (!isRecord(bearer)) return false;
  const keys = Object.keys(bearer);
  if (keys.length !== 1 || keys[0] !== BEARER) return false;
  const scopes = bearer[BEARER];
  return Array.isArray(scopes) && scopes.length === 0;
}

/** Does any requirement object in an operation's `security` array stand for anonymous? */
function mentionsAnonymous(security: unknown): boolean {
  return (
    Array.isArray(security) &&
    security.some((requirement) => isRecord(requirement) && Object.keys(requirement).length === 0)
  );
}

function enumerateOperations(spec: Record<string, unknown>): OperationRef[] {
  const paths = isRecord(spec.paths) ? spec.paths : {};
  const operations: OperationRef[] = [];
  for (const [path, item] of Object.entries(paths)) {
    if (!isRecord(item)) continue;
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (!isRecord(operation)) continue;
      operations.push({
        key: `${method.toUpperCase()} ${path}`,
        path,
        method,
        security: operation.security,
      });
    }
  }
  return operations;
}

function main(): number {
  const specPath = join(__dirname, '..', 'openapi.yaml');
  const spec = load(readFileSync(specPath, 'utf8'));
  assert.ok(isRecord(spec), 'openapi.yaml did not parse to an object');

  const results: Array<{ name: string; ok: boolean }> = [];
  const check = (name: string, run: () => void): void => {
    try {
      run();
      results.push({ name, ok: true });
      console.log(`PASS  ${name}`);
    } catch (error) {
      results.push({ name, ok: false });
      console.error(`FAIL  ${name}`);
      console.error(error);
    }
  };

  const operations = enumerateOperations(spec);
  const optional = operations.filter((operation) => isOptionalAuth(operation.security));
  const optionalKeys = optional.map((operation) => operation.key).sort();

  check('DEV-058: the document root still inherits bearer auth by default', () => {
    assert.deepEqual(spec.security, [{ [BEARER]: [] }]);
  });

  check(
    'DEV-058: exactly the five token-optional operations publish security [{}, {bearerAuth: []}]',
    () => {
      assert.ok(operations.length > 0, 'no operations found in the spec');
      assert.deepEqual(
        optionalKeys,
        EXPECTED_OPTIONAL_AUTH,
        `optional-auth set drifted. Got:\n  ${optionalKeys.join('\n  ')}`,
      );
    },
  );

  check('DEV-058: each token-optional operation carries anonymous + bearer, in that order', () => {
    for (const key of EXPECTED_OPTIONAL_AUTH) {
      const operation = operations.find((candidate) => candidate.key === key);
      assert.ok(operation, `${key} missing from the spec`);
      assert.deepEqual(
        operation.security,
        [{}, { [BEARER]: [] }],
        `${key} must publish [{} , {bearerAuth: []}]`,
      );
    }
  });

  check('DEV-058: no other operation carries an optional-auth posture', () => {
    for (const operation of operations) {
      if (EXPECTED_OPTIONAL_AUTH.includes(operation.key)) continue;
      assert.ok(
        !isOptionalAuth(operation.security),
        `${operation.key} unexpectedly publishes the optional-auth shape`,
      );
    }
  });

  check('DEV-058: the stacked-decorator artifact ([{},{bearerAuth:[]},{}]) appears nowhere', () => {
    for (const operation of operations) {
      const security = operation.security;
      if (!Array.isArray(security)) continue;
      // A solo anonymous requirement ([{}]) is the legitimate public shape. The
      // moment an anonymous requirement shares the array with anything else, the
      // only valid contract is the canonical two-entry optional-auth shape.
      if (security.length > 1 && mentionsAnonymous(security)) {
        assert.ok(
          isOptionalAuth(security),
          `${operation.key} has an anonymous requirement beside other entries but is not the ` +
            `exact optional-auth shape: ${JSON.stringify(security)}`,
        );
      }
    }
  });

  check('D10-15: GET /quotes/random 200 publishes a nullable QuoteResponseDto schema', () => {
    const paths = isRecord(spec.paths) ? spec.paths : {};
    const item = paths['/api/v1/quotes/random'];
    assert.ok(isRecord(item), 'GET /api/v1/quotes/random missing from the spec');
    const operation = item.get;
    assert.ok(isRecord(operation), 'GET /api/v1/quotes/random has no GET operation');

    const responses = isRecord(operation.responses) ? operation.responses : {};
    const ok = responses['200'];
    assert.ok(isRecord(ok), 'GET /api/v1/quotes/random 200 response missing');

    const content = isRecord(ok.content) ? ok.content : {};
    const json = content['application/json'];
    assert.ok(isRecord(json), '200 has no application/json content');

    const schema = json.schema;
    assert.ok(
      isRecord(schema),
      '200 has no schema — the @ApiOkResponse is trapped in a comment again (D10-15)',
    );
    const serialized = JSON.stringify(schema);
    assert.ok(
      serialized.includes('QuoteResponseDto'),
      `200 schema does not reference QuoteResponseDto: ${serialized}`,
    );
    assert.ok(
      serialized.includes('null'),
      `200 schema does not allow the frozen null body: ${serialized}`,
    );
  });

  const failed = results.filter((result) => !result.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  return failed === 0 ? 0 : 1;
}

try {
  process.exit(main());
} catch (error: unknown) {
  console.error(error);
  process.exit(1);
}
