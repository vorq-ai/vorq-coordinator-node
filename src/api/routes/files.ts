import { randomBytes } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { Type } from "typebox";
import { commitmentStream, ContainerError } from "../../container.js";
import type { Queryable } from "../../db/db.js";
import { pinnerFor } from "../../pin/pinner.js";
import { sessionGate, sessionOf, type App, type RouteDeps } from "../deps.js";
import { ApiError, badRequest } from "../errors.js";
import { throughPinner } from "../pin-failure.js";
import { discardFile, multipartScope, readFields, streamFile, type FormHead } from "../multipart.js";
import { BEARER, errors } from "../schemas/common.js";

/**
 * `/v1/files` — the upload door, and the answer to Q26.
 *
 * Q26 is the decision that took the whole batch surface out of Plan 4, and this
 * module is where it is discharged. The old door wrote the caller's JSONL to the
 * node's own disk and served it back from there: the client payload at rest that
 * container v1 exists to remove. Nothing about the *shape* was wrong — the
 * `FileObject` below is OpenAI's, field for field — what was wrong was where the
 * bytes lived.
 *
 * They live where every container already lives now. The pinner files them with
 * the object store and answers with the name it minted; what this node writes
 * down is that name, a length, a purpose and an owner. `files` holds no payload,
 * and the test that proves it reads every column of the row back and asserts none
 * of them contains the upload.
 *
 * ## Three purposes, and what each one buys
 *
 * `batch` is a JSONL input, counted and opaque. `input` and `result` are the door
 * a payload too large to inline takes: a client uploads its sealed container and
 * posts `container_cid`, a provider uploads its sealed result and settles with
 * `result_cid`, and neither pays for its bytes twice. An `input` is committed to
 * as it streams past — this is the one place the node sees the bytes — so the
 * post door compares the client's signed `c` against `files.commitment` instead
 * of reading the object back.
 *
 * ## What this door does *not* do
 *
 * It does not split a batch file, pin per-line containers, or look inside a line
 * at all: 50 000 lines is 50 000 pins against a rate-limited service, which is
 * minutes of work and belongs to the batch worker, behind `validating`. The only
 * thing read out of those bytes is the **line count**, because this is the one
 * place the node holds them and the create door has to refuse a batch past the
 * cap without reading the object back.
 *
 * ## Registered outside the readiness gate
 *
 * Nothing here reads the index — the store and this node's own two tables are the
 * whole dependency set — so these routes carry no `as_of_block` and are not 503'd
 * while the indexer catches up, exactly as `POST /v1/jobs` is not (R28).
 */

/**
 * The largest upload this door accepts, in bytes — **200 MB, OpenAI's own batch
 * ceiling**, and the default for {@link Config.maxBlobBytes}.
 *
 * Both halves of the deviation that held this at 32 MiB are gone.
 *
 * *Storage*, first: the ceiling used to be `MAX_OBJECT_BYTES`, the largest object
 * the pinner could put or read back, and accepting a file this node could never
 * `fetch` again would be a promise broken at download time rather than at upload
 * time. `S3Pinner` now puts past `PART_BYTES` as a multipart upload and reads
 * back in ranged windows, and `fetch` takes the caller's own ceiling.
 *
 * *This door's memory*, second, which was the real bound and was measured rather
 * than guessed: buffering the body and parsing it with `Response.formData()` cost
 * ~680 MB of RSS for a 100 MB upload — the body, the parser's copy of the file
 * part, and the `Buffer` taken from it, ~4x the file. So the body is not buffered
 * any more. `@fastify/multipart` streams the file part, and each chunk goes
 * straight into a {@link PinUpload}: what this process holds is one part, whatever
 * the file weighs.
 *
 * It is MiB rather than MB, so no file OpenAI accepts is refused here. The cap
 * that binds first is now {@link MAX_BATCH_LINES} for any line under ~4 KB, which
 * is the right way round — the line cap is the one with a reason behind it.
 */
export const MAX_BLOB_BYTES = 200 * 1024 * 1024;

/** Lines one batch may carry. OpenAI's parity number. */
export const MAX_BATCH_LINES = 50_000;

