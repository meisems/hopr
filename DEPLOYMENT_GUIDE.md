# Hopr Deployment Guide

This guide deploys the current Hopr dashboard and Cloudflare Worker, then connects the Telegram bot to the Worker webhook.

> **Current product status:** token lookup, public-wallet balance reads, saved Telegram preferences, inline navigation, and the premium action menu are available. Buy/sell controls are present for UI parity with the dashboard, but trade execution, signing, approvals, transfers, and trade-status storage are **not implemented**.

## 1. Deployment architecture

| Component | Responsibility | Recommended deployment |
| --- | --- | --- |
| React/Vite frontend | Dashboard, charts, wallet UI, Telegram preview, LI.FI quote UI | Cloudflare Pages |
| Cloudflare Worker | `/api/*`, `/health`, `/telegram/webhook` | Cloudflare Workers |
| DexScreener | Token market lookup | Public API called by the Worker |
| Public RPC endpoints | Native balance reads | Called by the Worker |
| `CACHE` KV | Optional token-detection cache | Cloudflare KV binding |
| `TELEGRAM_STATE` KV | Optional saved Telegram wallets/preferences | Cloudflare KV binding |

The frontend and Worker can use separate hostnames. If they are served from the same Cloudflare project, keep the `/api/*` and `/telegram/webhook` routes mapped to the Worker.

## 2. Prerequisites

- Node.js 18 or newer
- A Cloudflare account with Pages and Workers enabled
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- A production HTTPS URL for the Worker webhook
- Wrangler available through `npx` or installed globally

Clone and install the project:

```bash
git clone https://github.com/meisems/hopr.git
cd hopr
npm install
```

Run the local checks before deploying:

```bash
npm run typecheck
npm run build
npm run test:telegram
```

## 3. Deploy the frontend to Cloudflare Pages

### Option A: Git-connected Pages deployment

1. Open **Cloudflare Dashboard → Workers & Pages → Create application → Pages**.
2. Choose **Connect to Git** and select the `meisems/hopr` repository.
3. Use these build settings:

   | Setting | Value |
   | --- | --- |
   | Framework preset | Vite |
   | Production branch | `main` |
   | Build command | `npm run build` |
   | Build output directory | `dist` |
   | Root directory | `/` |

4. Deploy the site.
5. Open the generated Pages URL and verify that the dashboard loads.

If the Pages site and Worker use different hostnames, add this Pages environment variable before building:

```text
VITE_API_URL=https://hopr.<your-subdomain>.workers.dev
```

The dashboard uses this server-side Worker URL for `/api/trade/quote`; the LI.FI key is never shipped to the browser.

Future pushes to `main` will create new Pages deployments when automatic deployments are enabled.

### Option B: Direct upload from a local build

```bash
npm install
npm run build
npx wrangler pages deploy dist --project-name=hopr
```

If the Pages project does not exist yet, create it in the Cloudflare dashboard first, or follow Wrangler's prompt to create `hopr`.

## 4. Deploy the Worker

The Worker entrypoint is `workers/index.ts`. The repository includes `wrangler.toml` with the Worker name `hopr`.

Authenticate Wrangler if needed:

```bash
npx wrangler login
```

Deploy the Worker:

```bash
npx wrangler deploy
```

Record the deployed Worker URL, for example:

```text
https://hopr.<your-subdomain>.workers.dev
```

Verify the health endpoint:

```bash
curl -i https://hopr.<your-subdomain>.workers.dev/health
```

Expected response shape:

```json
{"status":"ok","timestamp":1720000000000}
```

## 5. Configure Worker variables and secrets

Configure these in **Cloudflare Dashboard → Workers & Pages → hopr → Settings → Variables and Secrets**, or with Wrangler.

### Required for Telegram webhook requests

| Name | Type | Purpose |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | Secret | Token issued by BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | Secret | Shared secret checked against `X-Telegram-Bot-Api-Secret-Token` |

Generate a webhook secret locally without committing it:

```bash
openssl rand -hex 32
```

