---
title: Auth API
description: The session handshake routes, GET /auth/nonce and POST /auth/session.
---

The request and response schema for every route on this page is in the [API reference](https://api.vorq.co/docs). This page covers the flow and what each refusal means.

The session handshake. See [Authenticate with a wallet](../guides/authenticate-with-a-wallet.md) for a walkthrough and [Authentication model](../concepts/authentication-model.md) for what a session does and does not grant.

### GET /auth/nonce

Issue a single-use nonce for the wallet `address` that will sign.

**Auth:** public · **Index-backed:** no

The nonce is valid for 300 seconds, once. `chain_id` is the chain id to put in the `VorqSession` domain. An address holds at most 16 live nonces; issuing another drops the oldest.

```sh
curl -s "https://api.vorq.co/auth/nonce?address=0x…"
```

### POST /auth/session

Exchange a signed nonce for a session token.

**Auth:** public · **Index-backed:** no

**Request**

```json
{ "address": "0x…", "nonce": "3f9c…", "signature": "0x…", "role": "client" }
```

- `address` must be the address the nonce was issued to.
- `signature` is the wallet's [`VorqSession`](./signed-messages.md#vorqsession) signature over `(address, nonce)`.
- `role: "provider"` binds the wallet's `ProviderRegistry` id to the session; the answer then carries `provider_id`, and only then.

A session lasts 24 hours. An address holds at most 32 live sessions; creating another evicts the one closest to expiry.

Send the token as `authorization: Bearer <token>`. A missing, malformed or expired token answers `401` with `code: "invalid_session"`.

**Errors**

| Status | `code` | Cause |
| --- | --- | --- |
| `400` | `null`, `param: "nonce"` | Unknown, expired or already-used nonce. |
| `400` | `null` | A malformed field (`param` names it), or an unknown `role`. |
| `401` | `invalid_signature` | The signature is malformed or not from `address`, or `address` is not the one the nonce was issued to. |
| `403` | `not_registered` | `role: "provider"` for a wallet with no registry id. |
| `503` | `chain_unreachable`, `relay_unavailable` (`provider_id_read`) | The provider id could not be read from the chain. Retryable. |
