# Design: KYC redirect_url whitelist

## Approach
Two layers (clean separation of concerns):

| Layer | Responsibility | Mechanism |
|-------|----------------|-----------|
| Format | https + absolute + no credentials | `@IsRedirectUrl()` on DTOs (class-validator) |
| Domain | hostname ∈ consumer whitelist | `assertRedirectAllowed(username, url, map)` |

## Config
```
KYC_REDIRECT_URL_WHITELIST={"cosmos_acme":["acme.com","app.acme.com"]}
```
Parsed at boot into `AppConfig.kyc.redirectUrlWhitelist` (fail-closed on invalid
JSON). `ADMIN_API_CREDENTIALS` was the model for this and has since been removed —
`/v1/admin` is gated on the call coming from the platform console instead.

## Domain matching
- Normalize host to lowercase
- Exact match OR hostname ends with `.{allowed}` (label-safe suffix)
- No leading-dot tricks; reject empty hosts

## Wiring
- `KycMetaController.initiateTos` + `@CurrentConsumer()` → service asserts whitelist
- `ReceiversService.approve` / `requestTos` assert with `consumer.username`
- `approveById` / `requestTosById` load `Consumer.apisixUsername` via `row.consumerId` and assert

## Error messages
- Format: `redirect_url must be a valid https URL without embedded credentials`
- Domain: `redirect_url hostname '…' is not allowed for this consumer`
- Missing config: `no redirect_url domains are configured for this consumer`
