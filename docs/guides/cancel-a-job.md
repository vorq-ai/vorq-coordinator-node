---
title: Cancel a job
description: Cancel an open job with a signed Cancel message.
---

The owner can cancel a job while it is still open. An open job is an order the coordinator holds and no provider has claimed, so the cancel ends it in the coordinator and nothing is relayed. Once a provider has claimed it, cancelling is refused and the job runs to settlement, failure or reclaim.

Cancelling needs no session. The authority is the owner's signature.

## 1. Sign `Cancel`

Sign this EIP-712 message with the order's owner wallet:

| | |
| --- | --- |
| Domain | `{ "name": "VORQ Jobs", "version": "2", "chainId": <chain_id>, "verifyingContract": <job_registry> }` |
| Type | `Cancel(bytes32 jobId,uint64 issuedAt)` |
| Message | `{ "jobId": <job_id>, "issuedAt": <now, unix seconds> }` |

`issuedAt` must be within 600 seconds of the coordinator's clock, so sign right before sending.

## 2. Send it

```sh
curl -s -X POST "$VORQ/v1/jobs/$JOB_ID/cancel" \
  -H 'content-type: application/json' \
  -d "{\"issued_at\": $ISSUED_AT, \"signature\": \"$CANCEL_SIG\"}"
```

```json
{ "job_id": "0x…" }
```

The job then reads `status: "cancelled"`. Nothing was locked: funds are locked only at claim. An open job past its `expires_at` can still be cancelled.

## When it is refused

| Answer | Cause |
| --- | --- |
| `404` | No job under this id. |
| `409`, `code: "NotOpen"` | A provider has claimed the job, or it has already settled or been cancelled. |
| `409`, `code: "order_leased"` | A provider holds the order and may be claiming it now. Cancel again once its lease lapses unclaimed. |
| `409`, `code: "NotTheOwner"` | The signature does not recover to the job's owner. |
| `409`, `code: "StaleOp"` | `issued_at` is more than 600 seconds from the node's clock. Sign again. |

See [`POST /v1/jobs/{id}/cancel`](../reference/client-api.md#post-v1jobsidcancel).
