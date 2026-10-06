import { createHash, createHmac, randomBytes } from "node:crypto";
import type { Config, S3PinConfig } from "../config.js";
import type { Db } from "../db/db.js";
import { contentHashOfCid } from "./cid.js";

/**
 * Who names bytes, and where they live.
 *
 * A CID is an opaque locator **minted by the service that files the bytes**, and
 * there is exactly one backend: object storage, configured through
 * `PIN_S3_*`. This node puts the object, reads the name the store answers
 * with, and records it verbatim — it computes no name of its own, and no caller
 * ever parses the string it gets back.
 *
 * **The credentials are always the node operator's**, whoever that is, and a
 * client never holds them. Which backend runs is not a question this node asks —
 * there is one — and whether it is configured at all is settled at boot by
 * `loadConfig`, which refuses to start without it.
 *
 * **Pinning is on the request path**, and that is the change this file exists
 * around. `POST /v1/jobs` takes the container bytes with the signed order and
 * `POST /evm/ops` takes the result bytes with the settle op; each door verifies
 * what it can, files here, and puts the name on chain in the same call. Nothing
 * pins on a caller's behalf without an order or an op behind it.
 *
 * **There is one write path, {@link open}, and every object takes it** — a
 * container, a result, a batch line, a frozen batch output, a `/v1/files`
 * upload. It is a streaming multipart put under a random key, so
 * nothing about an object's size decides how it is filed and this process never
 * holds more than one part of it. {@link put} is the same path for a caller that
 * already has the bytes whole.
 *
 * `pins` — the `cid → key` book {@link S3Pinner} writes when an object is
 * completed — is one of the tables that do not come back from a rebuild (R44,
 * R47): it is the only record of where a store-minted name's object lives, and
 * no chain log carries it, so it sits in `PRESERVED` (src/db/db.ts) with
 * `quotes_live` rather than in the drop set.
 */
export interface Pinner {
  /** File one object, a piece at a time. See {@link PinUpload}. */
  open(): PinUpload;
  /**
   * The bytes filed under `cid`, or `null` if this node has no record of it.
   *
   * **Reachable from no route**, and kept deliberately. Reads need no coordinator
   * — a CID is the whole locator at the storage network's own gateway — so there
   * is no door here that serves bytes. What this is for is R73: `fetch(mint(b))
   * === b` is the only way to know that a put this node reported as a pin
   * actually stored the caller's bytes under the name it handed back, and a
   * backend that could not be asked could not be tested against a real store.
   *
   * `options.maxBytes` is how big the caller will let the answer be, defaulting
   * to {@link MAX_OBJECT_BYTES}. Per-call, because a container and a 200 MB batch
   * input file are read through the same method and only one of them is a size an
   * attacker picks.
   */
  fetch(cid: string, options?: FetchOptions): Promise<Buffer | null>;
  /**
   * Delete the object `cid` names and forget where it lived.
   *
   * The file sweep (`src/pin/sweep.ts`) is the only caller: nothing on a request
   * path removes an object, because a name this node put on chain is a name a
   * provider or a client may still resolve. A `cid` this node never filed is a
   * no-op — there is no key to delete under.
   */
  remove(cid: string): Promise<void>;
}

/** File bytes a caller holds whole, through the one write path, and return the CID. */
export async function put(pinner: Pinner, bytes: Buffer): Promise<string> {
  const upload = pinner.open();
  try {
    await upload.write(bytes);
    return await upload.finish();
  } catch (error) {
    await upload.abort();
    throw error;
  }
}

// ---------------------------------------------------------------------------
// SigV4
// ---------------------------------------------------------------------------

/** One request to sign. Header names are lowercase; `host` is required. */
export interface SigV4Input {
  method: string;
  /** The already-encoded request path, e.g. `/bucket/deadbeef…`. */
  path: string;
  /** The canonical query string, or `""`. */
  query: string;
  /** Exactly the headers to sign — nothing outside this map is signed. */
  headers: Record<string, string>;
  /** sha256 of the body, hex. */
  payloadHash: string;
  accessKey: string;
  secret: string;
  region: string;
  service: string;
  /** `YYYYMMDDTHHMMSSZ`. */
  amzDate: string;
}

