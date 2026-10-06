import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { S3PinConfig } from "../../src/config.js";
import { sigv4Authorization } from "../../src/pin/pinner.js";

/**
 * A stub object store that refuses the way a real one refuses (R64).
 *
 * S3's failure modes reproduced in **shape** rather than in spirit: the status
 * code *and* the XML `<Code>` a real endpoint answers with. A stub that merely
 * threw would let the pinner pass for the wrong reason — it would never exercise
 * the path where a service answers `200` with no minted name, which is the one
 * failure that would otherwise make the node invent one.
 *
 * The signature is verified by recomputing it over **the request as received**.
 * That is not a check of the cryptography (AWS's own published vectors do that in
 * `pinner.test.ts`) — it is a check that the pinner signed the path, the headers
 * and the payload it actually sent, which is exactly what a wrong endpoint URL or
 * a stale payload hash breaks.
 *
 * It lives here rather than inside one test file because pinning is now on the
 * request path of both write doors and the devnet suite: `POST /v1/jobs` and the
 * `settle` branch of `POST /evm/ops` cannot be exercised at all without a store
 * that answers, and four files would otherwise each grow their own.
 *
 * **The minted name is deliberately not a CID this node could have computed.**
 * The store names the bytes and may name them anything; a stub that echoed the
 * spec CID would let a node that quietly computed its own name pass every test.
 */

export const BUCKET = "vorq-pins";
export const STORE_KEY = "AKIAPINEXAMPLE";
export const STORE_SECRET = "pinner-secret-not-a-credential";
export const STORE_REGION = "eu-central-1";

export interface StubStore {
  server: Server;
  endpoint: string;
  /** Every object the store holds, by key (the random `stream-…` key the pinner opened). */
  objects: Map<string, Buffer>;
  requests: { method: string; url: string; headers: Record<string, string> }[];
  /** What the "service" answers with as the minted name. Overwritable per test. */
  mintedCid: (bytes: Buffer) => string;
  /** Answer the next completion without a minted name, the way an unconfigured bucket does. */
  omitCid: boolean;
  /** Answer `307` pointing here, the way a wrong-region bucket redirects. */
  redirectTo: string | null;
  /** Multipart uploads currently open, by `UploadId`. An abandoned one lingers here. */
  uploads: Map<string, { key: string; parts: Map<number, Buffer> }>;
  /** Names each `UploadId`, so a test can tell one upload from the next. */
  uploadSeq: number;
  /** Refuse this part number, so the abandonment path is reachable. */
  failPartNumber: number | null;
  /**
   * Answer every object DELETE with this status instead of `204`.
   *
   * Stores differ on a key they do not hold — S3 answers `204`, other
   * S3-compatible gateways answer `404 NoSuchKey` — and a removal has to read
   * both as "the object is gone". `500` is the other side of it: a refusal the
   * sweep must report rather than swallow.
   */
  deleteStatus: number | null;
  /**
   * Close the connection on this many requests to come, with no answer — the
   * way the live store closes one mid-request now and then. Each dropped
   * request is still logged in `requests`, so a test can count the re-sends.
   */
  dropRequests: number;
  /**
   * Process the Nth request from now in full, then close the connection in
   * place of the answer — the store did what it was asked and the caller never
   * learns of it. That is the other way a connection dies, and the one the
   * re-send has to be right about: an open whose answer was lost is a second
   * upload, a part re-put replaces itself, and a completion re-sent meets
   * `NoSuchUpload`. One request, counted from the next, because a lost answer
   * is followed by a re-send of the same request.
   */
  dropAnswerAt: number | null;
  /** Forget every upload before its completion, as a store's incomplete-upload expiry does. */
  expireUploadsBeforeCompletion: boolean;
  /** The `PIN_S3_*` group that reaches this store. */
  config(overrides?: Partial<S3PinConfig>): S3PinConfig;
  /** The `PIN_S3_*` environment that reaches this store. */
  env(): Record<string, string>;
  close(): Promise<void>;
}

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** A name no CID scheme in this repository mints, derived from the bytes so it is stable. */
export const externallyMintedCid = (bytes: Buffer): string =>
  `bexternallyminted${sha256Hex(bytes).slice(0, 16)}`;

function xmlError(res: ServerResponse, status: number, code: string, message: string): void {
  xml(res, status, `<Error><Code>${code}</Code><Message>${message}</Message></Error>`);
}

