---
title: Page through listings
description: Read a whole job book, provider list or catalog with limit, offset and the truncation headers.
---

The public listings (`/evm/jobs`, `/evm/providers`, `/v1/models`, `/evm/models`, `/evm/asks`, `/evm/asks/floors`, `/evm/allowlist`) are paged with `limit` and `offset`. A page can end early when the response would pass 4 MiB, so the length of the page alone does not tell you whether you are done.

## The loop

Keep paging while **either** the page is full **or** the `x-vorq-page-truncated` header is `true`:

```sh
offset=0
while :; do
  curl -s -D headers.txt "$VORQ/evm/jobs?state=Open&limit=1000&offset=$offset" > page.json
  jq -c '.jobs[]' page.json            # consume the page
  n=$(jq '.jobs | length' page.json)
  truncated=$(grep -i '^x-vorq-page-truncated:' headers.txt | tr -d '\r' | awk '{print $2}')
  next=$(grep -i '^x-vorq-next-offset:' headers.txt | tr -d '\r' | awk '{print $2}')
  [ "$n" -eq 1000 ] || [ "$truncated" = "true" ] || break
  offset=${next:-$((offset + n))}
done
```

- `limit` is `1`–`1000` (default `100`); `offset` is `0`–`1 000 000`.
- `x-vorq-next-offset` is present only on a truncated page. Otherwise the next offset is `offset + returned`.

## Narrow instead of paging deep

Offsets past one million are refused. For a large job book, filter rather than page: `/evm/jobs` takes `state`, `model`, `provider`, `owner`, `min_rate_in`, `min_rate_out` and `posted_before`, and `order=newest` puts the latest jobs first. See [`GET /evm/jobs`](../reference/provider-api.md#get-evmjobs).

## Rows move between pages

Each page carries `as_of_block`, the index block it was read at. The index keeps moving between pages, so rows can shift. On the job book, pass the first page's `as_of_block` as `posted_before` so that jobs posted while you page do not push rows onto the next page. Jobs can still change state between pages.

`GET /v1/batches` pages differently, by `limit` and `after`; see [`GET /v1/batches`](../reference/client-api.md#get-v1batches).
