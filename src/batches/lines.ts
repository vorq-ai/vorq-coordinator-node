import { Type, type Static } from "typebox";
import type { Hex } from "viem";
import { ApiError } from "../api/errors.js";
import { bodyAjv, validationFailure } from "../api/schemas/ajv.js";
import type { Address, Addresses } from "../config.js";
import { assertCommitment, assertSameCommitment, ContainerError } from "../container.js";
import {
  authorizationTypedData,
  capOf,
  CapOverflowError,
  feeOf,
  MAX_EXPIRY_SECONDS,
  MAX_SLA_SECONDS,
  orderTypedData,
  type Terms,
} from "../orders.js";
import type { Queryable } from "../db/db.js";
import { findUpload } from "../api/routes/files.js";
import {
  parseContent,
  parseOrder,
  parsePayment,
  recovers,
  Submission,
  type Content,
} from "../submission.js";

/** A line: a submission, plus OpenAI's optional per-line `url`. */
const Line = Type.Object(
  { ...Submission.properties, url: Type.Optional(Type.String()) },
  { dependentRequired: { auth_sig: ["amount"] } },
);
const validLine = bodyAjv.compile<Static<typeof Line>>(Line);

/**
 * One input-file line, admitted or skipped.
 *
 * ## A line is a `POST /v1/jobs` body
 *
 * The same nine signed members, the same `container` / `container_cid` pair, the
 * same payment — parsed by the same {@link parseOrder} and
 * {@link parseContent}, because a batch line **is** a single-job submission that
 * happens to arrive fifty thousand at a time. Nothing about a line is
 * batch-shaped except the file it sits on.
 *
 * That is a deliberate departure from the recovered shape doc, which spelled the
 * container under an `input` key inherited from the retired `{enc, ciphertext}`
 * wire form. One name for one field: the client SDK builds a line with the code
 * that builds a submission, and this node reads it with the code that reads one.
 *
 * `custom_id` is **not on the line**. It is the caller's own text, it travels
 * sealed inside the container, and it comes back inside the sealed result — so it
 * never reaches this node in the clear and there is nothing here to parse.
 *
 * ## Skip, never refuse
 *
 * Every refusal below produces a {@link LineSkip} rather than an error, and the
 * batch continues. That is the `AskRegistry.setAsks` rule the contract's own
 * `postMany` follows, and at a 50 000-line cap it is the only coherent choice: an
 * all-or-nothing create would throw away 49 999 good lines — and the ~8 minutes of
 * pinning already spent on them — for one line with a typo. The skip's `code` is
 * what the error-file row for that line carries.
 *
 * ## Almost everything here is free
 *
 * No store: admission is the set of checks that cost no round trip, which is what
 * lets 50 000 of them run before a single object is filed. There are two
 * exceptions. A line that references its container by cid is one indexed `files`
 * read, and there is no way to check such a line without it. A line's payer is
 * one `eth_getCode` — read once per payer for the whole file by the closure the
 * worker supplies, so a file signed by one wallet costs one call. The two
 * checks that are not a line's own — is this model in the catalog, and does this
 * `job_id` repeat — are the worker's, and it makes them in bulk.
 *
 * ## A referenced upload has 300 seconds to be taken up
 *
 * An upload nobody has attached is deleted 300 s after it is made, and the
 * attach for a line's `container_cid` happens when the **worker** reaches that
 * line — not when the batch is created. So a client uploads its containers
 * immediately before creating the batch, and keeps a batch of them small enough
 * that the worker reaches its last line inside that window; anything older is
 * skipped `unknown_container`, whichever door it was uploaded through.
 */

