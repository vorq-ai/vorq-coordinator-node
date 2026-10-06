import { keccak256, type Hex } from "viem";
import { formatUsd } from "../src/money.js";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { admitLine, type LineContext } from "../src/batches/lines.js";
import { commitmentOf, CONTAINER_TAG, SEED_WRAP_BYTES } from "../src/container.js";
import type { Db } from "../src/db/db.js";
import { EIP712_NAMES, feeOf } from "../src/orders.js";
import { testConfig } from "./support/stub-chain.js";

/**
 * One input-file line, admitted or skipped.
 *
 * A line **is** the body of `POST /v1/jobs` — the same order, the same
 * `container` / `container_cid` pair, the same payment — so every refusal this
 * file asserts is one the single-job door makes too. What differs is the answer:
 * the door refuses the request, and this skips the line and keeps a receipt,
 * because a batch is up to 50 000 lines and one bad one must not kill the other
 * 49 999 (the `AskRegistry.setAsks` rule the contract's own `postMany` follows).
 *
 * The EIP-712 domains and type strings are written out literally, from the
 * contract sources, rather than imported from `src/orders.ts` — importing them
 * would let a wrong member list agree with itself and pass (R32, R64).
 *
 * No chain and no store. The one read admission can make is the `files` row
 * behind a line's `container_cid`, and it is served by a stub rather than a
 * schema, so a query this code is not supposed to make is a hard failure rather
 * than an empty result set.
 */

const config = testConfig();
const { chainId, jobRegistry, usdc } = config.addresses;

/** Throwaway scalars. Neither has ever held value on any chain. */
const owner = privateKeyToAccount(`0x${"66".repeat(32)}`);
const stranger = privateKeyToAccount(`0x${"77".repeat(32)}`);

/** The batch owner whose uploads a line may name — the session that created it. */
const BATCH_OWNER = Buffer.alloc(20, 0x0b);

const containerOf = (ciphertext: string): Buffer =>
  Buffer.concat([CONTAINER_TAG, Buffer.alloc(SEED_WRAP_BYTES, 0xd1), Buffer.from(ciphertext, "utf8")]);

const CONTAINER = containerOf("a sealed prompt envelope");
const C = commitmentOf(CONTAINER);

const NOW = 1_800_000_000n;
const GAS_FEE = 500_000n;

interface Terms {
  c: Hex;
  modelId: bigint;
  slaSecs: bigint;
  rateIn: bigint;
  rateOut: bigint;
  unitsIn: bigint;
  unitsOut: bigint;
  designated: bigint;
  expiresAt: bigint;
}

const terms = (overrides: Partial<Terms> = {}): Terms => ({
  c: C,
  modelId: 1n,
  slaSecs: 3600n,
  rateIn: 30_000n,
  rateOut: 90_000n,
  unitsIn: 1000n,
  unitsOut: 2000n,
  designated: 7n,
  expiresAt: NOW + 3600n,
  ...overrides,
});

/** `ceilDiv(rateIn*unitsIn + rateOut*unitsOut, RATE_SCALE)`, spelled out. */
const capFor = (t: Terms): bigint => {
  const scaled = t.rateIn * t.unitsIn + t.rateOut * t.unitsOut;
  const cap = (scaled + 999_999n) / 1_000_000n;
  return cap === 0n ? 1n : cap;
};

/** The protocol's own fee, and the one every context here charges. */
const FEE_BPS = 100;

/** The pull a line's payment must be for: `cap + cap*feeBps/10000 + gasFeeSnap`. */
const amountFor = (t: Terms, feeBps = FEE_BPS): bigint =>
  capFor(t) + feeOf(capFor(t), feeBps) + GAS_FEE;

// ---------------------------------------------------------------------------
// Signing, to the contracts' own typehash strings
// ---------------------------------------------------------------------------

const orderDomain = {
  name: EIP712_NAMES.job,
  version: "2",
  chainId,
  verifyingContract: jobRegistry,
} as const;

const orderTypes = {
  Order: [
    { name: "c", type: "bytes32" },
    { name: "modelId", type: "uint32" },
    { name: "slaSecs", type: "uint32" },
    { name: "rateIn", type: "uint128" },
    { name: "rateOut", type: "uint128" },
    { name: "unitsIn", type: "uint32" },
    { name: "unitsOut", type: "uint32" },
    { name: "designated", type: "uint32" },
    { name: "expiresAt", type: "uint64" },
  ],
} as const;

const signOrder = (t: Terms, signer = owner): Promise<Hex> =>
  signer.signTypedData({
    domain: orderDomain,
    types: orderTypes,
    primaryType: "Order",
    message: {
      c: t.c,
      modelId: Number(t.modelId),
      slaSecs: Number(t.slaSecs),
      rateIn: t.rateIn,
      rateOut: t.rateOut,
      unitsIn: Number(t.unitsIn),
      unitsOut: Number(t.unitsOut),
      designated: Number(t.designated),
      expiresAt: t.expiresAt,
    },
  });

