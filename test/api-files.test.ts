import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/api/app.js";
import {
  attachFile,
  FILE_ORPHAN_SECONDS,
  findUpload,
  MAX_BATCH_LINES,
} from "../src/api/routes/files.js";
import { commitmentOf, MIN_CONTAINER_BYTES } from "../src/container.js";
import { openDb, type Db } from "../src/db/db.js";
import { createSession } from "../src/api/sessions.js";
import type { Indexer, IndexerStatus } from "../src/index/indexer.js";
import { startStubStore, type StubStore } from "./support/stub-store.js";
import { BOUNDARY, multipart } from "./support/multipart.js";
import { testConfig } from "./support/stub-chain.js";

/**
 * `/v1/files` — the upload door, and the one place Q26 is answered.
 *
 * Q26 is why the whole batch surface came out: the old `POST /v1/files` wrote the
 * caller's JSONL to the node's own disk and `GET /v1/files/{id}/content` served it
 * back, which is exactly the payload-at-rest that container v1 exists to remove.
 * The door returns because the answer is the pinner: the bytes go to the object
 * store, the node keeps a CID, and the row that names it holds no payload at all.
 * The test that matters most in this file is the one that proves that
 * ("keeps no copy of the bytes it was handed").
 *
 * The other two purposes are the door a payload too large to inline takes: a
 * sealed `input` committed to as it streams past, and a sealed `result`. Every
 * upload carries an expiry, which is what the file sweep (`test/sweep.test.ts`)
 * honours.
 *
 * Database-gated (R25) — `files` is a real table and the owner scope is a real
 * query — so this runs with:
 *
 *   docker compose -f compose.dev.yml up -d
 *   TEST_DATABASE_URL=postgres://vorq:vorq@localhost:5433/vorq npm test
 */

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const TEST_SCHEMA = "vorq_files_test";

const OWNER = Buffer.alloc(20, 0xa1);
const STRANGER = Buffer.alloc(20, 0xb2);

function stubIndexer(): Indexer {
  const status = async (): Promise<IndexerStatus> => ({
    cursor: 4242n,
    head: 4242n,
    ready: true,
    forked: null,
  });
  return {
    coldStart: async () => undefined,
    poll: async () => undefined,
    status,
    start: async () => undefined,
    stop: async () => undefined,
  };
}

/** One JSONL line, of the shape a batch input carries. Content is not checked here. */
const line = (n: number): string =>
  JSON.stringify({ custom_id: `req-${n}`, method: "POST", url: "/v1/responses" });

const jsonl = (count: number): string =>
  Array.from({ length: count }, (_, index) => line(index)).join("\n");

/** A container v1: the version byte, an 80-byte wrap, then ciphertext. */
const container = (ciphertext = 64, version = 0x01): Buffer =>
  Buffer.concat([
    Buffer.from([version]),
    Buffer.alloc(MIN_CONTAINER_BYTES - 1, 0x77),
    Buffer.alloc(ciphertext, 0x33),
  ]);

