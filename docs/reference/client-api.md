---
title: Client API
description: Every /v1/* route, for models, jobs, the prepaid balance, files and batches.
---

The request and response schema for every route on this page is in the [API reference](https://api.vorq.co/docs). This page covers the flow and what each refusal means.

Routes under `/v1/*`. Encoding, headers, paging and body limits are in [API conventions](./conventions.md); the error envelope and retry rule are in [Errors](./errors.md).

## Models

### GET /v1/models

The models that can be ordered. Disabled models are not listed; [`GET /evm/models`](./provider-api.md#get-evmmodels) lists every registered model in the same shape.

**Auth:** public · **Index-backed:** yes · **Paged:** yes

`id` is the model's name; `vorq.model_id` is the id orders use. `vorq.enabled` is `true` on every listed model.

```sh
curl -s https://api.vorq.co/v1/models
```

### GET /v1/models/{name}

One model by name. Names may contain `/`; send them as-is or percent-encoded.

**Auth:** public · **Index-backed:** yes

**Errors**

| Status | `code` | Cause |
| --- | --- | --- |
| `404` | `model_not_found` | No model has this name. |

## Jobs

### POST /v1/jobs

Quote or submit an order. The same body, sent without and then with `amount`, first returns a `402` quote and then holds the job. See [Submit a job](../guides/submit-a-job.md).

**Auth:** public (the order signature is the authority) · **Index-backed:** no · **Body limit:** 20 MiB

**Order** (every request):

- `c` is the commitment to the sealed container, and `job_id` must equal `keccak256(owner ‖ c)`.
- `owner` is the order's owner, whose prepaid balance pays for it; `signature` is its [`Order`](./signed-messages.md#order) signature.
- `rate_in` and `rate_out` are USD per million units, as decimal strings; the order signature covers them as `rate × 10^decimals` (see [Conventions](./conventions.md#numbers)). `units_in` and `units_out` are the most units the order pays for.
- `designated` is `0` for an open bid, or the provider id the job is reserved for.
- `sla_secs` must be an SLA the chain allows, at most `86400`.
- `expires_at` must be in `(now, now + 86400]`.
- `model_id` must be an enabled model.

**Submission** (second request only):

- `amount` is the quoted `amount`: what the claim will lock from the owner's prepaid balance.
- Send exactly one of `container` (the sealed container, base64, up to 15 679 488 bytes decoded) and `container_cid` (the `vorq.cid` of an `input` upload by `owner`).

**Market probe** (a body with neither `rate_in` nor `rate_out`): `model_id`, `sla_secs`, `units_in`, `units_out` and optional `designated`, `max_rate_in` and `max_rate_out`, unsigned. The answer is `402` with `{"candidates": [...]}` only: every live ask for the model and window at or under the ceilings named, ranked as below, with no quote. See [Matching and leases](../concepts/matching-and-leases.md#the-market-probe).

**Response `402`**: the quote, when `amount` is absent. `x-vorq-retryable: false`.

```json
{
  "quote": {
    "cap": "0.0096",
    "fee_bps": 100,
    "fee": "0.000096",
    "gas_fee": "0.002",
    "amount": "0.011696",
    "balance": "0.005",
    "deposit": "0.008696",
    "deposit_fee": "0.002"
  },
  "candidates": [
    { "provider_id": 7, "box_key": "0x…", "rate_in": "0.0015", "rate_out": "0.006", "rate_in_cached": "0.00075" }
  ],
  "accepts": [{ "scheme": "eip3009", "network": "eip155:8453" }]
}
```

- `quote.cap` is the ceiling in USD: `(rate_in·units_in + rate_out·units_out) / 10^6`, rounded up to the token's smallest unit and never below one (`"0.000001"` for USDC).
- `quote.fee` is `cap · fee_bps / 10000`, rounded down to the smallest unit; `quote.gas_fee` is the flat relay charge, read from the `JobRegistry`; `quote.amount` is `cap + fee + gas_fee`, what a claim locks.
- `quote.balance` is the owner's available prepaid balance: its balance on chain less what its open orders reserve.
- `quote.deposit` is what to [deposit](#post-v1deposits) before submitting: `"0"` when `balance` covers `amount`, otherwise `amount − balance + deposit_fee`, so the deposit credits exactly the shortfall. `quote.deposit_fee` is the flat fee the registry takes from each deposit.
- `candidates` lists up to `MATCH_CANDIDATES` live providers whose ask clears the order, cheapest first, with the ask's rates and its listed `rate_in_cached` (at most `rate_in`, not signed); empty when none match. See [Matching and leases](../concepts/matching-and-leases.md).
- `accepts` names the deposit scheme and CAIP-2 network.

**Response `202`**: `{job_id, task_cid}`. The coordinator holds the order; `task_cid` is the IPFS CID the container was stored under. The job reads as `queued` at [`GET /v1/jobs/{id}`](#get-v1jobsid) as soon as this returns, and goes on chain inside the claim of the provider that takes it. See [Held orders](../concepts/matching-and-leases.md#held-orders).

**Errors**

| Status | `code` | Cause |
| --- | --- | --- |
| `400` | `null` | A malformed field (`param` names it as a path); `job_id` mismatch; `expires_at` out of range; `sla_secs` over 86400 or not allowed; model not enabled. |
| `400` | `cap_overflow` | `cap` exceeds 2^53 − 1, the largest amount the API carries. |
| `400` | `invalid_order_signature` | `signature` does not recover to `owner`. |
| `400` | `container_without_payment` | A container was sent without `amount`. |
| `400` | `container_required` | `amount` was sent without a container. |
| `400` | `container_ambiguous` | Both `container` and `container_cid`. |
| `400` | `unknown_container` | `container_cid` names no `input` upload by `owner`, or it expired. |
| `400` | `too_short`, `bad_version`, `commitment_mismatch` | The container is malformed or does not reproduce `c`. |
| `409` | *(quote body)* | `amount` is not the current `cap + fee + gas_fee` (`gas_fee` or `fee_bps` changed), or the available balance no longer covers it. The body is a fresh `{quote, candidates, accepts}`. Make its `deposit` and resubmit with its `amount`. |
| `409` | `DuplicateJob` | This `job_id` is already taken, here or on chain. Use a fresh `c`. |
| `429`, `503` | | See [Errors](./errors.md). |

The quote is answered after the order signature is checked and before the model, SLA-allowlist and duplicate checks, so a `402` does not guarantee the submission will pass them.

### GET /v1/jobs/{id}

The client view of one job, by `job_id`.

**Auth:** public · **Index-backed:** yes

`status` is `queued`, `in_progress`, `completed`, `failed` or `cancelled`; see [Job lifecycle](../concepts/job-lifecycle.md#states). `in_progress_at` is the claim time, `null` before a claim. `result_cid` is the sealed result's IPFS CID once settled, else `null`. `model` is `null` if the catalog does not know the model. `vorq.gas_fee` is the relay gas fee in USD the order was quoted at, and once claimed the one the claim locked: paid once the job is claimed, whether it then settles, fails or is reclaimed, and never by a job cancelled or expired while open. `vorq.fee` is the protocol fee in USD that settlement took on top of the charge; `"0"` for a job that did not settle. `vorq.prompt_tok`, `vorq.cached_tok`, `vorq.completion_tok` and `vorq.rate_in_cached` are what settlement billed (see [When funds move](../concepts/job-lifecycle.md#when-funds-move)), `0` until settled.

**Errors:** `400` for a malformed id; `404` until the coordinator has a record of the job.

```sh
curl -s https://api.vorq.co/v1/jobs/0x…
```

### POST /v1/jobs/{id}/cancel

Cancel an open job. See [Cancel a job](../guides/cancel-a-job.md).

**Auth:** public (the owner's signature is the authority) · **Index-backed:** no · **Body limit:** 8 KiB

`signature` is the owner's [`Cancel`](./signed-messages.md#cancel) signature over `(id, issued_at)`, with `issued_at` within ±600 seconds of the coordinator's clock.

An open job is an order the coordinator holds, not yet on chain, so the cancel ends it in the coordinator and nothing is relayed. **Response `200`:** `{job_id}`.

**Errors**

| Status | `code` | Cause |
| --- | --- | --- |
| `404` | `null` | No job under this id. |
| `409` | `StaleOp` | `issued_at` outside ±600 seconds. |
| `409` | `NotTheOwner` | The signature does not recover to the job's owner. |
| `409` | `NotOpen` | The job was claimed, settled or already cancelled. |
| `409` | `order_leased` | A provider holds the order and may be claiming it. Cancel again once its lease lapses unclaimed. |
| `503` | | See [Errors](./errors.md). |

## Balance

A client pays for jobs from a prepaid balance the `JobRegistry` holds for it. Every route here needs a [session](../guides/authenticate-with-a-wallet.md); the two writes are authorised by the owner's signature in the body, relayed and paid for by the coordinator, and simulated before anything is sent. All three answer the same **balance body**:

```json
{ "owner": "0x…", "balance": "0.05", "reserved": "0.01606", "available": "0.03394", "deposit_fee": "0.002" }
```

- `balance` is `JobRegistry.balanceOf(owner)`, already net of every claimed job's lock.
- `reserved` is what the owner's open orders will lock when they are claimed.
- `available` is `balance − reserved`, never below `0`: what a new order or a withdrawal can draw on.
- `deposit_fee` is the flat fee the registry takes from each deposit.

Deposits, withdrawals and submissions of one owner decide against its balance one at a time, and deposits plus withdrawals count against `MONEY_RATE_LIMIT` (default 24) per wallet per 24 hours.

### GET /v1/balance

The balance body for `?owner=0x…`.

**Auth:** session · **Index-backed:** no

### POST /v1/deposits

Relay a deposit into the prepaid balance.

**Auth:** session (the authorization signature is the authority) · **Index-backed:** no

**Request**

```json
{ "owner": "0x…", "value": "0.05", "valid_before": 1786003600, "nonce": "0x…", "auth_sig": "0x…" }
```

`auth_sig` is the owner's [`ReceiveWithAuthorization`](./signed-messages.md#receivewithauthorization) to the `JobRegistry` for `value` (USD, signed as `value × 10^decimals`), with `validAfter` `0`, `valid_before` and a random 32-byte `nonce`. The registry credits `value − deposit_fee`.

**Response `200`:** the balance body after the deposit. An authorization that was already used answers `200` with the current balance, and nothing is relayed.

**Errors**

| Status | `code` | Cause |
| --- | --- | --- |
| `400` | `null` | A malformed field; `value` with more fraction digits than the token has. |
| `400` | `payer_has_code` | `owner` has contract code (a smart account or an EIP-7702 delegation). Deposit from an account with no code. |
| `401` | `invalid_session` | No valid session. |
| `409` | contract error name | The chain refuses the deposit, for example `BadDepositValue` (`value` at or under `deposit_fee`), or `unknown` for a refusal by the payment token. |
| `429`, `503`, `504` | | See [Errors](./errors.md). |

### POST /v1/withdrawals

Relay a withdrawal from the prepaid balance to the owner's wallet.

**Auth:** session (the owner's signature is the authority) · **Index-backed:** no

**Request**

```json
{ "owner": "0x…", "amount": "0.01", "issued_at": 1786000000, "signature": "0x…" }
```

`signature` is the owner's [`Withdraw`](./signed-messages.md#withdraw) signature over `(amount × 10^decimals, issued_at)`. `issued_at` must be within ±600 seconds of the coordinator's clock and greater than the owner's last withdrawal's.

**Response `200`:** the balance body after the withdrawal.

**Errors**

| Status | `code` | Cause |
| --- | --- | --- |
| `400` | `null` | A malformed field; `amount` of `0`. |
| `401` | `invalid_session` | No valid session. |
| `409` | `insufficient_balance` | `amount` is more than `available`. Open orders keep what they reserve. |
| `409` | `StaleOp` | `issued_at` outside ±600 seconds, or not after the owner's last withdrawal. |
| `409` | other contract error name | The chain refuses the withdrawal, for example `InvalidWithdrawSignature`. |
| `429`, `503`, `504` | | See [Errors](./errors.md). |

## Files

### POST /v1/files

Upload a sealed container, a sealed result or a batch input. The file is streamed to the object store.

**Auth:** session · **Index-backed:** no · **Body:** `multipart/form-data`

The `purpose` part must come **before** the one `file` part. The file may be up to `MAX_BLOB_BYTES` (200 MiB by default).

| `purpose` | Contents | Checks |
| --- | --- | --- |
| `input` | A sealed container | Framing; the commitment is computed during upload so `POST /v1/jobs` can compare it with `c`. |
| `result` | A sealed result | Non-empty. |
| `batch` | JSONL, one request per line | At least one and at most 50 000 non-blank lines. |

`vorq.cid` is what `container_cid` and `result_cid` reference; `id` is what `input_file_id` references. `expires_at` is 300 seconds after upload until the file is attached; see [File retention](../concepts/payloads-and-file-retention.md#file-retention). `vorq.lines` counts non-blank lines for `batch` files and is `0` otherwise.

**Errors**

| Status | `code` | Cause |
| --- | --- | --- |
| `400` | `invalid_purpose` | `purpose` is not `input`, `result` or `batch`. |
| `400` | `empty_file` | No bytes, or a batch file with no requests. |
| `400` | `too_many_lines` | A batch file over 50 000 lines. |
| `400` | `bad_container` | An `input` file that is not a valid container. |
| `400` | `null` | Missing `purpose` or file part, or a malformed form. |
| `413` | `file_too_large` | Over `MAX_BLOB_BYTES`. |
| `503` | `store_unavailable`, `store_rejected` | The object store failed. Retryable. |

```sh
curl -s -X POST https://api.vorq.co/v1/files \
  -H "authorization: Bearer $TOKEN" \
  -F purpose=input -F file=@container.bin
```

### GET /v1/files/{id}

The file object, as returned by [`POST /v1/files`](#post-v1files). Batch output files have `purpose: "batch_output"` and `status: "processed"`.

**Auth:** session; only the file's owner · **Index-backed:** no

**Errors:** `404` for an unknown file or one owned by another address.

### GET /v1/files/{id}/content

The file's bytes.

**Auth:** session; only the file's owner · **Index-backed:** no

**Response `200`:** `application/jsonl` for `batch` uploads, `application/octet-stream` for every other file, including batch output files.

**Errors:** `404` for an unknown file or one owned by another address; `503` with `code: "object_missing"` when the object store no longer holds it.

## Batches

Batch objects follow the OpenAI batch shape. Every line of the input file is a complete [`POST /v1/jobs`](#post-v1jobs) submission body; see [Run a batch](../guides/run-a-batch.md).

Every batch route needs a session. A missing one answers `401` with `code: "invalid_session"` before the body is validated.

### POST /v1/batches

Create a batch from an uploaded `batch` file.

**Auth:** session · **Index-backed:** no

`input_file_id` must name a `batch` upload by this session's address. A line's `url`, when present, must equal `endpoint`. The batch expires `completion_window` after creation.

**Response `200`:** a [batch object](#batch-object) with `status: "validating"`.

**Batch plan** (a body with no `input_file_id`): ask how the network would take the lines before sealing anything.

```json
{ "completion_window": "24h", "models": [{ "model_id": 3, "lines": 120, "units_in": 48000, "units_out": 491520 }] }
```

`units_in` and `units_out` are the totals over that entry's lines. An entry may add `max_rate_in` and `max_rate_out` (USD per 1M units); only providers asking at or under them are planned. An entry may add `providers`, 1 to 64 distinct provider ids (absent for the whole market); its lines are planned onto those providers alone, cheapest first, and get fewer or none when they cannot take them. Entries may repeat a `model_id` with different `providers`, up to 16 entries. The answer is `402` with, per entry, the providers to seal to, their ask and how many lines each takes:

```json
{ "plan": [{ "model_id": 3, "lines": 120, "allocation": [{ "provider_id": 1, "box_key": "0x…", "rate_in": "2.1184", "rate_out": "10.6264", "rate_in_cached": "2.1184", "lines": 120 }] }] }
```

Each live provider's share is at most its on-chain capacity less what it already holds: claimed jobs and open orders designated to it. Providers are filled cheapest first for the model's unit mix, and equal prices take turns. Nothing is reserved. When the `allocation` lines add up to fewer than `lines`, the network cannot take the batch in that window now; the SDKs refuse it before sealing.

**Errors**

| Status | `code` | Cause |
| --- | --- | --- |
| `400` | `invalid_endpoint` | Unsupported `endpoint`. |
| `400` | `invalid_completion_window` | Not `1h` or `24h`. |
| `400` | `invalid_input_file` | No `batch` file with this id for this address. |
| `400` | `null` | A malformed or missing field (`param` names it as a path). |
| `401` | `invalid_session` | No valid session. Answered before the body is validated. |

### GET /v1/batches

This address's batches, newest first.

**Auth:** session · **Index-backed:** yes

Pass `last_id` as `after` to get the next page while `has_more` is `true`.

### GET /v1/batches/{id}

One [batch object](#batch-object) plus `as_of_block`.

**Auth:** session; only the batch's owner · **Index-backed:** yes

**Errors:** `404` for an unknown batch or one owned by another address.

### POST /v1/batches/{id}/cancel

Stop a batch. Lines not yet held are not held. Lines already held are not cancelled: open ones stay open until claimed or expired, and claimed ones run to completion. The owner can [cancel each job](#post-v1jobsidcancel). Repeating the call is a no-op.

**Auth:** session; only the batch's owner · **Index-backed:** yes

**Response `200`:** the [batch object](#batch-object) plus `as_of_block`, with `cancelling_at` set.

**Errors**

| Status | `code` | Cause |
| --- | --- | --- |
| `400` | `batch_not_cancellable` | The batch is not `validating`, `in_progress` or `cancelling`. |
| `404` | `null` | Unknown batch, or owned by another address. |

### Batch object

- `status` is `validating` (not yet processed), `in_progress`, `finalizing` (every line ended, files being written), `completed`, `failed`, `expired` (the window ended first), `cancelling` or `cancelled`.
- `request_counts.total` counts the lines recorded; `completed` those settled; `failed` those skipped, cancelled, failed, reclaimed or expired.
- `output_file_id` and `error_file_id` are set when the batch finishes, and stay `null` when that file would be empty.

Status and counts are computed from the member jobs on every read.

### Batch output files

Both files are JSONL, read with [`GET /v1/files/{id}/content`](#get-v1filesidcontent). Line ids have the form `batch_req_<batch>_<line number>`.

**Output file**: one line per settled job.

```json
{"id":"batch_req_5e2a…_1","custom_id":null,"response":{"status_code":200,"request_id":"0x<job_id>","body":null},"error":null,"vorq":{"job_id":"0x…","result_cid":"bafy…","provider":7,"rate_in":"0.0015","rate_in_cached":"0.00075","rate_out":"0.006","gas_fee":"0.03","fee":"0","prompt_tok":412,"cached_tok":0,"completion_tok":800}}
```

Results are sealed to the owner, so `body` is always `null`: fetch each result by `result_cid`. Your own request ids travel inside the sealed payload and result.

**Error file**: one line per input line that did not settle.

```json
{"id":"batch_req_5e2a…_2","custom_id":null,"response":null,"error":{"code":"insufficient_funds","message":"…"},"vorq":{"job_id":null,"line":2}}
```

| `error.code` | Cause |
| --- | --- |
| `invalid_json`, `invalid_line` | The line is not a JSON object, or a field is malformed. Other field-level codes from [`POST /v1/jobs`](#post-v1jobs) may appear. |
| `endpoint_mismatch` | The line's `url` differs from the batch `endpoint`. |
| `container_required`, `unknown_container`, `too_short`, `bad_version`, `commitment_mismatch` | Missing, unknown or invalid container. |
| `order_expired`, `expiry_too_far`, `sla_too_long`, `cap_overflow` | Order terms out of range when the batch was processed. |
| `insufficient_payment` | `amount` is not exactly `cap + fee + gas_fee`. |
| `invalid_order_signature` | The order signature does not recover to `owner`. |
| `insufficient_funds` | The owner's available balance, after the lines before it, does not cover the line's `amount`. |
| `duplicate_job_id` | Another line in the file has the same `job_id`. |
| `DuplicateJob` | An order outside this batch already has the line's `job_id`. |
| `invalid_model` | The model is not enabled. |
| `cancelled` | The batch was cancelled before the line was held, or the owner cancelled the job. |
| `provider_fail`, `reclaim`, `expired` | Held, but the provider failed it, missed its SLA, or nobody claimed it in time. |
