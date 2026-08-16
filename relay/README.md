# Spün MovieBox Relay

Authenticated egress relay for the [`spun-moviebox` Cloudflare Worker](https://github.com/heisdanny64/spun-moviebox-api). The Worker builds the fully signed MovieBox request, and this service re-issues that request from a Render web-service instance instead of directly from Cloudflare Workers egress.

The relay lives in the `relay/` directory of the Worker monorepo. Its package manifest, lockfile, server, tests, and deployment documentation remain self-contained so Render can build it independently from the Worker.

This repository is public and self-hostable. It contains no Render account credentials, relay secrets, MovieBox signing keys, or Worker secrets. All deployment secrets are supplied through Render's environment settings or local environment variables at runtime.

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

### `GET /media/:encodedTarget?e=<cdn-t>&s=<signature>&download=1&filename=<signed-name>`

The Worker returns signed media-proxy URLs for resources hosted on `bcdn.hakunaymatata.com`. The relay verifies the HMAC signature with `RELAY_SECRET`, forwards client `Range` headers using the accepted Android-style playback User-Agent, and streams the upstream response without buffering the media in a JSON envelope.

Download URLs include `download=1` and a signed `filename` parameter. The relay emits a UTF-8-aware `Content-Disposition: attachment` header using that filename. Stream URLs omit the download flag and remain inline-playable. The filename is included in the HMAC payload, so changing it invalidates the signature. Legacy signed URLs without `filename` remain supported and fall back to the upstream CDN basename.

The Worker generates names in this format:

```text
Movie_Title_1080p_bySpün.mp4
Series_Title_1080p_S01E02_bySpün.mp4
Shorts_Title_720p_S01E03_bySpün.mp4
```

The media proxy accepts only base64url-encoded HTTPS targets on `bcdn.hakunaymatata.com` that contain the upstream `sign` and `t` query parameters. It is deliberately not a general-purpose proxy. The Worker and Render service must use the same `RELAY_SECRET`.

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

Media proxy host:

- `bcdn.hakunaymatata.com`

Update `ALLOWED_HOSTS` in `server.js` if MovieBox changes its mirror pool.

## Public repository and security model

Anyone can clone and deploy this relay, provided they have their own Render account or another Node.js host. The repository deliberately keeps `RELAY_SECRET` out of source control. The included `.gitignore` excludes `.env` files, local Wrangler state, dependency directories, logs, and other common local artifacts.

The relay is not a general-purpose open proxy. Its JSON API requires `X-Relay-Secret`, accepts only HTTPS upstream URLs on the explicit MovieBox allowlist, allows only `GET` and `POST`, strips hop-by-hop headers, enforces request-size limits, and applies an upstream timeout. Its media endpoint requires a separate HMAC-signed target and only permits the MovieBox CDN host.
The relay never needs the Worker's `MOVIEBOX_SECRET`, the MovieBox signing key, or the MovieBox bearer token as configuration; those remain part of the Worker request flow.

## Local development

The service requires Node.js 20 or newer and has no runtime dependencies.

```bash
npm ci
read -r -s -p 'Relay secret: ' RELAY_SECRET
echo
export RELAY_SECRET
npm start
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

1. In the Render Dashboard, create a new Blueprint and select the [`heisdanny64/spun-moviebox-api`](https://github.com/heisdanny64/spun-moviebox-api) repository.
2. Render will read the root-level [`render.yaml`](../render.yaml), set `rootDir: relay`, and configure the Node runtime, build command, start command, and `/health` check.
3. Set the prompted `RELAY_SECRET` value to a long random secret. Do not commit the value to Git or place it in `render.yaml`.
4. Deploy the service and copy its `https://<service-name>.onrender.com` URL.
5. Confirm `https://<service-name>.onrender.com/health` returns a `200` response.
6. Configure the Worker repository's `RELAY_URL` with the base URL and its `RELAY_SECRET` with the exact same secret.

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

The Worker and relay are now maintained in the same [`heisdanny64/spun-moviebox-api`](https://github.com/heisdanny64/spun-moviebox-api) monorepo. Deploy the Render relay from the root Blueprint first, then set the two Worker secrets below.

Set both Worker secrets to the same values used by Render:

```bash
wrangler secret put RELAY_URL
# enter: https://<service-name>.onrender.com

wrangler secret put RELAY_SECRET
# enter the exact same value configured on Render
```

The Worker appends `/api/relay` to `RELAY_URL`. Do not include `/api/relay` in the secret value or URL; use only the service base URL.

The Worker still owns all MovieBox authentication and signing. The relay must never receive the signing key or be configured with a MovieBox application secret.

## License

The original Worker, relay, deployment configuration, tests, and documentation in this repository are licensed under the [MIT License](../LICENSE). The license does not grant rights to MovieBox's service, trademarks, media, CDN assets, or separately licensed dependencies.
