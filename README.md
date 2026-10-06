# vorq-coordinator-node

The coordinator API for the VORQ compute marketplace: it indexes the VORQ contracts on Base and relays what clients and providers sign.

Clients post signed, sealed orders; providers poll, claim and settle them with signed ops. The coordinator checks each request, stores payloads in object storage, simulates the transaction, and relays it from its own account, so providers never need gas or a chain connection. It never signs on anyone's behalf: every action is authorised by the actor's EIP-712 signature and verified on chain.

## Features

- Job book, providers, model catalog and published asks, indexed from chain events into Postgres
- Two-step order flow: `402` payment quote (EIP-3009), then post with the sealed payload
- Gasless provider operations: claim, settle, fail, identity and capacity updates
- Provider matching with poll-based job leases and ranked candidates
- File uploads and OpenAI-style batches
- Optional escrow for open-bid payload keys
- Rebuildable state: the index is a replay of the chain

## Quick start

Requires Node.js 22+, PostgreSQL 16+, an RPC endpoint, an S3-compatible object store that pins to IPFS and returns each object's CID, a relayer key funded with ETH, and the deployment's `addresses.json`.

```sh
npm install
docker compose -f compose.dev.yml up -d   # local Postgres on :5433

ADDRESSES_FILE=./addresses.json \
DATABASE_URL=postgres://vorq:vorq@localhost:5433/vorq \
RPC_URL=https://rpc.example.com \
RELAYER_KEY=0x… \
PIN_S3_ENDPOINT=… PIN_S3_KEY=… PIN_S3_SECRET=… PIN_S3_BUCKET=… \
npm start
```

The server listens on port `8402`. `GET /readyz` returns `200` once the index has caught up with the chain.

## Documentation

Full documentation is at **https://docs.vorq.co/docs/coordinator**, built from [`docs/`](docs/index.md):

- [Quickstart](docs/quickstart.md): read the deployment, get a quote and open a session with `curl`
- [Self-host the coordinator](docs/guides/self-host-the-coordinator.md)
- [Client API](docs/reference/client-api.md) (`/v1/*`) and [Provider API](docs/reference/provider-api.md) (`/evm/*`)
- [Errors](docs/reference/errors.md) and [Configuration](docs/reference/configuration.md)

## Contributing

```sh
npm run typecheck     # type-check
npm test              # unit tests (set TEST_DATABASE_URL to include database tests)
npm run test:devnet   # integration tests against a local chain and Postgres
```

Database changes go in a new migration file; see [`src/db/migrations/README.md`](src/db/migrations/README.md).

## License

[FSL-1.1-ALv2](LICENSE.md) (Functional Source License). Any use is permitted except offering a competing product or service. Each version converts to Apache-2.0 two years after its release.
