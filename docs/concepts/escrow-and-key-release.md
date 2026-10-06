---
title: Escrow and key release
description: How a coordinator's escrow holds the key for open-bid payloads and releases it only to the provider holding the claim.
---

An open-bid order does not know in advance which provider will work it, so the client cannot seal its payload to a provider's key. Instead it seals a random seed to the key of the coordinator's **escrow**, and the escrow releases the payload key only to the provider that has claimed the job on chain.

Designated orders are sealed straight to the provider's `box_key` and do not use the escrow.

## The guarantee

> The escrow releases an open-bid payload key only to the registered provider wallet that holds the job's claim on chain.

[`POST /release`](../reference/escrow-api.md#post-release) authorises against the chain, never against the coordinator's index. It reads the job with `getJob` and requires that:

- the job exists and is in the Claimed state;
- the `seed_wrap` and `ct_hash` presented reproduce the job's commitment `c`;
- the request is signed by the wallet registered for the provider that claimed it.

So every release corresponds to a visible, on-record claim by a registered provider.

## Key derivation

The `seed_wrap` seals a 32-byte **seed**, not the key itself. The working key is bound to the job's owner:

```
dek = HKDF-SHA256(ikm = seed, salt = empty, info = utf8("vorq-dek") ‖ owner (20 raw bytes), length = 32)
```

Containers are publicly fetchable. Someone who copies a `seed_wrap` onto an order of their own receives a key derived under their own address, which opens nothing.

The escrow returns the key sealed to a one-time X25519 public key the provider sends with the request (`response_pubkey`), so it never crosses the wire in the clear.

## Where the escrow key comes from

In production mode (`ESCROW_MODE=static`) the escrow key is derived from the operator's `OPERATOR_KEY`. Every instance with the same operator key holds the same escrow key, and restarts lose nothing. [`GET /key`](../reference/escrow-api.md#get-key) announces the public key with evidence of type `static-coordinator-v1`, which binds the key to the escrow service. That evidence is computable by anyone, so trust rests on the operator's custody of `OPERATOR_KEY`. See [Run the escrow](../guides/run-the-escrow.md).

`ESCROW_MODE=mock` exists for development and CI. Its evidence is forgeable by design.

## When no key opens a wrap

If the escrow holds no key that opens a job's `seed_wrap`, `/release` answers `400 unseal_failed` (or, in development mode after key loss, `410 escrow_key_lost`). The provider should `fail` the job within 300 seconds of its claim: it takes no reputation penalty and the client is refunded. See [Job lifecycle](./job-lifecycle.md#when-funds-move).

## What it does not do

- **It does not protect open bids from the operator.** Whoever holds `OPERATOR_KEY` can derive the escrow key and open any open-bid payload sealed to it without a claim. Send an open bid only to a coordinator whose operator you trust with it, or use a designated order.
- **It is not end-to-end encryption between client and provider.** The provider that works an open-bid job decrypts it, and the escrow holds the key that makes that possible. The design bounds *how* the operator can reach a payload, through an on-record claim, not whether plaintext exists outside the client.
- **Running your own coordinator does not reduce trust for open bids.** The key still goes to whichever provider claims the job. It removes a hosted operator from the path of your designated work.
- **Designated orders avoid the escrow entirely.** If you know which provider you want, seal to it.