Set the secrets with Wrangler:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put LIFI_API_KEY
```

Wrangler will prompt for each value. Do not put either value in `.env`, source control, screenshots, or shell history.

### Optional/runtime configuration

| Name | Purpose | Notes |
| --- | --- | --- |
| `CACHE` | Token-detection cache | KV binding; without it, detection still works but is not cached |
| `TELEGRAM_STATE` | Saved public Telegram wallet addresses and preferences | KV binding; without it, one-time public balance reads and token lookup still work |
| `RATE_LIMIT` | API rate-limit storage | KV binding; if absent, the Worker falls back to allowing requests |
| `ENVIRONMENT` | Environment label | Already set to `production` in `wrangler.toml` |
| `LIFI_API_KEY` | Server-side LI.FI quote requests | Never expose this key to Pages/browser code; execution is still disabled |
| `ENCRYPTION_KEY` | Encrypts every custodial private key (EVM, Solana, NEAR) with AES-256-GCM | Secret; 32+ random bytes. Rotating it makes existing keys undecryptable |
| `NEAR_RPC_URL` | Keyed NEAR mainnet JSON-RPC used for NEAR balances, quotes and broadcasts | Secret (URLs often embed an API key). Free public RPCs are rate limited and used only as fallbacks |

## 6. Create and bind KV namespaces

### Token cache (optional)

```bash
npx wrangler kv namespace create CACHE
```

Copy the returned namespace ID into `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "CACHE"
id = "<cache-namespace-id>"
```

### Telegram state (recommended for saved wallets/settings)

```bash
npx wrangler kv namespace create TELEGRAM_STATE
```

Add the returned ID to `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "TELEGRAM_STATE"
id = "<telegram-state-namespace-id>"
```

Then redeploy:

```bash
npx wrangler deploy
```

`TELEGRAM_STATE` stores only public wallet addresses and display preferences. The bot does not store or request private keys, seed phrases, signing approvals, or transaction credentials.

Apply the Telegram profile migration to D1:

```bash
npx wrangler d1 migrations apply hopr-db --remote
```

This creates `telegram_profiles`, which stores public Telegram wallet addresses, preferences, and the most recent token context used by LI.FI quote previews. KV remains the fast profile cache; D1 is the durable source of truth.

`migrations/0004_add_near_chain.sql` adds the NEAR columns (`near_address`, `near_encrypted_key`) to the custody tables and a read-only `near_address` to `telegram_profiles`. Until it is applied, the bot keeps working for EVM and Solana and NEAR actions reply with a message asking for the migration. Set `NEAR_RPC_URL` before enabling NEAR trading:

```bash
npx wrangler secret put NEAR_RPC_URL
```

### Rate-limit storage (optional)

```bash
npx wrangler kv namespace create RATE_LIMIT
```

Bind it in `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "RATE_LIMIT"
id = "<rate-limit-namespace-id>"
```

## 7. Configure the Telegram bot

Set the local environment variables only for the configuration command:

```bash
read -rsp 'Telegram bot token: ' TELEGRAM_BOT_TOKEN
echo
export TELEGRAM_BOT_TOKEN
export TELEGRAM_WEBHOOK_SECRET='<same-secret-configured-on-the-worker>'
export TELEGRAM_WEBHOOK_URL='https://hopr.<your-subdomain>.workers.dev/telegram/webhook'
```

Register the webhook and command menu:

```bash
npm run telegram:configure
```

The script configures:

- Telegram webhook delivery for `message` and `callback_query` updates
- Slash-command suggestions: `/start`, `/menu`, `/help`, `/wallet`, `/setwallet`, `/balances`, and `/settings`
- Telegram's native command menu button

The command must complete successfully before testing inline buttons. It is safe to rerun after a Worker deployment.

## 8. Optional custom domain and routing

For a custom frontend domain:

1. Open the Pages project in Cloudflare.
2. Go to **Custom domains → Set up a custom domain**.
3. Complete the DNS and TLS prompts.

For a custom Worker API domain:

1. Open the Worker in Cloudflare.
2. Go to **Triggers → Routes** or configure a Worker custom domain.
3. Route `/api/*`, `/health`, and `/telegram/webhook` to the Worker.
4. Update `TELEGRAM_WEBHOOK_URL` to the final HTTPS webhook URL.
5. Rerun `npm run telegram:configure`.

## 9. Verification checklist

### Frontend

- [ ] Pages deployment returns HTTP 200.
- [ ] Dashboard loads without a blank screen.
- [ ] The Telegram preview shows `/start`, `/menu`, `/help`, `/wallet`, and `/settings` indicators.
- [ ] The token action rows render: buy, custom, change chain, sell, settings, DexScreener, and dismiss.
- [ ] The preview clearly identifies the bot as read-only.

### Worker

```bash
curl -i https://hopr.<your-subdomain>.workers.dev/health
```

- [ ] `POST /api/detect` returns token data for a known indexed token.
- [ ] `GET /api/wallet/<public-address>/balances` returns balance data.
- [ ] `POST /telegram/webhook` rejects requests with an incorrect webhook secret.
- [ ] `POST /api/trade/quote` returns a read-only LI.FI quote for a connected EVM wallet.
- [ ] Trade endpoints return the documented `501 TRADE_EXECUTION_UNAVAILABLE` response rather than claiming success.

### Telegram

In a private chat with the bot:

1. Send `/start` and confirm the Wallet, Settings, Link wallet, and Commands buttons.
2. Send `/menu` and confirm the action menu appears.
3. Send `/help` and confirm `/menu` is listed.
4. Send a token contract address and confirm the token card plus premium inline action rows.
5. Tap a Buy or Sell button and confirm the bot explains that trading is not enabled yet.
6. If `TELEGRAM_STATE` is bound, test `/setwallet`, `/wallet`, and `/settings`.
7. After looking up an EVM token and linking a public EVM wallet, tap a Telegram Buy button and confirm a read-only LI.FI quote is returned.

## 10. Rollback

### Pages rollback

1. Open the Pages project.
2. Open **Deployments**.
3. Find the last known-good deployment.
4. Choose **Rollback** or promote it according to the current Cloudflare dashboard controls.

### Worker rollback

List recent Worker deployments:

```bash
npx wrangler deployments list
```

Rollback using the Cloudflare dashboard's deployment history, or redeploy the last known-good commit:

```bash
git checkout <known-good-commit>
npm install
npm run typecheck
npm run build
npx wrangler deploy
```

After a Worker rollback, verify `/health` and rerun `npm run telegram:configure` if the webhook URL or secret changed.

## 11. Ongoing releases

For each release:

```bash
git pull --ff-only origin main
npm ci
npm run typecheck
npm run build
npm run test:telegram
npx wrangler pages deploy dist --project-name=hopr
npx wrangler deploy
```

Then run the Telegram verification checklist. Never describe a buy or sell as submitted or completed until real signing, transaction submission, and status tracking have been implemented and separately verified.
