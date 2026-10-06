---
title: Run the escrow
description: Enable the escrow so a coordinator can accept open-bid orders, and rotate its key.
---

Only a coordinator that accepts **open-bid** orders needs the escrow. Designated orders are sealed straight to a provider and never touch it. With the default `ESCROW_MODE=off`, the escrow routes answer `403 escrow_unavailable`. See [Escrow and key release](../concepts/escrow-and-key-release.md) for what it guarantees.

## Enable it

Set `ESCROW_MODE=static` and an operator key:

```sh
ESCROW_MODE=static
OPERATOR_KEY=0x<32-byte secp256k1 private key>
```

The escrow key pair is derived from `OPERATOR_KEY`, so:

- every instance with the same `OPERATOR_KEY` holds the same key, and any of them serves any release;
- a restart loses nothing;
- nothing rotates on a timer.

Keep `OPERATOR_KEY` as secret as `RELAYER_KEY`: whoever holds it can open every open-bid payload sealed to its key. Use a dedicated key for it.

Check it:

```sh
curl -s "$VORQ/key" | jq
```

```json
{ "escrow_public_key": "<64 hex characters>", "evidence": { "type": "static-coordinator-v1", "report_data": "…", "debug": false, "release": 1 }, "issued_at": 1786000000 }
```

## Rotate the operator key

`OPERATOR_KEY` takes a comma-separated list. The **first** entry derives the key that `GET /key` announces; **every** entry still opens payloads sealed to its key. Rotate in two restarts:

1. `OPERATOR_KEY=K_new,K_old`. New orders are sealed to `K_new`; orders already sealed to `K_old` still release.
2. `OPERATOR_KEY=K_new`, once every order sealed to `K_old` has settled or ended.

Wait at least 51 hours between the two steps: clients may cache the announced key for up to 3 hours, an order can stay open for up to 24 hours, and a claimed job can run for up to 24 hours. Dropping `K_old` sooner leaves providers unable to open jobs sealed to it; they can still `fail` those jobs and the client is refunded.

## Development mode

`ESCROW_MODE=mock` mints random keys in memory, rotates them every `ESCROW_ROTATE_INTERVAL_MS` and can copy them between instances with `POST /handover` (`PEER_URL`, `PEER_REQUIRED`, `PEER_SYNC_S`). Its attestation evidence is forgeable by design. Use it only for development and CI, and never expose it to the internet. The node logs a warning at boot in this mode.

The mock-only variables are listed in [Configuration](../reference/configuration.md#escrow).
