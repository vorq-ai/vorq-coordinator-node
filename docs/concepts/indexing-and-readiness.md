---
title: Indexing and readiness
description: How the coordinator builds its index from chain events, what as_of_block promises, and how it handles lag and reorgs.
---

The coordinator's view of the market is an **index**: a projection of the VORQ contracts' events into Postgres. The chain is the source of truth, and the index can always be rebuilt by replaying it.

## Two kinds of route

- **Index-backed** routes read the index: the job book, job reads, providers, the catalog, asks, the allowlist and batch reads. They answer only when the index is fresh, and every response carries `as_of_block`.
- **Chain-backed and write** routes read the chain or relay to it: `/evm/chain`, `/evm/ops`, `/evm/simulate/claim`, `POST /v1/jobs` and its cancel, file routes, `POST /v1/batches`, `PUT /evm/asks`, the auth handshake and the escrow routes. They are never held back by index lag and carry no `as_of_block`.

`POST /evm/simulate/claim` reads the chain on purpose: it stays accurate while the index trails, which is exactly when a provider needs it.

## `as_of_block`

`as_of_block` is the last block the index had processed when the answer was read. It is read before the data, so it can understate freshness but never overstate it: if you wait for `as_of_block >= n`, the answer reflects every event up to block `n`.

## Readiness

The node is **ready** while its index is within `READY_LAG_BLOCKS` (default 7) of the chain head. [`GET /readyz`](../reference/health-api.md#get-readyz) reports it:

| `reason` | Meaning |
| --- | --- |
| `ready` | Serving. |
| `cold_start` | The index has not processed its first block yet. |
| `trailing` | The index is behind the head by more than the allowed lag. It heals by itself. |
| `reorg` | A block the index had processed was replaced. The node stays unready until an operator rebuilds the index. |
| `chain_unreachable` | The RPC endpoint did not answer, so lag is unknown. |

While not ready, index-backed routes answer `503` with type `not_ready` (or `chain_unreachable`), and `x-vorq-retryable: true`.

## Your own writes

When a post relayed by this coordinator is mined, the coordinator writes the new job to its index from the receipt before it answers. A job posted through a coordinator can normally be read from it as soon as the `201` returns. Every other change, including claims, settlements and cancels, and jobs posted through another coordinator, appears once the indexer reaches its block.

## Reorgs

The indexer follows the `latest` block and remembers the hash of the last block it processed. If that block is replaced, it stops rather than serve rows from a chain that no longer exists. Recovery is a rebuild: see [Recover from a reorg](../guides/recover-from-a-reorg.md).

## Log fetching

The indexer reads events with `eth_getLogs` in ranges of up to `GETLOGS_CAP` blocks (default 5000), and narrows the range automatically when the RPC endpoint refuses a wide one.
