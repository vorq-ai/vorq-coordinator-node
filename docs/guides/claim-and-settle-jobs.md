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

The coordinator leases you up to `free` of the oldest matching open jobs (open bids, or jobs designated to you) for 20 seconds by default, and returns only the jobs you hold. Other pollers do not see them while the lease lasts. The poll also marks you as live with those free slots, which is what lets a `402` quote name you as a candidate. Poll at least every 15 seconds to stay live.

A lease is advisory. The chain decides every claim.

## 2. Check before you sign

```sh
curl -s -X POST "$VORQ/evm/simulate/claim" -H 'content-type: application/json' \
  -d "{\"job_id\": \"$JOB_ID\", \"address\": \"$PROVIDER_ADDR\"}"
```

`{"ok": true}` means the claim would pass the contract's checks right now. Otherwise `reason` names the first check that fails: `UnknownJob`, `NotOpen`, `UnknownProvider`, `NotListed`, `ModelNotAllowed`, `NotDesignated` or `AtCapacity`.

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

The claim collects the client's payment. A `409` body names the contract's reason, for example `{"ok": false, "reason": "NotOpen"}` when another provider claimed first.

## 4. Get the payload key

- **Designated job** (`designated` is your id): open the `seed_wrap` with your own box key.
- **Open bid** (`designated` is `0`): ask the coordinator's escrow for the key with [`POST /release`](../reference/escrow-api.md#post-release). It answers only while you hold the claim on chain. See [Escrow and key release](../concepts/escrow-and-key-release.md).

## 5. Settle

Seal the result to the client and sign `Settle(bytes32 jobId,uint32 completionTok,uint64 issuedAt)`. `completionTok` is the number of output units you delivered; the contract charges for at most the order's `units_out`.

Send the sealed result inline as base64:

```sh
curl -s -X POST "$VORQ/evm/ops" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d @settle.json
```

```json
{ "op": "settle", "job_id": "0x…", "completion_tok": 800, "issued_at": 1786000100, "signature": "0x…", "result": "<base64>" }
```

For a result larger than the 20 MiB request body allows, upload it first with `POST /v1/files` and `purpose=result` under the same session, and send `result_cid` instead of `result`.

```json
{ "tx_hash": "0x…", "status": "success", "block_number": 12345690, "result_cid": "bafy…" }
```

Settle before `claimed_at + sla_secs`. After that, anyone can reclaim the job and the client is refunded.

## If you cannot deliver

Relay a `fail` op (`Fail(bytes32 jobId,uint64 issuedAt)`). The client is refunded. Within 300 seconds of the claim there is no reputation penalty; after that, the provider's reputation drops.

## Timing rules

- `claim`, `settle` and `fail` must have `issued_at` within 600 seconds of the coordinator's clock, or they are refused with `409 StaleOp`.
- Up to 8 requests may queue on one job; more answer `429 busy`, which is safe to retry.
- A `504 receipt_timeout` means the transaction was sent. Read [`GET /v1/jobs/{id}`](../reference/client-api.md#get-v1jobsid) instead of re-sending.