const sha256Hex = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

const hmac = (key: Buffer, value: string): Buffer =>
  createHmac("sha256", key).update(value).digest();

/**
 * The `Authorization` header for one SigV4-signed request.
 *
 * Hand-written rather than pulled from an SDK, and therefore pinned in the tests
 * to **AWS's own published test-suite vectors** (`get-vanilla` and
 * `post-x-www-form-urlencoded`) rather than to itself. The alternative was a
 * signing SDK, which is discussed in the task report; what it buys here is that
 * the body is put on the wire exactly as the caller sent it, with no chunked
 * framing or trailing checksum — and the service names what it receives, so any
 * reframing would mint the CID of something other than the caller's bytes.
 *
 * The narrow subset this node needs: no session token, no multi-value headers,
 * and paths that are already URI-safe (a bucket name and a hex digest).
 */
export function sigv4Authorization(input: SigV4Input): string {
  const { accessKey, secret, region, service, amzDate, payloadHash } = input;
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${region}/${service}/aws4_request`;

  const names = Object.keys(input.headers)
    .map((name) => name.toLowerCase())
    .sort();
  const canonicalHeaders = names
    .map((name) => `${name}:${(input.headers[name] ?? "").trim()}\n`)
    .join("");
  const signedHeaders = names.join(";");

  const canonicalRequest = [
    input.method,
    input.path,
    input.query,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = hmac(
    hmac(hmac(hmac(Buffer.from(`AWS4${secret}`, "utf8"), date), region), service),
    "aws4_request",
  );
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");

  return (
    `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`
  );
}

// ---------------------------------------------------------------------------
// The object-storage pinner
// ---------------------------------------------------------------------------

/**
 * Where the pinning service returns the minted name: the `<CID>` element of the
 * completion document, or this response header. Filebase answers a completed
 * multipart upload with the element and a plain put with the header; both are
 * read, the element first.
 */
const CID_HEADER = "x-amz-meta-cid";

/**
 * The store's own `<Code>` for a refusal it did not phrase as one: a `2xx` put
 * that came back with no minted name. Synthetic, like `"redirect"`, because the
 * store sent no code of its own — and in `OPERATOR_MUST_ACT` for the same reason
 * `NoSuchBucket` is.
 */
export const NO_CID_MINTED = "no-cid-minted";

/**
 * The longest name this node will put on chain, in characters.
 *
 * A CIDv1/raw/sha2-256 name is exactly 59. `order.taskCid` and `resultCid` are
 * `bytes` on chain and the contracts bound only their emptiness, so an unbounded
 * name is unbounded calldata and unbounded storage — **all of it fronted by the
 * relayer**, for a value the chain never asked to be small.
 *
 * This used to be a bound on a request field, when the caller supplied the CID.
 * The caller does not any more, so it moved to the only place it can still be
 * enforced: the name the store hands back. A store that mints one is answering,
 * not failing, which is why the refusal is a {@link StoreRejected} in
 * `OPERATOR_MUST_ACT` rather than an outage.
 */
export const MAX_CID_CHARS = 64;

/** The store minted a name too long to put on chain. See {@link MAX_CID_CHARS}. */
export const OVERSIZED_CID = "oversized-cid";

/**
 * The largest object this node will read back, in bytes.
 *
 * The read path's own ceiling, and the only one on it: an object's size is
 * chosen by the store, not declared by a caller, so nothing upstream bounds it.
 * The write path is bounded at its doors instead, by the multipart `fileSize`
 * limit every streamed body is read under (`MAX_BLOB_BYTES`).
 */
export const MAX_OBJECT_BYTES = 32 * 1024 * 1024;

/** The store answered with an object past the ceiling its caller allowed. */
export const OVERSIZED_OBJECT = "oversized-object";

/**
 * The seam: an object is uploaded in parts of this size, and reads come back in
 * chunks of it.
 *
 * 8 MiB, which is above S3's 5 MiB floor for every part but the last and well
 * under the per-request size any S3-compatible gateway takes. It is the same
 * number in both directions on purpose — it is the one figure that bounds how
 * much of an object this process holds *per request*, and two constants would
 * invite them to drift apart.
 *
 * The number that matters is not this one but its product with concurrency: the
 * batch worker pins at {@link PIN_CONCURRENCY}, so the write path's ceiling is
 * that many parts in flight, not one file.
 */
export const PART_BYTES = 8 * 1024 * 1024;

/** How many times one store request is sent before a dropped socket is a failure. */
export const SEND_ATTEMPTS = 3;

/** The pause before a re-send, multiplied by the attempt number. */
export const SEND_RETRY_MS = 100;

/**
 * Whether `fetch` failed because the connection went away with no answer —
 * the one failure a re-send can fix. Anything with a status is an answer, and
 * anything else (a refused connection, a bad hostname, a TLS failure) is the
 * same on the next attempt.
 */
function socketDropped(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false;
  const code = (error.cause as { code?: string } | undefined)?.code ?? "";
  return code === "UND_ERR_SOCKET" || code === "ECONNRESET" || code === "EPIPE";
}

/** Reads come back in windows of this size. See {@link PART_BYTES}. */
export const READ_CHUNK_BYTES = PART_BYTES;

/** The most of a store's *error* document this node reads to find its `<Code>`. */
const MAX_ERROR_BODY_BYTES = 64 * 1024;

/** `YYYYMMDDTHHMMSSZ` from an ISO timestamp. */
const amzDateNow = (): string => new Date().toISOString().replace(/[-:]|\.\d{3}/g, "");

/**
 * A real S3-compatible pinning service: **the put is the pin**, and the service
 * answers it with the name it minted in the `x-amz-meta-cid` response header.
 *
 * Path-style addressing, so the bucket stays out of the hostname on a
 * third-party endpoint.
 *
 * **The round trip closes on this backend too (R73): `fetch(mint(b))` is `b`.**
 * The store names the bytes and may name them anything — that is what
 * `x-amz-meta-cid` is for — so the object key is not in general recoverable from
 * the name, and a `fetch` that only re-derived it through
 * {@link contentHashOfCid} would 404 the very CID this node had just issued.
 * `recordMint` therefore writes the `cid → key` pair to `pins` and `fetch` reads it,
 * falling back to re-derivation for a name **this node did not mint** — a
 * provider holding a `task_cid` from a job another coordinator pinned, which is a
 * spec CID and carries its own key.
 */
export class S3Pinner implements Pinner {
  /** {@link S3PinConfig.partBytes}, resolved once. */
  private readonly partBytes: number;

  constructor(
    private readonly config: S3PinConfig,
    private readonly db: Db,
  ) {
    this.partBytes = config.partBytes ?? PART_BYTES;
  }

  /**
   * The one write path: a streaming multipart put under a random key.
   *
   * Written as a closure over `this` rather than as a class, because everything
   * it needs — `send`, `partBytes`, `recordMint` — is this pinner's own private
   * surface, and a sibling class would have to open that surface to the module
   * for no other reason.
   *
   * **The key is random, and the name is the store's.** S3 wants the key in the
   * request that *opens* a multipart upload, before this process has seen the
   * bytes it would hash — so a streamed object cannot be content-addressed, and
   * pretending otherwise would mean buffering the very thing this exists not to
   * buffer. The CID the store mints on completion is still a fact about the
   * bytes, and `pins` is keyed on it: two puts of the same bytes land under two
   * keys and one name, and {@link recordMint} keeps the first key and deletes the
   * second object. Idempotence lives in the name book, not in the key.
   *
   * Parts leave as they fill, so a part is on the wire before the caller has
   * finished writing. The upload is not opened until there is something to send:
   * a caller that aborts before its first part costs no request at all.
   */
  open(): PinUpload {
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    const key = `stream-${randomBytes(24).toString("hex")}`;
    let uploadId: string | null = null;
    const etags: string[] = [];

    const take = (): Buffer => {
      const all = Buffer.concat(pending, pendingBytes);
      pending = [];
      pendingBytes = 0;
      return all;
    };

    const openUpload = async (): Promise<void> => {
      const opened = await this.send("POST", key, Buffer.alloc(0), { query: { uploads: "" } });
      if (!opened.ok) throw await storeRefused(opened, "PUT", key);
      uploadId = tagOf(await opened.text(), "UploadId");
      if (uploadId === null) {
        throw new StoreRejected(
          opened.status,
          NO_CID_MINTED,
          `pinning service answered the multipart open for ${key} without an UploadId`,
        );
      }
    };

    const flush = async (bytes: Buffer): Promise<void> => {
      const response = await this.send("PUT", key, bytes, {
        query: { partNumber: String(etags.length + 1), uploadId: uploadId as string },
      });
      if (!response.ok) throw await storeRefused(response, "PUT", key);
      // Unquoted: S3 answers a quoted ETag and refuses a completion document
      // that carries the quotes through.
      etags.push((response.headers.get("etag") ?? "").replace(/"/g, ""));
    };

    /** Best effort, and it never replaces the failure that got here. */
    const abandon = async (): Promise<void> => {
      pending = [];
      pendingBytes = 0;
      if (uploadId === null) return;
      const opened = uploadId;
      uploadId = null;
      await this.send("DELETE", key, undefined, { query: { uploadId: opened } }).catch(
        () => undefined,
      );
    };

    /** Anything that throws mid-upload abandons it: see {@link PinUpload}. */
    const guarded = async <T>(step: () => Promise<T>): Promise<T> => {
      try {
        return await step();
      } catch (error) {
        await abandon();
        throw error;
      }
    };

    return {
      write: async (chunk: Buffer): Promise<void> =>
        guarded(async () => {
          pending.push(chunk);
          pendingBytes += chunk.length;
          // Strictly greater, so the last part is never the empty remainder of
          // a flush that took everything.
          if (pendingBytes <= this.partBytes) return;
          if (uploadId === null) await openUpload();
          let rest = take();
          while (rest.length > this.partBytes) {
            await flush(rest.subarray(0, this.partBytes));
            rest = rest.subarray(this.partBytes);
          }
          pending = [rest];
          pendingBytes = rest.length;
        }),

      finish: async (): Promise<string> =>
        guarded(async () => {
          if (uploadId === null) await openUpload();
          // Whatever is left is the last part, and it may be the only one. S3
          // puts no floor on the last part's size, and the store this node
          // files with completes a one-part upload of a few KiB.
          await flush(take());
          const document =
            "<CompleteMultipartUpload>" +
            etags
              .map(
                (etag, index) =>
                  `<Part><PartNumber>${index + 1}</PartNumber><ETag>${etag}</ETag></Part>`,
              )
              .join("") +
            "</CompleteMultipartUpload>";
          const completed = await this.send("POST", key, Buffer.from(document, "utf8"), {
            query: { uploadId: uploadId as string },
          });
          if (!completed.ok) {
            const refused = await storeRefused(completed, "PUT", key);
            if (refused.storeCode === "NoSuchUpload") {
              // The upload is gone from the store's side: either an earlier
              // attempt at this completion went through and its answer was
              // lost on the way back (see `send`), or the store expired it. A
              // HEAD tells the two apart. An object under this key is that
              // earlier completion, and the store's HEAD carries the name it
              // minted, so it is recorded like any other completion — a lost
              // answer is not a lost pin. Anything else is dropped best effort
              // and the pin fails. Nothing to abandon: there is no upload left.
              uploadId = null;
              const head = await this.send("HEAD", key);
              if (head.ok) return this.recordMint(head, key);
              await this.send("DELETE", key).catch(() => undefined);
            }
            throw refused;
          }
          uploadId = null;
          return this.recordMint(completed, key);
        }),

      abort: abandon,
    };
  }

  /**
   * The name the store minted for a completed put, checked and written down.
   *
   * The name is read from the completion document's `<CID>` first and from the
   * response header second — the store answers a completed multipart upload
   * with the element — and a name is refused for the same reasons whichever
   * carried it.
   */
  private async recordMint(response: Response, key: string): Promise<string> {
    if (!response.ok) throw await storeRefused(response, "PUT", key);

    const document = await response.text().catch(() => "");
    const cid = tagOf(document, "CID") ?? response.headers.get(CID_HEADER);
    if (cid === null || cid === "") {
      // A `StoreRejected`, not a bare `Error`, and under a code the door treats
      // as an operator's problem: **the store answered — it just answered
      // wrongly.** A bucket or gateway that is not configured to mint names will
      // answer every put this way, forever, so reporting it as
      // `store_unavailable` at `error` (which a bare `Error` does) tells an
      // operator to wait for a dependency that is up and working exactly as
      // configured. It is the same permanent misconfiguration as a wrong key or
      // an absent bucket, and it belongs in the same place: `store_rejected`, at
      // `fatal`. The object is dropped: a name this node cannot record is a
      // name it cannot serve.
      await this.send("DELETE", key).catch(() => undefined);
      throw new StoreRejected(
        response.status,
        NO_CID_MINTED,
        `pinning service completed ${key} with neither a <CID> element nor an ${CID_HEADER} header; no CID was minted`,
      );
    }
    if (cid.length > MAX_CID_CHARS) {
      // The store answered, and answered with something this node cannot put on
      // chain: `taskCid` and `resultCid` are unbounded `bytes` and the relayer
      // pays for every one of them. Refused here rather than at the door, because
      // the door has nothing to check — the name is not the caller's.
      await this.send("DELETE", key).catch(() => undefined);
      throw new StoreRejected(
        response.status,
        OVERSIZED_CID,
        `pinning service minted a ${cid.length}-character name for ${key}, past this node's ` +
          `${MAX_CID_CHARS}-character ceiling; it was not recorded and nothing was relayed`,
      );
    }

    // Written **before** the CID is handed back, and a failure here fails the pin:
    // a `201 {cid}` for a name this node cannot resolve is a promise it has
    // already broken. `DO NOTHING ... RETURNING` answers no row when the name is
    // already in the book — the same bytes were filed before, under another
    // key — and then the object just completed is the duplicate: it is deleted
    // (best effort; a survivor is billed storage no row names) and the name is
    // handed back exactly as the first put handed it back. That is what makes a
    // retried post or settle land on one object and one row.
    let rows: { s3_key: string }[];
    try {
      ({ rows } = await this.db.query<{ s3_key: string }>(
        "INSERT INTO pins (cid, s3_key) VALUES ($1, $2) ON CONFLICT (cid) DO NOTHING RETURNING s3_key",
        [cid, key],
      ));
    } catch (error) {
      // The key is random, so an object no row names is one nothing can ever
      // reach again — not even a retry of the same bytes, which lands on a new
      // key. Dropped rather than left as storage no listing shows.
      await this.send("DELETE", key).catch(() => undefined);
      throw error;
    }
    if (rows.length === 0) await this.send("DELETE", key).catch(() => undefined);
    return cid;
  }

  /**
   * The object a name resolves to, or `null` if the store does not hold it.
   *
   * `maxBytes` is the caller's ceiling and defaults to {@link MAX_OBJECT_BYTES}.
   * It is per-call rather than global because the two things this node reads back
   * are not the same size: a container or a sealed result has no business being
   * more than a few MiB, while a batch input file is a caller's own 200 MB
   * upload. One constant for both would either refuse the file or stop bounding
   * the container, and the container is the one an attacker chooses.
   */
  async fetch(cid: string, { maxBytes = MAX_OBJECT_BYTES }: FetchOptions = {}): Promise<Buffer | null> {
    const key = (await this.keyOf(cid)) ?? contentHashOfCid(cid);
    if (key === null) return null;

    // **Ranged from the first request, and the first answer names the total.**
    // A whole-object GET buffers whatever the store returns before this node can
    // refuse it — the ceiling below would be checked against a `content-length`
    // whose body was already on the wire and already allocated. A first window of
    // one chunk costs the same round trip and comes back with `content-range`,
    // whose `/total` is the size, so the refusal happens after one chunk rather
    // than after the whole file.
    const first = await this.send("GET", key, undefined, { range: rangeHeader(0, this.partBytes) });
    if (first.status === 404) return null;
    if (!first.ok) throw await storeRefused(first, "GET", key);

    const total = totalOf(first);
    // A store that answered `200` to a ranged request does not do ranges — the
    // whole object is already here, and re-reading it in windows would be both
    // wrong and slower. Its size is what arrived.
    const head = Buffer.from(await first.arrayBuffer());
    const size = total ?? head.length;

    // The store's declared size, checked **before** the rest is read. An object
    // larger than this node would ever have filed can be there for reasons it
    // does not control: a co-tenant, a migration, a mis-scoped bucket.
    if (size > maxBytes) {
      throw new StoreRejected(
        first.status,
        OVERSIZED_OBJECT,
        `pinning service answered GET ${key} with ${size} bytes, past the ${maxBytes}-byte ` +
          `ceiling this read allowed; the object was not assembled`,
      );
    }
    if (total === null || head.length >= size) return head;

    // One allocation of the final size, filled window by window — rather than an
    // array of chunks concatenated at the end, which would hold the object twice
    // at its peak.
    const object = Buffer.alloc(size);
    head.copy(object, 0);
    let at = head.length;
    while (at < size) {
      const window = await this.send("GET", key, undefined, {
        range: rangeHeader(at, Math.min(this.partBytes, size - at)),
      });
      if (!window.ok) throw await storeRefused(window, "GET", key);
      const chunk = Buffer.from(await window.arrayBuffer());
      if (chunk.length === 0) {
        // The store stopped answering before the total it declared. Refusing is
        // the only honest move: the bytes this node has are a prefix, and a
        // prefix of a container is a commitment mismatch reported against the
        // client rather than against the store.
        throw new StoreRejected(
          window.status,
          OVERSIZED_OBJECT,
          `pinning service stopped answering GET ${key} at ${at} of ${size} bytes`,
        );
      }
      chunk.copy(object, at);
      at += chunk.length;
    }
    return object;
  }

  /**
   * Delete the object and then forget the name — in that order.
   *
   * The order is the retry story. A row dropped first would leave an object
   * nothing can ever reach again: the key is random, so `pins` is the only record
   * of it, and nothing would bill the operator for it any less. Object first, and
   * a store that refuses leaves the row for the next sweep to try again.
   *
   * A `404` is the outcome asked for rather than a failure — the object is not
   * there, which is what this call is about.
   */
  async remove(cid: string): Promise<void> {
    const key = await this.keyOf(cid);
    // No row is no record of where the bytes live. Re-deriving the key the way
    // `fetch` does would be worse than useless here: a name this node did not
    // mint belongs to somebody else's object.
    if (key === null) return;

    const response = await this.send("DELETE", key);
    if (!response.ok && response.status !== 404) throw await storeRefused(response, "DELETE", key);
    await this.db.query("DELETE FROM pins WHERE cid = $1", [cid]);
  }

  /** The object key this node recorded for `cid` when it was filed, or `null`. */
  private async keyOf(cid: string): Promise<string | null> {
    const { rows } = await this.db.query<{ s3_key: string }>(
      "SELECT s3_key FROM pins WHERE cid = $1",
      [cid],
    );
    return rows[0]?.s3_key ?? null;
  }

  private async send(
    method: "PUT" | "GET" | "HEAD" | "POST" | "DELETE",
    key: string,
    body?: Buffer,
    { query = {}, range }: { query?: Record<string, string>; range?: string } = {},
  ): Promise<Response> {
    // The query is put on the wire exactly as it is signed: SigV4's canonical
    // form, every parameter as `name=value` (a bare `?uploads` signs as
    // `uploads=`), RFC 3986-encoded and sorted by name. The store this node
    // files with answers `403 AccessDenied` to a `?uploads` signed without its
    // `=`, which is what an unsigned multipart open looks like from outside.
    const canonicalQuery = Object.keys(query)
      .sort()
      .map((name) => `${rfc3986(name)}=${rfc3986(query[name] ?? "")}`)
      .join("&");
    const url = new URL(
      `${this.config.endpoint.replace(/\/+$/, "")}/${this.config.bucket}/${key}` +
        (canonicalQuery === "" ? "" : `?${canonicalQuery}`),
    );
    const payloadHash = createHash("sha256")
      .update(body ?? Buffer.alloc(0))
      .digest("hex");
    const amzDate = amzDateNow();

    // Only these three are signed. The runtime adds its own headers to an
    // outgoing request (`accept`, `user-agent`), and a signature over headers
    // the caller does not control is a signature that breaks on a runtime
    // upgrade. `range` is deliberately **not** signed for the same reason it is
    // safe not to: a proxy may legitimately narrow or drop it, and S3 does not
    // require it in the signature.
    const signed: Record<string, string> = {
      host: url.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    };

    const authorization = sigv4Authorization({
      method,
      path: url.pathname,
      query: canonicalQuery,
      headers: signed,
      payloadHash,
      accessKey: this.config.key,
      secret: this.config.secret,
      region: this.config.region,
      service: "s3",
      amzDate,
    });

    const request = (): Promise<Response> =>
      fetch(url, {
        method,
        // Never followed. A signature is bound to the `host` header it was computed
        // over, so a followed redirect arrives at the new host with a signature that
        // cannot validate there — the request could only fail, one hop later and
        // with the cause hidden. S3 answers `301 PermanentRedirect` when the bucket
        // lives in another region, which is one of the two or three
        // misconfigurations an operator actually makes, and following it turned that
        // into a bare `fetch failed`.
        redirect: "manual",
        headers: range === undefined ? { ...signed, authorization } : { ...signed, authorization, range },
        // A view over the same memory, not a copy: `fetch` takes a `BodyInit` and
        // a Node `Buffer` is not one of its members, but the `Uint8Array` behind
        // it is — and copying here would double the peak memory of a 32 MiB pin.
        // The `as ArrayBuffer` is the SharedArrayBuffer case being excluded, which
        // a Buffer from an HTTP body never is.
        body:
          body === undefined
            ? null
            : new Uint8Array(body.buffer as ArrayBuffer, body.byteOffset, body.byteLength),
      });

    // A dropped socket is re-sent, up to {@link SEND_ATTEMPTS} times. The store
    // this node files with closes a connection mid-request now and then — an
    // `other side closed` with no answer, seen live on a 2 MiB part — and every
    // S3 client re-sends on exactly that, because every request here can be: a
    // part re-put under its number replaces itself, a delete answers the same
    // twice, a completion that went through before its answer was lost is
    // answered `NoSuchUpload` the second time and `finish` drops the object it
    // can no longer record, and an open whose answer was lost leaves one
    // unfinished upload that only the bucket's own incomplete-upload expiry
    // clears (an operator's setting; see the README). The signature is reused:
    // it is good for fifteen minutes. Nothing else is retried — a refusal is
    // an answer, and the caller reads it.
    let response: Response;
    for (let attempt = 1; ; attempt++) {
      try {
        response = await request();
        break;
      } catch (error) {
        if (attempt >= SEND_ATTEMPTS || !socketDropped(error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, SEND_RETRY_MS * attempt));
      }
    }

    if (response.status >= 300 && response.status < 400) {
      // Named, not followed. `location`'s **host** is the diagnosis — a bucket in
      // another region redirects to `<bucket>.s3.<region>.amazonaws.com` and that
      // hostname says which region to configure. The path is dropped: it can
      // carry the key, and the message is logged.
      const location = response.headers.get("location") ?? "";
      const host = location === "" ? "no location header" : hostOf(location);
      throw new StoreRejected(
        response.status,
        "redirect",
        `pinning service redirected ${method} ${key}: ${response.status} to ${host}; ` +
          `redirects are never followed (a SigV4 signature is bound to the host it was signed for)`,
      );
    }

    return response;
  }
}

