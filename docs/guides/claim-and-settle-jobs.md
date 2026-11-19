---
title: Claim and settle jobs
description: Poll for jobs as a provider, claim one, obtain the payload key, and settle or fail it through the relay.
---

This is the provider's loop over HTTP. The [provider daemon](/docs/provider) runs it for you; follow this page to call the API directly.

Every write goes through [`POST /evm/ops`](../reference/provider-api.md#post-evmops). The coordinator relays it and pays the gas, so your wallet needs no ETH.

## Before you start

- Your wallet is registered and listed in the `ProviderRegistry`, and allowed the model you serve.
- Your identity is set: a `set_identity` op has published your X25519 `box_key`, which designated clients seal to.
- You hold a [provider session](./authenticate-with-a-wallet.md) (`"role": "provider"`).
- You have [published asks](./publish-asks.md) for the model, so quotes can name you as a candidate.

Every op is an EIP-712 message signed by your provider wallet. Types and domains are in [Signed messages](../reference/signed-messages.md).

## 1. Poll for jobs

Ask for as many jobs as you have free slots for one model:

```sh
curl -s "$VORQ/evm/jobs?state=Open&model=$MODEL_ID&free=4" -H "authorization: Bearer $TOKEN"
```

The coordinator leases you up to `free` of the oldest matching open orders (open bids, or orders designated to you) for 20 seconds by default, and returns only the ones you hold. An open order is held by the coordinator and is not on chain yet: your claim puts it there. Other pollers do not see them while the lease lasts. The poll also marks you as live with those free slots, which is what lets a `402` quote name you as a candidate. Poll at least every 15 seconds to stay live.

A lease is advisory. The chain decides every claim.

## 2. Check before you sign

```sh
curl -s -X POST "$VORQ/evm/simulate/claim" -H 'content-type: application/json' \
  -d "{\"job_id\": \"$JOB_ID\", \"address\": \"$PROVIDER_ADDR\"}"
```

`{"ok": true}` means the claim would pass the contract's checks right now. Otherwise `reason` names the first check that fails: `NotOpen` (no open order under this id), `SlaNotAllowed`, `AlreadyExpired`, `UnknownModel`, `ModelDisabled`, `UnknownProvider`, `NotListed`, `ModelNotAllowed`, `NotDesignated`, `AtCapacity`, `GasFeeChanged` (the order was quoted at another gas fee) or `InsufficientDeposit` (the owner's balance does not cover the lock).

Fetch the job's container by its `task_cid` from an IPFS gateway and check that it reproduces the order's `c` before claiming. See [Payloads and file retention](../concepts/payloads-and-file-retention.md).

## 3. Claim

Sign `Claim(bytes32 jobId,uint64 issuedAt)` with `issuedAt` = now, and relay it:

```sh
curl -s -X POST "$VORQ/evm/ops" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"op\": \"claim\", \"job_id\": \"$JOB_ID\", \"issued_at\": $ISSUED_AT, \"signature\": \"$CLAIM_SIG\"}"
```

```json
{ "tx_hash": "0x…", "status": "success", "block_number": 12345678 }
```

The coordinator adds the client's signed order from its own record and relays `claim(order, owner, orderSig, issuedAt, signature)`: the order goes on chain and the job is claimed in one transaction, which locks `cap + fee + gas_fee` from the client's prepaid balance. A `409` body names the reason, for example `{"ok": false, "reason": "NotOpen"}` when another provider claimed first, or `InsufficientDeposit` when the client's balance is short.

## 4. Get the payload key

- **Designated job** (`designated` is your id): open the `seed_wrap` with your own box key.
- **Open bid** (`designated` is `0`): ask the coordinator's escrow for the key with [`POST /release`](../reference/escrow-api.md#post-release). It answers only while you hold the claim on chain. See [Escrow and key release](../concepts/escrow-and-key-release.md).

## 5. Settle

Seal the result to the client and sign `Settle(bytes32 jobId,uint32 promptTok,uint32 cachedTok,uint32 completionTok,uint128 rateInCached,uint64 issuedAt)` with the counts your backend reported, never estimates:

- `promptTok`: the backend's prompt tokens. For media jobs, the order's `units_in`.
- `cachedTok`: the cached share of `promptTok`, `0` when the backend reports none.
- `completionTok`: the output units you delivered.
- `rateInCached`: your rate for cached prompt tokens in atomic units, at most the job's `rate_in`. With no cached discount, sign the job's `rate_in`.

The contract clamps `promptTok` to `units_in`, `cachedTok` to `promptTok`, `completionTok` to `units_out` and `rateInCached` to `rate_in`, then charges `rate_in × (promptTok − cachedTok) + rateInCached × cachedTok + rate_out × completionTok`. See [What a job costs](../concepts/job-lifecycle.md#when-funds-move).

Send the sealed result inline as base64:

```sh
curl -s -X POST "$VORQ/evm/ops" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d @settle.json
```

```json
{ "op": "settle", "job_id": "0x…", "prompt_tok": 912, "cached_tok": 512, "completion_tok": 800, "rate_in_cached": "0.0006", "issued_at": 1786000100, "signature": "0x…", "result": "<base64>" }
```

`rate_in_cached` is a USD string per 1M tokens, like `rate_in`; the signature covers it as `rate × 10^decimals`.

For a result larger than the 20 MiB request body allows, upload it first with `POST /v1/files` and `purpose=result` under the same session, and send `result_cid` instead of `result`.

```json
{ "tx_hash": "0x…", "status": "success", "block_number": 12345690, "result_cid": "bafy…" }
```

Settle before `claimed_at + sla_secs`. After that, anyone can reclaim the job and the client's lock returns to its balance.

The coordinator adds the job's terms from its record to `settle` and `fail`, including the relayer that landed the claim; the contract checks them against what it stored at claim. You can settle or fail through any coordinator, not only the one that relayed your claim. A job the coordinator has no record of, or whose claim it has not indexed yet, is refused `NotClaimed`.

Settlement credits your charge to your provider id inside the `JobRegistry`. The coordinator's payout keeper pays it out once a day (`PAYOUT_INTERVAL_MS`) to your provider's current operator key.

## If you cannot deliver

Relay a `fail` op (`Fail(bytes32 jobId,uint64 issuedAt)`). The client's lock, less the gas fee, returns to its balance. Within 300 seconds of the claim there is no reputation penalty; after that, the provider's reputation drops.

## Timing rules

- `claim`, `settle` and `fail` must have `issued_at` within 600 seconds of the coordinator's clock, or they are refused with `409 StaleOp`.
- Up to 8 requests may queue on one job; more answer `429 busy`, which is safe to retry.
- A `504 receipt_timeout` means the transaction was sent. Read [`GET /v1/jobs/{id}`](../reference/client-api.md#get-v1jobsid) instead of re-sending.