/**
 * How long an upload nobody has attached to a job or a batch lives, in seconds.
 *
 * A client uploads immediately before it posts, so five minutes covers the round
 * trip and a retry of it. Past that the upload is storage this node owes nobody:
 * the sweep deletes the row and the object. Attaching one moves its expiry to
 * `config.fileRetentionSeconds` (see {@link attachFile}).
 */
export const FILE_ORPHAN_SECONDS = 300;

/**
 * The purposes a caller may upload under.
 *
 * `batch_output` is **minted by the worker** at finalization and is refused
 * here: accepting one would let a caller hand this node a result file it never
 * produced, under an id every other reader treats as authoritative. It is the
 * purpose of both frozen files — `openai`'s own `FileObject.purpose` Literal has
 * no `batch_error`, and the two are told apart by which field of the batch names
 * them, exactly as OpenAI tells them apart.
 */
const UPLOADABLE_PURPOSES = new Set(["batch", "input", "result"]);

/** What a file part with no filename of its own is called, per purpose. */
const DEFAULT_FILENAME: Record<string, string> = {
  batch: "upload.jsonl",
  input: "container",
  result: "result",
};

/** OpenAI's `FileObject`, plus `vorq` for what only this network has. */
interface FileObject {
  id: string;
  object: "file";
  bytes: number;
  created_at: number;
  /**
   * When the sweep deletes this file and the object behind it, in unix seconds.
   * `created_at + FILE_ORPHAN_SECONDS` until something attaches it.
   */
  expires_at: number;
  filename: string;
  purpose: string;
  /** Deprecated on OpenAI's side, still emitted, and still what their SDK types. */
  status: "uploaded" | "processed" | "error";
  /**
   * Additive. `cid` is the store's own name for the object, so a client can read
   * its file back from the storage network with no coordinator in the path;
   * `lines` is the count this door made while it had the bytes.
   */
  vorq: { cid: string; lines: number };
}

interface FileRow {
  file_id: string;
  bytes: bigint;
  created_at: bigint;
  expires_at: bigint;
  filename: string;
  purpose: string;
  status: string;
  cid: string;
  lines: bigint;
}

/** Every column `fileObject` reads, in one place: the door and `ownedFile` agree. */
const FILE_COLUMNS = "file_id, bytes, created_at, expires_at, filename, purpose, status, cid, lines";

const fileObject = (row: FileRow): FileObject => ({
  id: row.file_id,
  object: "file",
  // BIGINT columns arrive as `bigint`, which `JSON.stringify` refuses (R46).
  bytes: Number(row.bytes),
  created_at: Number(row.created_at),
  expires_at: Number(row.expires_at),
  filename: row.filename,
  purpose: row.purpose,
  status: row.status as FileObject["status"],
  vorq: { cid: row.cid, lines: Number(row.lines) },
});

/**
 * Counts non-blank lines across chunks that arrive one at a time.
 *
 * Scanned byte by byte rather than over `chunk.toString().split("\n")`, which
 * would allocate a copy of the upload and 50 000 strings to count them — and
 * incremental rather than over a whole `Buffer`, because with the body streamed
 * there is no whole buffer to scan. A trailing newline does not add a line, and
 * a file of nothing but whitespace counts zero, which is what makes `empty_file`
 * catch the upload that would otherwise become a batch with nothing in it.
 *
 * The one thing a chunk boundary could break, it does not: the state that
 * crosses it is a single "is the line so far blank" flag, so a `\n` in one chunk
 * and the next line's first byte in another count exactly as they would whole.
 */
export function lineCounter(): { take(chunk: Buffer): void; total(): number } {
  let lines = 0;
  let blank = true;
  return {
    take(chunk: Buffer): void {
      for (let index = 0; index < chunk.length; index += 1) {
        const byte = chunk[index];
        if (byte === 0x0a) {
          if (!blank) lines += 1;
          blank = true;
        } else if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0d) {
          blank = false;
        }
      }
    },
    total: (): number => (blank ? lines : lines + 1),
  };
}

/** `file-` and 12 random bytes. Nothing is derived from it and nothing parses it. */
const mintFileId = (): string => `file-${randomBytes(12).toString("hex")}`;

