# Spün MovieBox Relay

Authenticated egress relay for the `spun-moviebox` Cloudflare Worker. The Worker builds the fully signed MovieBox request, and this service re-issues that request from a Render web-service instance instead of directly from Cloudflare Workers egress.

## Why this exists

MovieBox's mobile API began rejecting requests originating from Cloudflare Workers egress IPs with transport-level `HTTP 440`/`530` responses. The signing and bearer-token logic remains in the Worker; this service only forwards the already formed request.

The relay is intentionally generic and does not know the MovieBox signing key, bearer-token format, or application response schema. It is protected by `X-Relay-Secret` and an upstream host allowlist so that a leaked URL cannot become an unrestricted open proxy.

## Endpoints

### `GET /health`

Returns a liveness response without authentication:

```json
{
  "status": "ok",
  "service": "spun-moviebox-relay",
  "ts": 1720000000000
}
```

`GET /api/health` is retained as a compatibility alias for older Worker health-check configurations.

### `POST /api/relay`

Requires `X-Relay-Secret` to match the server's `RELAY_SECRET` environment variable. The request body is:

```json
{
  "url": "https://api6.aoneroom.com/wefeed-mobile-bff/subject-api/get?subjectId=...",
  "method": "GET",
  "headers": {
    "Authorization": "Bearer ...",
    "x-tr-signature": "..."
  },
  "body": null
}
```

The relay returns HTTP `200` when it successfully contacted the upstream host, regardless of the upstream status. The upstream status, response headers, and raw response body are returned in the JSON envelope:

```json
{
  "status": 200,
  "headers": {
    "content-type": "application/json",
    "x-user": "..."
  },
  "body": "{\"code\":0,...}"
}
```

Relay-level failures return `4xx` or `5xx` responses. The relay accepts only `GET` and `POST` upstream methods, requires HTTPS, rejects custom upstream ports and credentials, limits request sizes, strips hop-by-hop headers, and aborts upstream requests after `RELAY_TIMEOUT_MS`.

## Allowed upstream hosts

Only the following hosts can be forwarded to:

- `api6.aoneroom.com`
- `api5.aoneroom.com`
- `api4.aoneroom.com`
- `api4sg.aoneroom.com`
- `api3.aoneroom.com`
- `api6sg.aoneroom.com`
- `api.inmoviebox.com`
- `h5.aoneroom.com`

Update `ALLOWED_HOSTS` in `server.js` if MovieBox changes its mirror pool.

## Local development

The service requires Node.js 20 or newer and has no runtime dependencies.

```bash
npm ci
RELAY_SECRET='replace-with-a-long-random-secret' npm start
```

The local service listens on `0.0.0.0:${PORT}`. It defaults to port `10000`, matching Render's default web-service port. Use `RELAY_TIMEOUT_MS` to override the upstream timeout, within the supported range of 1,000 to 60,000 milliseconds.

Run the test suite with:

```bash
npm test
```

Check the health endpoint:

```bash
curl -s http://127.0.0.1:10000/health
```

## Deploying to Render

Render web services must bind to `0.0.0.0` and the `PORT` environment variable; this service does both. Render's current Node web-service workflow supports `npm ci` as the build command, `npm start` as the start command, environment variables, and an HTTP health-check path. See the [Render web-service documentation](https://render.com/docs/web-services) and [Render health-check documentation](https://render.com/docs/health-checks).

### Option A: Render Blueprint

1. In the Render Dashboard, create a new Blueprint and select this repository.
2. Render will read `render.yaml`.
3. Set the prompted `RELAY_SECRET` value to a long random secret. Do not commit the value to Git.
4. Deploy the service and copy its `https://<service-name>.onrender.com` URL.
5. Confirm `https://<service-name>.onrender.com/health` returns a `200` response.

### Option B: Create a Web Service manually

Use the following values when creating a Render Web Service from this repository:

| Setting | Value |
|---|---|
| Runtime | Node |
| Build command | `npm ci` |
| Start command | `npm start` |
| Health-check path | `/health` |
| Required secret | `RELAY_SECRET` |
| Optional variable | `RELAY_TIMEOUT_MS=15000` |

Render automatically redeploys from the configured Git branch when new commits are pushed, subject to the service's auto-deploy setting.

## Wiring the Cloudflare Worker

Set both Worker secrets to the same values used by Render:

```bash
wrangler secret put RELAY_URL
# enter: https://<service-name>.onrender.com

wrangler secret put RELAY_SECRET
# enter the exact same value configured on Render
```

The Worker appends `/api/relay` to `RELAY_URL`. Do not include `/api/relay` in the secret value or URL; use only the service base URL.

The Worker still owns all MovieBox authentication and signing. The relay must never receive the signing key or be configured with a MovieBox application secret.
