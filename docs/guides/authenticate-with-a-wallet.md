---
title: Authenticate with a wallet
description: Get a session token for a client or provider wallet and use it on the routes that need one.
---

A session token proves to one coordinator that you control an address. You need one for file uploads, batches and every provider write. Posting and cancelling jobs need none: the order and payment signatures are the authority there. See [Authentication model](../concepts/authentication-model.md).

## 1. Get a nonce

```sh
curl -s "$VORQ/auth/nonce?address=$ADDR"
```

```json
{ "nonce": "3f9c0e1d2a4b5c6d7e8f901a2b3c4d5e", "expires_at": 1786000000, "chain_id": 84532 }
```

The nonce is single-use and expires after 300 seconds. Use the returned `chain_id` in the next step.

## 2. Sign `VorqSession`

Sign this EIP-712 message with the wallet whose address you passed:

| | |
| --- | --- |
| Domain | `{ "name": "VORQ Session", "version": "1", "chainId": <chain_id> }`, no `verifyingContract` |
| Type | `VorqSession(address address,string nonce)` |
| Message | `{ "address": <your address>, "nonce": <nonce> }` |

With `cast`, write the typed data to `session.json` as in the [Quickstart](../quickstart.md#6-open-a-session) and run:

```sh
export SESSION_SIG=$(cast wallet sign --data --from-file session.json --private-key "$KEY")
```

## 3. Exchange it for a token

```sh
curl -s -X POST "$VORQ/auth/session" \
  -H 'content-type: application/json' \
  -d "{\"address\":\"$ADDR\",\"nonce\":\"$NONCE\",\"signature\":\"$SESSION_SIG\",\"role\":\"client\"}"
```

```json
{ "token": "vorq_sess_8c1f…", "expires_at": 1786086400 }
```

For a provider wallet, send `"role": "provider"`. The wallet must be registered in the `ProviderRegistry`, and the answer then carries its `provider_id`:

```json
{ "token": "vorq_sess_…", "expires_at": 1786086400, "provider_id": 7 }
```

## 4. Send the token

```sh
curl -s "$VORQ/v1/batches" -H "authorization: Bearer $TOKEN"
```

A token lasts 24 hours. When a request answers `401` with `code: "invalid_session"`, run the handshake again.

## Troubleshooting

| Answer | Fix |
| --- | --- |
| `400`, `param: "nonce"` | The nonce is unknown, expired or already used. Request a new one. |
| `401 invalid_signature` | The signature is malformed, was not made by `address`, or used a different domain. Check `chainId` and that `address` is the one the nonce was issued to. |
| `403 not_registered` | `role: "provider"` for a wallet with no registry id. Register the provider first, or use `role: "client"`. |

Full details: [Auth API reference](../reference/auth-api.md).