describe.skipIf(!TEST_DATABASE_URL)("/v1/files", () => {
  let db: Db;
  let app: FastifyInstance;
  /**
   * The same door with a ceiling small enough to cross in a test, and a part
   * size small enough that crossing it is a *streamed* upload.
   *
   * The shipped numbers are 200 MB and 8 MiB, and a suite that drove them
   * honestly would allocate a fifth of a gigabyte per case to prove arithmetic
   * that is identical at 64 KiB. Both are settings for exactly this reason: the
   * ceiling is an operator's (`MAX_BLOB_BYTES`) and the part size is the
   * store's, so the two paths a large file takes — refused at the door, or
   * streamed past the seam in parts — are reachable at a scale a test can hold.
   */
  let smallApp: FastifyInstance;
  const SMALL_CEILING = 64 * 1024;
  const SMALL_PART = 8 * 1024;
  let store: StubStore;
  let token: string;
  let strangerToken: string;

  const upload = (body: Buffer, bearer = token) =>
    app.inject({
      method: "POST",
      url: "/v1/files",
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: body,
    });

  const uploadBatch = (content: string, filename = "batch.jsonl") =>
    upload(
      multipart([
        { name: "purpose", value: "batch" },
        { name: "file", value: content, filename },
      ]),
    );

  /**
   * One upload under any purpose. The default `filename` is empty rather than
   * absent: a part with no `filename` at all is a *field* to the parser, and what
   * is under test is the name the door picks when the caller supplies none.
   */
  const uploadAs = (purpose: string, value: string | Buffer, filename = "") =>
    upload(
      multipart([
        { name: "purpose", value: purpose },
        { name: "file", value, filename },
      ]),
    );

  beforeAll(async () => {
    store = await startStubStore();
    const options = encodeURIComponent(`-c search_path=${TEST_SCHEMA}`);
    const url = TEST_DATABASE_URL as string;
    db = openDb(`${url}${url.includes("?") ? "&" : "?"}options=${options}`);
    await db.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await db.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
    await db.migrate();

    app = buildApp({
      db,
      indexer: stubIndexer(),
      config: testConfig({ dbUrl: url, pinS3: store.config() }),
    });
    smallApp = buildApp({
      db,
      indexer: stubIndexer(),
      config: testConfig({
        dbUrl: url,
        pinS3: store.config({ partBytes: SMALL_PART }),
        maxBlobBytes: SMALL_CEILING,
      }),
    });
  });

  afterAll(async () => {
    await smallApp?.close();
    await app?.close();
    await store?.close();
    await db.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await db.close();
  });

  beforeEach(async () => {
    for (const table of ["files", "sessions", "pins"]) await db.query(`DELETE FROM ${table}`);
    store.objects.clear();
    store.uploads.clear();
    token = (await createSession(db, OWNER, "client", null)).token;
    strangerToken = (await createSession(db, STRANGER, "client", null)).token;
  });

  // -------------------------------------------------------------------------
  // Upload
  // -------------------------------------------------------------------------

  it("answers a FileObject in OpenAI's shape", async () => {
    const content = jsonl(3);
    const response = await uploadBatch(content);

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.id).toMatch(/^file-[0-9a-f]{24}$/);
    expect(body.object).toBe("file");
    expect(body.purpose).toBe("batch");
    expect(body.filename).toBe("batch.jsonl");
    expect(body.bytes).toBe(Buffer.byteLength(content));
    expect(body.status).toBe("uploaded");
    expect(typeof body.created_at).toBe("number");
    expect(typeof body.expires_at).toBe("number");
  });

  it("refuses an upload with no session", async () => {
    const response = await upload(
      multipart([
        { name: "purpose", value: "batch" },
        { name: "file", value: jsonl(1), filename: "batch.jsonl" },
      ]),
      "not-a-token",
    );
    expect(response.statusCode).toBe(401);
  });

  it("keeps no copy of the bytes it was handed — Q26, the reason the door was closed", async () => {
    const content = jsonl(4);
    const id = (await uploadBatch(content)).json().id;

    // Every column of the row, as text. None of them may carry the payload: what
    // the node keeps is a name the store minted, and the object lives there.
    const { rows } = await db.query<Record<string, unknown>>(
      "SELECT * FROM files WHERE file_id = $1",
      [id],
    );
    const row = rows[0] as Record<string, unknown>;
    expect(row).toBeDefined();
    for (const value of Object.values(row)) {
      expect(String(value)).not.toContain("req-1");
    }
    expect(String(row.cid)).not.toBe("");

    // …and the store holds exactly what was uploaded.
    expect([...store.objects.values()].map((bytes) => bytes.toString("utf8"))).toContain(content);
  });

  it("refuses a purpose the coordinator mints rather than accepts", async () => {
    // `batch_output` and `batch_error` are written by the worker at finalization.
    // A caller uploading one would be handing the node a result file it never
    // produced, under an id other callers read as authoritative.
    const response = await upload(
      multipart([
        { name: "purpose", value: "batch_output" },
        { name: "file", value: jsonl(1), filename: "out.jsonl" },
      ]),
    );
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("invalid_purpose");
    expect(response.json().error.param).toBe("purpose");
  });

  it("refuses a body carrying no file part", async () => {
    const response = await upload(multipart([{ name: "purpose", value: "batch" }]));
    expect(response.statusCode).toBe(400);
    expect(response.json().error.param).toBe("file");
  });

  it("refuses an empty file rather than creating a batch with nothing in it", async () => {
    const response = await uploadBatch("");
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("empty_file");
  });

  it("refuses a file of nothing but blank lines", async () => {
    const response = await uploadBatch("\n\n   \n");
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("empty_file");
  });

  it("counts lines and refuses past the cap, naming the count", async () => {
    // 50 000 is OpenAI's parity number. Refused here rather than at create,
    // because this is the one place the node holds the bytes to count.
    const response = await uploadBatch(jsonl(MAX_BATCH_LINES + 1));
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("too_many_lines");
    expect(response.json().error.message).toContain(String(MAX_BATCH_LINES));
  });

  it("accepts a trailing newline without counting a line that is not there", async () => {
    const response = await uploadBatch(`${jsonl(2)}\n`);
    expect(response.statusCode).toBe(200);
    expect(response.json().vorq.lines).toBe(2);
  });

  /** The same body, at the door whose ceiling and part size a test can reach. */
  const uploadSmall = (parts: { name: string; value: string | Buffer; filename?: string }[]) =>
    smallApp.inject({
      method: "POST",
      url: "/v1/files",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: multipart(parts),
    });

  it("refuses a file past the ceiling, and files nothing", async () => {
    const response = await uploadSmall([
      { name: "purpose", value: "batch" },
      { name: "file", value: Buffer.alloc(SMALL_CEILING + 1024, 0x41), filename: "big.jsonl" },
    ]);

    expect(response.statusCode).toBe(413);
    expect(response.json().error.code).toBe("file_too_large");
    // Past the ceiling **and** past the part size, so parts of it were already
    // on the store when the refusal landed. The upload they belong to is
    // abandoned, so the object never comes into existence.
    expect(store.objects.size).toBe(0);
    expect(store.uploads.size).toBe(0);
  });

  it("streams a file bigger than one part, and keeps every byte of it", async () => {
    // The upload path that does not fit in memory, at a scale that does. Nothing
    // in the arithmetic is sensitive to the size: the door writes what it reads,
    // the pinner cuts parts at the seam, and the store assembles them in the
    // order the completion document names.
    const content = jsonl(400);
    expect(content.length).toBeGreaterThan(SMALL_PART * 3);

    const created = (
      await uploadSmall([
        { name: "purpose", value: "batch" },
        { name: "file", value: content, filename: "big.jsonl" },
      ])
    ).json();

    expect(created.bytes).toBe(Buffer.byteLength(content));
    expect(created.vorq.lines).toBe(400);
    // It went past the seam rather than landing in one put — otherwise this
    // whole case would be the small path with a bigger fixture.
    expect(store.requests.filter((r) => r.url.includes("partNumber=")).length).toBeGreaterThan(1);

    const back = await smallApp.inject({
      method: "GET",
      url: `/v1/files/${created.id}/content`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(back.rawPayload.toString("utf8")).toBe(content);
  });

  it("refuses a file that arrives before purpose, and stores nothing", async () => {
    // Fields first, file last — the rule every byte-carrying door reads by
    // (`api/multipart.ts`). The fields are read up to the file part and the
    // door decides there, with the file unread: a form whose file comes first
    // has no purpose by then, and nothing of it reaches the store.
    const response = await uploadSmall([
      { name: "file", value: jsonl(400), filename: "big.jsonl" },
      { name: "purpose", value: "batch" },
    ]);

    expect(response.statusCode).toBe(400);
    expect(response.json().error.param).toBe("purpose");
    expect(store.objects.size).toBe(0);
    expect(store.uploads.size).toBe(0);
  });
  it("names the object the store minted, so a client can read it without this node", async () => {
    const body = (await uploadBatch(jsonl(2))).json();
    expect(body.vorq.cid).toBe(store.mintedCid(Buffer.from(jsonl(2), "utf8")));
  });

  // -------------------------------------------------------------------------
  // The two payload purposes
  // -------------------------------------------------------------------------

  it("commits to a container as it streams past, and stores c on the row", async () => {
    // The whole point of the `input` purpose: this is the one place the sealed
    // bytes go past, so `c` is computed here and the post door compares the
    // client's signed commitment against this column instead of reading the
    // object back.
    const bytes = container();
    const created = (await uploadAs("input", bytes)).json();

    expect(created.purpose).toBe("input");
    expect(created.filename).toBe("container");
    expect(created.bytes).toBe(bytes.length);
    expect(created.vorq.lines).toBe(0);

    const { rows } = await db.query<{ commitment: Buffer }>(
      "SELECT commitment FROM files WHERE file_id = $1",
      [created.id],
    );
    expect(`0x${(rows[0]?.commitment as Buffer).toString("hex")}`).toBe(commitmentOf(bytes));
  });

  it("refuses a container that is not v1, on its first chunk, and stores nothing", async () => {
    const response = await uploadAs("input", container(64, 0x02));

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("bad_container");
    expect(response.json().error.param).toBe("file");
    expect(store.objects.size).toBe(0);
    expect(store.uploads.size).toBe(0);
  });

  it("reads a bad container to its end rather than leaving the client mid-body", async () => {
    // The fault is known on the first chunk and the door still consumes the
    // upload. Throwing out of the async iterator destroys the file stream, at
    // which point busboy stops parsing while the client is still sending — and
    // the client sees a reset instead of this `400`.
    store.requests.length = 0;
    const bad = Buffer.concat([Buffer.from([0x02]), Buffer.alloc(SMALL_PART * 3, 0x77)]);

    const response = await uploadSmall([
      { name: "purpose", value: "input" },
      { name: "file", value: bad, filename: "container" },
    ]);

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("bad_container");
    // Parts past the first seam went out, which is the evidence the stream kept
    // being read after the fault rather than stopping on chunk one.
    expect(store.requests.filter((r) => r.url.includes("partNumber=")).length).toBeGreaterThan(1);
    // And the upload they belong to was abandoned, so no object exists.
    expect(store.objects.size).toBe(0);
    expect(store.uploads.size).toBe(0);
  });

  it("refuses a container too short to split, which only the end of it knows", async () => {
    const response = await uploadAs("input", Buffer.alloc(MIN_CONTAINER_BYTES - 1, 0x01));

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("bad_container");
    expect(store.objects.size).toBe(0);
  });

  it("takes a sealed result, and reads nothing out of it", async () => {
    const bytes = Buffer.alloc(256, 0x5a);
    const created = (await uploadAs("result", bytes)).json();

    expect(created.purpose).toBe("result");
    expect(created.filename).toBe("result");
    expect(created.bytes).toBe(bytes.length);
    // No commitment: a result's bytes are the provider's, and nothing on this
    // node's side commits to them.
    const { rows } = await db.query<{ commitment: Buffer | null }>(
      "SELECT commitment FROM files WHERE file_id = $1",
      [created.id],
    );
    expect(rows[0]?.commitment).toBeNull();
  });

  it("refuses an empty upload under either payload purpose", async () => {
    for (const purpose of ["input", "result"]) {
      const response = await uploadAs(purpose, Buffer.alloc(0));
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("empty_file");
    }
  });

  it("does not count lines in a payload, so a container full of newlines is one file", async () => {
    const created = (await uploadAs("result", Buffer.alloc(MAX_BATCH_LINES + 1, 0x0a))).json();
    expect(created.vorq.lines).toBe(0);
  });

  // -------------------------------------------------------------------------
  // The lifecycle
  // -------------------------------------------------------------------------

  it("gives every upload the orphan expiry, in the answer and on the row", async () => {
    // An upload nobody attaches is deleted five minutes later. The client is
    // told when, because the field is what it plans its retry around.
    for (const response of [
      await uploadBatch(jsonl(2)),
      await uploadAs("input", container()),
      await uploadAs("result", Buffer.alloc(8, 1)),
    ]) {
      const created = response.json();
      expect(created.expires_at).toBe(created.created_at + FILE_ORPHAN_SECONDS);

      const { rows } = await db.query<{ created_at: bigint; expires_at: bigint }>(
        "SELECT created_at, expires_at FROM files WHERE file_id = $1",
        [created.id],
      );
      expect(rows[0]?.expires_at).toBe((rows[0]?.created_at as bigint) + BigInt(FILE_ORPHAN_SECONDS));
    }
  });

  it("finds an upload by cid for its owner, and never for a stranger", async () => {
    const bytes = container();
    const created = (await uploadAs("input", bytes)).json();

    const found = await findUpload(db, {
      cid: created.vorq.cid,
      owner: OWNER,
      purpose: "input",
    });
    expect(found?.cid).toBe(created.vorq.cid);
    expect(`0x${(found?.commitment as Buffer).toString("hex")}`).toBe(commitmentOf(bytes));

    // The cid is the whole reference, so the owner is what stops one client
    // posting a job over another's container.
    expect(await findUpload(db, { cid: created.vorq.cid, owner: STRANGER, purpose: "input" }))
      .toBeNull();
    // And the purpose is not interchangeable: an input is not a result.
    expect(await findUpload(db, { cid: created.vorq.cid, owner: OWNER, purpose: "result" }))
      .toBeNull();
  });

  it("attaching a file moves its expiry to the retention window, idempotently", async () => {
    const created = (await uploadAs("result", Buffer.alloc(16, 2))).json();
    const RETENTION = 2_592_000;

    const expiry = async (): Promise<bigint> =>
      (
        await db.query<{ expires_at: bigint }>("SELECT expires_at FROM files WHERE file_id = $1", [
          created.id,
        ])
      ).rows[0]?.expires_at as bigint;

    const attach = (owner: Buffer, retention: number): Promise<boolean> =>
      attachFile(db, { cid: created.vorq.cid, owner, purpose: "result" }, retention);

    expect(await attach(OWNER, RETENTION)).toBe(true);
    expect(await expiry()).toBe(BigInt(created.created_at + RETENTION));

    // Computed from `created_at`, never added to the current expiry: a retried
    // post attaches the same file again and must not extend it.
    expect(await attach(OWNER, RETENTION)).toBe(true);
    expect(await expiry()).toBe(BigInt(created.created_at + RETENTION));

    // By file id, which is how a batch attaches its input file.
    expect(await attachFile(db, { fileId: created.id }, RETENTION + 1)).toBe(true);
    expect(await expiry()).toBe(BigInt(created.created_at + RETENTION + 1));
  });

  it("reports false when the file is gone, which is the sweep's window closing", async () => {
    // `findUpload` and `attachFile` are two statements and the sweep's DELETE can
    // commit between them. The caller has to be able to tell, or it relays a job
    // naming an object this node has just deleted.
    const created = (await uploadAs("result", Buffer.alloc(16, 4))).json();
    await db.query("DELETE FROM files WHERE file_id = $1", [created.id]);

    expect(
      await attachFile(db, { cid: created.vorq.cid, owner: OWNER, purpose: "result" }, 2_592_000),
    ).toBe(false);
    expect(await attachFile(db, { fileId: created.id }, 2_592_000)).toBe(false);
  });

  it("does not attach a stranger's file", async () => {
    const created = (await uploadAs("result", Buffer.alloc(16, 3))).json();

    expect(
      await attachFile(db, { cid: created.vorq.cid, owner: STRANGER, purpose: "result" }, 2_592_000),
    ).toBe(false);

    const { rows } = await db.query<{ expires_at: bigint }>(
      "SELECT expires_at FROM files WHERE file_id = $1",
      [created.id],
    );
    expect(rows[0]?.expires_at).toBe(BigInt(created.created_at + FILE_ORPHAN_SECONDS));
  });

  it("does not attach a file under a purpose the caller did not check", async () => {
    // The cid form has to match the `findUpload` that authorised it row for row:
    // the post door checked an `input` upload, so an attach that would extend a
    // `result` row of the same owner over the same bytes is not the row it looked
    // at, and `true` would be a lie about which file now has retention.
    const created = (await uploadAs("result", Buffer.alloc(16, 5))).json();

    expect(
      await attachFile(
        db,
        { cid: created.vorq.cid, owner: OWNER, purpose: "input" },
        2_592_000,
      ),
    ).toBe(false);

    const { rows } = await db.query<{ expires_at: bigint }>(
      "SELECT expires_at FROM files WHERE file_id = $1",
      [created.id],
    );
    expect(rows[0]?.expires_at).toBe(BigInt(created.created_at + FILE_ORPHAN_SECONDS));
  });

  // -------------------------------------------------------------------------
  // Retrieve and download
  // -------------------------------------------------------------------------

  it("hands the bytes back exactly as they were uploaded", async () => {
    const content = jsonl(5);
    const id = (await uploadBatch(content)).json().id;

    const response = await app.inject({
      method: "GET",
      url: `/v1/files/${id}/content`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload.toString("utf8")).toBe(content);
  });

  it("serves content as bytes, never through the JSON boundary", async () => {
    // Every other response on this app goes through `toJsonText`. A JSONL body
    // that did would come back as a quoted JSON string, and the stock client
    // would parse each line out of an escaped blob.
    const id = (await uploadBatch(jsonl(2))).json().id;
    const response = await app.inject({
      method: "GET",
      url: `/v1/files/${id}/content`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.headers["content-type"]).toContain("application/jsonl");
    expect(response.rawPayload.toString("utf8").startsWith('{"custom_id"')).toBe(true);
  });

  it("serves a payload as octet-stream, because it is sealed bytes and not JSONL", async () => {
    const bytes = container();
    const id = (await uploadAs("input", bytes)).json().id;

    const response = await app.inject({
      method: "GET",
      url: `/v1/files/${id}/content`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.headers["content-type"]).toContain("application/octet-stream");
    expect(response.rawPayload).toEqual(bytes);
  });

  it("answers the FileObject on retrieve", async () => {
    const created = (await uploadBatch(jsonl(3))).json();
    const response = await app.inject({
      method: "GET",
      url: `/v1/files/${created.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: created.id, object: "file", purpose: "batch" });
  });

  it("does not serve one caller's file to another, and does not confirm it exists", async () => {
    // 404, not 403: a `403` tells a stranger the id is real, and file ids are the
    // only thing standing between one client's batch input and another's.
    const id = (await uploadBatch(jsonl(2))).json().id;
    for (const url of [`/v1/files/${id}`, `/v1/files/${id}/content`]) {
      const response = await app.inject({
        method: "GET",
        url,
        headers: { authorization: `Bearer ${strangerToken}` },
      });
      expect(response.statusCode).toBe(404);
    }
  });

  it("answers 404 for an id it never minted", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/files/file-000000000000000000000000",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(404);
  });

  it("refuses a download with no session", async () => {
    const id = (await uploadBatch(jsonl(1))).json().id;
    const response = await app.inject({ method: "GET", url: `/v1/files/${id}/content` });
    expect(response.statusCode).toBe(401);
  });
});