/** What the worker needs from the batch to judge a line, read once per batch. */
export interface LineContext {
  /** Reads the `files` row behind a line's `container_cid`. */
  db: Queryable;
  /** The batch's own endpoint. A line naming a different one is a mistake worth saying. */
  endpoint: string;
  /**
   * The batch's owner, and the only account whose uploads its lines may name.
   *
   * A line's `owner` is the order's signer and is not necessarily this — a batch
   * may carry orders signed by several wallets — but the file a line references
   * is scoped to whoever created the batch, because that is the session the
   * upload was made under.
   */
  owner: Buffer;
  /** The deployment both of a line's signatures are verified against. */
  addresses: Addresses;
  /** Unix seconds, taken once for the whole file so lines are judged against one instant. */
  now: bigint;
  /** `JobRegistry.gasFee()`, read once per batch — every line's payment must cover it. */
  gasFee: bigint;
  /** `JobRegistry.feeBps()`, read once per batch — the fee every line's payment must also cover. */
  feeBps: number;
  /**
   * Whether one account carries code at `latest` — `eth_getCode`, and the one
   * chain read a line's own checks make.
   *
   * A code-bearing payer is validated by the payment token through ERC-1271
   * rather than `ecrecover`, so its plain EOA authorization fails inside the
   * token at `claim` however well it recovers here. The line is skipped rather
   * than posted, for the same reason every other check on this path exists: the
   * gas is never fronted for a job that can only rest Open to expiry.
   *
   * Supplied by the worker as a closure, so the answer is read **once per payer
   * per batch** rather than once per line — the way `gasFee` and `feeBps` are
   * read once for the whole file. A file of 50 000 lines from one wallet is one
   * `eth_getCode`.
   */
  hasCode: (address: Address) => Promise<boolean>;
}

/** An admitted line: everything the pin and the `postMany` call need, and nothing else. */
export interface AdmittedLine {
  terms: Terms;
  owner: Address;
  jobId: Hex;
  signature: Hex;
  authSig: Hex;
  /**
   * The sealed container, inline or by name. Inline bytes are filed as-is and
   * the name the store mints is this line's `task_cid`; a cid **is** that
   * `task_cid` already.
   */
  content: Content;
}

/** Why a line never became a job. `code` is what its error-file row carries. */
export interface LineSkip {
  code: string;
  message: string;
}

export type LineVerdict = { ok: true; line: AdmittedLine } | { ok: false; skip: LineSkip };

const skip = (code: string, message: string): LineVerdict => ({ ok: false, skip: { code, message } });

/**
 * Parse and check one line.
 *
 * The order of the checks is the order of their cost: the JSON parse, then the
 * widths, then the commitment, then the clock, then the two ECDSA recoveries. A
 * line that fails cheaply never pays for the rest. The commitment sits where it
 * does because inline it is two keccaks — cheaper than a recovery — and a line
 * that references an upload has to be read before anything about it is known.
 */
