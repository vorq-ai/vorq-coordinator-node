---
title: Job lifecycle
description: How a job moves from quote to settlement, what each state means, and when funds move.
---

A job is an order the client signs, which goes on the `JobRegistry` contract when a provider claims it. The coordinator relays every on-chain step, but each step is authorised by a signature from the client or the provider, and the contract decides whether it happens.

## From quote to result

1. **Quote.** The client signs an `Order` and posts it to [`POST /v1/jobs`](../reference/client-api.md#post-v1jobs) without `amount`. The coordinator answers `402` with the price, the client's available prepaid balance, the deposit to make first, if any, and up to three candidate providers.
2. **Submit.** The client [deposits](../reference/client-api.md#post-v1deposits) what the quote names and posts the same order with `amount` and the sealed payload. The coordinator stores the payload and [holds](./matching-and-leases.md#held-orders) the order, answering `202`. The job is **open**. Nothing is on chain yet.
3. **Claim.** A provider relays a signed `claim` through [`POST /evm/ops`](../reference/provider-api.md#post-evmops). The coordinator adds the client's signed order, so one transaction puts the order on chain and claims it. The contract locks the job's funds from the client's balance. The job is **claimed**.
4. **Settle.** The provider relays a signed `settle` with the sealed result. The contract credits the provider, the treasury and the claim's relayer and returns the rest to the client's balance. The job is **settled**.
5. **Collect.** The client polls [`GET /v1/jobs/{id}`](../reference/client-api.md#get-v1jobsid) and fetches the result by `result_cid`.

A job can also end without a result:

- **Cancel.** The owner cancels an open job with a signed `Cancel`. The coordinator ends the held order; nothing is relayed.
- **Expiry.** Nobody claims it before `expires_at`.
- **Fail.** The provider that claimed it relays a signed `fail`.
- **Reclaim.** The provider misses its SLA (`claimed_at + sla_secs`). Anyone may then call the contract's `reclaim`; the coordinator does so itself once a minute, so the client's lock returns to its balance even if nobody else acts.

## States

| Chain `state` | `ended_because` | Client `status` |
| --- | --- | --- |
| `0` Open | `0` | `queued` |
| `1` Claimed | `0` | `in_progress` |
| `2` Settled | `1` settled | `completed` |
| `3` Ended | `3` provider fail, `4` reclaim | `failed` |
| `3` Ended | `2` cancelled, `5` expired | `cancelled` |

`/evm/*` routes report `state` and `ended_because`; `/v1/jobs/{id}` adds the client `status`.

Expiry is computed when the job is read: an open job whose `expires_at` has passed reads as state `3`, `ended_because` `5`. The `expires_at` second itself still counts as open. Nothing is written for an expiry, so the owner can still cancel such a job, which then reads `ended_because` `2`.

## What a job costs

Rates are USD per million units. The order's ceiling, in USD, is

```
cap = (rate_in × units_in + rate_out × units_out) / 10^6
```

rounded up to the payment token's smallest unit ($0.000001 for USDC), and never below one such unit. `units_in` and `units_out` are ceilings: settlement bills what was used. A claim locks

```
amount = cap + fee + gas_fee,   fee = cap × fee_bps / 10000, rounded down to the smallest unit
```

`fee_bps` (the protocol fee) and `gas_fee` (a flat charge that covers relayed gas) are read from the `JobRegistry`. The protocol fee goes to the treasury. The `gas_fee` goes to the relayer that landed the claim, which is the account of whichever coordinator relayed it; [`GET /evm/chain`](../reference/provider-api.md#get-evmchain) returns `fee_bps`, and every quote states both.

## When funds move

- **Deposit.** The client's wallet pays into its prepaid balance in the `JobRegistry` through [`POST /v1/deposits`](../reference/client-api.md#post-v1deposits). The registry credits the value less a flat `deposit_fee`, which goes to the relayer that landed the deposit. The client can [withdraw](../reference/client-api.md#post-v1withdrawals) what its open orders do not reserve at any time.
- **Submit, cancel, expiry.** Nothing moves. An open order reserves `amount` from the available balance the coordinator reports, but nothing is locked on chain.
- **Claim.** The contract locks `amount` from the owner's balance. It is refused `InsufficientDeposit` when the balance is short.
- **Settle.** The provider is paid

  ```
  charge = (rate_in × (prompt_tok − cached_tok) + rate_in_cached × cached_tok + rate_out × completion_tok) / 10^6
  ```

  rounded up to the smallest unit and never below one, at most `cap`. `prompt_tok`, `cached_tok` and `completion_tok` are the counts the provider's backend reported; `rate_in_cached` is the provider's rate for cached prompt tokens. The contract clamps `prompt_tok` to `units_in`, `cached_tok` to `prompt_tok`, `completion_tok` to `units_out` and `rate_in_cached` to `rate_in`. For media jobs `prompt_tok` is `units_in` and `cached_tok` is `0`. The protocol fee on that charge accrues to the treasury and the `gas_fee` to the claim's relayer. The rest of the lock returns to the owner's balance.
- **Fail or reclaim.** The owner's balance gets back `cap` and the fee. The `gas_fee` accrues to the claim's relayer, because the gas was already spent. A reclaim relayed by another coordinator still pays the claim's relayer.
- **Payout.** Settlement moves no tokens: the provider's charge is credited to its provider id, and the treasury's and the relayer's shares accrue inside the registry. The coordinator's payout keeper relays `payProvider` for every provider with earnings, paying its current operator key, then `payRelayer` for its own relayer account, paying that same account, and then `payTreasury`, once per `PAYOUT_INTERVAL_MS` (daily by default). Anyone may call all three.

A provider that fails a job within 300 seconds of claiming it takes no reputation penalty. Later fails, and reclaims, lower its reputation.

## Timing rules

- `expires_at` must be in the future and at most 24 hours ahead.
- `sla_secs` must be an SLA the contract allows, at most 24 hours.
- Signed `cancel`, `claim`, `settle` and `fail` messages carry `issuedAt`, which must be within 600 seconds of the coordinator's clock.

## Who can see a job

The job book is public: every job's terms, state and content identifiers can be read by anyone. Payloads and results are sealed, so only the client and the provider that works the job can open them. See [Payloads and file retention](./payloads-and-file-retention.md).
