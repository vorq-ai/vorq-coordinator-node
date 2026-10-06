---
title: Authentication model
description: Why the coordinator separates sessions from signatures, and which routes need which.
---

The coordinator uses two separate mechanisms, and neither stands in for the other.

- **Signatures carry authority.** Orders, payments, cancels, provider ops, ask snapshots and key releases are EIP-712 messages signed by the actor. The contracts verify them, so nothing happens on chain that the actor did not sign. The coordinator checks each one first, so it never pays gas for a transaction the chain would refuse.
- **Sessions are a transport gate.** A bearer token says the caller proved control of an address to this coordinator. It never authorises anything on chain. It scopes private data (your uploads and batches) and stops strangers from using the relay.

## Sessions

A session comes from a handshake: the coordinator issues a nonce, the wallet signs a `VorqSession` message over it, and the coordinator returns a token. See [Authenticate with a wallet](../guides/authenticate-with-a-wallet.md).

- A nonce is single-use and lives 300 seconds. An address holds at most 16 live nonces; issuing another drops the oldest.
- A token lives 24 hours. An address holds at most 32 live sessions; creating another evicts the one closest to expiry.
- A `provider` session binds the wallet's `ProviderRegistry` id. Only a provider session can lease jobs with `GET /evm/jobs?free=N`.
- The `VorqSession` domain is bound to the deployment's chain id, so a signature for one deployment is useless on another.

Sessions are stored in the coordinator's database. They are not portable between coordinators.

## Which routes need a session

| Route | Session |
| --- | --- |
| `GET /evm/jobs` with `free=N` | provider |
| `POST /evm/ops` | any |
| `PUT /evm/asks` | any |
| `POST /v1/files`, `GET /v1/files/{id}`, `GET /v1/files/{id}/content` | any; files belong to the session's address |
| `POST /v1/batches`, `GET /v1/batches`, `GET /v1/batches/{id}`, `POST /v1/batches/{id}/cancel` | any; batches belong to the session's address |

Every other route is public, including `POST /v1/jobs`, `POST /v1/jobs/{id}/cancel`, `POST /evm/simulate/claim` and `POST /release`: there the signatures in the body are the authority.

## Session and signer are independent

On `POST /evm/ops` and `PUT /evm/asks`, the coordinator does not compare the session's address with the signer. A valid session is never enough to relay a message someone else did not sign, and a message signed by a registered provider is valid whoever relays it. The one place the two meet is settlement by upload: a `result_cid` must name an upload made by the same session address.

## Replay protection

- Job ops (`Cancel`, `Claim`, `Settle`, `Fail`) carry `issuedAt` and must land within 600 seconds of it. The contract also refuses to apply an op to a job in the wrong state.
- Provider-registry ops (`SetIdentity`, `RequestCapacity`) must carry an `issuedAt` strictly greater than the last accepted one, and at most one hour ahead.
- Ask snapshots must carry a `signedAt` newer than the provider's last, and at most one hour ahead.
- The payment authorization's nonce is the `job_id`, so it can pay for exactly one job.

Every signed type is listed in [Signed messages](../reference/signed-messages.md).
