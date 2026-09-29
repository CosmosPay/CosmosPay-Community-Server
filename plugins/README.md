# Plugins

Every plugin lives here, one folder each. Nothing in this folder runs until its
slug is listed in `PLUGINS_ENABLED`.

```
plugins/
  example/
    plugin.json      what the plugin is, and what it may touch
    index.ts         what it does — plain TypeScript, no build step
    signature.json   who vouches for the two files above
```

## Write your first plugin in five minutes

```sh
npm run plugins -- new my-plugin      # creates plugins/my-plugin/ from a template
npm run plugins -- check my-plugin    # compiles it and runs every boot-time check
PLUGINS_ENABLED=my-plugin PLUGINS_ALLOW_UNSIGNED=true npm run start:dev
```

Then call it (with a key that holds `plugins:read` / `plugins:write`):

```sh
# consent to what plugin.json asks for — once per tenant
curl -X PUT  .../v1/plugins/my-plugin/installation -d '{"grantCapabilities":["customers:read"]}'
# run an action
curl -X POST .../v1/plugins/my-plugin/queries/hello -d '{"input":{"customerId":"…"}}'
```

**`plugin.json`** — the manifest. `capabilities` is everything your plugin may do with
the core (`customers:read`, `customers:write`, `products:read`, `products:write`,
`payment_intents:read`); `egress` is every host it may call over HTTPS; `config` is
the settings a tenant fills in (mark API keys `"secret": true`).

**`index.ts`** — `export default defineHandlers({ queries, commands, events })`. Import
only from `@/plugins/sdk`. Your handlers get `ctx`:

| | |
| --- | --- |
| `ctx.storage` | your plugin's own data, per tenant: `get`, `put`, `delete`, `list` |
| `ctx.core` | the tenant's customers, products, payment intents — what `capabilities` allows |
| `ctx.http` | `request({ method, url, body })` to the hosts in `egress` |
| `ctx.installation.config` | the tenant's settings |
| `ctx.log` | a logger |

Throw `PluginError('message')` to refuse a request; the caller sees your message.
Queries may not write — put writes in `commands`. `example/` uses every one of these.

## Shipping it

Open a pull request with your folder. Once it is reviewed, Cosmos Pay support signs it:

```sh
npm run plugins -- sign my-plugin --key <support key .pem> --key-id cosmos-support
```

A plugin signed by support is **preinstalled**: it loads on every deployment as soon
as it is enabled. Plugins from elsewhere are installed from a registry with
`npm run plugins -- install <slug>` and must be signed by support or by a key the
operator lists in `PLUGINS_TRUSTED_KEYS`. Changing a signed `plugin.json` or
`index.ts` breaks its signature — sign again after every change.

The full rules — what a plugin can reach, budgets, consent, routes — are in the
Plugins section of the main README.
