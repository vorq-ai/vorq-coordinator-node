---
title: Job lifecycle
description: How a job moves from quote to settlement, what each state means, and when funds move.
---

A job is an order on the `JobRegistry` contract. The coordinator relays every step, but each step is authorised by a signature from the client or the provider, and the contract decides whether it happens.

## From quote to result

1. **Quote.** The client signs an `Order` and posts it to [`POST /v1/jobs`](../reference/client-api.md#post-v1jobs) without payment. The coordinator answers `402` with the price and up to three candidate providers.
2. **Post.** The client signs the payment authorization and posts the same order with it and the sealed payload. The coordinator stores the payload, relays `post` and answers `201`. The job is **open**.
3. **Claim.** A provider relays a signed `claim` through [`POST /evm/ops`](../reference/provider-api.md#post-evmops). The contract collects the client's payment. The job is **claimed**.
4. **Settle.** The provider relays a signed `settle` with the sealed result. The contract pays out. The job is **settled**.
5. **Collect.** The client polls [`GET /v1/jobs/{id}`](../reference/client-api.md#get-v1jobsid) and fetches the result by `result_cid`.

A job can also end without a result:

- **Cancel.** The owner cancels an open job with a signed `Cancel`.
- **Expiry.** Nobody claims it before `expires_at`.
- **Fail.** The provider that claimed it relays a signed `fail`.
- **Reclaim.** The provider misses its SLA (`claimed_at + sla_secs`). Anyone may then call the contract's `reclaim`; the coordinator does so itself once a minute, so the client is refunded even if nobody else acts.

## States

| Chain `state` | `ended_because` | Client `status` |
| --- | --- | --- |
| `0` Open | `0` | `queued` |
| `1` Claimed | `0` | `in_progress` |
| `2` Settled | `1` settled | `completed` |
| `3` Ended | `3` provider fail, `4` reclaim | `failed` |
| `3` Ended | `2` cancelled, `5` expired | `cancelled` |

`/evm/*` routes report `state` and `ended_because`; `/v1/jobs/{id}` adds the client `status`.

Expiry is computed when the job is read: an open job whose `expires_at` has passed reads as state `3`, `ended_because` `5`. The `expires_at` second itself still counts as open. Nothing is written on chain for an expiry, so the owner can still cancel such a job, which then reads `ended_because` `2`.

## What a job costs

Rates are USD per million units. The order's ceiling, in USD, is

```
cap = (rate_in × units_in + rate_out × units_out) / 10^6
```

rounded up to the payment token's smallest unit ($0.000001 for USDC), and never below one such unit. The client authorises

```
amount = cap + fee + gas_fee,   fee = cap × fee_bps / 10000, rounded down to the smallest unit
```

`fee_bps` (the protocol fee) and `gas_fee` (a flat charge that covers relayed gas) are read from the `JobRegistry`; [`GET /evm/chain`](../reference/provider-api.md#get-evmchain) returns `fee_bps`, and every quote states both.

## When funds move

- **Post, cancel, expiry.** Nothing moves. The payment authorization is only used at claim.
- **Claim.** The contract pulls `amount` from the owner.
- **Settle.** The provider is paid `min(cap, (rate_in × units_in + rate_out × completion_tok) / 10^6)`, the charge rounded up to the smallest unit, where `completion_tok` is the output units it reports, clamped to `units_out`. The protocol fee on that charge and the `gas_fee` go to the treasury. The rest goes back to the owner.
- **Fail or reclaim.** The owner gets back `cap` and the fee. The `gas_fee` goes to the treasury, because the gas was already spent.

A provider that fails a job within 300 seconds of claiming it takes no reputation penalty. Later fails, and reclaims, lower its reputation.

## Timing rules

- `expires_at` must be in the future and at most 24 hours ahead.
- `sla_secs` must be an SLA the contract allows, at most 24 hours.
- Signed `cancel`, `claim`, `settle` and `fail` messages carry `issuedAt`, which must be within 600 seconds of the coordinator's clock.

## Who can see a job

The job book is public: every job's terms, state and content identifiers can be read by anyone. Payloads and results are sealed, so only the client and the provider that works the job can open them. See [Payloads and file retention](./payloads-and-file-retention.md).
