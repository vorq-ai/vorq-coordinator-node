import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/api/app.js";
import type { Db } from "../src/db/db.js";
import type { Indexer } from "../src/index/indexer.js";
import { testConfig } from "./support/stub-chain.js";

/**
 * The published reference is the route schemas, so the reference is complete
 * exactly when every route carries one. This asks the router rather than a list:
 * a route added without a schema is a route missing from `/docs`, and fails here.
 */

const app = buildApp({
  db: { query: async () => ({ rows: [] }) } as unknown as Db,
  indexer: {} as Indexer,
  config: testConfig(),
});
const routes: { method: string; url: string }[] = [];
app.addHook("onRoute", (route) => {
  for (const method of [route.method].flat()) routes.push({ method, url: route.url });
});

afterAll(() => app.close());

/** `/evm/jobs/:job_id` → `/evm/jobs/{job_id}`; the one wildcard is documented as `{name}`. */
const openApiPath = (url: string) => url.replace(/:(\w+)/g, "{$1}").replace(/\*$/, "{name}");

describe("GET /docs/json", () => {
  it("is an OpenAPI 3.1 document naming every route this node serves", async () => {
    const res = await app.inject("/docs/json");
    expect(res.statusCode).toBe(200);
    const spec = res.json() as { openapi: string; paths: Record<string, Record<string, unknown>> };
    expect(spec.openapi).toBe("3.1.0");

    const served = routes
      .filter(({ method, url }) => method !== "HEAD" && !url.startsWith("/docs"))
      .map(({ method, url }) => `${method} ${openApiPath(url)}`)
      .sort();
    const documented = Object.entries(spec.paths)
      .flatMap(([path, operations]) => Object.keys(operations).map((m) => `${m.toUpperCase()} ${path}`))
      .sort();
    expect(documented).toEqual(served);
  });

  // A summary is only ever set by a route schema, so it is the proof one exists.
  it("gives every operation a summary, a tag and declared responses", async () => {
    const spec = (await app.inject("/docs/json")).json() as {
      paths: Record<string, Record<string, { summary?: string; tags?: string[]; responses?: object }>>;
    };
    for (const [path, operations] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        const at = `${method.toUpperCase()} ${path}`;
        expect(operation.summary, at).toBeTruthy();
        expect(operation.tags?.length, at).toBeGreaterThan(0);
        expect(Object.keys(operation.responses ?? {}).length, at).toBeGreaterThan(0);
      }
    }
  });

  it("serves the browsable reference at /docs", async () => {
    const res = await app.inject("/docs/");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
  });
});
