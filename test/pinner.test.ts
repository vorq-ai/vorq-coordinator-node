import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/api/app.js";
import type { Config, S3PinConfig } from "../src/config.js";
import { DROPPABLE, openDb, PRESERVED, type Db } from "../src/db/db.js";
import type { Indexer, IndexerStatus } from "../src/index/indexer.js";
import { cidForBytes, contentHashOfCid } from "../src/pin/cid.js";
import {
  MAX_CID_CHARS,
  NO_CID_MINTED,
  OVERSIZED_CID,
  pinnerFor,
  type PinUpload,
  put,
  S3Pinner,
  SEND_ATTEMPTS,
  sigv4Authorization,
  StoreRejected,
} from "../src/pin/pinner.js";
import {
  externallyMintedCid,
  startStubStore,
  stubPinsDb,
  type StubStore,
} from "./support/stub-store.js";
import { stubChain, testConfig, type StubChain } from "./support/stub-chain.js";
import { EIP712_NAMES } from "../src/orders.js";

/**
 * The pinner: the name, the signer, the store, and the one door test that proves
 * a store's refusal reaches a caller as the right envelope.
 *
 * Four independent things are proved here, and they are deliberately not proved
 * against each other:
 *
 *   * **the CID** against vectors derived outside this codebase (below);
 *   * **the SigV4 signer** against AWS's own published test-suite vectors, so
 *     the one piece of cryptography this task hand-writes is pinned to the
 *     authority rather than to itself;
 *   * **the S3 pinner** against a real loopback HTTP server that refuses the way
 *     the service refuses (R64) — wrong signature, wrong payload hash and an
 *     absent key each get the status and the XML error code S3 answers with;
 *   * **the classification of a store failure**, through the shipped `settle`
 *     door, with the real SQL exercised against a real Postgres whenever
 *     `TEST_DATABASE_URL` is set (R25).
 *
 * **There is no pin door and no blob door any more**, so neither is tested here:
 * pinning happens inside `POST /v1/jobs` and inside the `settle` branch of
 * `POST /evm/ops`, in the same call that puts the minted name on chain, and
 * inside `POST /v1/files` for a payload a caller references by cid instead. The
 * admission counter, the raw octet-stream parser and the 32 MiB read ceiling that
 * belonged to those two doors went with them; what bounds this node's memory now
 * is each write door's own `bodyLimit`, which `test/api-post.test.ts`,
 * `test/api-ops.test.ts` and `test/edges.test.ts` own.
 *
 * No chain and no external network: the only socket is a loopback server this
 * file starts and stops itself.
 */

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const TEST_SCHEMA = "vorq_pin_test";

const SESSION = "vorq_sess_0123456789abcdef0123456789abcdef";

/** A throwaway scalar. It has never held value on any chain. */
const provider = privateKeyToAccount(`0x${"44".repeat(32)}`);
const PROVIDER_ID = 5n;

const stubIndexer = (): Indexer => ({
  coldStart: async () => undefined,
  poll: async () => undefined,
  status: async (): Promise<IndexerStatus> => ({ cursor: 9n, head: 9n, ready: true, forked: null }),
  start: async () => undefined,
  stop: async () => undefined,
});

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

// ---------------------------------------------------------------------------
// cidForBytes
// ---------------------------------------------------------------------------

describe("cidForBytes", () => {
  /**
   * Known-answer vectors, computed **once and outside this codebase** and pinned
   * here: derived in Python (`hashlib` + `base64.b32encode`) and cross-checked
   * against IPFS's canonical strings for the same bytes. A vector produced by
   * the function under test would prove only that it equals itself, and this
   * name is a cross-repo contract — the client and provider SDKs mirror it, and
   * a drift in the encoding would rename every object on the network at once.
   */
  it("matches pinned CIDv1/raw/sha2-256 vectors", () => {
    expect(cidForBytes(Buffer.from("hello"))).toBe(
      "bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq",
    );
    expect(cidForBytes(Buffer.from("hello world"))).toBe(
      "bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e",
    );
    expect(cidForBytes(Buffer.alloc(0))).toBe(
      "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku",
    );
  });

  it("is base32lower with no padding, and always 59 characters", () => {
    const cid = cidForBytes(Buffer.from("vorq"));
    expect(cid).toMatch(/^bafkrei[a-z2-7]{52}$/);
    expect(cid).toHaveLength(59);
    // A single raw block's name is fully determined by its bytes, so the length
    // never varies with the payload: 4 prefix bytes + a 32-byte digest.
    expect(cidForBytes(Buffer.alloc(1_000_000, 0x41))).toHaveLength(59);
  });

  it("names the bytes, not the object identity", () => {
    expect(cidForBytes(Buffer.from("a"))).toBe(cidForBytes(Uint8Array.from([0x61])));
    expect(cidForBytes(Buffer.from("a"))).not.toBe(cidForBytes(Buffer.from("b")));
  });

  it("is comfortably inside the ceiling this node puts on chain", () => {
    // `MAX_CID_CHARS` bounds the name the *store* mints, and a spec CID is the
    // reference point that says the bound is not absurdly tight: 59 against 64.
    expect(cidForBytes(Buffer.from("vorq")).length).toBeLessThanOrEqual(MAX_CID_CHARS);
  });
});

