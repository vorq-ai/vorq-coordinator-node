import type { ValidateFunction } from "ajv";
import { afterEach, vi } from "vitest";
import type { AppOptions } from "../../src/api/app.js";
import { bodyAjv } from "../../src/api/schemas/ajv.js";

/**
 * Every response a test provokes is checked against the schema its route
 * publishes for that status.
 *
 * The reply serializer wins over response schemas (`app.ts`), so nothing in
 * production compares a body with the spec; without this the spec could drift
 * from the wire unseen. A route that declares `response` must declare every
 * status it answers, `500` aside, and each body must match.
 */

const violations: string[] = [];
const compiled = new WeakMap<object, ValidateFunction>();

function check(route: string, status: number, schemas: Record<string, object>, payload: unknown): void {
  const schema = schemas[status] ?? schemas[`${Math.floor(status / 100)}xx`];
  if (schema === undefined) {
    if (status !== 500) violations.push(`${route} answered ${status}, which its schema does not declare`);
    return;
  }
  if (typeof payload !== "string") return;
  let validate = compiled.get(schema);
  if (validate === undefined) {
    validate = bodyAjv.compile(schema);
    compiled.set(schema, validate);
  }
  if (!validate(JSON.parse(payload))) {
    violations.push(`${route} ${status} breaks its response schema: ${bodyAjv.errorsText(validate.errors)}`);
  }
}

vi.mock("../../src/api/app.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api/app.js")>();
  return {
    ...actual,
    buildApp: (options: AppOptions) => {
      const app = actual.buildApp(options);
      app.addHook("onSend", async (request, reply, payload) => {
        const schemas = request.routeOptions.schema?.response as Record<string, object> | undefined;
        if (schemas !== undefined) {
          check(`${request.method} ${request.routeOptions.url}`, reply.statusCode, schemas, payload);
        }
        return payload;
      });
      return app;
    },
  };
});

afterEach(() => {
  const found = violations.splice(0);
  if (found.length > 0) throw new Error(found.join("\n"));
});
