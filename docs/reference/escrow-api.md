---
title: Escrow API
description: The escrow routes, GET /key, POST /release and POST /handover.
---

The request and response schema for every route on this page is in the [API reference](https://api.vorq.co/docs). This page covers the flow and what each refusal means.

The escrow routes exist on every coordinator. On one with `ESCROW_MODE=off` they answer `403` with `code: "escrow_unavailable"` (not retryable). They do not read the index, so they keep answering while it catches up. See [Escrow and key release](../concepts/escrow-and-key-release.md).

### GET /key

The X25519 public key a client seals an open bid's seed to.

**Auth:** public · **Index-backed:** no

`evidence.type` is `static-coordinator-v1` in production mode and `mock-coordinator-v1` in development mode, which also carries `measurement`, `tcb` and `quote`. `evidence.report_data` is `sha256(escrow_public_key ‖ utf8("vorq-coordinator-escrow-v1"))`. `evidence.release` is the node's `RELEASE_ORDINAL`; `issued_at` is the node's clock.

**Errors**

| Status | `code` | Cause |
| --- | --- | --- |
| `403` | `escrow_unavailable` | This coordinator hosts no escrow. |
| `503` | `escrow_key_unminted` | A joining development-mode instance holds no key yet. Retryable. |

```sh
curl -s https://api.vorq.co/key
```

### POST /release

Release an open-bid job's payload key to the provider holding its claim.

**Auth:** public (the signature and the chain are the authority) · **Index-backed:** no · **Body limit:** 2 KiB

**Request**

```json
{
  "job_id": "0x…",
  "seed_wrap": "<base64, 80 bytes>",
  "ct_hash": "0x<keccak256(ciphertext)>",
  "response_pubkey": "<64 hex characters, no 0x>",
  "issued_at": 1786000000,
  "signature": "0x…"
}
```

- `seed_wrap` is the container's 80-byte `seed_wrap`, canonical padded base64; `ct_hash` is `keccak256` of the container's ciphertext.
- `response_pubkey` is the X25519 key to seal the answer to.
- `issued_at` must be within ±600 seconds of the node's clock.
- `signature` is the claiming provider wallet's [`Release`](./signed-messages.md#release) signature.

The node reads the job from the chain and requires that it is Claimed, that `seed_wrap` and `ct_hash` reproduce its commitment, and that the signer is the registered wallet of the provider that claimed it.

**Response `200`:** the job's payload key (see [Key derivation](../concepts/escrow-and-key-release.md#key-derivation)), sealed to `response_pubkey`, as `dek_sealed`.

**Errors**

| Status | `code` | Cause |
| --- | --- | --- |
| `400` | `stale_issued_at` | `issued_at` outside ±600 seconds. |
| `400` | `bad_container` | Malformed `seed_wrap` or `ct_hash`. |
| `400` | `wrap_mismatch` | `seed_wrap` and `ct_hash` do not reproduce the job's commitment. |
| `400` | `unseal_failed` | No key this escrow holds opens the wrap. Fail the job within 300 seconds of the claim. |
| `400` | `null` | A malformed `job_id`, `response_pubkey` or `issued_at` (`param` names it). |
| `403` | `wrong_wallet` | The signature is malformed, or not from the provider holding the claim. |
| `403` | `escrow_unavailable` | This coordinator hosts no escrow. |
| `404` | `no_claim` | The chain has no such job. |
| `409` | `not_claimed` | The job is not in the Claimed state. |
| `410` | `escrow_key_lost` | Development mode only: the job was sealed to a key no live instance holds. Fail it within 300 seconds of the claim. |
| `503` | `chain_unreachable`, `relay_unavailable` (`job_read`, `provider_id_read`) | The chain read failed. Retryable. |

### POST /handover

Key transfer between development-mode (`ESCROW_MODE=mock`) instances. It answers `403 escrow_unavailable` when the escrow is off and `403 escrow_handover_disabled` in production mode, where every instance already derives the same key.

**Auth:** an operator signature in the body · **Index-backed:** no · **Body limit:** 4 KiB

`operator_signature` is a `HandoverAuth(bytes32 channelPubkey,uint64 issuedAt)` signature in the `VORQ Escrow` domain by an `OPERATOR_KEY` the holder accepts. The answer carries the held keys sealed to `channel_pubkey`.

**Errors:** `stale_issued_at`, `bad_binding`, `debug_evidence`, `stale_release`, `bad_operator_signature`, `operator_not_authorized`, `not_allowlisted`, `tombstoned`, `escrow_unavailable`, `escrow_handover_disabled`, and retryable `chain_unreachable` / `relay_unavailable` (`allowlist_status_read`).