const FileObjectSchema = Type.Object({
  id: Type.String(),
  object: Type.Literal("file"),
  bytes: Type.Integer(),
  created_at: Type.Integer(),
  expires_at: Type.Integer({ description: "Unix seconds; 300 s until a job or batch names it." }),
  filename: Type.String(),
  purpose: Type.String(),
  status: Type.Enum(["uploaded", "processed", "error"]),
  vorq: Type.Object({
    cid: Type.String({ description: "The storage name; what `container_cid` and `result_cid` take." }),
    lines: Type.Integer({ description: "Non-blank lines, for a batch file." }),
  }),
});

/**
 * The upload form, for the spec only. The door streams the body through
 * `readFields` rather than letting Fastify parse it, so there is no body for a
 * validator to see; the swagger transform below puts this where a reader looks.
 */
const UploadForm = Type.Object({
  purpose: Type.Enum([...UPLOADABLE_PURPOSES], {
    description: "`batch` (a JSONL batch input), `input` (a sealed container) or `result`.",
  }),
  file: Type.String({ format: "binary", description: "The bytes, as the last part." }),
});

const FileId = Type.Object({ file_id: Type.String() });

export function fileRoutes(app: App, deps: RouteDeps): void {
  const pinner = pinnerFor(deps.config, deps.db);
  const gate = sessionGate(deps.db);

  multipartScope(app, deps.config.maxBlobBytes, (scope) => {
    scope.post(
      "/v1/files",
      {
        onRequest: gate,
        schema: {
          tags: ["files"],
          summary: "Upload a file",
          description:
            "multipart/form-data, fields first and the file last. The bytes are streamed to " +
            "storage, never held; an `input` upload is committed to as it streams, so a job can " +
            "name it by cid.",
          security: BEARER,
          response: { 200: FileObjectSchema, ...errors(400, 401, 413, 503) },
        },
        config: {
          swaggerTransform: ({ schema, url }) => ({
            schema: { ...schema, consumes: ["multipart/form-data"], body: UploadForm },
            url,
          }),
        },
      },
      async (request, reply) => {
      const session = sessionOf(request);

      // Fields first, file last — the rule every byte-carrying door reads by
      // (`api/multipart.ts`). `purpose` is decided before the first byte of the
      // file is read, so a refused upload costs the store nothing.
      let head: FormHead;
      try {
        head = await readFields(request);
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw badRequest("body is not a well-formed multipart/form-data upload", "file");
      }
      const { fields, file } = head;
      const refuse = async (error: ApiError): Promise<never> => {
        await discardFile(file);
        throw error;
      };

      const purpose = fields.purpose;
      if (purpose === undefined || purpose === "") {
        await refuse(badRequest("purpose is required", "purpose"));
      }
      if (!UPLOADABLE_PURPOSES.has(purpose as string)) {
        await refuse(
          new ApiError(
            400,
            "invalid_request",
            `purpose must be one of ${[...UPLOADABLE_PURPOSES].join(", ")}; ` +
              "batch_output is minted by this node at finalization and cannot be uploaded",
            "purpose",
            "invalid_purpose",
          ),
        );
      }
      if (file === null) {
        throw badRequest("file is required and must be an uploaded file part", "file");
      }

      // Read once, as the bytes go past, because this is the one place the node
      // holds them. A batch's lines are counted because the create door refuses a
      // batch past the cap and would otherwise have to read the whole object
      // back; a container is committed to because the post door compares the
      // client's signed `c` against what this computed.
      const counted = purpose === "batch" ? lineCounter() : null;
      const committed = purpose === "input" ? commitmentStream() : null;
      const sink = pinner.open();

      // A container that is not v1 is known on its first chunk, and the fault is
      // **remembered rather than thrown**. Throwing out of the iterator destroys
      // the file stream, and busboy then stops parsing
      // (`@fastify/multipart/index.js:425`) while the client is still sending a
      // body nobody is reading — which the client sees as a reset rather than as
      // this door's `400`. So the upload is read to its end, exactly as a refusal
      // decided before the stream reads it to its end (`discardFile`), and the
      // parts already on the store are abandoned below.
      const seen: { fault: ContainerError | null } = { fault: null };
      const bytes = await streamFile(request, file, sink, (chunk) => {
        counted?.take(chunk);
        if (committed === null || seen.fault !== null) return;
        try {
          committed.update(chunk);
        } catch (error) {
          if (!(error instanceof ContainerError)) throw error;
          seen.fault = error;
        }
      });

      // The refusals only the whole file can decide. The upload holds parts the
      // store has not been told to keep, and either `throw` drops them.
      const abortWith = async (error: ApiError): Promise<never> => {
        await sink.abort();
        throw error;
      };

      if (seen.fault !== null) await abortWith(badContainer(seen.fault));

      // A batch of nothing but blank lines carries no requests; a payload of no
      // bytes is not a payload. Both are the same refusal to a caller.
      const lines = counted === null ? 0 : counted.total();
      if (counted === null ? bytes === 0 : lines === 0) {
        await abortWith(
          new ApiError(
            400,
            "invalid_request",
            counted === null
              ? "the uploaded file is empty"
              : "the uploaded file contains no requests",
            "file",
            "empty_file",
          ),
        );
      }
      if (lines > MAX_BATCH_LINES) {
        await abortWith(
          new ApiError(
            400,
            "invalid_request",
            `the uploaded file contains ${lines} lines, past the ${MAX_BATCH_LINES}-line ceiling`,
            "file",
            "too_many_lines",
          ),
        );
      }

      // `c` over the whole container. It refuses one too short to split, which is
      // the second thing only the end of the stream knows.
      let commitment: Buffer | null = null;
      if (committed !== null) {
        try {
          commitment = Buffer.from(committed.digest().slice(2), "hex");
        } catch (error) {
          if (error instanceof ContainerError) await abortWith(badContainer(error));
          throw error;
        }
      }

      // The pin is the storage. It happens **before** the row is written, so a
      // `files` row never names an object that was not filed — the reverse
      // leaves a pin no row names, which the sweep removes once it is past
      // retention.
      const cid = await throughPinner(request, async () => {
        try {
          return await sink.finish();
        } catch (error) {
          await sink.abort();
          throw error;
        }
      });

      const fileId = mintFileId();
      const filename =
        file.filename === undefined || file.filename === ""
          ? (DEFAULT_FILENAME[purpose as string] as string)
          : file.filename;
      // `now()` is the transaction's timestamp, so `created_at` and `expires_at`
      // are taken from one instant and the offset between them is exactly
      // `FILE_ORPHAN_SECONDS`.
      const { rows } = await deps.db.query<FileRow>(
        `INSERT INTO files (file_id, owner, purpose, filename, bytes, cid, status, lines,
                            commitment, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'uploaded', $7, $8,
                 floor(extract(epoch from now()))::bigint,
                 floor(extract(epoch from now()))::bigint + $9)
         RETURNING ${FILE_COLUMNS}`,
        [
          fileId,
          session.address,
          purpose,
          filename,
          bytes,
          cid,
          lines,
          commitment,
          FILE_ORPHAN_SECONDS,
        ],
      );
      return reply.code(200).send(fileObject(rows[0] as FileRow));
      },
    );
  });

  /**
   * One row, scoped to its owner.
   *
   * A miss and a stranger's file are the **same answer**, deliberately. A `403`
   * on someone else's id confirms the id is real, and a file id is the only thing
   * standing between one client's batch input and another's.
   */
  const ownedFile = async (request: FastifyRequest, fileId: string): Promise<FileRow> => {
    const session = sessionOf(request);
    const { rows } = await deps.db.query<FileRow>(
      `SELECT ${FILE_COLUMNS} FROM files WHERE file_id = $1 AND owner = $2`,
      [fileId, session.address],
    );
    const row = rows[0];
    if (row === undefined) throw new ApiError(404, "not_found", `No such file: ${fileId}`);
    return row;
  };

  app.get(
    "/v1/files/:file_id",
    {
      onRequest: gate,
      schema: {
        tags: ["files"],
        summary: "Read a file's metadata",
        security: BEARER,
        params: FileId,
        response: { 200: FileObjectSchema, ...errors(401, 404) },
      },
    },
    async (request) => fileObject(await ownedFile(request, request.params.file_id)),
  );

  app.get(
    "/v1/files/:file_id/content",
    {
      onRequest: gate,
      schema: {
        tags: ["files"],
        summary: "Download a file's bytes",
        description: "`application/jsonl` for a batch file, `application/octet-stream` otherwise.",
        security: BEARER,
        params: FileId,
        response: {
          200: Type.String({ format: "binary", description: "The bytes." }),
          ...errors(401, 404, 503),
        },
      },
    },
    async (request, reply) => {
    const row = await ownedFile(request, request.params.file_id);
    // Read under the **file** ceiling, not the container one. These objects are
    // this node's own — an upload it admitted at `maxBlobBytes`, or a JSONL it
    // froze itself — so the size is one it already allowed, and the default
    // ceiling would refuse to serve back a file it had accepted.
    //
    // Buffered, unlike the upload: the whole object is one allocation here, and
    // at the 200 MB ceiling that is 200 MB per concurrent download. It is a
    // known 1x cost and not the 4x the upload had, and the reader who pays it is
    // the file's own owner rather than anyone who can reach the door.
    const content = await throughPinner(request, () =>
      pinner.fetch(row.cid, { maxBytes: deps.config.maxBlobBytes }),
    );
    if (content === null) {
      // The row names an object the store no longer has. Not a 404 on the file —
      // the file exists and this node minted its name — and not a caller error:
      // an operator emptied a bucket or a lifecycle rule reaped it.
      throw new ApiError(
        503,
        "pinner_unavailable",
        `the object store no longer holds the object behind ${row.file_id}`,
        null,
        "object_missing",
      );
    }
    // A Buffer, so Fastify treats it as pre-serialized and the JSON boundary
    // (`toJsonText`, set app-wide) never sees it — a JSONL body that went through
    // it would arrive as one escaped JSON string.
    const type = row.purpose === "batch" ? "application/jsonl" : "application/octet-stream";
    return reply.type(type).send(content);
    },
  );
}