function xml(res: ServerResponse, status: number, document: string): void {
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n${document}`;
  res.writeHead(status, { "content-type": "application/xml" });
  res.end(body);
}

export async function startStubStore(): Promise<StubStore> {
  const state: StubStore = {
    server: undefined as unknown as Server,
    endpoint: "",
    objects: new Map(),
    requests: [],
    uploads: new Map(),
    uploadSeq: 0,
    failPartNumber: null,
    deleteStatus: null,
    dropRequests: 0,
    dropAnswerAt: null,
    expireUploadsBeforeCompletion: false,
    mintedCid: externallyMintedCid,
    omitCid: false,
    redirectTo: null,
    config: (overrides = {}) => ({
      endpoint: state.endpoint,
      key: STORE_KEY,
      secret: STORE_SECRET,
      bucket: BUCKET,
      region: STORE_REGION,
      ...overrides,
    }),
    env: () => ({
      PIN_S3_ENDPOINT: state.endpoint,
      PIN_S3_KEY: STORE_KEY,
      PIN_S3_SECRET: STORE_SECRET,
      PIN_S3_BUCKET: BUCKET,
      PIN_S3_REGION: STORE_REGION,
    }),
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        state.server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    if (state.dropRequests > 0) {
      state.dropRequests--;
      state.requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers as Record<string, string>,
      });
      req.socket.destroy();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const headers = req.headers as Record<string, string>;
      state.requests.push({ method: req.method ?? "", url: req.url ?? "", headers });

      if (state.dropAnswerAt !== null && --state.dropAnswerAt === 0) {
        state.dropAnswerAt = null;
        // Every branch below still runs and still writes the store's state;
        // only the answer is replaced by a dead connection.
        res.writeHead = (() => res) as typeof res.writeHead;
        res.end = (() => {
          req.socket.destroy();
          return res;
        }) as typeof res.end;
      }

      if (state.redirectTo !== null) {
        // Before the signature check, exactly as S3 does: the region decides
        // where the request belongs before anything decides whether it is valid.
        res.writeHead(307, { location: state.redirectTo });
        res.end();
        return;
      }

      // Split the query off before anything reads the key: a multipart request
      // carries `?uploads` / `?partNumber=&uploadId=`, and a key that swallowed
      // them would name a different object per part.
      const [rawPath = "", rawQuery = ""] = (req.url ?? "").split("?");
      const [, bucket, key] = rawPath.split("/");
      if (bucket !== BUCKET) {
        xmlError(res, 404, "NoSuchBucket", "The specified bucket does not exist");
        return;
      }

      // Every S3 request carries the payload hash it signed, and the service
      // hashes what it received: a mismatch is this exact error.
      const amzContentSha256 = headers["x-amz-content-sha256"];
      if (amzContentSha256 !== sha256Hex(body)) {
        xmlError(
          res,
          400,
          "XAmzContentSHA256Mismatch",
          "The provided 'x-amz-content-sha256' header does not match what was computed.",
        );
        return;
      }

      const amzDate = headers["x-amz-date"] ?? "";
      const signedHeaderNames = /SignedHeaders=([^,]+)/.exec(headers.authorization ?? "")?.[1];
      if (signedHeaderNames === undefined || amzDate === "") {
        xmlError(res, 403, "AccessDenied", "Missing or malformed Authorization header");
        return;
      }
      const signed: Record<string, string> = {};
      for (const name of signedHeaderNames.split(";")) signed[name] = headers[name] ?? "";
      const expected = sigv4Authorization({
        method: req.method ?? "",
        path: rawPath,
        query: rawQuery,
        headers: signed,
        payloadHash: amzContentSha256,
        accessKey: STORE_KEY,
        secret: STORE_SECRET,
        region: STORE_REGION,
        service: "s3",
        amzDate,
      });
      if (headers.authorization !== expected) {
        xmlError(
          res,
          403,
          "SignatureDoesNotMatch",
          "The request signature we calculated does not match the signature you provided.",
        );
        return;
      }

      // --- multipart upload --------------------------------------------------
      //
      // Modelled rather than mocked, because the three calls have three different
      // shapes and only the real sequence proves the pinner speaks it: `POST
      // ?uploads` opens one and answers an `UploadId`, `PUT ?partNumber=N` stores
      // a part and answers its `ETag` — the caller must send them all back in
      // order — and `POST ?uploadId=` assembles them. **The CID is minted on the
      // complete**, not on any part: no part is the object, so no part has a name.
      const params = new URLSearchParams(rawQuery);

      if (req.method === "POST" && params.has("uploads")) {
        const uploadId = `upload-${++state.uploadSeq}`;
        state.uploads.set(uploadId, { key: key ?? "", parts: new Map() });
        xml(res, 200,
          `<InitiateMultipartUploadResult><Bucket>${BUCKET}</Bucket>` +
          `<Key>${key}</Key><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`);
        return;
      }

      if (req.method === "PUT" && params.has("uploadId")) {
        const upload = state.uploads.get(params.get("uploadId") ?? "");
        if (upload === undefined) {
          xmlError(res, 404, "NoSuchUpload", "The specified multipart upload does not exist.");
          return;
        }
        const partNumber = Number(params.get("partNumber"));
        if (state.failPartNumber === partNumber) {
          xmlError(res, 500, "InternalError", "We encountered an internal error. Please try again.");
          return;
        }
        upload.parts.set(partNumber, body);
        // A weak, quoted ETag, exactly as S3 answers: the pinner has to unquote it
        // to build the completion document, and a pinner that echoed the quotes
        // would produce XML S3 refuses.
        res.writeHead(200, { etag: `"${sha256Hex(body).slice(0, 32)}"`, "content-length": "0" });
        res.end();
        return;
      }

      if (req.method === "POST" && params.has("uploadId")) {
        const uploadId = params.get("uploadId") ?? "";
        if (state.expireUploadsBeforeCompletion) state.uploads.delete(uploadId);
        const upload = state.uploads.get(uploadId);
        if (upload === undefined) {
          xmlError(res, 404, "NoSuchUpload", "The specified multipart upload does not exist.");
          return;
        }
        // Assembled in the order the completion document names, not in the order
        // the parts arrived — which is the whole point of sending it.
        const numbers = [...body.toString("utf8").matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)]
          .map((m) => Number(m[1]));
        const assembled = Buffer.concat(numbers.map((n) => upload.parts.get(n) ?? Buffer.alloc(0)));
        state.uploads.delete(uploadId);
        state.objects.set(upload.key, assembled);
        // The name rides in the completion document, as the real store answers
        // it — not in a header. A pinner that read only the header would refuse
        // every object it ever filed.
        const cid = state.omitCid ? "" : `<CID>${state.mintedCid(assembled)}</CID>`;
        res.writeHead(200, { "content-type": "application/xml" });
        res.end(
          `<CompleteMultipartUploadResult><Bucket>${BUCKET}</Bucket>` +
          `<Key>${upload.key}</Key>${cid}</CompleteMultipartUploadResult>`);
        return;
      }

      if (req.method === "DELETE" && params.has("uploadId")) {
        state.uploads.delete(params.get("uploadId") ?? "");
        res.writeHead(204, { "content-length": "0" });
        res.end();
        return;
      }

      if (req.method === "DELETE") {
        if (state.deleteStatus !== null) {
          xmlError(
            res,
            state.deleteStatus,
            state.deleteStatus === 404 ? "NoSuchKey" : "InternalError",
            "The specified key does not exist.",
          );
          return;
        }
        state.objects.delete(key ?? "");
        res.writeHead(204, { "content-length": "0" });
        res.end();
        return;
      }

      if (req.method === "HEAD") {
        // As the store answers it: the minted name in `x-amz-meta-cid`, no body.
        const object = state.objects.get(key ?? "");
        if (object === undefined) {
          res.writeHead(404, { "content-length": "0" });
          res.end();
          return;
        }
        res.writeHead(200, {
          "content-length": String(object.length),
          "x-amz-meta-cid": state.mintedCid(object),
        });
        res.end();
        return;
      }

      if (req.method === "GET") {
        const object = state.objects.get(key ?? "");
        if (object === undefined) {
          xmlError(res, 404, "NoSuchKey", "The specified key does not exist.");
          return;
        }
        // `Range`, answered as S3 answers it: `206` with `content-range`, and the
        // half-open arithmetic is the store's rather than the caller's — a reader
        // that got the inclusive end wrong would silently drop or duplicate a byte
        // at every chunk seam, which only shows up on an object big enough to have
        // seams.
        const range = /^bytes=(\d+)-(\d+)$/.exec(headers.range ?? "");
        if (range !== null) {
          const from = Number(range[1]);
          const through = Math.min(Number(range[2]), object.length - 1);
          const slice = object.subarray(from, through + 1);
          res.writeHead(206, {
            "content-type": "application/octet-stream",
            "content-length": String(slice.length),
            "content-range": `bytes ${from}-${through}/${object.length}`,
          });
          res.end(slice);
          return;
        }
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": String(object.length),
        });
        res.end(object);
        return;
      }

      xmlError(res, 405, "MethodNotAllowed", "The specified method is not allowed");
    });
  };

  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.server = server;
  const { port } = server.address() as AddressInfo;
  state.endpoint = `http://127.0.0.1:${port}`;
  return state;
}

