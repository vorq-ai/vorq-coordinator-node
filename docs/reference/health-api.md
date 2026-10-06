---
title: Health API
description: The liveness and readiness routes, GET /healthz and GET /readyz.
---

The request and response schema for every route on this page is in the [API reference](https://api.vorq.co/docs). This page covers what each answer means.

### GET /healthz

Liveness. Answers `200` as soon as the server listens, including during a cold start.

**Auth:** public · **Index-backed:** no

### GET /readyz

Readiness: whether the index is within `READY_LAG_BLOCKS` of the chain head. Use it for load-balancer and orchestrator readiness checks. The result is cached for `BLOCK_TIME_MS`.

**Auth:** public · **Index-backed:** no

**Response `200`** when ready, **`503`** otherwise.

```json
{ "ready": false, "reason": "trailing", "cursor": 123, "head_block": 140, "lag": 17 }
```

`reason` is `ready`, `cold_start`, `trailing`, `reorg` or `chain_unreachable`; see [Indexing and readiness](../concepts/indexing-and-readiness.md#readiness). `cursor` is the last indexed block, `null` before the first. `lag` is `head_block − cursor` and can be negative if the RPC endpoint is behind the index.

With `reason: "chain_unreachable"`, `cursor`, `head_block` and `lag` are `null`. With `reason: "reorg"` the node stays unready until the index is rebuilt; see [Recover from a reorg](../guides/recover-from-a-reorg.md).

```sh
curl -s -o /dev/null -w '%{http_code}\n' https://api.vorq.co/readyz
```