/** What one caller allows itself to read back. See {@link S3Pinner.fetch}. */
export interface FetchOptions {
  maxBytes?: number;
}

/**
 * One object being filed a piece at a time.
 *
 * **Nothing is stored until {@link finish}.** Up to one part the bytes are still
 * in this process, and past that the parts are on the store but the object is
 * not: an incomplete multipart upload is not listed, not fetchable and not
 * named. That is what lets a door abort an upload it has already read — a
 * container whose commitment fails on its last byte stores nothing.
 *
 * **{@link write} is serial.** The caller writes what it read, in order, and the
 * part numbering is the call order — two concurrent writes would interleave two
 * parts of the same object. Every caller is a `for await` over a stream, which
 * is serial by construction.
 *
 * **An upload that is neither finished nor aborted leaks.** Not an object — one
 * nothing lists — but billed storage that only `ListMultipartUploads` sees and
 * no lifecycle rule on the object prefix reaches. {@link write} and
 * {@link finish} abort their own failures; what the caller owes is an
 * {@link abort} on the path where *it* gives up.
 */
export interface PinUpload {
  /** Take the next bytes, in order. */
  write(chunk: Buffer): Promise<void>;
  /** Close the object and return the name the store minted for it. */
  finish(): Promise<string>;
  /** Give up: nothing is stored, and any opened multipart upload is aborted. */
  abort(): Promise<void>;
}