/**
 * A `pins` name book in memory, for a test that wants the pinner without a
 * database.
 *
 * `S3Pinner` writes `cid → s3_key` at mint time and reads it back at fetch time
 * (R73). A stub that answered every query with an empty result would make `mint`
 * look like it worked while quietly recording nothing, so this holds the rows and
 * hands them back.
 */
export function stubPinsDb(): {
  query: (text: string, params?: readonly unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  pins: Map<string, string>;
} {
  const pins = new Map<string, string>();
  return {
    pins,
    query: async (text: string, params?: readonly unknown[]) => {
      if (text.includes("INSERT INTO pins")) {
        // `ON CONFLICT DO NOTHING RETURNING`: a row for a new name, none for a
        // name already in the book — which is how the pinner learns it filed a
        // duplicate.
        const [cid, key] = params as [string, string];
        if (pins.has(cid)) return { rows: [] };
        pins.set(cid, key);
        return { rows: [{ s3_key: key }] };
      }
      if (text.includes("DELETE FROM pins")) {
        pins.delete(params?.[0] as string);
        return { rows: [] };
      }
      if (text.includes("FROM pins")) {
        const key = pins.get(params?.[0] as string);
        return { rows: key === undefined ? [] : [{ s3_key: key }] };
      }
      throw new Error(`stubPinsDb: unexpected query ${text}`);
    },
  };
}
