---
title: Submit a job
description: Quote an order, sign the payment, post the sealed payload inline or by upload, and collect the result.
---

Submitting a job is two calls to [`POST /v1/jobs`](../reference/client-api.md#post-v1jobs) with the same order: the first returns a quote, the second carries the payment signature and the sealed payload.

This guide assumes the shell variables from the [Quickstart](../quickstart.md) (`VORQ`, `KEY`, `ADDR`, `CHAIN_ID`, `JOB_REGISTRY`).

## 1. Seal the payload

The coordinator never sees plaintext. Build the sealed **container** on your side:

```
container = 0x01 ‖ seed_wrap (80 bytes) ‖ ciphertext
```

`seed_wrap` seals a random 32-byte seed to one of two keys:

- **Designated order**: the `box_key` of the provider you pick (from a quote's `candidates`, or from [`GET /evm/providers/{id}`](../reference/provider-api.md#get-evmprovidersid)). Set `designated` to that provider's id.
- **Open bid**: the escrow key from [`GET /key`](../reference/escrow-api.md#get-key), on a coordinator that hosts an escrow. Set `designated` to `0`.

The VORQ client SDKs implement the sealing. The coordinator checks only the framing and the commitment. See [Payloads and file retention](../concepts/payloads-and-file-retention.md) and [Escrow and key release](../concepts/escrow-and-key-release.md).

## 2. Compute the commitment and job id

```
c      = keccak256(0x01 ‖ seed_wrap ‖ keccak256(ciphertext))
job_id = keccak256(owner ‖ c)
```

A fresh `c` gives a fresh `job_id`. Reusing one answers `409 DuplicateJob`.

## 3. Sign the order and get a quote

Sign the `Order` (see [Signed messages](../reference/signed-messages.md#order)) and post the order fields without `auth_sig`, as in the [Quickstart](../quickstart.md#5-get-a-quote). The answer is `402` with a `quote`.

If you seal to a candidate, set `designated` to its `provider_id` before signing: the order you quote must be the order you submit.

## 4. Sign the payment

Sign the EIP-3009 `ReceiveWithAuthorization` described by `quote.authorization`, using the payment token's own domain (`quote.authorization.domain`):

| Field | Value |
| --- | --- |
| `from` | the order `owner` |
| `to` | `quote.authorization.to` (the `JobRegistry`) |
| `value` | `quote.amount` |
| `validAfter` | `0` |
| `validBefore` | `expires_at + 1` |
| `nonce` | `job_id` |

The owner must be an account with no contract code: a smart account or an EIP-7702-delegated account is refused with `400 payer_has_code`. Funds move only when a provider claims the job, so the owner needs a balance of at least `amount` by then.

## 5. Submit

Send the same order fields again, plus `auth_sig`, `amount` and the container.

**Inline**, for containers up to 15 679 488 bytes, as base64:

```sh
curl -s -X POST "$VORQ/v1/jobs" -H 'content-type: application/json' -d @submit.json
```

```json
{
  "c": "0x…", "model_id": 3, "sla_secs": 3600, "rate_in": "0.0012", "rate_out": "0.005",
  "units_in": 1000, "units_out": 1000, "designated": 7, "expires_at": 1786003600,
  "owner": "0x…", "job_id": "0x…", "signature": "0x…",
  "auth_sig": "0x…", "amount": "0.002007",
  "container": "AQ…"
}
```

**By upload**, for larger containers. Open a [session](./authenticate-with-a-wallet.md), upload the container, then post its cid as `container_cid` instead of `container`:

```sh
curl -s -X POST "$VORQ/v1/files" \
  -H "authorization: Bearer $TOKEN" \
  -F purpose=input \
  -F file=@container.bin | jq -r .vorq.cid
```

The upload must come from the order's owner. An upload that is not attached to a job within 300 seconds is deleted, so upload right before you post.

The answer is `201`:

```json
{ "job_id": "0x…", "task_cid": "bafy…", "tx_hash": "0x…" }
```

## 6. Handle a changed price

If the node's `gas_fee` or the protocol `fee_bps` changed after your quote, `amount` no longer matches and the answer is `409` with a fresh `{quote, candidates, accepts}` body. Sign a new payment for the new `amount` and submit again. The order signature stays valid.

For any other failure, see [Errors](../reference/errors.md). Retry only when the `x-vorq-retryable` header is `true`. A `504 receipt_timeout` means the transaction was sent: poll the job instead of posting again.

## 7. Collect the result

Poll the job until its status is terminal:

```sh
curl -s "$VORQ/v1/jobs/$JOB_ID" | jq '{status, result_cid}'
```

| `status` | Meaning |
| --- | --- |
| `queued` | Open, waiting for a provider. |
| `in_progress` | Claimed. |
| `completed` | Settled. `result_cid` names the sealed result. |
| `failed` | The provider failed it, or missed its SLA and it was reclaimed. |
| `cancelled` | You cancelled it, or it expired unclaimed. |

`result_cid` is an IPFS content identifier. Fetch the sealed result from an IPFS gateway and open it with your key. The coordinator does not serve result bytes to clients.

To stop an open job, see [Cancel a job](./cancel-a-job.md).
