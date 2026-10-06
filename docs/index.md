---
title: Coordinator API
description: What the VORQ coordinator does, who talks to it, and where to go next.
---

The coordinator is the HTTP API of the VORQ compute marketplace. It does two jobs:

- **Indexes** the three VORQ contracts on Base (`JobRegistry`, `ProviderRegistry`, `AskRegistry`) into Postgres and serves that index: the job book, providers, the model catalog and published asks.
- **Relays** what clients and providers sign. Every action on the contracts is authorised by the actor's own EIP-712 signature. The coordinator checks it, simulates the exact transaction, sends it from its relayer account and pays the gas. Providers need no ETH and no chain connection.

The coordinator never signs on anyone's behalf. It holds no key that can sign an order, a claim or a price, and the contracts would reject one if it tried.

## Who talks to it

- **Clients** read the catalog and prices, post signed orders under `/v1/jobs`, upload large payloads and batch inputs under `/v1/files` and `/v1/batches`, and poll their jobs.
- **Providers** poll the job book under `/evm/jobs`, relay signed claims and settlements through `/evm/ops`, publish prices through `/evm/asks` and, for open bids, fetch the payload key from the escrow.
- **Operators** run the coordinator: Postgres, an RPC endpoint, an object store and a funded relayer account.

The [Python](/docs/python) and [JavaScript](/docs/js) SDKs and the [provider daemon](/docs/provider) wrap this API. These pages are for calling it directly and for running your own node.

## Next steps

- [Quickstart](./quickstart.md): read the deployment, sign an order, get a price quote and open a session with `curl`.
- Guides: [authenticate with a wallet](./guides/authenticate-with-a-wallet.md), [submit a job](./guides/submit-a-job.md), [run a batch](./guides/run-a-batch.md), [claim and settle jobs](./guides/claim-and-settle-jobs.md), [self-host the coordinator](./guides/self-host-the-coordinator.md).
- Concepts: [job lifecycle](./concepts/job-lifecycle.md), [authentication model](./concepts/authentication-model.md), [payloads and file retention](./concepts/payloads-and-file-retention.md), [escrow and key release](./concepts/escrow-and-key-release.md), [indexing and readiness](./concepts/indexing-and-readiness.md).
- Reference: [client API](./reference/client-api.md), [provider API](./reference/provider-api.md), [errors](./reference/errors.md), [configuration](./reference/configuration.md).