describe("contentHashOfCid", () => {
  it("recovers the sha256 a spec CID was minted from", () => {
    // The S3 read path's whole basis: key = sha256 hex, and the CID carries that
    // digest verbatim under four bytes of multiformat prefix.
    expect(contentHashOfCid(cidForBytes(Buffer.from("hello")))).toBe(sha256Hex(Buffer.from("hello")));
    expect(contentHashOfCid("bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });

  it("answers null for anything that is not a CIDv1/raw/sha2-256 name", () => {
    expect(contentHashOfCid("")).toBeNull();
    expect(contentHashOfCid("Qmpretend-this-is-a-cidv0-name-000000000000000")).toBeNull();
    expect(contentHashOfCid("b!!!")).toBeNull();
    // Right multibase, right length, wrong multicodec: `bafybei…` is the same
    // digest under dag-pb (0x70) rather than raw (0x55), and it names a
    // different object.
    const rawName = cidForBytes(Buffer.from("hello"));
    expect(contentHashOfCid(rawName.replace(/^bafkrei/, "bafybei"))).toBeNull();
    expect(contentHashOfCid(`${cidForBytes(Buffer.from("hello"))}extra`)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SigV4, against AWS's published test suite
// ---------------------------------------------------------------------------

/**
 * The suite's fixed credentials (`aws/aws-sdk-ruby`,
 * `gems/aws-sigv4/spec/suite/`). Published example values, not secrets.
 */
const SUITE = {
  accessKey: "AKIDEXAMPLE",
  secret: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  region: "us-east-1",
  service: "service",
  amzDate: "20150830T123600Z",
} as const;

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("sigv4Authorization", () => {
  it("reproduces the suite's get-vanilla Authorization header exactly", () => {
    expect(
      sigv4Authorization({
        ...SUITE,
        method: "GET",
        path: "/",
        query: "",
        headers: { host: "example.amazonaws.com", "x-amz-date": SUITE.amzDate },
        payloadHash: EMPTY_SHA256,
      }),
    ).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, " +
        "SignedHeaders=host;x-amz-date, " +
        "Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
  });

  it("reproduces the suite's one vector that carries a body", () => {
    // post-x-www-form-urlencoded: body `Param1=value1`, so the payload hash is
    // load-bearing rather than the empty-string constant — which is the only
    // shape this node actually signs.
    const body = Buffer.from("Param1=value1");
    expect(sha256Hex(body)).toBe(
      "9095672bbd1f56dfc5b65f3e153adc8731a4a654192329106275f4c7b24d0b6e",
    );
    expect(
      sigv4Authorization({
        ...SUITE,
        method: "POST",
        path: "/",
        query: "",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          host: "example.amazonaws.com",
          "x-amz-date": SUITE.amzDate,
        },
        payloadHash: sha256Hex(body),
      }),
    ).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, " +
        "SignedHeaders=content-type;host;x-amz-date, " +
        "Signature=ff11897932ad3f4e8b18135d722051e5ac45fc38421b1da7b9d196a0fe09473a",
    );
  });

  it("signs the request it is given: a changed path or payload changes the signature", () => {
    const base = {
      ...SUITE,
      method: "GET" as const,
      path: "/",
      query: "",
      headers: { host: "example.amazonaws.com", "x-amz-date": SUITE.amzDate },
      payloadHash: EMPTY_SHA256,
    };
    const signature = (input: Parameters<typeof sigv4Authorization>[0]): string =>
      sigv4Authorization(input).split("Signature=")[1] ?? "";

    expect(signature({ ...base, path: "/other" })).not.toBe(signature(base));
    expect(signature({ ...base, payloadHash: sha256Hex(Buffer.from("x")) })).not.toBe(
      signature(base),
    );
    expect(signature({ ...base, secret: `${SUITE.secret}x` })).not.toBe(signature(base));
  });
});

// ---------------------------------------------------------------------------
// The object-store pinner
// ---------------------------------------------------------------------------

describe("S3Pinner", () => {
  let stub: StubStore;
  /** The `pins` name book this pinner writes at mint time (R73). */
  let names: ReturnType<typeof stubPinsDb>;

  beforeAll(async () => {
    stub = await startStubStore();
  });
  beforeEach(() => {
    names = stubPinsDb();
  });
  afterAll(async () => {
    await stub.close();
  });
  afterEach(() => {
    stub.requests.length = 0;
    stub.objects.clear();
    stub.uploads.clear();
    stub.omitCid = false;
    stub.redirectTo = null;
    stub.failPartNumber = null;
    stub.deleteStatus = null;
    stub.dropRequests = 0;
    stub.dropAnswerAt = null;
    stub.expireUploadsBeforeCompletion = false;
    stub.mintedCid = externallyMintedCid;
  });

  const pinner = (overrides: Partial<S3PinConfig> = {}, db?: Db) =>
    new S3Pinner(stub.config(overrides), db ?? (names as unknown as Db));

  it("files under a random stream key and returns the service's name verbatim", async () => {
    const bytes = Buffer.from("pin me");

    const cid = await put(pinner(), bytes);

    // The name is the service's, not ours. Asserted against a value that is
    // deliberately **not** a spec CID, so a pinner that quietly recomputed the
    // name locally could not pass.
    expect(cid).toBe(stub.mintedCid(bytes));
    expect(cid).not.toBe(cidForBytes(bytes));
    // One path for every object, whatever its size: open, one part, complete.
    expect(stub.requests.map((r) => `${r.method} ${r.url.replace(/^.*\?/, "?")}`)).toEqual([
      "POST ?uploads=",
      "PUT ?partNumber=1&uploadId=upload-1",
      "POST ?uploadId=upload-1",
    ]);
    const key = names.pins.get(cid);
    expect(key).toMatch(/^stream-[0-9a-f]{48}$/);
    expect(stub.objects.get(key as string)).toEqual(bytes);
  });

  it("re-putting the same bytes keeps one object and one row", async () => {
    // The property the whole retry story on both write doors rests on: a relay
    // that fails after a successful pin can be retried, and the second pin is
    // the same name — the store mints it from the bytes — with one `pins` row.
    // The key is random, so the duplicate is a second object; the pinner drops
    // it, and the survivor is the one the row names.
    const bytes = Buffer.from("idempotent");
    const p = pinner();

    const first = await put(p, bytes);
    expect(await put(p, bytes)).toBe(first);

    expect(names.pins.size).toBe(1);
    expect(stub.objects.size).toBe(1);
    expect(stub.objects.get(names.pins.get(first) as string)).toEqual(bytes);
    expect(stub.requests.at(-1)?.method).toBe("DELETE");
  });

  it("refuses to invent a name when the service completes without one", async () => {
    stub.omitCid = true;

    await expect(put(pinner(), Buffer.from("unnamed"))).rejects.toThrow(/<CID>/);
    // A refusal by the store, under a code of its own, rather than a bare
    // `Error`: the put *succeeded* — a `200` came back — and what is broken is
    // the store's configuration, not its availability. The door turns this code
    // into `store_rejected` at `fatal` (below).
    const raised = await put(pinner(), Buffer.from("unnamed")).catch((error: unknown) => error);
    expect(raised).toBeInstanceOf(StoreRejected);
    expect((raised as StoreRejected).storeCode).toBe(NO_CID_MINTED);
    expect((raised as StoreRejected).status).toBe(200);
    // And the nameless object was not left behind.
    expect(stub.objects.size).toBe(0);
  });

  /**
   * The bound that moved when the caller stopped supplying the CID.
   *
   * `order.taskCid` and `resultCid` are unbounded `bytes` on chain and **the
   * relayer pays for every one of them**, so the length had to stay bounded
   * somewhere. It used to be a check on a request field; the only place left is
   * the name the store hands back. Probed at the edge (R78), because a store that
   * mints exactly `MAX_CID_CHARS` is answering correctly and must not be refused.
   */
  it("takes a name exactly at MAX_CID_CHARS and refuses one past it", async () => {
    stub.mintedCid = () => "b".repeat(MAX_CID_CHARS);
    expect(await put(pinner(), Buffer.from("at the edge"))).toHaveLength(MAX_CID_CHARS);

    stub.mintedCid = () => "b".repeat(MAX_CID_CHARS + 1);
    const raised = await put(pinner(), Buffer.from("one past it")).catch((error: unknown) => error);
    expect(raised).toBeInstanceOf(StoreRejected);
    expect((raised as StoreRejected).storeCode).toBe(OVERSIZED_CID);
    // And it was not recorded: a name this node will not put on chain is not a
    // name it pretends to hold — and the object behind it is not kept either.
    expect(names.pins.size).toBe(1);
    expect(stub.objects.size).toBe(1);
  });

  it("surfaces the service's own refusal, with its status and error code", async () => {
    await expect(put(pinner({ secret: "not-the-secret" }), Buffer.from("nope"))).rejects.toThrow(
      /403.*SignatureDoesNotMatch/s,
    );
    await expect(put(pinner({ bucket: "someone-elses" }), Buffer.from("nope"))).rejects.toThrow(
      /404.*NoSuchBucket/s,
    );
  });

  it("signs the query in its canonical form, name=value, and sends it the same way", async () => {
    // `?uploads` is signed as `uploads=` under SigV4, and the store this node
    // files with answers `403 AccessDenied` to the bare spelling. The stub
    // recomputes the signature over the query as received, so a wire form that
    // differed from the signed form would be refused here too.
    await put(pinner(), Buffer.from("canonical"));
    expect(stub.requests[0]?.url).toMatch(/\?uploads=$/);
  });

  it("fetches by re-deriving the key from the CID, and answers null for a miss", async () => {
    const bytes = Buffer.from("readable");
    const key = sha256Hex(bytes);
    stub.objects.set(key, bytes);

    expect(await pinner().fetch(cidForBytes(bytes))).toEqual(bytes);
    expect(stub.requests.at(-1)).toMatchObject({
      method: "GET",
      url: `/${stub.config().bucket}/${key}`,
    });

    expect(await pinner().fetch(cidForBytes(Buffer.from("never stored")))).toBeNull();
  });

  it("does not go to the network for a name it did not mint and cannot re-derive", async () => {
    expect(await pinner().fetch("not-a-cid")).toBeNull();
    expect(stub.requests).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Objects too big for one part
  // -------------------------------------------------------------------------

  /**
   * A part size of a few KB, so a body of a few parts is a few KB rather than a
   * few tens of MB.
   *
   * The seam arithmetic is what these tests are about — the last part being
   * short, the ranges being inclusive at both ends, the completion document
   * naming the parts in order — and none of it is sensitive to the scale. Driving
   * it at the shipped 8 MiB cost 24 MB a case, and vitest holds every case's
   * fixtures for the file: the worker died on a 4 GB heap before an assertion ran.
   */
  const SMALL_PART = 4 * 1024;

  const partedPinner = () => pinner({ partBytes: SMALL_PART });

  const bigBody = (parts: number): Buffer =>
    Buffer.concat(
      Array.from({ length: parts }, (_, index) =>
        Buffer.alloc(SMALL_PART, String.fromCharCode(97 + index)),
      ),
    );

  /**
   * Compare two multi-megabyte buffers by their hash, never with `toEqual`.
   *
   * `toEqual` walks a Buffer element by element and builds a diff of what it
   * walked; on 24 MiB that exhausted a 4 GB heap and killed the worker before any
   * assertion ran. The hash is the same claim — these are content-addressed bytes,
   * and equal digests is what "the same object" means everywhere else in this file.
   */
  const sameBytes = (actual: Buffer | null, expected: Buffer): void => {
    expect(actual).not.toBeNull();
    expect(actual?.length).toBe(expected.length);
    expect(sha256Hex(actual as Buffer)).toBe(sha256Hex(expected));
  };

  it("uploads an object past the part size in parts, and the object is the whole of it", async () => {
    const bytes = bigBody(3);

    const cid = await put(partedPinner(), bytes);

    // The name is minted on the completion, and it names the assembled object —
    // no part is the object, so no part has a name of its own.
    expect(cid).toBe(stub.mintedCid(bytes));
    sameBytes(stub.objects.get(names.pins.get(cid) as string) ?? null, bytes);

    const calls = stub.requests.map((r) => `${r.method} ${r.url.split("/").pop()}`);
    expect(calls[0]).toMatch(/^POST .*\?uploads=$/);
    expect(calls.filter((c) => c.includes("partNumber="))).toHaveLength(3);
    expect(calls.at(-1)).toMatch(/^POST .*\?uploadId=/);
  });

  it("re-sends a request whose connection the store dropped, and the object completes", async () => {
    // Seen live: the store closed the connection mid-request on a 2 MiB part,
    // with no answer at all. A client that re-posted the job would pay twice,
    // so the node re-sends the store request instead — the same signature, the
    // same part number, the same completion document.
    const bytes = Buffer.from("dropped once");
    stub.dropRequests = 1;

    const cid = await put(pinner(), bytes);

    expect(cid).toBe(stub.mintedCid(bytes));
    expect(stub.objects.get(names.pins.get(cid) as string)).toEqual(bytes);
    expect(
      stub.requests.map((r) => `${r.method} ${r.url.replace(/^.*\?/, "?").replace(/upload-\d+/, "upload-N")}`),
    ).toEqual([
      "POST ?uploads=",
      "POST ?uploads=",
      "PUT ?partNumber=1&uploadId=upload-N",
      "POST ?uploadId=upload-N",
    ]);
    expect(stub.uploads.size).toBe(0);
  });

  it("files the object when a completion went through but its answer was lost", async () => {
    // The store assembled the object and closed the connection before
    // answering (seen live on 2026-09-30 against a 4 KiB container). The
    // re-sent completion meets `NoSuchUpload`, the HEAD finds the object and
    // its minted name, and the pin succeeds exactly as an answered one does.
    const bytes = Buffer.from("completed, unanswered");
    stub.dropAnswerAt = 3; // open, part, then the completion

    const cid = await put(pinner(), bytes);

    expect(cid).toBe(stub.mintedCid(bytes));
    expect(stub.objects.get(names.pins.get(cid) as string)).toEqual(bytes);
    expect(stub.uploads.size).toBe(0);
    expect(stub.requests.at(-1)?.method).toBe("HEAD");
  });

  it("fails and drops nothing it cannot find when the store expired the upload", async () => {
    // `NoSuchUpload` with no object under the key: the upload really is gone,
    // so the pin fails retryably and no row is written.
    const bytes = Buffer.from("expired upload");
    stub.expireUploadsBeforeCompletion = true;

    await expect(put(pinner(), bytes)).rejects.toThrow(/NoSuchUpload/);

    expect(stub.objects.size).toBe(0);
    expect(names.pins.size).toBe(0);
    expect(stub.requests.map((r) => r.method).slice(-2)).toEqual(["HEAD", "DELETE"]);
  });

  it("leaves one unfinished upload behind when an open's answer was lost, and files the object", async () => {
    // The residue the README hands to the bucket's incomplete-upload expiry:
    // the store opened an upload the caller never heard of, the re-sent open
    // is the one that gets used, and the object completes under it.
    const bytes = Buffer.from("opened twice");
    stub.dropAnswerAt = 1;

    const cid = await put(pinner(), bytes);

    expect(cid).toBe(stub.mintedCid(bytes));
    expect(stub.objects.get(names.pins.get(cid) as string)).toEqual(bytes);
    expect(stub.uploads.size).toBe(1);
    expect(stub.requests.filter((r) => r.url.endsWith("?uploads="))).toHaveLength(2);
  });

  it("drops the object when the name book refuses the row", async () => {
    // A random key no row names is unreachable for good — a retry of the same
    // bytes lands on a new key — so a failed insert must not leave it behind.
    const refusing = {
      query: async (text: string) => {
        if (text.includes("INSERT INTO pins")) throw new Error("name book unavailable");
        return { rows: [] };
      },
    } as unknown as Db;

    await expect(put(pinner({}, refusing), Buffer.from("unrecorded"))).rejects.toThrow(
      /name book unavailable/,
    );

    expect(stub.objects.size).toBe(0);
    expect(stub.requests.at(-1)?.method).toBe("DELETE");
  });

  it("gives up after the last attempt when every connection is dropped", async () => {
    stub.dropRequests = SEND_ATTEMPTS;

    await expect(put(pinner(), Buffer.from("dropped always"))).rejects.toThrow(/fetch failed/);

    expect(stub.requests).toHaveLength(SEND_ATTEMPTS);
    expect(stub.requests.every((r) => r.url.endsWith("?uploads="))).toBe(true);
    expect(stub.uploads.size).toBe(0);
    expect(stub.objects.size).toBe(0);
  });

  it("abandons the upload it opened when a part is refused, rather than leaving it open", async () => {
    // An abandoned multipart upload is billed storage that no listing shows and
    // no lifecycle rule on the object prefix reaches — it is only visible to
    // `ListMultipartUploads`. A node that opened one and walked away would leak
    // the batch's whole input file, silently, on every failed pin.
    const bytes = bigBody(3);
    stub.failPartNumber = 2;

    await expect(put(partedPinner(), bytes)).rejects.toThrow();

    expect(stub.uploads.size).toBe(0);
    expect(stub.requests.at(-1)?.method).toBe("DELETE");
  });

  // -------------------------------------------------------------------------
  // Objects that never exist whole in this process
  // -------------------------------------------------------------------------

  /**
   * The property these tests are about is not "it works" but **when** the bytes
   * leave: a part must be on the wire before the caller has finished writing, or
   * the upload is a buffer with extra steps.
   */
  const drain = async (upload: PinUpload, chunks: Buffer[]): Promise<void> => {
    for (const chunk of chunks) await upload.write(chunk);
  };

  it("puts a part before the caller has finished writing", async () => {
    const p = partedPinner();
    const upload = p.open();
    // Two parts' worth, a realistic chunk at a time — nothing this process ever
    // holds whole.
    const chunks = Array.from({ length: 16 }, (_, index) =>
      Buffer.alloc(SMALL_PART / 4, String.fromCharCode(97 + index)),
    );

    await drain(upload, chunks.slice(0, 12));
    // Three parts' worth written, so the store has already been given at least
    // one of them: this is the whole claim, and a buffering implementation that
    // put everything at `finish` would have made no request at all by now.
    expect(stub.requests.some((r) => r.url.includes("partNumber="))).toBe(true);

    await drain(upload, chunks.slice(12));
    const cid = await upload.finish();

    const whole = Buffer.concat(chunks);
    expect(cid).toBe(stub.mintedCid(whole));
    sameBytes(await p.fetch(cid, { maxBytes: whole.length }), whole);
  });

  it("files a stream that fits in one part as one part, and names it like any other", async () => {
    const p = partedPinner();
    const upload = p.open();
    await drain(upload, [Buffer.from("half a "), Buffer.from("line")]);

    const cid = await upload.finish();

    expect(stub.requests.map((r) => r.method)).toEqual(["POST", "PUT", "POST"]);
    // The same bytes, handed over whole, get the same name — and the duplicate
    // object is dropped, so the two arrivals still leave one object.
    expect(await put(p, Buffer.from("half a line"))).toBe(cid);
    expect(stub.objects.size).toBe(1);
  });

  it("abandons an upload the caller gives up on, storing nothing", async () => {
    // The door aborts when the rest of the request turns out to be invalid, and
    // this is what makes that safe: an upload opened and walked away from is
    // billed storage only `ListMultipartUploads` can see.
    const p = partedPinner();
    const upload = p.open();
    await drain(upload, [bigBody(2)]);

    await upload.abort();

    expect(stub.uploads.size).toBe(0);
    expect(stub.objects.size).toBe(0);
    expect(stub.requests.at(-1)?.method).toBe("DELETE");
  });

  it("costs no request at all when the caller gives up before the first part", async () => {
    const upload = partedPinner().open();
    await drain(upload, [Buffer.from("not even one part")]);

    await upload.abort();

    expect(stub.requests).toEqual([]);
  });

  it("abandons an upload whose part the store refuses", async () => {
    stub.failPartNumber = 1;
    const upload = partedPinner().open();

    await expect(drain(upload, [bigBody(2)])).rejects.toThrow();

    expect(stub.uploads.size).toBe(0);
  });

  it("reads a large object back in ranged chunks, and answers the same bytes", async () => {
    const bytes = bigBody(3);
    const p = partedPinner();
    const cid = await put(p, bytes);
    stub.requests.length = 0;

    sameBytes(await p.fetch(cid, { maxBytes: bytes.length }), bytes);

    // One HEAD-shaped probe is not what this does: the first ranged GET carries
    // `content-range`, which names the total, so the size is learned from the
    // read itself rather than from a second round trip.
    const ranges = stub.requests.map((r) => r.headers.range).filter(Boolean);
    expect(ranges.length).toBeGreaterThan(1);
    expect(ranges[0]).toBe(`bytes=0-${SMALL_PART - 1}`);
  });

  it("refuses an object past the ceiling the caller allowed, without reading it", async () => {
    const bytes = bigBody(3);
    const p = partedPinner();
    const cid = await put(p, bytes);
    stub.requests.length = 0;

    await expect(p.fetch(cid, { maxBytes: SMALL_PART })).rejects.toThrow(/ceiling/);
    // One range asked for, none of the object assembled: the refusal is on the
    // total the store declared, not on what arrived.
    expect(stub.requests).toHaveLength(1);
  });

  /**
   * **R73, and it is the assertion whose absence hid the bug.** The tree used to
   * state both halves separately — "the name is the store's, not ours" in one
   * test and "a spec CID re-derives its key" in another — and never joined them,
   * so nothing noticed that every object this node pinned was a guaranteed 404
   * through its own read path.
   *
   * The stub mints `bexternallyminted…`, which is deliberately **not** a spec
   * CID: `contentHashOfCid` returns null for it, so this passes only if the
   * mapping written at completion is what resolves the read.
   */
  it("closes the round trip on a store that mints its own name: fetch(put(b)) is b", async () => {
    const p = pinner();
    const bytes = Buffer.from("a task payload the store names itself");

    const cid = await put(p, bytes);

    expect(contentHashOfCid(cid)).toBeNull(); // the name carries no key at all
    expect(await p.fetch(cid)).toEqual(bytes);
    // The mapping is the mechanism, and it is the key the object was put under.
    expect(names.pins.get(cid)).toMatch(/^stream-/);
  });

  it("resolves a name this node did not mint by re-deriving the key", async () => {
    // A provider holding a `task_cid` from a job some other coordinator pinned:
    // there is no row for it here, and a spec CID carries its own key.
    const bytes = Buffer.from("pinned somewhere else");
    stub.objects.set(sha256Hex(bytes), bytes);

    expect(names.pins.size).toBe(0);
    expect(await pinner().fetch(cidForBytes(bytes))).toEqual(bytes);
  });

  it("fails the pin rather than issuing a name it could not record", async () => {
    // A minted name whose mapping was never written is a name this node will 404
    // forever — and on both write doors it would go on chain in the very next
    // statement. The caller is owed the failure, not the unusable name.
    const broken = {
      query: () => Promise.reject(new Error("connection terminated unexpectedly")),
    } as unknown as Db;

    await expect(put(pinner({}, broken), Buffer.from("unrecorded"))).rejects.toThrow(
      /connection terminated/,
    );
  });

  it("removes the object and then the row that says where it lived", async () => {
    const p = pinner();
    const cid = await put(p, Buffer.from("swept"));
    const key = names.pins.get(cid) as string;

    await p.remove(cid);

    expect(stub.objects.has(key)).toBe(false);
    expect(names.pins.has(cid)).toBe(false);
    expect(await p.fetch(cid)).toBeNull();
  });

  it("counts a 404 from the store as deleted and still forgets the name", async () => {
    // Stores differ on a key they do not hold. Either answer means the object is
    // gone, and a row kept for it would be retried by every later sweep.
    const p = pinner();
    const cid = await put(p, Buffer.from("already gone"));
    stub.deleteStatus = 404;

    await p.remove(cid);

    expect(names.pins.has(cid)).toBe(false);
  });

  it("keeps the row when the store refuses the delete, so the next sweep retries", async () => {
    const p = pinner();
    const cid = await put(p, Buffer.from("refused"));
    stub.deleteStatus = 500;

    await expect(p.remove(cid)).rejects.toThrow(StoreRejected);
    expect(names.pins.get(cid)).toMatch(/^stream-/);
  });

  it("asks the store nothing for a name it has no key for", async () => {
    const p = pinner();
    stub.requests.length = 0;

    await p.remove("bexternallymintednotours");

    expect(stub.requests).toHaveLength(0);
  });

  it("names a redirect instead of following it into an unverifiable signature", async () => {
    // S3's `301 PermanentRedirect` for a bucket in another region is one of the
    // handful of misconfigurations operators actually make, and following it
    // would carry a signature bound to the old host — it could only fail, one hop
    // later and with the cause gone. Previously: a bare `fetch failed`.
    stub.redirectTo = "https://example.s3.eu-west-1.example.invalid/example/key";

    await expect(put(pinner(), Buffer.from("wrong region"))).rejects.toThrow(
      /307.*s3\.eu-west-1\.example\.invalid/s,
    );
    // Followed, this would be a second request to the redirect target.
    expect(stub.requests).toHaveLength(1);
  });
});

describe("pinnerFor", () => {
  it("returns the object-store pinner, because there is no other", () => {
    // One backend. `loadConfig` requires the whole `PIN_S3_*` group at boot
    // (see `test/config.test.ts`), so by the time a `Config` exists there is a
    // store or the process never started — which is why this has nothing to
    // choose between and no `null` branch to take.
    const config: Config = testConfig();
    expect(pinnerFor(config, unreachableDb())).toBeInstanceOf(S3Pinner);
  });
});

/** A database no test in this half may reach. */
const unreachableDb = (): Db => ({
  query: () => Promise.reject(new Error("no query expected")),
  tx: () => Promise.reject(new Error("no transaction expected")),
  migrate: () => Promise.reject(new Error("no migration expected")),
  close: async () => undefined,
});

// ---------------------------------------------------------------------------
// A store that answers and refuses, against a store that is not there
// ---------------------------------------------------------------------------

/**
 * The same classification, seen from the outside — through the door that pins.
 *
 * `settle` is the smaller of the two pinning doors to drive (one signature, no
 * payment) and it exercises the identical helper, `api/pin-failure.ts`, that
 * `POST /v1/jobs` uses. What is asserted is the envelope: the status, the
 * retryability header, the `code` that tells an operator whether to wait or to
 * act, and the `fatal` line that wakes them.
 *
 * **And that nothing was relayed.** The pin is upstream of the simulate on
 * purpose, so a store failure must leave `broadcasts` and `simulated` both empty
 * — a settle whose result was never filed must not put a name on chain.
 */
describe("a permanently misconfigured object store", () => {
  let stub: StubStore;

  beforeAll(async () => {
    stub = await startStubStore();
  });
  afterAll(async () => {
    await stub.close();
  });
  afterEach(() => {
    stub.omitCid = false;
  });

  const settleDb = (): Db =>
    ({
      query: (async (text: string, params?: readonly unknown[]) => {
        if (text.includes("FROM sessions")) {
          return {
            rows:
              params?.[0] === SESSION
                ? [
                    {
                      token: SESSION,
                      address: Buffer.alloc(20, 0x77),
                      role: "provider",
                      provider_id: PROVIDER_ID,
                      expires_at: 4_102_444_800n,
                    },
                  ]
                : [],
          };
        }
        if (text.includes("FROM providers")) return { rows: [{ provider_id: PROVIDER_ID }] };
        if (text.includes("INSERT INTO pins")) return { rows: [{ s3_key: params?.[1] }] };
        throw new Error(`settleDb: unexpected query ${text}`);
      }) as unknown as Db["query"],
      tx: () => Promise.reject(new Error("no transaction expected")),
      migrate: () => Promise.reject(new Error("no migration expected")),
      close: async () => undefined,
    }) as Db;

  /** The settle door over an object store, with every `fatal` line it writes. */
  function doorOverStore(overrides: Partial<S3PinConfig>): {
    server: FastifyInstance;
    chain: StubChain;
    fatal: { storeStatus?: number; storeCode?: string; msg: string }[];
  } {
    const fatal: { storeStatus?: number; storeCode?: string; msg: string }[] = [];
    const config = testConfig({ pinS3: stub.config(overrides) });
    const chain = stubChain(config, {});
    const server = buildApp({
      db: settleDb(),
      indexer: stubIndexer(),
      config,
      chain: chain.chain,
      // `fatal` only, so the array below *is* the set of lines an operator is
      // meant to be woken by.
      logger: {
        level: "fatal",
        stream: { write: (line: string) => void fatal.push(JSON.parse(line)) },
      },
    });
    return { server, chain, fatal };
  }

  /** A well-formed `settle`, signed to the contract's own typehash string. */
  const settle = async (server: FastifyInstance) => {
    const issuedAt = BigInt(Math.floor(Date.now() / 1000));
    const jobId = `0x${"01".repeat(32)}` as const;
    const signature = await provider.signTypedData({
      domain: {
        name: EIP712_NAMES.job,
        version: "2",
        chainId: testConfig().addresses.chainId,
        verifyingContract: testConfig().addresses.jobRegistry,
      },
      // `Settle(bytes32 jobId,uint32 completionTok,uint64 issuedAt)` — written
      // out from `JobRegistry.sol`, and `resultCid` is not one of its members.
      types: {
        Settle: [
          { name: "jobId", type: "bytes32" },
          { name: "completionTok", type: "uint32" },
          { name: "issuedAt", type: "uint64" },
        ],
      },
      primaryType: "Settle",
      message: { jobId, completionTok: 12, issuedAt },
    });
    return server.inject({
      method: "POST",
      url: "/evm/ops",
      headers: { authorization: `Bearer ${SESSION}` },
      payload: {
        op: "settle",
        job_id: jobId,
        completion_tok: 12,
        issued_at: Number(issuedAt),
        signature,
        result: Buffer.from("bytes that are fine").toString("base64"),
      },
    });
  };

  it("says the store refused — and says so at fatal, with the store's own code", async () => {
    // Wrong credentials. Every retry answers identically until a human changes
    // `PIN_S3_SECRET`, and before this the envelope was indistinguishable
    // from a store that was merely rebooting.
    const { server, chain, fatal } = doorOverStore({ secret: "not-the-secret" });

    const res = await settle(server);

    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatchObject({
      type: "pinner_unavailable",
      code: "store_rejected",
    });
    // The 503 stays retryable on purpose: the *caller's* bytes really are fine,
    // and R57 says the header is the contract. The `code` is what carries "this
    // one will not fix itself".
    expect(res.headers["x-vorq-retryable"]).toBe("true");
    // The envelope still says nothing about the deployment.
    expect(res.json().error.message).toBe("The pinning service could not be reached.");
    // The ordering that matters: nothing was simulated and nothing was relayed.
    expect(chain.simulated).toEqual([]);
    expect(chain.broadcasts).toEqual([]);

    expect(fatal).toHaveLength(1);
    expect(fatal[0]).toMatchObject({ storeStatus: 403, storeCode: "SignatureDoesNotMatch" });
    await server.close();
  });

  it("names a bucket that does not exist at fatal too", async () => {
    const { server, fatal } = doorOverStore({ bucket: "someone-elses" });

    const res = await settle(server);

    expect(res.json().error.code).toBe("store_rejected");
    expect(fatal[0]).toMatchObject({ storeStatus: 404, storeCode: "NoSuchBucket" });
    await server.close();
  });

  it("treats a store that mints no name as a misconfiguration, not an outage", async () => {
    // The one refusal path a status-only classification does not reach: a `200`
    // to the completion with no `<CID>` in it. A bucket or gateway that is not
    // set up to mint names answers every put this way and will until a human
    // changes it — which is `store_rejected` at `fatal`, the same as a wrong key.
    // As a bare `Error` it read as `store_unavailable` at `error`: wait for a
    // dependency that is up and doing exactly as configured.
    stub.omitCid = true;
    const { server, chain, fatal } = doorOverStore({});

    const res = await settle(server);

    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("store_rejected");
    expect(res.headers["x-vorq-retryable"]).toBe("true");
    expect(chain.broadcasts).toEqual([]);
    expect(fatal).toHaveLength(1);
    expect(fatal[0]).toMatchObject({ storeStatus: 200, storeCode: NO_CID_MINTED });
    await server.close();
  });

  it("keeps a store that is simply unreachable at store_unavailable, and off fatal", async () => {
    // Nothing answered. This one really may heal itself, and waking an operator
    // for it is how a fatal line stops meaning anything.
    const { server, chain, fatal } = doorOverStore({ endpoint: "http://127.0.0.1:1" });

    const res = await settle(server);

    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("store_unavailable");
    expect(chain.broadcasts).toEqual([]);
    expect(fatal).toEqual([]);
    await server.close();
  });
});

// ---------------------------------------------------------------------------
// R44 / R47 — the drop set is a list, not a comment
// ---------------------------------------------------------------------------

describe("the rebuild path's drop set", () => {
  const dir = new URL("../src/db/migrations/", import.meta.url);
  const schema = readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .map((name) => readFileSync(new URL(name, dir), "utf8"))
    .join("\n");
  // `schema_migrations` is created by `migrate()` itself, before any migration runs.
  const declared = [
    ...[...schema.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]),
    "schema_migrations",
  ];

  it("leaves out every table a replay cannot rebuild", () => {
    // `pins` is the only book naming where a store-minted CID's object lives and
    // no chain log carries it; `quotes_live` holds snapshots providers will not
    // push again on demand. Enforcement, not a comment in a migration (R67) —
    // whoever writes the rebuild drops `DROPPABLE`, and this goes red the day
    // either of these joins it.
    // `batches` and `batch_lines` join them for one reason between them: nothing on
    // chain says a job belongs to a batch — every line is an independent designated
    // order — so a replay brings back every member job and no way to attribute one,
    // and these two rows are the only record of the grouping there is.
    // `files` joins them for `pins`' own reason, one level up: it is the `file_id → cid`
    // book, no chain log carries it, and dropping it leaves every batch naming an input
    // file this node can no longer resolve to an object.
    for (const preserved of ["batch_lines", "batches", "files", "pins", "quotes_live"]) {
      expect(DROPPABLE).not.toContain(preserved);
      expect(PRESERVED).toContain(preserved);
    }
    expect(PRESERVED).toEqual(["batch_lines", "batches", "files", "pins", "quotes_live"]);
  });

  it("classifies every table the migrations declare exactly once", () => {
    // A new table must be *decided* about. Defaulting into either list is how
    // `pins` would have been dropped by a rebuild written six months from now.
    expect([...DROPPABLE, ...PRESERVED].sort()).toEqual([...declared].sort());
    expect(DROPPABLE.filter((table) => PRESERVED.includes(table))).toEqual([]);
  });

  it("agrees with the schema about which tables exist", () => {
    // Guards the regex above: if the migrations stop matching it, this is 0 and
    // the assertion below fails rather than the list silently passing empty.
    expect(declared.length).toBeGreaterThanOrEqual(10);
    expect(declared).toContain("pins");
  });
});

// ---------------------------------------------------------------------------
// The same round trip, against a real Postgres (R25)
// ---------------------------------------------------------------------------

/**
 * Scoped to a schema of this suite's own, so a developer's real projection is
 * never what gets truncated:
 *
 *   docker compose -f compose.dev.yml up -d
 *   TEST_DATABASE_URL=postgres://vorq:vorq@localhost:5433/vorq npm test
 */
function scopedToTestSchema(url: string): string {
  const options = encodeURIComponent(`-c search_path=${TEST_SCHEMA}`);
  return `${url}${url.includes("?") ? "&" : "?"}options=${options}`;
}

describe.skipIf(!TEST_DATABASE_URL)("the name book, against Postgres", () => {
  let db: Db;
  let stub: StubStore;

  beforeAll(async () => {
    const admin = openDb(TEST_DATABASE_URL as string);
    await admin.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
    await admin.close();

    db = openDb(scopedToTestSchema(TEST_DATABASE_URL as string));
    await db.migrate();
    stub = await startStubStore();
  });

  afterAll(async () => {
    await db.query("DELETE FROM pins");
    await db.close();
    await stub.close();
  });

  /**
   * R73 against the real SQL. `stubPinsDb` models `pins` faithfully as far as its
   * *semantics* go, and not at all as far as the statements go — this is the half
   * that would catch a column named wrong or a conflict target that does not
   * exist (R25).
   */
  it("keeps the object-store name book in Postgres, and reads the round trip back", async () => {
    const pinner = new S3Pinner(stub.config(), db);
    const bytes = Buffer.from("named by the store, resolved from pins");

    const cid = await put(pinner, bytes);

    expect(cid).toBe(stub.mintedCid(bytes));
    expect(contentHashOfCid(cid)).toBeNull();
    expect(await pinner.fetch(cid)).toEqual(bytes);

    const { rows } = await db.query<{ s3_key: string }>(
      "SELECT s3_key FROM pins WHERE cid = $1",
      [cid],
    );
    expect(rows[0]?.s3_key).toMatch(/^stream-/);

    // Filing the same bytes again is one row — the property a retried relay
    // depends on — and the real `ON CONFLICT ... RETURNING` is what says so.
    expect(await put(pinner, bytes)).toBe(cid);
    const { rows: counted } = await db.query<{ count: bigint }>(
      "SELECT count(*) AS count FROM pins WHERE cid = $1",
      [cid],
    );
    expect(counted[0]?.count).toBe(1n);
  });

  it("survives a re-migration with its name book intact (R44/R47)", async () => {
    const bytes = Buffer.from("still here after migrate()");
    await db.query("INSERT INTO pins (cid, s3_key) VALUES ($1, $2) ON CONFLICT (cid) DO NOTHING", [
      "bexternallymintedsurvivor",
      sha256Hex(bytes),
    ]);

    // Idempotent by `IF NOT EXISTS` throughout — the thing a rebuild path must
    // not turn into a drop.
    await db.migrate();

    const { rows } = await db.query<{ s3_key: string }>(
      "SELECT s3_key FROM pins WHERE cid = $1",
      ["bexternallymintedsurvivor"],
    );
    expect(rows[0]?.s3_key).toBe(sha256Hex(bytes));
  });
});
