---
title: Self-host the coordinator
description: Run your own coordinator against a VORQ deployment, with Postgres, an RPC endpoint and an object store.
---

## Requirements

- Node.js 22 or newer, or Docker.
- PostgreSQL 16 or newer. Migrations refuse older versions.
- A JSON-RPC endpoint for the chain the VORQ contracts are deployed on.
- An S3-compatible object store that pins each object to IPFS and returns its CID, either as a `CID` element in the `CompleteMultipartUpload` response or as an `x-amz-meta-cid` response header. A plain S3 bucket does not mint CIDs, and every upload through it fails.
- A relayer account (`RELAYER_KEY`) funded with ETH. It pays the gas for every relayed transaction.
- The deployment's address book (see [Configuration](../reference/configuration.md#address-book)).

## 1. Get the code and a database

```sh
git clone https://github.com/vorq-ai/vorq-coordinator-node.git
cd vorq-coordinator-node
npm install
docker compose -f compose.dev.yml up -d   # Postgres 16 on localhost:5433, user/password/db: vorq
```

## 2. Start it

```sh
ADDRESSES_FILE=./addresses.json \
DATABASE_URL=postgres://vorq:vorq@localhost:5433/vorq \
RPC_URL=https://rpc.example.com \
RELAYER_KEY=0x… \
PIN_S3_ENDPOINT=https://s3.example.com PIN_S3_KEY=… PIN_S3_SECRET=… PIN_S3_BUCKET=vorq \
npm start
```

The server listens on port `8402`. Every variable is listed in [Configuration](../reference/configuration.md).

### With Docker

```sh
docker build -t vorq-coordinator .
docker run -p 8402:8402 \
  -e ADDRESSES_JSON="$(cat addresses.json)" \
  -e DATABASE_URL=… -e RPC_URL=… -e RELAYER_KEY=… \
  -e PIN_S3_ENDPOINT=… -e PIN_S3_KEY=… -e PIN_S3_SECRET=… -e PIN_S3_BUCKET=… \
  vorq-coordinator
```

The image runs as an unprivileged user, listens on `0.0.0.0:$PORT` and has a `HEALTHCHECK` on `/readyz`.

## 3. Wait for it to be ready

On boot the node:

1. Applies database migrations.
2. Checks the EIP-712 domains of the payment token and the three registries against the chain, and exits on a mismatch.
3. With `ESCROW_MODE=mock`, checks escrow key retention against the chain's limits.
4. Starts listening.
5. Indexes contract events from its last indexed block, or from the address book's `deployBlock` on an empty database.

Until the index is within `READY_LAG_BLOCKS` of the head, `/healthz` is `200`, `/readyz` is `503` and index-backed routes answer `503 not_ready`. A first replay can take minutes. Use `/healthz` for liveness and `/readyz` for readiness. If the replay fails, the process exits non-zero so a supervisor can restart it.

## 4. Set up the object store

The node uploads every payload as a multipart upload and aborts it when a request fails. An upload interrupted by a crash or a dropped connection can stay incomplete; add an `AbortIncompleteMultipartUpload` lifecycle rule (or your store's equivalent) with a one-day expiry.

The node deletes unattached uploads after 300 seconds and every object older than `FILE_RETENTION_SECONDS`. See [Payloads and file retention](../concepts/payloads-and-file-retention.md).

## 5. Serve browsers (optional)

Set `CORS_ORIGINS` to the exact origins of your web apps:

```sh
CORS_ORIGINS=https://app.example.com,http://localhost:3000
```

Unset, the node sends no CORS headers.

## Keep it running

- **Relayer balance.** When the relayer runs out of ETH, relayed writes answer `503 relay_unavailable` with `code: "relayer_funds"`. Top it up. The order's `gas_fee` is set by the `JobRegistry` and paid to its treasury, not to the relayer.
- **Reclaims.** The node calls `reclaim` once a minute for claimed jobs past their SLA, so clients are refunded even when nobody else acts.
- **Reorgs.** If `/readyz` reports `reason: "reorg"`, rebuild the index: see [Recover from a reorg](./recover-from-a-reorg.md).
- **Open bids.** To accept open-bid orders, run the escrow: see [Run the escrow](./run-the-escrow.md).
- **Error reporting.** Set `SENTRY_DSN` to report errors. The Docker image preloads the reporter; with `npm start` it is preloaded too.
