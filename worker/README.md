# Deploying the Worker

Same shape as the Cloudflare Worker setup for the other 3 projects: create a
KV namespace, set a secret, deploy, then wire the resulting URL into the
dashboard. This one has one extra piece, the Browser Rendering binding,
which doesn't need any setup beyond what's already in `wrangler.toml`.

I can't test any of this myself, no Cloudflare account access, no npm in my
sandbox, so treat this as a first draft that likely needs a debugging pass,
the same way the agent-eval Worker needed a few real fixes before it worked
(wrong API key, a deprecated parameter, a guard-check bug). Send me whatever
error you hit and I'll fix it.

## 1. Install dependencies

```
cd accessibility-triage-tool/worker
npm install
```

## 2. Create the KV namespace (for rate limiting)

```
npx wrangler kv namespace create RATE_LIMIT_KV
```

This prints an `id`. Open `wrangler.toml` and replace
`REPLACE_WITH_YOUR_KV_NAMESPACE_ID` with that value.

## 3. Set your Anthropic API key as a secret

```
npx wrangler secret put ANTHROPIC_API_KEY
```

Paste the key when prompted (same key used for the other 3 projects).

## 4. Check Browser Rendering is available on your account

Browser Rendering (now called "Browser Run") needs the Workers Paid plan
for anything beyond the free tier's 10 minutes/day, but the free tier
should work fine for testing. If `wrangler deploy` errors out complaining
about the `[browser]` binding, that's the first thing to check in the
Cloudflare dashboard under Workers → Browser Run.

## 5. Deploy

```
npx wrangler deploy
```

This prints your Worker's URL, something like:

```
https://accessibility-triage-worker.YOUR-SUBDOMAIN.workers.dev
```

## 6. Wire the URL into the dashboard

Open `../docs/index.html` and find this line near the top of the `<script>`
block:

```js
const WORKER_URL = "REPLACE_WITH_YOUR_DEPLOYED_WORKER_URL/scan";
```

Replace `REPLACE_WITH_YOUR_DEPLOYED_WORKER_URL` with the URL from step 5
(keep the `/scan` on the end). Note: unlike the agent-eval project's bug
last time, this file only has ONE copy of that placeholder string, the
"not deployed yet" check is a `.startsWith()` test rather than a second
exact copy of the same text, so there's nothing else to accidentally
corrupt with a find-and-replace this time.

## 7. Test it

Open `docs/index.html` directly (or serve it locally), type a real URL into
the box, click Scan. Should take 10-30 seconds (real headless browser +
real page load + real Claude call) and come back with a screenshot,
overlay boxes, and ticket cards, all live, not the embedded example.

## What to watch for

- **CORS errors in the browser console**: the Worker sets
  `Access-Control-Allow-Origin: *`, should work everywhere, but check this
  first if the fetch silently fails.
- **A rate limit error on the very first try**: means the KV namespace ID
  is wrong or the binding name doesn't match `RATE_LIMIT_KV` exactly.
- **Timeout on the scan**: some pages are slow or heavy, the Worker's
  `goto` timeout is 25 seconds. If a specific site you care about times out
  consistently, that number can be raised.
- **Screenshot doesn't load but tickets do**: check the browser console for
  a broken base64 data URL, most likely the response got truncated or the
  Worker's response size hit a limit on a very large page.
