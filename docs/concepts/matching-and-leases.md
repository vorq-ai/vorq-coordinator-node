---
title: Matching and leases
description: How quotes name candidate providers, and how job leases spread open jobs across polling providers.
---

Matching on VORQ is advisory. The chain decides every claim; the coordinator only helps clients and providers find each other faster.

## Presence

A provider polls [`GET /evm/jobs?state=Open&model=M&free=N`](../reference/provider-api.md#get-evmjobs) with its provider session. Each poll records that the provider is live for model `M` with `N` free slots. A provider counts as live for `MATCH_LIVENESS_MS` (default 15 seconds) after its last poll.

## Candidates on a quote

A `402` quote lists up to `MATCH_CANDIDATES` (default 3) providers that:

- are listed, live for the order's model, and allowed to serve it;
- have a free slot after counting the jobs they currently lease;
- have published an ask for the order's model at exactly the order's `sla_secs`, with `rate_in` and `rate_out` at or below the order's.;
- have a `box_key` set, so the client can seal to them;
- for a designated order, are the designated provider.

They are ordered by what the order would cost at their ask, cheapest first. Among equally priced providers, the one picked least recently comes first, and each open-bid quote marks its first candidate as picked, so successive quotes rotate across them.

The client seals to the first candidate and sets `designated` to its id. An empty list means no live provider currently matches; the order can still be posted as an open bid.

## The market probe

A client asks for the market before it signs: `POST /v1/jobs` with the order's `model_id`, `sla_secs`, `units_in`, `units_out` and optional `designated`, and **no rates and no signature**. Optional `max_rate_in` and `max_rate_out` are ceilings: an ask above one is left out, and a side with no ceiling is unbounded. The answer is `402` with `candidates` only: every live ask within the ceilings that meets the other conditions above, ranked the same way, with no quote. An unpinned probe advances the rotation like an open-bid quote does.

The client then signs the first candidate's `rate_in` and `rate_out` with `designated` set to that provider, and continues with the normal quote.

## Leases

When a provider polls with `free=N`, the coordinator gives it a **lease** on up to `N` open jobs, counting leases it already holds. It picks the oldest jobs that match the poll's filters and that the provider may claim (open bids, or jobs designated to it), skipping jobs another provider holds. A lease lasts `MATCH_LEASE_MS` (default 20 seconds); the poll returns only the jobs the provider holds.

While a lease lasts, other pollers do not receive that job, so providers polling the same model do not all race for the same jobs. A lease does not reserve anything on chain: any provider can still claim any job it may claim, and the first valid claim wins.

`free=0` records presence without taking new leases.

## The batch plan

A batch is planned before any line is sealed: [`POST /v1/batches`](../reference/client-api.md#post-v1batches) with no `input_file_id`, the batch window, and per entry a model, the line count, the summed units and optional `max_rate_in` / `max_rate_out` ceilings. The coordinator answers how many lines each provider within the ceilings takes, at its ask.

The budget is the network's own limit. A provider may hold at most its on-chain capacity (reputation times the lesser of what it requested and its ceiling) in claimed jobs, so its share of a plan is that capacity less its claimed jobs and the open orders already designated to it. Single orders and batches draw on the same pool. Providers are filled cheapest first for the entry's unit mix; equal prices take turns. An entry's allocation sums to fewer lines than it asked for when the network cannot take them all within its ceilings.
