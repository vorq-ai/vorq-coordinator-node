import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { HANDOVER_AUTH_TYPES } from "./handover.js";
import { releaseDomain } from "./release.js";

/**
 * The operator credential: the one key that says "this deployment is ours".
 *
 * ## What it is, and what it deliberately is not
 *
 * It authorises **one thing** — a `POST /handover` pull — and it authorises
 * nothing on chain: it appears in no contract, no allowlist and no registry. It
 * is a shared secret the escrow fleet holds, and a holder authenticates a pull by
 * recovering to an address it derives from a key of its own. That narrow scope is
 * the point: a credential that only ever proves membership can be changed on a
 * schedule without touching governance, funds, or any provider's registration.
 *
 * The cost of it not being chain state is stated where an operator will meet it —
 * `docs` in the meta repo, and `README.md` here: it cannot be withdrawn from a
 * node that is already running, because a node reads it once at boot and a
 * restart erases the escrow key set. `OPERATOR_KEY` is therefore a list, and
 * changing it is two cutovers rather than a key-set loss.
 *
 * ## Why it exists at all
 *
 * Attestation proves *what code* a caller is running. It cannot prove *whose
 * deployment* that is, because the things that decide what a coordinator
 * believes — its RPC endpoint, its registry addresses — come from the
 * environment and no measurement covers them. Without this signature the genuine
 * image, run by a stranger and pointed at a chain that stranger controls, clears
 * every evidence rung, takes the entire key set, and then answers its own
 * `/release` for any job it likes.
 *
 * ## It never leaves this module
 *
 * `joinPeer` takes a *signing function*, not a key, so the secret exists in one
 * place and no call path can log or forward it.
 *
 * The shape is checked twice, deliberately. `loadConfig` checks every entry at
 * boot so a malformed *second* key fails the node that introduced it rather than
 * the cutover hours later that first needed it — and it names the offending
 * entry by position, never by value, because a loader that quoted the value would
 * put a private key into a log line the first time somebody pasted one with a
 * typo. The check here is the one at the point of use, for the same call that
 * `relayerAccount` guards: it keeps this module honest on its own terms rather
 * than trusting a caller to have come through the loader.
 */

const OPERATOR_KEY_HEX = /^0x[0-9a-fA-F]{64}$/;

export type HandoverAuthSigner = (message: {
  channelPubkey: Hex;
  issuedAt: bigint;
}) => Promise<Hex>;

/**
 * Builds the signer, refusing a key that is not one **without ever quoting it**.
 *
 * The message names the variable and the expected shape and stops there. A
 * loader that echoed the bad value into an exception would put an operator's
 * private key into a log line the first time somebody pasted one with a typo,
 * and a redacted log is not a recalled one.
 */
export function handoverAuthSigner(operatorKey: string, chainId: number): HandoverAuthSigner {
  if (!OPERATOR_KEY_HEX.test(operatorKey)) {
    throw new Error(
      "OPERATOR_KEY must be 0x followed by 64 hex characters — a 32-byte secp256k1 " +
        "private key. Its value is deliberately not repeated here.",
    );
  }
  const account = privateKeyToAccount(operatorKey as Hex);

  return async (message) =>
    account.signTypedData({
      domain: releaseDomain(chainId),
      types: HANDOVER_AUTH_TYPES,
      primaryType: "HandoverAuth",
      message,
    });
}

/** The address a given operator key authorises as, for the boot log line. */
export function operatorAddressOf(operatorKey: string): string {
  if (!OPERATOR_KEY_HEX.test(operatorKey)) {
    throw new Error(
      "OPERATOR_KEY must be 0x followed by 64 hex characters — a 32-byte secp256k1 " +
        "private key. Its value is deliberately not repeated here.",
    );
  }
  return privateKeyToAccount(operatorKey as Hex).address;
}
