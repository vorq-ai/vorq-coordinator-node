---
title: Recover from a reorg
description: Rebuild the coordinator's index after the chain replaced a block it had indexed.
---

The indexer follows `latest` and records the hash of the last block it indexed. If the chain replaces that block, the indexer stops and the node stays unready:

```sh
curl -s "$VORQ/readyz"
```

```json
{ "ready": false, "reason": "reorg", "cursor": 12345670, "head_block": 12345690, "lag": 20 }
```

Waiting does not fix it. Rebuild the index from the chain.

## 1. Stop the node

Stop every coordinator process that uses the database.

## 2. Drop the derived tables

The index is a projection of the chain, except for the open orders: an order nobody has claimed exists only in the coordinator's database. Keep those rows, drop every other job, and drop exactly these tables, in one transaction:

```sql
BEGIN;
DELETE FROM jobs WHERE order_sig IS NULL;
DROP TABLE IF EXISTS cursor, providers, models, allowlist, asks_chain,
  sessions, nonces, provider_presence, job_leases, schema_migrations CASCADE;
COMMIT;
```

This is `dropDerived` in [`src/db/db.ts`](https://github.com/vorq-ai/vorq-coordinator-node/blob/main/src/db/db.ts): the rows it keeps are `PRUNED`, the tables it drops `DROPPABLE`. A kept row is an open order, or one its owner cancelled before any claim. Keep `pins`, `files`, `batches`, `batch_lines`, `provider_names` and `quotes_live` as well: they record uploads, batches, display names and unpublished ask snapshots, which the chain cannot give back. Never drop the whole schema.

## 3. Start the node

It re-applies the migrations and replays every event from the address book's `deployBlock`. An open order whose claim is in the replayed range becomes the claimed job again. `/readyz` turns `200` when the replay catches up.

## What users notice

- Sessions and nonces are gone: every client and provider runs the [session handshake](./authenticate-with-a-wallet.md) again.
- Provider presence and job leases are gone until providers poll again, so quotes name no candidates for a few seconds. Open orders stay in the book.
- During the replay, index-backed routes answer `503 not_ready`. Clients retry on the `x-vorq-retryable` header.