/** RFC 3986 percent-encoding, which is what SigV4 canonicalises a query with. */
const rfc3986 = (value: string): string =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/** `bytes=from-through`, inclusive at both ends, which is what HTTP means by a range. */
const rangeHeader = (from: number, length: number): string => `bytes=${from}-${from + length - 1}`;

/**
 * The object's full size, off a `206`'s `content-range`, or `null` when the store
 * answered the whole object instead.
 *
 * `content-range: bytes 0-8388607/52428800` — the part after the slash. A `*`
 * there is legal and means the store will not say, which reads the same as no
 * ranges at all: take what arrived.
 */
function totalOf(response: Response): number | null {
  if (response.status !== 206) return null;
  const total = /\/(\d+)\s*$/.exec(response.headers.get("content-range") ?? "");
  return total === null ? null : Number(total[1]);
}

/** The text of the first `<tag>` in an S3 XML answer. */
function tagOf(document: string, tag: string): string | null {
  return new RegExp(`<${tag}>([^<]+)</${tag}>`).exec(document)?.[1] ?? null;
}

/** The host of a `location` header, or the header itself when it will not parse. */
function hostOf(location: string): string {
  try {
    return new URL(location).host;
  } catch {
    return location;
  }
}

/**
 * The store answered, and refused. Distinguished from a transport failure because
 * the two need opposite responses from an operator: this one is nearly always a
 * permanent misconfiguration — wrong key, wrong bucket, wrong region, a clock
 * more than fifteen minutes out — and a transport failure heals itself.
 * `throughPinner` turns the difference into the `code` on the envelope, which is
 * the only place a client can see it (the `503` and its retryability are the same
 * either way: the *caller's* bytes are fine in both cases).
 */