export async function admitLine(raw: string, ctx: LineContext): Promise<LineVerdict> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Its own code, distinct from `invalid_line`: "this is not JSON" and "this
    // JSON is not an order" are different mistakes with different fixes, and a
    // client reading its error file should not have to guess which it made.
    return skip("invalid_json", "the line is not valid JSON");
  }

  try {
    // The `POST /v1/jobs` body schema, so a line is refused exactly as the door
    // would refuse it — same field, same message, same code.
    if (!validLine(parsed)) throw validationFailure(validLine.errors ?? [], "line");
    const body = parsed;

    // OpenAI's own per-line field, and optional here. When a line names one it
    // has to be the batch's — a file assembled from two batches is the mistake
    // this catches, and it costs one comparison.
    const { url } = body;
    if (url !== undefined) {
      if (url !== ctx.endpoint) {
        return skip(
          "endpoint_mismatch",
          `the line names url ${url}, and this batch is for ${ctx.endpoint}`,
        );
      }
    }

    const { terms, owner, jobId, signature } = parseOrder(body, ctx.addresses.decimals);

    const content = parseContent(body);
    if (content === null) {
      return skip(
        "container_required",
        "the line carries neither container nor container_cid: this node files the bytes and " +
          "puts the name it mints into order.taskCid, so a line without them cannot be posted",
      );
    }

    // The one check no other party can make: no contract sees a container, and a
    // job posted over bytes that miss their commitment can never be claimed by
    // anyone while its escrow is committed the moment it would be. Inline, that
    // is two keccaks over bytes this process already holds; by cid it is the
    // commitment `POST /v1/files` computed while the upload streamed past.
    //
    // A cid that names no upload of this batch owner's is a **skip**, never a
    // refusal of the batch: one line referencing a file that expired must not
    // cost the other 49 999.
    if (content.kind === "inline") {
      try {
        assertCommitment(content.bytes, terms.c);
      } catch (error) {
        if (!(error instanceof ContainerError)) throw error;
        return skip(error.fault, error.message);
      }
    } else {
      const upload = await findUpload(ctx.db, {
        cid: content.cid,
        owner: ctx.owner,
        purpose: "input",
      });
      if (upload === null) {
        return skip(
          "unknown_container",
          `container_cid names no upload with purpose 'input' for this batch's owner: ${content.cid}`,
        );
      }
      try {
        assertSameCommitment(`0x${(upload.commitment ?? Buffer.alloc(0)).toString("hex")}`, terms.c);
      } catch (error) {
        if (!(error instanceof ContainerError)) throw error;
        return skip(error.fault, error.message);
      }
    }

    // The contract's own two bounds, checked here so the gas is never fronted.
    // Separate codes because the remedies are opposite — one line needs a later
    // expiry, the other an earlier one.
    if (terms.expiresAt <= ctx.now) {
      return skip("order_expired", "expires_at is in the past");
    }
    if (terms.expiresAt > ctx.now + MAX_EXPIRY_SECONDS) {
      return skip("expiry_too_far", `expires_at is past now+${MAX_EXPIRY_SECONDS}`);
    }
    if (terms.slaSecs > MAX_SLA_SECONDS) {
      return skip("sla_too_long", `sla_secs is past ${MAX_SLA_SECONDS}`);
    }

    let cap: bigint;
    try {
      cap = capOf(terms);
    } catch (error) {
      if (!(error instanceof CapOverflowError)) throw error;
      return skip("cap_overflow", error.message);
    }

    const { authSig, amount } = parsePayment(body, ctx.addresses.decimals);

    // **`!==`, exactly as `POST /v1/jobs` compares.** The asymmetry this door
    // used to carry — a line over-signed for more than the pull was admitted —
    // belonged to the retired scheme, whose signature was a ceiling the claim
    // drew under. An EIP-3009 authorization is not a ceiling: the claim pulls the **signed**
    // value, so a line signed for more than `cap + feeCap + gasFeeSnap` would
    // move the difference out of the client's wallet and a line signed for less
    // reverts. One amount is payable, and it is this one.
    const due = cap + feeOf(cap, ctx.feeBps) + ctx.gasFee;
    if (amount !== due) {
      return skip(
        "insufficient_payment",
        `amount is ${amount} and this line's claim will pull exactly ${due}`,
      );
    }

    if (
      !(await recovers(
        orderTypedData(ctx.addresses.chainId, ctx.addresses.jobRegistry, terms),
        owner,
        signature,
      ))
    ) {
      return skip(
        "invalid_order_signature",
        "signature does not recover to owner over this order",
      );
    }

    const authorization = authorizationTypedData(ctx.addresses, {
      from: owner,
      to: ctx.addresses.jobRegistry,
      value: amount,
      validBefore: terms.expiresAt + 1n,
      jobId,
    });
    if (!(await recovers(authorization, owner, authSig))) {
      return skip(
        "invalid_payment_signature",
        "auth_sig does not recover to owner over this line's payment authorization",
      );
    }

    // Last, because it is the only check here that costs a round trip. Same fact
    // as `POST /v1/jobs`'s `payer_has_code`: the payment token routes a
    // code-bearing authorizer to ERC-1271, so this line's authorization — which
    // recovers perfectly above — can never be collected, and posting it would
    // spend gas on a job that rests Open to expiry.
    if (await ctx.hasCode(owner)) {
      return skip(
        "payer_has_code",
        `owner ${owner} carries contract code, so the payment token would validate this ` +
          "authorization through ERC-1271 and the claim would revert; pay from an account " +
          "with no code — an undelegated EOA",
      );
    }

    return { ok: true, line: { terms, owner, jobId, signature, authSig, content } };
  } catch (error) {
    // The schema's refusal and `parseOrder`'s — a missing member, a value past
    // its chain width, a malformed signature, a `job_id` that is not the order's.
    // They are written for an HTTP door and answer with an `ApiError`; here that
    // is one skipped line, and the door's own message is the best description of
    // the fault there is.
    if (error instanceof ApiError) return skip(error.code ?? "invalid_line", error.message);
    throw error;
  }
}
