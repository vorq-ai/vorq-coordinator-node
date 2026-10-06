---
title: Publish asks
description: Publish a provider's prices to the AskRegistry with a signed snapshot.
---

An ask is a provider's price for one model at one SLA. Asks are published on chain in a signed **snapshot**. Each quote in it sets the price for its `(model_id, sla)` pair; pairs the snapshot does not name keep their current price. Quotes name a provider as a candidate only for orders that clear one of its asks.

You need a [session](./authenticate-with-a-wallet.md). The coordinator relays the snapshot and pays the gas.

## 1. Build the snapshot

```json
{
  "provider_id": 7,
  "signed_at": 1786000000,
  "quotes": [
    { "model_id": 3, "sla": 3600, "rate_in": "0.0015", "rate_out": "0.006" },
    { "model_id": 3, "sla": 86400, "rate_in": "0.0009", "rate_out": "0.0036" }
  ]
}
```

- At most 64 quotes.
- A quote with `rate_in` and `rate_out` both `"0"` withdraws the ask for that `(model_id, sla)`.
- `signed_at` must be newer than your last published snapshot, and at most one hour ahead of the coordinator's clock. Use the current time.
- Rates are USD per million units, as decimal strings. See [Job lifecycle](../concepts/job-lifecycle.md#what-a-job-costs).

## 2. Sign it

Sign `AskSnapshot` with your provider wallet, in the `VORQ Asks` domain (version `"2"`, the deployment's chain id, the `AskRegistry` address). Types are in [Signed messages](../reference/signed-messages.md#asksnapshot).

## 3. Publish

```sh
curl -s -X PUT "$VORQ/evm/asks" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"snapshot\": $(cat snapshot.json), \"signature\": \"$ASK_SIG\"}"
```

The coordinator waits for the transaction and answers once the snapshot is on chain:

```json
{ "provider_id": 7, "signed_at": 1786000000, "published": true, "tx_hash": "0x…" }
```

## 4. Check it

```sh
curl -s "$VORQ/evm/asks?model=3" | jq '.asks[] | select(.provider_id == "7")'
```

Only listed providers' asks appear.

## When it is refused

| Answer | Fix |
| --- | --- |
| `403 invalid_signature` | The signature does not recover over this snapshot. Check the domain and field types. |
| `403 not_registered` | The signer has no provider registration. |
| `403 provider_mismatch` | The signer operates a different provider than `provider_id`. |
| `409 stale_snapshot` | `signed_at` is not newer than your latest snapshot. Sign again with the current time. |
| `409 superseded` | A newer snapshot is already on chain. |
| `503 publication_skipped` | The transaction mined but recorded nothing. Retry. |

See [`PUT /evm/asks`](../reference/provider-api.md#put-evmasks).
