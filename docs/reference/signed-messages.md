---
title: Signed messages
description: Every EIP-712 domain and type the coordinator verifies, and where each is used.
---

Every write is authorised by an EIP-712 signature (65 bytes, `0x`-hex). Field widths below are the contracts' own. `GET /evm/chain` returns the chain id and contract addresses the domains need.

## Domains

| Domain `name` | `version` | `chainId` | `verifyingContract` | Types |
| --- | --- | --- | --- | --- |
| `VORQ Jobs` | `2` | deployment chain | `JobRegistry` | `Order`, `Cancel`, `Claim`, `Settle`, `Fail` |
| `VORQ Providers` | `2` | deployment chain | `ProviderRegistry` | `SetIdentity`, `RequestCapacity` |
| `VORQ Asks` | `2` | deployment chain | `AskRegistry` | `AskSnapshot` |
| payment token's `token_domain.name` | `token_domain.version` | deployment chain | payment token | `ReceiveWithAuthorization` |
| `VORQ Escrow` | `1` | deployment chain | *(none)* | `Release`, `HandoverAuth` |
| `VORQ Session` | `1` | deployment chain | *(none)* | `VorqSession` |

At boot the coordinator checks the job, provider, ask and payment-token domains against each contract's `DOMAIN_SEPARATOR` and refuses to start on a mismatch.

## Job registry

### Order

```
Order(bytes32 c,uint32 modelId,uint32 slaSecs,uint128 rateIn,uint128 rateOut,uint32 unitsIn,uint32 unitsOut,uint32 designated,uint64 expiresAt)
```

Signed by the owner. Used by [`POST /v1/jobs`](./client-api.md#post-v1jobs). `taskCid` is not signed: the coordinator mints it when it stores the container. `rateIn` and `rateOut` are the body's USD rates times 10^decimals: `"0.05"` is signed as `50000` (see [Conventions](./conventions.md#numbers)).

### Cancel

```
Cancel(bytes32 jobId,uint64 issuedAt)
```

Signed by the owner. Used by [`POST /v1/jobs/{id}/cancel`](./client-api.md#post-v1jobsidcancel). `issuedAt` within ±600 seconds.

### Claim

```
Claim(bytes32 jobId,uint64 issuedAt)
```

Signed by the provider wallet. `op: "claim"` on [`POST /evm/ops`](./provider-api.md#post-evmops). `issuedAt` within ±600 seconds.

### Settle

```
Settle(bytes32 jobId,uint32 completionTok,uint64 issuedAt)
```

Signed by the provider wallet. `op: "settle"`. `resultCid` is not signed: the coordinator mints it when it stores the result. `issuedAt` within ±600 seconds.

### Fail

```
Fail(bytes32 jobId,uint64 issuedAt)
```

Signed by the provider wallet. `op: "fail"`. `issuedAt` within ±600 seconds.

## Provider registry

### SetIdentity

```
SetIdentity(bytes32 boxKey,bytes evidence,uint64 issuedAt)
```

Signed by the provider wallet. `op: "set_identity"`. `issuedAt` greater than the last accepted `SetIdentity` and at most one hour ahead.

### RequestCapacity

```
RequestCapacity(uint32 n,uint64 issuedAt)
```

Signed by the provider wallet. `op: "request_capacity"`. `issuedAt` greater than the last accepted `RequestCapacity` and at most one hour ahead.

## Ask registry

### AskSnapshot

```
AskSnapshot(uint32 providerId,uint64 signedAt,Ask[] quotes)
Ask(uint32 modelId,uint32 sla,uint128 rateIn,uint128 rateOut)
```

Signed by the provider wallet. Used by [`PUT /evm/asks`](./provider-api.md#put-evmasks). At most 64 quotes; `signedAt` newer than the provider's last and at most one hour ahead. `rateIn` and `rateOut` are the body's USD rates times 10^decimals, as in `Order`.

## Payment

### ReceiveWithAuthorization

```
ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)
```

EIP-3009, in the payment token's own domain. Signed by the owner as `auth_sig` on [`POST /v1/jobs`](./client-api.md#post-v1jobs).

| Field | Value |
| --- | --- |
| `from` | the order's `owner` |
| `to` | the `JobRegistry` |
| `value` | the quote's `authorization.value`: its USD `amount` times 10^decimals |
| `validAfter` | `0` |
| `validBefore` | `expires_at + 1` |
| `nonce` | the `job_id` |

The payer must be an account with no contract code. The token collects the payment when the job is claimed.

## Escrow

### Release

```
Release(bytes32 jobId,bytes seedWrap,bytes32 ctHash,bytes32 responsePubkey,uint64 issuedAt)
```

Signed by the claiming provider's wallet. Used by [`POST /release`](./escrow-api.md#post-release). `issuedAt` within ±600 seconds.

### HandoverAuth

```
HandoverAuth(bytes32 channelPubkey,uint64 issuedAt)
```

Signed with an `OPERATOR_KEY`. Used by [`POST /handover`](./escrow-api.md#post-handover) between development-mode instances.

## Session

### VorqSession

```
VorqSession(address address,string nonce)
```

Signed by the wallet opening the session. Used by [`POST /auth/session`](./auth-api.md#post-authsession).
