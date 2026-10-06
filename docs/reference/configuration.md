---
title: Configuration
description: Every environment variable the coordinator reads, and the address book format.
---

The coordinator is configured entirely through environment variables. Numeric values are integers; a value outside its range stops the process at boot with a message naming the variable. An empty value counts as unset.

## Address book

The deployment's contract addresses. Supply **exactly one** of:

| Variable | Meaning |
| --- | --- |
| `ADDRESSES_FILE` | Path to the address book JSON file. |
| `ADDRESSES_JSON` | The same JSON, inline. |

Every key is required:

```json
{
  "chainId": 84532,
  "deployBlock": 12345678,
  "jobRegistry": "0x…",
  "providerRegistry": "0x…",
  "askRegistry": "0x…",
  "usdc": "0x…",
  "paymentTokenDecimals": 6,
  "tokenDomain": { "name": "…", "version": "…" }
}
```

| Key | Meaning |
| --- | --- |
| `chainId` | The chain the contracts live on. |
| `deployBlock` | The block the index replays from on an empty database. |
| `jobRegistry`, `providerRegistry`, `askRegistry` | Contract addresses. |
| `usdc` | The payment token's address. |
| `paymentTokenDecimals` | The payment token's decimals (`0`–`36`). |
| `tokenDomain` | The payment token's EIP-712 `name` and `version`. |

## Core

| Variable | Default | Range | Purpose |
| --- | --- | --- | --- |
| `DATABASE_URL` | required | | PostgreSQL 16+ connection string. |
| `RELAYER_KEY` | required | | Private key of the account that signs and pays for relayed transactions. |
| `RPC_URL` | `http://localhost:8545` | | JSON-RPC endpoint. |
| `PORT` | `8402` | `1`–`65535` | HTTP port. The server binds `0.0.0.0`. |
| `CORS_ORIGINS` | unset | | Comma-separated exact browser origins, such as `https://app.example.com,http://localhost:3000`. Unset sends no CORS headers. `*`, wildcard hosts, paths and trailing slashes are refused at boot. |

## Indexer

| Variable | Default | Range | Purpose |
| --- | --- | --- | --- |
| `GETLOGS_CAP` | `5000` | `1`–`1000000` | Widest block range per `eth_getLogs`. Narrowed automatically when the endpoint refuses. |
| `BLOCK_TIME_MS` | `2000` | `1`–`3600000` | Indexer poll interval, and how long a readiness answer is cached. |
| `READY_LAG_BLOCKS` | `7` | `0`–`1000000` | How far the index may trail the head while still ready. |

## Relay

| Variable | Default | Range | Purpose |
| --- | --- | --- | --- |
| `RELAY_MAX_DEPTH` | `32` | `1`–`4096` | Relays that may queue on the relayer account. Beyond it: `503 relay_unavailable`, `relay_queue_full`. |
| `RELAY_QUEUE_TIMEOUT_MS` | `10000` | `1`–`600000` | Longest a relay waits in that queue. Beyond it: `503 relay_unavailable`, `relay_queue_timeout`. |
| `RELAYER_LOW_BALANCE_GWEI` | `50000000` | `1`–`1000000000000` | Relayer balance, in gwei, under which the daily balance check logs an error. The default is 0.05 ETH. |
| `JOB_RATE_LIMIT` | `0` (no limit) | `0`–`1000000` | Jobs one wallet may post for one model through `POST /v1/jobs` in 24 hours. Beyond it: `429 rate_limit_exceeded`. Counted in memory, so a restart resets it and each instance counts its own. |

## Object storage and files

| Variable | Default | Range | Purpose |
| --- | --- | --- | --- |
| `PIN_S3_ENDPOINT` | required | | S3-compatible endpoint of an object store that pins to IPFS and returns each object's CID. |
| `PIN_S3_KEY`, `PIN_S3_SECRET` | required | | Access key and secret. |
| `PIN_S3_BUCKET` | required | | Bucket name. |
| `PIN_S3_REGION` | `us-east-1` | | Signing region. |
| `MAX_BLOB_BYTES` | `209715200` (200 MiB) | `1024`–`1073741824` | Largest `POST /v1/files` upload. |
| `FILE_RETENTION_SECONDS` | `2592000` (30 days) | `259200`–`31536000` | Lifetime of attached files and stored objects. |

## Matching

| Variable | Default | Range | Purpose |
| --- | --- | --- | --- |
| `MATCH_LEASE_MS` | `20000` | `1000`–`600000` | How long a provider poll holds a job. Keep it above the provider's poll interval plus a claim round trip. |
| `MATCH_LIVENESS_MS` | `15000` | `1000`–`600000` | How recently a provider must have polled to be named as a quote candidate. |
| `MATCH_CANDIDATES` | `3` | `1`–`100` | Candidates named on a `402` quote. |

## Escrow

| Variable | Default | Range | Purpose |
| --- | --- | --- | --- |
| `ESCROW_MODE` | `off` | `off`, `static`, `mock` | `static` derives the escrow key from `OPERATOR_KEY`. `mock` is for development and CI only. See [Run the escrow](../guides/run-the-escrow.md). |
| `OPERATOR_KEY` | unset | | Required when `ESCROW_MODE` is not `off`. Comma-separated 32-byte hex private keys; the first derives the announced key, every entry still opens wraps sealed to its key. |
| `RELEASE_ORDINAL` | `1` | `0`–`65535` | Reported as `evidence.release` by `GET /key`. In `mock` mode, handover refuses peers on an older release. |

`mock` mode only; `static` mode refuses to start with any of these set:

| Variable | Default | Range | Purpose |
| --- | --- | --- | --- |
| `ESCROW_ROTATE_INTERVAL_MS` | `86400000` | `3600000`–`604800000` | How often a new key generation is minted. |
| `ESCROW_SWEEP_INTERVAL_MS` | `300000` | `1000`–`3600000` | How often retired generations past retention are erased. |
| `PEER_URL` | unset | | An instance to pull keys from with `POST /handover`. |
| `PEER_REQUIRED` | `false` | `1`, `0`, `true`, `false` | The first pull must succeed before the node listens. Requires `PEER_URL`. |
| `PEER_SYNC_S` | `300` | `5`–`86400` | Interval of the standing peer pull. |
| `ESCROW_CLOCK_OFFSET_MS` | `0` | `0`–`31536000000` | Runs the key-retention clock ahead, for tests. |

## Error reporting

| Variable | Purpose |
| --- | --- |
| `SENTRY_DSN` | Enables error reporting to Sentry. Unset disables it. |
| `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE` | Optional tags for reported errors. |

Reporting needs the instrumentation preloaded: the Docker image starts with `node --import ./dist/instrument.js dist/main.js`, and `npm start` preloads it too.