/** `keccak256(abi.encodePacked(owner, c))` — 20 bytes then 32. */
const jobIdFor = (address: Hex, c: Hex): Hex => keccak256(`0x${address.slice(2)}${c.slice(2)}` as Hex);

const authDomain = { name: "USDC", version: "2", chainId, verifyingContract: usdc } as const;

const authTypes = {
  ReceiveWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

const signAuthorization = (
  jobId: Hex,
  value: bigint,
  expiresAt: bigint,
  signer = owner,
): Promise<Hex> =>
  signer.signTypedData({
    domain: authDomain,
    types: authTypes,
    primaryType: "ReceiveWithAuthorization",
    message: {
      from: owner.address,
      to: jobRegistry,
      value,
      validAfter: 0n,
      // `expiresAt + 1`: the token requires `now < validBefore`, and a claim may
      // land on `expiresAt` itself.
      validBefore: expiresAt + 1n,
      nonce: jobId,
    },
  });

// ---------------------------------------------------------------------------
// A line
// ---------------------------------------------------------------------------

/**
 * The `files` read `container_cid` makes, and nothing else.
 *
 * `uploads` is `cid → {owner, purpose, commitment}`, and the stub applies the
 * whole predicate `findUpload` sends — owner and purpose included — so a test
 * that expects a miss gets one for the reason it names.
 */
type Upload = { owner: Buffer; purpose: string; commitment: Buffer | null };

function stubDb(uploads: Map<string, Upload> = new Map()): Db {
  const query = (async (text: string, params?: readonly unknown[]) => {
    if (!text.includes("FROM files")) throw new Error(`stubDb: unexpected query ${text}`);
    const [cid, ownerBytes, purpose] = params as [string, Buffer, string];
    const found = uploads.get(cid);
    if (found === undefined || found.purpose !== purpose || !found.owner.equals(ownerBytes)) {
      return { rows: [] };
    }
    return { rows: [{ cid, commitment: found.commitment }] };
  }) as Db["query"];
  return {
    query,
    tx: () => Promise.reject(new Error("stubDb: no transaction expected")),
    migrate: () => Promise.reject(new Error("stubDb: no migration expected")),
    close: async () => undefined,
  };
}

const context = (overrides: Partial<LineContext> = {}): LineContext => ({
  db: stubDb(),
  endpoint: "/v1/responses",
  owner: BATCH_OWNER,
  addresses: config.addresses,
  now: NOW,
  gasFee: GAS_FEE,
  feeBps: FEE_BPS,
  // The default is the ordinary account: no code, so the line is judged on
  // everything else. A case that wants a code-bearing payer says so.
  hasCode: async () => false,
  ...overrides,
});

interface LineOptions {
  terms?: Terms;
  container?: Buffer;
  /** Sent instead of `container`, for a line that references an upload. */
  containerCid?: string;
  orderSigner?: typeof owner;
  authSigner?: typeof owner;
  amount?: bigint;
  url?: string;
  patch?: Record<string, unknown>;
}

/** A complete line: the `POST /v1/jobs` body, one JSON object, one file line. */
async function line(options: LineOptions = {}): Promise<string> {
  const t = options.terms ?? terms();
  const container = options.container ?? CONTAINER;
  const jobId = jobIdFor(owner.address, t.c);
  const amount = options.amount ?? amountFor(t);
  return JSON.stringify({
    url: options.url ?? "/v1/responses",
    c: t.c,
    owner: owner.address,
    job_id: jobId,
    model_id: Number(t.modelId),
    sla_secs: Number(t.slaSecs),
    rate_in: formatUsd(t.rateIn, 6),
    rate_out: formatUsd(t.rateOut, 6),
    units_in: Number(t.unitsIn),
    units_out: Number(t.unitsOut),
    designated: Number(t.designated),
    expires_at: Number(t.expiresAt),
    signature: await signOrder(t, options.orderSigner ?? owner),
    ...(options.containerCid === undefined
      ? { container: container.toString("base64") }
      : { container_cid: options.containerCid }),
    auth_sig: await signAuthorization(jobId, amount, t.expiresAt, options.authSigner ?? owner),
    amount: formatUsd(amount, 6),
    ...options.patch,
  });
}

/** The skip code, or `null` when the line was admitted. Keeps every assertion one line. */
async function skipCode(raw: string, ctx = context()): Promise<string | null> {
  const verdict = await admitLine(raw, ctx);
  return verdict.ok ? null : verdict.skip.code;
}

describe("admitting one input-file line", () => {
  it("admits a complete, correctly signed line and hands back its parsed order", async () => {
    const verdict = await admitLine(await line(), context());

    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.line.owner.toLowerCase()).toBe(owner.address.toLowerCase());
    expect(verdict.line.jobId).toBe(jobIdFor(owner.address, C));
    expect(verdict.line.terms.c).toBe(C);
    expect(verdict.line.terms.designated).toBe(7n);
    // The bytes themselves, decoded — the worker files exactly these to mint the
    // line's `task_cid`, and a container that survived the round trip altered
    // would miss the commitment every provider re-derives.
    expect(verdict.line.content).toEqual({ kind: "inline", bytes: CONTAINER });
  });

  it("skips a line that is not JSON at all", async () => {
    expect(await skipCode("{not json")).toBe("invalid_json");
  });

  it("skips a line whose JSON is not an object", async () => {
    expect(await skipCode("[1, 2, 3]")).toBe("invalid_line");
  });

  it("skips a line missing the order block entirely", async () => {
    expect(await skipCode(JSON.stringify({ container: CONTAINER.toString("base64") }))).toBe(
      "invalid_line",
    );
  });

  it("skips a line whose container misses the commitment its order signed", async () => {
    const other = containerOf("different bytes entirely");
    expect(await skipCode(await line({ container: other }))).toBe("commitment_mismatch");
  });

  it("admits a container of any size a line can carry: there is no per-line cap", async () => {
    // The 256 KiB per-line bound is gone. What
    // bounds a line now is the input file the whole batch arrived in
    // (`MAX_BLOB_BYTES`) and nothing narrower, so a container far past the old
    // ceiling is admitted on its own terms.
    const big = containerOf("x".repeat(512 * 1024));
    const verdict = await admitLine(
      await line({ terms: terms({ c: commitmentOf(big) }), container: big }),
      context(),
    );

    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.line.content).toEqual({ kind: "inline", bytes: big });
  });

  it("skips a line carrying neither container nor container_cid", async () => {
    const raw = JSON.parse(await line()) as Record<string, unknown>;
    delete raw.container;
    expect(await skipCode(JSON.stringify(raw))).toBe("container_required");
  });

  it("skips a line that names both a container and a container_cid", async () => {
    // Two containers do not say which one `c` commits to, and picking either
    // would be this node deciding which bytes the client meant to pay for.
    expect(await skipCode(await line({ patch: { container_cid: "bafyupload" } }))).toBe(
      "container_ambiguous",
    );
  });

  // -------------------------------------------------------------------------
  // A line that references an upload rather than inlining one
  // -------------------------------------------------------------------------

  const CID = "bafyuploadedcontainer";

  const withUpload = (upload: Partial<Upload> = {}): LineContext =>
    context({
      db: stubDb(
        new Map([
          [
            CID,
            {
              owner: BATCH_OWNER,
              purpose: "input",
              commitment: Buffer.from(C.slice(2), "hex"),
              ...upload,
            },
          ],
        ]),
      ),
    });

  it("admits a line whose container_cid names an input upload with the signed commitment", async () => {
    // The cid **is** the `task_cid`: the bytes are already in the store, so the
    // worker files nothing for this line. What stands in for hashing them is
    // `files.commitment`, which `POST /v1/files` computed as they streamed past.
    const verdict = await admitLine(await line({ containerCid: CID }), withUpload());

    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.line.content).toEqual({ kind: "cid", cid: CID });
  });

  it("skips a line whose container_cid names no upload of this batch owner's", async () => {
    // A miss, a stranger's upload and an upload under another purpose are one
    // answer — and a skip rather than a refusal, so one line referencing a file
    // that expired does not cost the other 49 999.
    expect(await skipCode(await line({ containerCid: "bafynothing" }), withUpload())).toBe(
      "unknown_container",
    );
    expect(
      await skipCode(
        await line({ containerCid: CID }),
        withUpload({ owner: Buffer.alloc(20, 0xee) }),
      ),
    ).toBe("unknown_container");
    expect(
      await skipCode(await line({ containerCid: CID }), withUpload({ purpose: "result" })),
    ).toBe("unknown_container");
  });

  it("skips a line whose upload was committed to under another order's c", async () => {
    const other = commitmentOf(containerOf("different bytes entirely"));
    expect(
      await skipCode(
        await line({ containerCid: CID }),
        withUpload({ commitment: Buffer.from(other.slice(2), "hex") }),
      ),
    ).toBe("commitment_mismatch");
  });

  it("skips a line whose order signature recovers to somebody else", async () => {
    expect(await skipCode(await line({ orderSigner: stranger }))).toBe("invalid_order_signature");
  });

  it("skips a line whose payment was authorized by somebody else", async () => {
    expect(await skipCode(await line({ authSigner: stranger }))).toBe("invalid_payment_signature");
  });

  it("skips a line whose job_id is not keccak256(owner ‖ c)", async () => {
    const raw = JSON.parse(await line()) as Record<string, unknown>;
    raw.job_id = `0x${"11".repeat(32)}`;
    expect(await skipCode(JSON.stringify(raw))).toBe("invalid_line");
  });

  it("skips a line that has already expired", async () => {
    expect(await skipCode(await line({ terms: terms({ expiresAt: NOW - 1n }) }))).toBe(
      "order_expired",
    );
  });

  it("skips a line whose expiry is further out than the chain's own ceiling", async () => {
    expect(await skipCode(await line({ terms: terms({ expiresAt: NOW + 86_401n }) }))).toBe(
      "expiry_too_far",
    );
  });

  it("skips a line whose SLA is past the ceiling", async () => {
    expect(await skipCode(await line({ terms: terms({ slaSecs: 86_401n }) }))).toBe("sla_too_long");
  });

  /**
   * **One payable amount, exactly as the single-job door has it.** The claim
   * pulls the *signed* value, so a line authorized for more than
   * `cap + feeCap + gasFeeSnap` moves the difference out of the client's wallet
   * and a line authorized for less reverts. This door used to admit the
   * over-signed line — that looseness belonged to a scheme whose signature was a
   * ceiling the claim drew under, and it does not survive the change.
   */
  it("skips a line authorized for more than the pull as well as one for less", async () => {
    const t = terms();
    expect(await skipCode(await line({ terms: t, amount: amountFor(t) + 1n }))).toBe(
      "insufficient_payment",
    );
    expect(await skipCode(await line({ terms: t, amount: amountFor(t) - 1n }))).toBe(
      "insufficient_payment",
    );
    expect(await skipCode(await line({ terms: t, amount: amountFor(t) }))).toBe(null);
  });

  /**
   * The pull is `cap + cap*feeBps/10000 + gasFeeSnap`, so an authorization for
   * only the cap and the gas fee is short by the protocol fee and the claim
   * would revert — a line the worker must skip rather than post.
   */
  it("skips a line whose authorization leaves the protocol fee out", async () => {
    const t = terms();
    expect(
      await skipCode(await line({ terms: t, amount: capFor(t) + GAS_FEE }), context({ feeBps: 250 })),
    ).toBe("insufficient_payment");
  });

  it("admits a line authorized for the cap, the protocol fee and the gas fee", async () => {
    const t = terms();
    const amount = capFor(t) + (capFor(t) * 250n) / 10000n + GAS_FEE;
    expect(await skipCode(await line({ terms: t, amount }), context({ feeBps: 250 }))).toBe(null);
  });

  it("skips a line addressed to an endpoint this batch is not for", async () => {
    expect(await skipCode(await line({ url: "/v1/embeddings" }))).toBe("endpoint_mismatch");
  });

  it("admits a line that names no url at all: the batch's endpoint is the one that binds", async () => {
    const raw = JSON.parse(await line()) as Record<string, unknown>;
    delete raw.url;
    expect(await skipCode(JSON.stringify(raw))).toBe(null);
  });

  it("skips a line whose rates are wider than the chain's uint128", async () => {
    const raw = JSON.parse(await line()) as Record<string, unknown>;
    raw.rate_in = ((1n << 128n) + 1n).toString();
    expect(await skipCode(JSON.stringify(raw))).toBe("invalid_line");
  });

  /**
   * The batch half of `POST /v1/jobs`'s `payer_has_code`. A code-bearing payer is
   * validated by the payment token through ERC-1271 rather than `ecrecover`, so
   * this line's authorization — which recovers perfectly — can never be
   * collected, and posting it would spend gas on a job that rests Open to expiry.
   */
  it("skips a line whose payer carries contract code", async () => {
    const asked: string[] = [];
    const ctx = context({
      hasCode: async (address) => {
        asked.push(address.toLowerCase());
        return true;
      },
    });
    expect(await skipCode(await line(), ctx)).toBe("payer_has_code");
    // The line's own signer, not the batch's owner: a batch may carry orders
    // signed by several wallets and it is the payer whose code matters.
    expect(asked).toEqual([owner.address.toLowerCase()]);
  });

  it("asks about the payer only once every cheaper check has passed", async () => {
    const asked: string[] = [];
    const ctx = context({
      hasCode: async (address) => {
        asked.push(address.toLowerCase());
        return false;
      },
    });
    // A line refused on its order signature never pays for the round trip.
    expect(await skipCode(await line({ orderSigner: stranger }), ctx)).toBe("invalid_order_signature");
    expect(asked).toEqual([]);
  });

  it("carries a message with every skip, so the error file row says what went wrong", async () => {
    const verdict = await admitLine(await line({ orderSigner: stranger }), context());
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.skip.message.length).toBeGreaterThan(0);
  });
});
