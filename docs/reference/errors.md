---
title: Errors
description: The error envelope, the error types, the retry rule, and the codes routes return.
---

## Envelope

```json
{ "error": { "message": "expires_at must be in (now, now+86400]", "type": "invalid_request_error", "param": "expires_at", "code": null } }
```

| Field | Meaning |
| --- | --- |
| `message` | Human-readable. Do not parse it. |
| `type` | The error class, below. |
| `param` | The request field at fault, or `null`. |
| `code` | A machine-readable discriminator within `type`, or `null`. Branch on this. |

Two routes answer some failures with a different body, documented on the route: [`POST /v1/jobs`](./client-api.md#post-v1jobs) answers a changed price with a fresh quote, and [`POST /evm/ops`](./provider-api.md#post-evmops) answers a chain refusal with `{"ok": false, "reason": …}`.

## Retrying

**Retry on the `x-vorq-retryable` response header, never on `type` or status.** `true` means the identical request may succeed later; `false` means it will not, and you must change the request (or stop).

## Types

| `type` | Typical status | Retryable | Meaning |
| --- | --- | --- | --- |
| `invalid_request_error` | 400, 403, 409, 413 | no | The request is malformed, refused by policy, or refused by the chain. |
| `authentication_error` | 401, 403 | no | Missing or invalid session, or a signature from the wrong wallet. |
| `invalid_op_signature` | 403 | no | A provider op or ask snapshot does not recover to a registered provider. |
| `not_found` | 404, 410 | no | No such resource. |
| `busy` | 429 | yes | More than 8 requests are queued on one job or op subject. Retry shortly. |
| `rate_limit_exceeded` | 429 | no | The wallet reached the coordinator's 24-hour job limit for this model. The message names when the next slot opens. |
| `not_ready` | 503 | yes | The index is catching up, or a joining escrow has no key yet. |
| `chain_unreachable` | 503 | yes | The RPC endpoint did not answer. |
| `relay_unavailable` | 503 | yes | The coordinator could not get its own transaction or chain read through. Nothing is wrong with the request. |
| `pinner_unavailable` | 503 | yes | The object store could not be reached, or no longer holds an object. |
| `receipt_timeout` | 504 | **no** | The transaction was broadcast but no receipt arrived within 60 seconds. `code` is the transaction hash. Poll the job or provider instead of re-sending. |
| `internal_error` | 500 | no | Unexpected failure. |

A `409` always means the chain refused, or would refuse, the transaction. Failing to reach the chain is never a `409`.

## `relay_unavailable` codes

| `code` | Cause |
| --- | --- |
| `relayer_funds` | The relayer account is out of ETH. An operator must top it up. |
| `nonce_conflict` | The relayer's transaction lost a nonce race. |
| `rpc_internal`, `rate_limited` | The RPC endpoint answered `-32603` or `-32005`. |
| `endpoint_refused` | The RPC endpoint refused the transaction for another reason. |
| `relay_queue_full`, `relay_queue_timeout` | Too many relays are queued on the relayer account (`RELAY_MAX_DEPTH`), or one waited longer than `RELAY_QUEUE_TIMEOUT_MS`. |
| `config_read`, `payer_code_read`, `provider_id_read`, `registry_floor_read`, `claim_simulate_read`, `job_read`, `allowlist_status_read` | A named chain read failed. |
| `publication_skipped` | An ask snapshot was mined but the chain recorded no publication. |

## `pinner_unavailable` codes

| `code` | Cause |
| --- | --- |
| `store_unavailable` | The object store did not answer. |
| `store_rejected` | The object store refused the request. |
| `object_missing` | The object behind a file is no longer stored. |

## Common request codes

| Status | `code` | Where | Cause |
| --- | --- | --- | --- |
| `400` | `null` | any | A malformed field; `param` names it. |
| `401` | `invalid_session` | session routes | Missing, malformed or expired session token. |
| `413` | `body_too_large` | any JSON route | The body is over the route's limit. Upload the payload instead. |
| `413` | `file_too_large` | `POST /v1/files` | The file is over `MAX_BLOB_BYTES`. |
| `404` | `null` | any | Unknown route, job, provider, file or batch. |

Route-specific codes are listed with each route in the [client](./client-api.md), [provider](./provider-api.md), [auth](./auth-api.md) and [escrow](./escrow-api.md) references.