/** A buffer that is not a container v1. The fault says which way. */
const badContainer = (error: ContainerError): ApiError =>
  new ApiError(400, "invalid_request", error.message, "file", "bad_container");

/**
 * An upload a caller is about to reference by cid, with the commitment this door
 * computed for it, or `null` if that owner has no such upload.
 *
 * Scoped to the owner, because the cid is the whole reference: without it one
 * client could post a job over another's container, or a provider could settle
 * with a result somebody else uploaded.
 */
export async function findUpload(
  db: Queryable,
  args: { cid: string; owner: Buffer; purpose: "input" | "result" },
): Promise<{ cid: string; commitment: Buffer | null } | null> {
  const { rows } = await db.query<{ cid: string; commitment: Buffer | null }>(
    "SELECT cid, commitment FROM files WHERE cid = $1 AND owner = $2 AND purpose = $3 LIMIT 1",
    [args.cid, args.owner, args.purpose],
  );
  return rows[0] ?? null;
}

/**
 * Give a file the retention of something a job or a batch names. Answers whether
 * a row was actually updated.
 *
 * **`false` means the file is gone**, and a caller must refuse rather than carry
 * on: `findUpload` and this are two statements, and the sweep's `DELETE` can
 * commit between them — a 300 s window closing on an upload the caller is in the
 * middle of referencing. There is no `FOR UPDATE` to take (the two calls are not
 * one transaction), and none is needed: under READ COMMITTED this `UPDATE` and
 * that `DELETE` serialize on the row, so whichever commits first wins and the
 * loser sees it. A door that ignored the answer would relay a job naming an
 * object this node had just deleted.
 *
 * **It is not an ownership check.** The `cid` form is scoped to an owner and a
 * purpose and the `fileId` form is not; both are for a caller that has already
 * established the file is its own (`findUpload`, or a `batches.input_file_id` it
 * wrote itself). The `cid` form carries the purpose so that it matches the
 * `findUpload` that authorised it row for row: without it `true` could mean some
 * other row of the same owner over the same bytes.
 *
 * Idempotent, because the new expiry is computed from `created_at` rather than
 * added to the current one: attaching the same file twice — a retried post, a
 * batch created from an input file a second time — leaves the same instant.
 */
export async function attachFile(
  db: Queryable,
  where: { cid: string; owner: Buffer; purpose: "input" | "result" } | { fileId: string },
  retentionSeconds: number,
): Promise<boolean> {
  const { rowCount } =
    "fileId" in where
      ? await db.query("UPDATE files SET expires_at = created_at + $2 WHERE file_id = $1", [
          where.fileId,
          retentionSeconds,
        ])
      : await db.query(
          "UPDATE files SET expires_at = created_at + $4 WHERE cid = $1 AND owner = $2 AND purpose = $3",
          [where.cid, where.owner, where.purpose, retentionSeconds],
        );
  return (rowCount ?? 0) > 0;
}
