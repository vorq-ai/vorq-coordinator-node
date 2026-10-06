---
title: Provider API
description: Every /evm/* route, for the deployment, the job book, provider operations, asks, providers and the allowlist.
---

The request and response schema for every route on this page is in the [API reference](https://api.vorq.co/docs). This page covers the flow and what each refusal means.

Routes under `/evm/*`. The read routes are public and used by clients too; the write routes relay provider-signed messages. Encoding, headers, paging and body limits are in [API conventions](./conventions.md); the error envelope and retry rule are in [Errors](./errors.md).

## Deployment

### GET /evm/chain

The deployment parameters a client or provider needs to sign.

**Auth:** public · **Index-backed:** no (reads the chain)

`contracts.usdc` is the payment token, and `token_domain` its EIP-712 `name` and `version` for signing the payment. `block_time_ms` is the node's poll interval. `fee_bps` is the protocol fee.

**Errors:** `503 chain_unreachable` or `relay_unavailable` (`config_read`).

## Job book

### GET /evm/jobs

The job book, filtered. With `free=N` it is also the provider's poll.

**Auth:** public; a provider session with `free` · **Index-backed:** yes · **Paged:** yes

`state=Cancelled` matches every ended job: cancelled, expired, failed or reclaimed. `provider` matches the jobs claimed by that provider. `min_rate_in` and `min_rate_out` keep jobs at or above those rates; `posted_before` keeps jobs posted at or before that block. The default `order` is `oldest`, by posting block.

`state` and `ended_because` are as in [Job lifecycle](../concepts/job-lifecycle.md#states); an open job past `expires_at` reads as `3` / `5`. `provider_id`, `claimed_at` and `completion_tok` are `"0"` until claimed or settled. `gas_fee` is the relay gas fee in USD that the `JobRegistry` fixed for the job when it was posted; the treasury keeps it when a claimed job settles, fails or is reclaimed. `fee` is the protocol fee in USD that settlement took on top of the charge, `"0"` for a job that did not settle.

**Provider poll.** `free=N` needs a provider session, `state=Open` and a `model` in the catalog. The node records the provider as live for that model with `N` free slots, leases it up to `N` of the oldest matching jobs it may claim (open bids, or designated to it) for `MATCH_LEASE_MS`, counting leases it already holds, and returns only the jobs it holds. See [Matching and leases](../concepts/matching-and-leases.md). Without `free`, the session is ignored.

On a coordinator whose escrow has lost keys, open undesignated jobs posted before its current key custody are left out of the book.

**Errors**

| Status | `code` | Cause |
| --- | --- | --- |
| `400` | `null` | A bad filter (`param` names it); `free` without `state=Open` or `model`; a model not in the catalog. |
| `401` | `invalid_session` | `free` without a valid session. |
| `403` | `not_registered` | `free` with a session that is not a provider session. |

```sh
curl -s "https://api.vorq.co/evm/jobs?state=Open&model=3&free=4" \
  -H "authorization: Bearer $TOKEN"
```

### GET /evm/jobs/summary

Totals for one `owner`, overall and per model.

**Auth:** public · **Index-backed:** yes

`completed` counts settled jobs, and `escrowed` is what their claims lock, summed over all of them: each job's `cap`, the protocol fee on it at the current `fee_bps`, and its `gas_fee`.

### GET /evm/jobs/{job_id}

One job in the book's shape, plus `as_of_block`.

**Auth:** public · **Index-backed:** yes

**Errors:** `400` for a malformed id; `404` for an unknown job.

## Provider operations

### POST /evm/ops

Relay one signed provider op. The coordinator verifies the signature, simulates the transaction, sends it and waits for the receipt.

**Auth:** session (any address; the op signature is the authority) · **Index-backed:** no · **Body limit:** 20 MiB

A missing session answers `401` before the body is validated.

**Request:** a flat object with `op`, `signature` and the op's fields. `signature` is the provider wallet's signature over the op's signed message: [`Claim`](./signed-messages.md#claim), [`Settle`](./signed-messages.md#settle), [`Fail`](./signed-messages.md#fail), [`SetIdentity`](./signed-messages.md#setidentity) or [`RequestCapacity`](./signed-messages.md#requestcapacity).

```json
{ "op": "claim", "job_id": "0x…", "issued_at": 1786000000, "signature": "0x…" }
```

- `settle` takes exactly one of `result` (the sealed result, base64, non-empty) and `result_cid` (the `vorq.cid` of a `result` upload by this session's address).
- `claim`, `settle` and `fail` need `issued_at` within ±600 seconds of the node's clock. `set_identity` and `request_capacity` need `issued_at` greater than the last accepted one for that op and at most one hour ahead.

**Response `201`:** after the receipt. On `settle` only, `result_cid` is the IPFS CID the result was stored under.

**Errors**

| Status | Body or `code` | Cause |
| --- | --- | --- |
| `400` | `result_required`, `result_ambiguous`, `unknown_result`, or `null` | A malformed op (`param` names the field), or a missing, doubled or unknown result. |
| `401` | `invalid_session` | No valid session. Answered before the body is validated. |
| `403` | type `invalid_op_signature` | The signature does not recover to a registered provider. |
| `409` | `{"ok": false, "reason": "<ContractError>"}` | The chain refuses the op, for example `StaleOp`, `NotOpen`, `AtCapacity`, `SlaExpired`. When `reason` is `unknown`, `raw` carries the revert data. `x-vorq-retryable: false`. |
| `429`, `503`, `504` | | See [Errors](./errors.md). A `504` message names the route to poll. |

### POST /evm/simulate/claim

An advisory check before signing a claim, for a `job_id` and the provider wallet `address`. It reads the chain, not the index, so it is accurate while the index lags.

**Auth:** public · **Index-backed:** no

**Response `200`:** `{"ok": true}`, or `{"ok": false, "reason": …}` with the first failing check, in the contract's order: `UnknownJob`, `NotOpen`, `UnknownProvider`, `NotListed`, `ModelNotAllowed`, `NotDesignated`, `AtCapacity`. It does not check the payment, the signature or the ±600-second window; `POST /evm/ops` simulates the real transaction.

## Asks

### PUT /evm/asks

Publish a signed ask snapshot to the `AskRegistry`. See [Publish asks](../guides/publish-asks.md).

**Auth:** session (any address; the snapshot signature is the authority) · **Index-backed:** no · **Body limit:** 32 KiB

A missing session answers `401` before the body is validated.

**Request**

```json
{
  "snapshot": {
    "provider_id": 7,
    "signed_at": 1786000000,
    "quotes": [{ "model_id": 3, "sla": 3600, "rate_in": "0.0015", "rate_out": "0.006" }]
  },
  "signature": "0x…"
}
```

- `snapshot.provider_id` must be the signer's provider id.
- `snapshot.signed_at` must be newer than the provider's latest snapshot and at most one hour ahead of the node's clock.
- Each quote sets the ask for its `(model_id, sla)`; both rates `0` withdraws it.
- `signature` is the provider wallet's [`AskSnapshot`](./signed-messages.md#asksnapshot) signature.

**Response `200`:** after the publication is mined and confirmed.

**Errors**

| Status | `code` | Cause |
| --- | --- | --- |
| `400` | `null` | A malformed field, with `param` naming it as a path such as `snapshot.quotes[3].rate_in`; `signed_at` too far ahead. |
| `401` | `invalid_session` | No valid session. Answered before the body is validated. |
| `403` | `invalid_signature` | The signature does not recover over the snapshot. |
| `403` | `not_registered` | The signer is not a registered provider. |
| `403` | `provider_mismatch` | The signer operates a different provider than `snapshot.provider_id`. |
| `409` | `stale_snapshot` | `signed_at` is not newer than the provider's latest. |
| `409` | `superseded` | A newer snapshot is already on chain. |
| `503` | `publication_skipped` | Mined, but the chain recorded no publication. Retry. |
| `504` | tx hash | No receipt within 60 seconds. The snapshot is stored; check `GET /evm/asks` rather than pushing it again. |

### GET /evm/asks

Published asks of listed providers.

**Auth:** public · **Index-backed:** yes · **Paged:** yes

### GET /evm/asks/floors

The lowest ask per `(model_id, sla)` across listed providers, for catalog models. `rate_in` and `rate_out` are each minimised on their own, so a floor row may combine two providers' rates.

**Auth:** public · **Index-backed:** yes · **Paged:** yes

## Providers and catalog

### GET /evm/providers

Registered providers, by id.

**Auth:** public · **Index-backed:** yes · **Paged:** yes

- `box_key` is the X25519 key designated orders are sealed to; `null` until set.
- `evidence` is the identity evidence published with `set_identity`, or `null`.
- `reputation` is `100`–`1000`.
- `capacity` is the effective capacity: `max(1, reputation × min(requested, ceiling) / 1000)`.
- `active_jobs` counts the jobs it currently holds claimed.

### GET /evm/providers/{id}

One provider plus `as_of_block`.

**Auth:** public · **Index-backed:** yes

**Errors:** `400` for an id that is not a uint32; `404` for an unknown provider.

### GET /evm/models

The model catalog; the same body as [`GET /v1/models`](./client-api.md#get-v1models).

### GET /evm/allowlist

Entries of the contracts' attestation allowlist.

**Auth:** public · **Index-backed:** yes · **Paged:** yes
