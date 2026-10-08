---
title: Run a batch
description: Post many signed orders from one JSONL file and read the per-line outcome files.
---

A batch posts many orders from one uploaded JSONL file. Each line is posted as its own job; the batch tracks them and writes an output file and an error file when they are all done.

You need a [session](./authenticate-with-a-wallet.md) for the wallet that owns the orders.

## 1. Write the input file

Each non-blank line is one complete [`POST /v1/jobs`](../reference/client-api.md#post-v1jobs) submission body: the order fields, `signature`, `auth_sig`, `amount`, and `container` or `container_cid`. A line may also carry `url`; when present it must equal the batch `endpoint`.

```jsonl
{"url":"/v1/responses","c":"0x…","model_id":3,"sla_secs":86400,"rate_in":"0.0012","rate_out":"0.005","units_in":1000,"units_out":1000,"designated":0,"expires_at":1786003600,"owner":"0x…","job_id":"0x…","signature":"0x…","auth_sig":"0x…","amount":"0.002007","container":"AQ…"}
```

- `amount` must be exactly `cap + fee + gas_fee` at the time the batch is processed. Quote one line first to learn the current `gas_fee` and `fee_bps`.
- A file holds at most 50 000 lines.
- Invalid lines are skipped and reported, never fatal to the batch.

## 2. Upload it

```sh
curl -s -X POST "$VORQ/v1/files" \
  -H "authorization: Bearer $TOKEN" \
  -F purpose=batch \
  -F file=@requests.jsonl | tee upload.json | jq '{id, vorq}'
```

`purpose` must come before `file` in the form.

## 3. Create the batch

```sh
curl -s -X POST "$VORQ/v1/batches" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"input_file_id\": \"$(jq -r .id upload.json)\", \"endpoint\": \"/v1/responses\", \"completion_window\": \"24h\"}" \
  | tee batch.json | jq '{id, status}'
```

`endpoint` is `/v1/responses` or `/v1/embeddings`. `completion_window` is `1h` or `24h`; a `24h` batch usually takes minutes to a few hours, 24 hours at most. The batch starts as `validating`; the coordinator picks it up within about 15 seconds and posts its lines on chain.

Lines that use `container_cid` are attached only when the batch is processed, and an unattached upload is deleted after 300 seconds. Upload those containers right before creating the batch.

## 4. Poll it

```sh
curl -s "$VORQ/v1/batches/$(jq -r .id batch.json)" \
  -H "authorization: Bearer $TOKEN" | jq '{status, request_counts, output_file_id, error_file_id}'
```

`status` goes `validating` → `in_progress` → `finalizing` → `completed`. It becomes `expired` if the window ends first. `request_counts` counts settled lines as `completed` and skipped, cancelled or failed lines as `failed`.

## 5. Read the results

When the batch is `completed` (or `expired` / `cancelled`), download the two files:

```sh
curl -s "$VORQ/v1/files/$OUTPUT_FILE_ID/content" -H "authorization: Bearer $TOKEN"
curl -s "$VORQ/v1/files/$ERROR_FILE_ID/content" -H "authorization: Bearer $TOKEN"
```

Either id is `null` when it would be empty. The output file has one line per settled job, naming its `result_cid`. Results are sealed to you, so fetch each one by its cid from an IPFS gateway. The error file has one line per line that did not complete, with a `code`. See [Batch output files](../reference/client-api.md#batch-output-files).

## Cancel a batch

```sh
curl -s -X POST "$VORQ/v1/batches/$BATCH_ID/cancel" -H "authorization: Bearer $TOKEN"
```

If the batch is still `validating`, none of its lines are posted. Lines already on chain are not touched: the coordinator cannot sign for you, so an open line stays open until a provider claims it or it expires. To stop those sooner, [cancel each job](./cancel-a-job.md) with your own signature. The batch reads `cancelling` until every line has ended, then `cancelled`.