export class StoreRejected extends Error {
  constructor(
    /** The HTTP status the store answered with. */
    readonly status: number,
    /** The store's own XML `<Code>`, `"redirect"`, or `""` when it sent none. */
    readonly storeCode: string,
    message: string,
  ) {
    super(message);
    this.name = "StoreRejected";
  }
}

/** The store's own refusal, carried up with the status and the code it gave. */
async function storeRefused(
  response: Response,
  method: string,
  key: string,
): Promise<StoreRejected> {
  // An error body is an XML document the *store* chose the size of, and it is
  // read only to pull a `<Code>` out of it. Refused before it is read, not
  // truncated after: `response.text()` buffers the whole thing first, so a
  // `.slice()` afterwards would bound the string and not the memory. 64 KiB is
  // far more than any S3-compatible error document.
  const declared = Number(response.headers.get("content-length") ?? "0");
  const body =
    Number.isFinite(declared) && declared > MAX_ERROR_BODY_BYTES
      ? ""
      : await response.text().catch(() => "");
  const code = /<Code>([^<]+)<\/Code>/.exec(body)?.[1] ?? "";
  return new StoreRejected(
    response.status,
    code,
    `pinning service refused ${method} ${key}: ${response.status} ${code || response.statusText}`.trim(),
  );
}

/**
 * The pinner this configuration selects — and there is one.
 *
 * Whether a store is configured is settled before this point: `loadConfig`
 * requires the whole `PIN_S3_*` group at boot, so by the time a `Config`
 * exists the credentials are there or the process never started. Every post and
 * every settle now files bytes, so a node without a pinning service cannot serve
 * its write doors at all, and starting one that answers `503` to every
 * submission would be a worse failure than refusing to boot.
 */
export function pinnerFor(config: Config, db: Db): Pinner {
  return new S3Pinner(config.pinS3, db);
}
