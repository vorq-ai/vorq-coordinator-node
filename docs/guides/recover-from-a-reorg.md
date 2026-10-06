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

The index is a projection of the chain. Drop exactly these tables, and nothing else:

```sql
DROP TABLE IF EXISTS cursor, jobs, providers, models, allowlist, asks_chain,
  sessions, nonces, provider_presence, job_leases, schema_migrations CASCADE;
```

This list is `DROPPABLE` in [`src/db/db.ts`](https://github.com/vorq-ai/vorq-coordinator-node/blob/main/src/db/db.ts). Keep `pins`, `files`, `batches`, `batch_lines` and `quotes_live`: they record uploads, batches and unpublished ask snapshots, which the chain cannot give back. Never drop the whole schema.

## 3. Start the node

It re-applies the migrations and replays every event from the address book's `deployBlock`. `/readyz` turns `200` when the replay catches up.

## What users notice

- Sessions and nonces are gone: every client and provider runs the [session handshake](./authenticate-with-a-wallet.md) again.
- Provider presence and job leases are gone until providers poll again, so quotes name no candidates for a few seconds.
- During the replay, index-backed routes answer `503 not_ready`. Clients retry on the `x-vorq-retryable` header.
