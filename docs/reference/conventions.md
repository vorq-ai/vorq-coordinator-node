---
title: API conventions
description: Encoding, numbers, headers, body limits, paging and freshness rules shared by every route.
---

## Base URL

Every path in this reference is relative to the coordinator's base URL, `https://api.vorq.co` for the VORQ coordinator. The default port for a self-hosted node is `8402`.

## API reference

Every route's request and response schema is published by the coordinator itself, as OpenAPI 3.1: browse it at [`https://api.vorq.co/docs`](https://api.vorq.co/docs), or fetch the document from `/docs/json`. A self-hosted node serves its own at the same paths. The pages in this section cover what a schema cannot: the flows, the signatures, and what each refusal means.

## Bodies and encoding

- Request and response bodies are JSON unless a route says otherwise. Send `content-type: application/json`.
- Byte values are `0x`-prefixed hex: addresses (20 bytes), hashes and ids (32 bytes), signatures (65 bytes).
- Payload bytes in JSON (`container`, `result`) are canonical padded base64.
- A query parameter may appear at most once, and an empty value (`?model=`) is refused like any other malformed one.
- A malformed request answers `400` with `param` naming the field as a path, for example `snapshot.quotes[3].rate_in`.

## Numbers

**Money is a USD decimal string**; every other integer is a **JSON integer**, in requests and responses alike.

- **Rates** (`rate_in`, `rate_out`, `min_rate_in`, `min_rate_out`) are USD per 1M units of work: `"0.05"` is $0.05 per million tokens.
- **Amounts** (`amount`, `cap`, `fee`, `gas_fee`, `escrowed`) are USD.
- A money string is plain decimal: `"0.05"`, `"12"`, `"0.000219"`. No sign, exponent, spaces or leading zeros, and at most as many fraction digits as the payment token has (`decimals` on `GET /evm/chain`, 6 for USDC). A value with more is refused, never rounded.
- **Signed data is atomic.** What a signature covers is the chain's own integer, `usd × 10^decimals`: the EIP-712 `rateIn`/`rateOut` of an order or ask (`"0.05"` → `50000`), and the 402's `authorization.value`, which is the JSON integer a wallet signs.
- **Everything else** is a JSON integer at most 2^53 − 1: ids, windows, unit counts, timestamps, and block numbers.

A money value sent as a JSON number is refused, and so is an integer sent as a string.

## Headers

| Header | Direction | Meaning |
| --- | --- | --- |
| `authorization: Bearer vorq_sess_…` | request | Session token, on routes that need one. See [Auth API](./auth-api.md). |
| `x-request-id` | response | An id for this request, on every response. Quote it when reporting a problem. |
| `x-vorq-retryable` | response | `true` or `false` on every error response: whether the identical request may succeed later. See [Errors](./errors.md). |
| `x-vorq-page-truncated` | response | On paged routes. See [Paging](#paging). |
| `x-vorq-next-offset` | response | On truncated pages. See [Paging](#paging). |

## Body limits

| Route | Limit |
| --- | --- |
| `POST /v1/jobs`, `POST /evm/ops` | 20 MiB |
| `PUT /evm/asks` | 32 KiB |
| `POST /v1/jobs/{id}/cancel` | 8 KiB |
| `POST /handover` | 4 KiB |
| `POST /release` | 2 KiB |
| `POST /v1/files` | `MAX_BLOB_BYTES` for the file part (200 MiB by default) |
| Every other route | 1 MiB |

A JSON body over its limit answers `413` with `code: "body_too_large"`. Payloads larger than 15 679 488 bytes decoded cannot be sent inline; upload them with [`POST /v1/files`](./client-api.md#post-v1files).

## Freshness

Index-backed routes carry `as_of_block`, the last block the index had processed when the answer was read, and answer `503 not_ready` while the index trails the chain by more than `READY_LAG_BLOCKS`. Chain-backed and write routes carry no `as_of_block` and are not held back by index lag. Each route below says which it is. See [Indexing and readiness](../concepts/indexing-and-readiness.md).

## Paging

Routes marked **Paged** take:

| Query | Default | Range |
| --- | --- | --- |
| `limit` | `100` | `1`–`1000` |
| `offset` | `0` | `0`–`1000000` |

and always set `x-vorq-page-truncated`. A page is cut short when its body would pass 4 MiB; then the header is `true` and `x-vorq-next-offset` gives the offset to request next.

Keep paging while the page is full (`returned == limit`) **or** `x-vorq-page-truncated` is `true`. See [Page through listings](../guides/page-through-listings.md).

`GET /v1/batches` pages by cursor instead; see [`GET /v1/batches`](./client-api.md#get-v1batches).

## CORS

A coordinator sends CORS headers only for the origins its operator lists in `CORS_ORIGINS`. Browsers may read `x-request-id`, `x-vorq-retryable`, `x-vorq-page-truncated` and `x-vorq-next-offset`. Credentialed requests are not supported; send the session as a bearer header.
