---
title: Quickstart
description: Read a coordinator's deployment, sign an order, get a price quote and open a session, using curl.
---

In this tutorial you talk to a coordinator with `curl`. You check that it is ready, read the deployment it serves, pick a model, sign an order and get a price quote for it, then open a session with your wallet. None of it moves funds: the quote is answered before any payment is signed.

## Before you start

You need:

- The VORQ coordinator's URL, `https://api.vorq.co`. The same calls work against a [self-hosted node](./guides/self-host-the-coordinator.md).
- `curl` and `jq`.
- [Foundry](https://getfoundry.sh)'s `cast`, to hash values and sign EIP-712 messages.

Set up the shell:

```sh
export VORQ=https://api.vorq.co
```

Create a throwaway wallet for this tutorial. It needs no funds:

```sh
export KEY=$(cast wallet new --json | jq -r '.[0].private_key')
export ADDR=$(cast wallet address --private-key "$KEY")
echo "$ADDR"
```

## 1. Check that the node is ready

```sh
curl -s "$VORQ/readyz" | jq
```

```json
{ "ready": true, "reason": "ready", "cursor": 12345670, "head_block": 12345672, "lag": 2 }
```

`ready: true` means the node's index has caught up with the chain. While it is catching up, index-backed routes answer `503`. See [Indexing and readiness](./concepts/indexing-and-readiness.md).

## 2. Read the deployment

Every signature is bound to a chain id and a contract address. The coordinator serves both:

```sh
curl -s "$VORQ/evm/chain" | tee chain.json | jq
```

```json
{
  "chain_id": 84532,
  "contracts": { "job_registry": "0x…", "provider_registry": "0x…", "ask_registry": "0x…", "usdc": "0x…" },
  "decimals": 6,
  "token_domain": { "name": "…", "version": "…" },
  "head_block": 12345672,
  "block_time_ms": 2000,
  "fee_bps": 100
}
```

Keep the two values you need:

```sh
export CHAIN_ID=$(jq -r .chain_id chain.json)
export JOB_REGISTRY=$(jq -r .contracts.job_registry chain.json)
```

## 3. Pick a model and a price

List the catalog:

```sh
curl -s "$VORQ/v1/models" | jq '.data[] | {name: .id, model_id: .vorq.model_id}'
```

Pick a model and read the cheapest published price for each SLA:

```sh
export MODEL_ID=3   # a model_id from the list above
curl -s "$VORQ/evm/asks/floors?model=$MODEL_ID" | jq .floors
```

```json
[{ "model_id": 3, "sla": 3600, "rate_in": "0.0012", "rate_out": "0.005" }]
```

Take the `sla` and rates of one row. An order whose rates are at or above a provider's ask can be matched by that provider:

```sh
export SLA=3600 RATE_IN=1200 RATE_OUT=5000
```

## 4. Sign an order

An order commits to its sealed payload through `c`, a 32-byte hash. For a quote, any fresh value will do; a real submission computes it from the container (see [Payloads and file retention](./concepts/payloads-and-file-retention.md)).

```sh
export C=$(cast keccak "quickstart-$(date +%s)")
export JOB_ID=$(cast keccak $(cast concat-hex "$ADDR" "$C"))
export EXPIRES_AT=$(( $(date +%s) + 3600 ))
```

`job_id` is always `keccak256(owner ‖ c)`. Write the order as EIP-712 typed data:

```sh
cat > order.json <<EOF
{
  "types": {
    "EIP712Domain": [
      { "name": "name", "type": "string" },
      { "name": "version", "type": "string" },
      { "name": "chainId", "type": "uint256" },
      { "name": "verifyingContract", "type": "address" }
    ],
    "Order": [
      { "name": "c", "type": "bytes32" },
      { "name": "modelId", "type": "uint32" },
      { "name": "slaSecs", "type": "uint32" },
      { "name": "rateIn", "type": "uint128" },
      { "name": "rateOut", "type": "uint128" },
      { "name": "unitsIn", "type": "uint32" },
      { "name": "unitsOut", "type": "uint32" },
      { "name": "designated", "type": "uint32" },
      { "name": "expiresAt", "type": "uint64" }
    ]
  },
  "primaryType": "Order",
  "domain": { "name": "VORQ Jobs", "version": "2", "chainId": $CHAIN_ID, "verifyingContract": "$JOB_REGISTRY" },
  "message": {
    "c": "$C", "modelId": $MODEL_ID, "slaSecs": $SLA,
    "rateIn": "$RATE_IN", "rateOut": "$RATE_OUT",
    "unitsIn": 1000, "unitsOut": 1000,
    "designated": 0, "expiresAt": $EXPIRES_AT
  }
}
EOF

export ORDER_SIG=$(cast wallet sign --data --from-file order.json --private-key "$KEY")
```

## 5. Get a quote

Post the order without a payment signature. The coordinator verifies the order signature and answers `402 Payment Required` with the price:

```sh
curl -s -X POST "$VORQ/v1/jobs" \
  -H 'content-type: application/json' \
  -d @- <<EOF | jq
{
  "c": "$C", "model_id": $MODEL_ID, "sla_secs": $SLA,
  "rate_in": "$RATE_IN", "rate_out": "$RATE_OUT",
  "units_in": 1000, "units_out": 1000,
  "designated": 0, "expires_at": $EXPIRES_AT,
  "owner": "$ADDR", "job_id": "$JOB_ID", "signature": "$ORDER_SIG"
}
EOF
```

```json
{
  "quote": {
    "cap": "0.000007", "fee_bps": 100, "fee": "0", "gas_fee": "0.002", "amount": "0.002007",
    "authorization": {
      "domain": { "name": "…", "version": "…", "chainId": 84532, "verifyingContract": "0x…" },
      "to": "0x…", "value": 2007, "valid_after": 0, "valid_before": 1786086401, "nonce": "0x…"
    }
  },
  "candidates": [{ "provider_id": 7, "box_key": "0x…", "rate_in": "0.0012", "rate_out": "0.005" }],
  "accepts": [{ "scheme": "eip3009", "network": "eip155:84532" }]
}
```

- `amount` is what the job would cost at most, in USD: the escrow ceiling `cap`, the protocol `fee` and the relayer `gas_fee`. `authorization.value` is the same amount in the token's smallest units, which is what the wallet signs.
- `authorization` is the payment you would sign to submit.
- `candidates` are live providers whose asks this order clears, cheapest first. To see the market before bidding, send the same body with no rates and no signature; see [Matching and leases](./concepts/matching-and-leases.md#the-market-probe).

A `400` here names the field that is wrong in `error.param`. See [Errors](./reference/errors.md).

## 6. Open a session

Some routes (file uploads, batches, provider operations) need a session token. Get a single-use nonce for your address:

```sh
export NONCE=$(curl -s "$VORQ/auth/nonce?address=$ADDR" | jq -r .nonce)
```

Sign it as a `VorqSession` message:

```sh
cat > session.json <<EOF
{
  "types": {
    "EIP712Domain": [
      { "name": "name", "type": "string" },
      { "name": "version", "type": "string" },
      { "name": "chainId", "type": "uint256" }
    ],
    "VorqSession": [
      { "name": "address", "type": "address" },
      { "name": "nonce", "type": "string" }
    ]
  },
  "primaryType": "VorqSession",
  "domain": { "name": "VORQ Session", "version": "1", "chainId": $CHAIN_ID },
  "message": { "address": "$ADDR", "nonce": "$NONCE" }
}
EOF

export SESSION_SIG=$(cast wallet sign --data --from-file session.json --private-key "$KEY")
```

Exchange the signature for a token:

```sh
export TOKEN=$(curl -s -X POST "$VORQ/auth/session" \
  -H 'content-type: application/json' \
  -d "{\"address\":\"$ADDR\",\"nonce\":\"$NONCE\",\"signature\":\"$SESSION_SIG\"}" | jq -r .token)
echo "$TOKEN"
```

Use it as a bearer token. Your wallet has no batches yet, so the list is empty:

```sh
curl -s "$VORQ/v1/batches" -H "authorization: Bearer $TOKEN" | jq
```

```json
{ "object": "list", "data": [], "first_id": null, "last_id": null, "has_more": false, "as_of_block": 12345672 }
```

## 7. Read a job

Read the oldest open job on the book, then its client view:

```sh
export SOME_JOB=$(curl -s "$VORQ/evm/jobs?state=Open&limit=1" | jq -r '.jobs[0].job_id')
curl -s "$VORQ/v1/jobs/$SOME_JOB" | jq '{id, model, status, result_cid}'
```

`status` moves from `queued` to `in_progress` to `completed` (or `failed` / `cancelled`). If the book is empty, the first command prints `null`.

## Next steps

- [Submit a job](./guides/submit-a-job.md): seal a payload, sign the payment and post it.
- [Job lifecycle](./concepts/job-lifecycle.md): what each state means and where funds go.
- [Client API reference](./reference/client-api.md): every `/v1/*` route.
