# Spün MovieBox Relay (Vercel)

Generic egress relay for the `spun-moviebox` Cloudflare Worker.

## Why this exists

MovieBox's mobile API returns `HTTP 440`/`530` to every request from
Cloudflare Workers' egress IPs, at the transport layer — before the request
reaches MovieBox's app logic. Confirmed by firing an identical signed
request (same HMAC signature, same bootstrapped bearer token) from a
non-Cloudflare IP, which succeeded on 6/7 hosts, versus the Worker's
`wrangler tail` log showing uniform 440/530 across all 7 hosts for the same
call at the same time. The Worker's signing/auth logic was never the
problem.

This relay does not know anything about MovieBox, HMAC signing, or bearer
tokens. It's a dumb forwarder: the Worker builds the fully-signed request
exactly as before, sends it here, and this relay re-issues it byte-for-byte
from Vercel's IP instead of Cloudflare's.

## Endpoints

- `GET /api/health` — liveness check, no auth required.
- `POST /api/relay` — forwards a request. Requires `X-Relay-Secret` header
  matching the `RELAY_SECRET` env var. Body:
  ```json
  {
    "url": "https://api6.aoneroom.com/wefeed-mobile-bff/subject-api/get?subjectId=...",
    "method": "GET",
    "headers": { "Authorization": "Bearer ...", "x-tr-signature": "...", ... },
    "body": null
  }
  ```
  Response:
  ```json
  {
    "status": 200,
    "headers": { "x-user": "...", "content-type": "application/json", ... },
    "body": "{\"code\":0,...}"
  }
  ```

Only hosts in `ALLOWED_HOSTS` inside `api/relay.js` can be forwarded to —
this prevents the relay being used as an open proxy if the secret ever
leaks. Add new MovieBox mirror hosts there if the pool changes.

## Deploying to Vercel

1. Push this folder to its own GitHub repo (or import directly from this
   folder with the Vercel CLI: `vercel --prod` from inside it).
2. On vercel.com: **Add New → Project** → import the repo. Framework
   preset: **Other** (no build step needed — it's just serverless
   functions under `api/`).
3. Project Settings → Environment Variables → add `RELAY_SECRET` = a long
   random value (e.g. `openssl rand -hex 32`). Apply to Production (and
   Preview if you want to test from preview deployments too).
4. Deploy. Note the assigned `https://<project>.vercel.app` URL.

## Cold starts

Vercel serverless functions on the Hobby plan spin down after inactivity
and cold-start on the next request (typically sub-second to a couple
seconds for a function this small — no heavy dependencies). If that
latency ever matters for a specific route, an uptime monitor (e.g.
UptimeRobot) pinging `/api/health` every 5 minutes keeps it warm, same
idea as would be needed on Render.

## Wiring into the Worker

Set two Worker secrets:
```
wrangler secret put RELAY_URL
# -> https://<project>.vercel.app

wrangler secret put RELAY_SECRET
# -> same value as set in Vercel's env vars above
```

`moviebox.ts` routes all `HOST_POOL` requests through `${RELAY_URL}/api/relay`
instead of calling MovieBox hosts directly. See the "2026-08-13 relay fix"
comments in `src/moviebox.ts` and `src/signing.ts`.
