---
title: Payloads and file retention
description: The sealed container format, how the commitment ties it to the order, how payloads are stored, and how long files are kept.
---

## The sealed container

A client never sends plaintext. The job's input travels as a sealed **container**:

```
container = version (1 byte, 0x01) ‖ seed_wrap (80 bytes) ‖ ciphertext
```

`seed_wrap` seals a random 32-byte seed to one public key: the chosen provider's `box_key` for a designated order, or the coordinator's escrow key for an open bid. The payload key is derived from that seed and the owner's address (see [Escrow and key release](./escrow-and-key-release.md#key-derivation)). The provider's result is sealed back to the client.

## The commitment

The signed order commits to the container through `c`:

```
c      = keccak256(version ‖ seed_wrap ‖ keccak256(ciphertext))
job_id = keccak256(owner ‖ c)
```

The coordinator recomputes `c` from the bytes it receives, inline or during upload, and refuses a post whose container does not match (`400 commitment_mismatch`). A container shorter than 81 bytes is refused as `too_short`, and one that does not start with `0x01` as `bad_version`. Providers check the same relation before they claim.

Because `job_id` depends on `c`, a client that lost its connection mid-post can compute the id and read the job instead of posting again.

## Where payloads live

The coordinator stores payload bytes in its object store, which pins them to IPFS. The IPFS content identifier (CID) it gets back is what goes on chain:

- the input's CID becomes the job's `task_cid`, set in the same `post` transaction;
- the result's CID becomes `result_cid`, set in the same `settle` transaction.

A job and its payload therefore land together or not at all. Anyone can fetch the bytes from an IPFS gateway by CID; they are sealed, so only the key holders can open them.

## Inline or upload

A request body is limited to 20 MiB. Within it, a container or result can be sent inline as base64 up to 15 679 488 bytes. Anything larger is uploaded first with [`POST /v1/files`](../reference/client-api.md#post-v1files) (up to `MAX_BLOB_BYTES`, 200 MiB by default) and referenced by its CID:

| Purpose | Uploaded by | Referenced as |
| --- | --- | --- |
| `input` | the order's owner | `container_cid` on `POST /v1/jobs` |
| `result` | the provider's session address | `result_cid` on a `settle` op |
| `batch` | the batch owner | `input_file_id` on `POST /v1/batches` |

An upload can only be referenced by the address that made it.

## File retention

- **Unattached uploads** expire 300 seconds after upload. Upload right before you post, settle or create the batch.
- **Attaching** an upload (a post naming its `container_cid`, a settle naming its `result_cid`, a batch naming its input file) extends it to the coordinator's retention period, `FILE_RETENTION_SECONDS`, 30 days by default, counted from the upload.
- **Batch output files** are kept for the same retention period.
- **Retention is a ceiling.** Every stored object is removed once it is older than the retention period, whatever still refers to it. Clients and providers that need a payload for longer keep their own copy.

The coordinator sweeps expired files and objects once a minute.
