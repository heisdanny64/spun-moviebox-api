<div align="center">

# 🎬 Spün MovieBox API

**An unofficial REST API built by [Spün](https://byspun.xyz) for MovieBox — wrapping the MovieBox Android & H5 APIs with host pool fallback, HMAC request signing, multi-quality stream resolution, and structured JSON responses, deployed on Cloudflare Workers.**

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat&logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/License-BSL%201.1-green?style=flat)](./LICENSE)
[![Status](https://img.shields.io/badge/Status-Production-brightgreen?style=flat)]()

</div>

---

## 📖 Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Environment Variables](#environment-variables)
- [Deployment](#deployment)
- [Local Smoke Test](#local-smoke-test)
- [API Reference](#api-reference)
  - [Public Routes](#public-routes)
  - [Search](#post-search)
  - [Info](#get-infosubjectid)
  - [Season](#get-seasonsubjectid)
  - [Stream](#get-streamsubjectid)
  - [Stream All](#get-streamsubjectidall)
  - [Download](#get-downloadsubjectid)
  - [Home](#get-home)
  - [Home Rows](#get-homerows)
  - [Home Subjects](#get-homesubjectsopidx)
- [Subject Types](#subject-types)
- [Known Quirks](#known-quirks)
- [Acknowledgements](#acknowledgements)
- [License](#license)

---

## Overview

This worker wraps two separate MovieBox API surfaces — the **Android mobile API** and the **H5 web API** — into a single, clean REST interface.

- The **Android API** powers search, info, season structure, and stream/download endpoints. It uses a 7-host pool with automatic fallback and HMAC-MD5 request signing to authenticate requests.
- The **H5 web API** powers the homepage feed endpoints. No signing required — just the right headers and a Nigerian IP hint to get the Africa-region feed.

All routes except `/` and `/health` are protected by an `X-Worker-Secret` header.

The Android routes use the companion [Spün MovieBox Relay](./relay/README.md) deployed as a Render Web Service from this same repository. The Worker keeps the MovieBox signing and bearer-token logic; the relay provides non-Cloudflare egress for the already signed upstream request. The H5 homepage routes continue to run directly from the Worker.

---

## Architecture

```
Client Request
      │
      ▼
Cloudflare Worker (src/index.ts)
      │
      ├── Android Routes (search, info, season, stream, download)
      │         │
      │         └── fetchWithHostPool()
      │                   │
      │                   ├── Builds HMAC-MD5 signature + bearer token
      │                   └── POSTs the signed request to the
      │                       Render relay (/api/relay)
      │                                  │
      │                                  └── Sequentially tries the
      │                                      allowed MovieBox mirrors
      │
      └── H5 Routes (home, home/rows, home/subjects)
                │
                └── fetchH5Home() → direct 2-host fallback, no signing
                          │         + X-Forwarded-For Nigerian IP pin
                          └── netnaija.film, h5.aoneroom.com, moviebox.pk
```

The relay source is maintained in [`relay/`](./relay/), with its Render Blueprint at the repository root in [`render.yaml`](./render.yaml). The relay has its own package manifest, lockfile, tests, and deployment README so Render can build it independently from the Worker.

### Why the Nigerian IP pin?

The H5 upstream server returns different homepage feeds based on the requester's IP geolocation. Cloudflare edge nodes have US/EU IPs and receive a truncated 30-row feed. By sending `X-Forwarded-For` with a Nigerian IP via the `NIGERIA_IP` environment variable, the upstream returns the full 35-row Africa region feed — including the Nollywood, Football Highlights, and Must-watch Black Shows rows.

### The `se=0&ep=0` trick

The Android resource endpoint returns all episodes in bulk when you pass `se=0` and `ep=0`. Individual episode filtering then happens in the worker. This was the key discovery that made the stream and download endpoints work.

### Why `perPage: 10`?

The Android resource endpoint silently rejects `perPage` values above 10 by returning API `code !== 0`, causing `fetchWithHostPool` to exhaust all 7 hosts and return null. The worker always sends `perPage: 10` and paginates properly via the `hasMore` flag.

### Why loop over resolutions?

The Android resource endpoint is resolution-filtered by default. Without passing a `resolution` param the server returns only one quality. The worker loops over `[360, 480, 720, 1080]` and makes a separate paginated request per resolution, deduplicating by `resourceId` across passes to build the full multi-quality pack.

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MOVIEBOX_SECRET` | ✅ Yes | Auth secret. Must match `X-Worker-Secret` on every request. Set via `wrangler secret put MOVIEBOX_SECRET` — never put in `wrangler.toml`. |
| `NIGERIA_IP` | Optional | A Nigerian IP address for `X-Forwarded-For`. It helps the H5 upstream return the Africa-region feed and falls back to the default in code when omitted. |
| `RELAY_URL` | ✅ Yes | Base URL of the [Render relay](./relay/README.md), for example `https://spun-moviebox-relay.onrender.com`. The Worker appends `/api/relay`. Set via `wrangler secret put RELAY_URL`. |
| `RELAY_SECRET` | ✅ Yes | Must exactly match the `RELAY_SECRET` configured on Render. Set via `wrangler secret put RELAY_SECRET`; never commit it. |
| `MOVIEBOX_SESSION_KV` | ✅ Yes | KV namespace binding used to cache the MovieBox bearer token between Worker isolates. Configure its namespace ID in `wrangler.toml`. |

---

## Deployment

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) — `npm install -g wrangler`
- A Cloudflare account with Workers and KV enabled
- A Render account if you are deploying the companion relay yourself

### Steps

**1. Clone the Worker repository**

```bash
git clone https://github.com/heisdanny64/spun-moviebox-api.git
cd spun-moviebox-api
npm ci
```

Anyone may clone and self-host this repository. No account credentials, API secrets, or deployment tokens are stored in the repository.

**2. Create or verify the Worker KV namespace**

Create a namespace if you do not already have one:

```bash
wrangler kv namespace create MOVIEBOX_SESSION_KV
```

Copy the returned production namespace ID into the `MOVIEBOX_SESSION_KV` binding in `wrangler.toml`. Do not commit local Wrangler state or secret files.

**3. Deploy the relay from this monorepo**

Create or update a Render Web Service from this repository. The root-level [`render.yaml`](./render.yaml) sets `rootDir: relay`, so Render builds and starts only the relay service even though the Worker is in the same repository. The relay's Node commands are `npm ci` and `npm start`, and its health-check path is `/health`.

If you already have the relay deployed from the former standalone repository, update that Render service to use this repository and set its Root Directory to `relay`, or create the new Blueprint service first and switch traffic after health verification. Do not delete the old service until the new one responds successfully.

Set a long random `RELAY_SECRET` as a Render environment secret. Verify the service before continuing:

```bash
curl -sS https://<service-name>.onrender.com/health
```

**4. Authenticate Wrangler and configure Worker secrets**

```bash
wrangler login
wrangler secret put MOVIEBOX_SECRET
wrangler secret put RELAY_URL
# enter: https://<service-name>.onrender.com
wrangler secret put RELAY_SECRET
# enter the exact value configured on Render
```

`RELAY_URL` must contain only the Render service base URL. The Worker appends `/api/relay` automatically. Keep all secret values in Wrangler and Render's secret stores; never place them in `wrangler.toml`, shell scripts, or commits.

**5. Configure non-secret Worker variables**

Edit `wrangler.toml` only for non-secret settings such as `NIGERIA_IP`, the KV namespace ID, and your Cloudflare route. The repository's sample configuration contains no user-specific credential values.

**6. Deploy the Worker**

```bash
wrangler deploy
```

**7. Run the local smoke test**

The repository includes [`scripts/smoke-test.sh`](./scripts/smoke-test.sh). It prompts for the Worker secret without writing it to disk and exercises public routes, authenticated Android routes through the relay, and H5 routes:

```bash
chmod +x scripts/smoke-test.sh
./scripts/smoke-test.sh
```

Use `RUN_EXPENSIVE=1` to additionally exercise `/stream`, `/stream/:subjectId/all`, and `/download/:subjectId`.

---

## Local Smoke Test

Run the complete non-expensive smoke suite against a deployed Worker:

```bash
./scripts/smoke-test.sh
```

For automation, provide the secret through the environment rather than committing it:

```bash
WORKER_SECRET='your-worker-secret' ./scripts/smoke-test.sh
```

The script discovers a subject ID from `/search` and uses it for `/info` and `/season`. It also discovers an `opId` from `/home/rows` and uses it for `/home/subjects`. It exits with status `1` if any tested route fails.

## API Reference

All authenticated routes require the `X-Worker-Secret` header:

```bash
-H "X-Worker-Secret: your_secret_here"
```

---

### Public Routes

#### `GET /`

API info and route listing. No auth required.

```bash
curl -s "https://your-worker.workers.dev/"
```

```json
{
  "name": "Spün MovieBox API",
  "description": "An unofficial REST API built by Spün for MovieBox...",
  "version": "1.0.0",
  "routes": [ ... ]
}
```

---

#### `GET /health`

Worker health check. No auth required.

```bash
curl -s "https://your-worker.workers.dev/health"
```

```json
{
  "status": "ok",
  "worker": "moviebox-worker",
  "ts": 1781168254381
}
```

---

### `POST /search`

Search for movies, TV shows, and shorts.

**Body:**

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `keyword` | string | ✅ | — |
| `page` | number | ❌ | `1` |
| `perPage` | number | ❌ | `20` |

```bash
curl -s -X POST "https://your-worker.workers.dev/search" \
  -H "X-Worker-Secret: your_secret" \
  -H "Content-Type: application/json" \
  -d '{"keyword": "avatar", "page": 1}'
```

```json
{
  "items": [
    {
      "subjectId": "1654274595068805784",
      "subjectType": 1,
      "title": "Avatar [Hindi]",
      "type": "movie",
      "releaseDate": "2009-12-18",
      "duration": "2h 42m",
      "genre": "Action, Adventure, Fantasy",
      "poster": "https://pbcdn.aoneroom.com/image/...",
      "rating": 7.9,
      "language": "English, Spanish",
      "country": "United States"
    }
  ],
  "pager": {
    "hasMore": true,
    "page": "1",
    "perPage": 20,
    "totalCount": 200
  }
}
```

---

### `GET /info/:subjectId`

Get full detail for a subject including staff list.

```bash
curl -s "https://your-worker.workers.dev/info/1654274595068805784" \
  -H "X-Worker-Secret: your_secret"
```

```json
{
  "subjectId": "1654274595068805784",
  "subjectType": 1,
  "type": "movie",
  "title": "Avatar [Hindi]",
  "description": "A paraplegic Marine dispatched to the moon Pandora...",
  "releaseDate": "2009-12-18",
  "runtime": 162,
  "genre": "Action, Adventure, Fantasy",
  "poster": "https://pbcdn.aoneroom.com/image/...",
  "country": "United States",
  "rating": 7.9,
  "hasResource": true,
  "language": "English, Spanish",
  "staff": [
    { "name": "James Cameron", "role": "Director", "avatar": null }
  ]
}
```

---

### `GET /season/:subjectId`

Get season and episode structure for a TV show or shorts series. The `episodesAvailable` field reflects the highest episode count across all available resolutions.

```bash
curl -s "https://your-worker.workers.dev/season/5139196938264400928" \
  -H "X-Worker-Secret: your_secret"
```

```json
{
  "seasons": [
    {
      "season": 1,
      "totalEpisode": 8,
      "episodesAvailable": 8,
      "resolutions": [
        { "resolution": 360, "epNum": 8 },
        { "resolution": 480, "epNum": 8 },
        { "resolution": 720, "epNum": 8 },
        { "resolution": 1080, "epNum": 7 }
      ],
      "episodes": [
        { "episode": 1, "title": null, "releaseDate": null }
      ]
    }
  ]
}
```

---

### `GET /stream/:subjectId`

Stream URLs for a specific episode, one URL per quality.

**Query Params:**

| Param | Description |
|-------|-------------|
| `se` | Season number. Use `0` for movies. |
| `ep` | Episode number. Use `0` for movies. |

```bash
# Movie
curl -s "https://your-worker.workers.dev/stream/1654274595068805784?se=0&ep=0" \
  -H "X-Worker-Secret: your_secret"

# TV Episode
curl -s "https://your-worker.workers.dev/stream/5139196938264400928?se=5&ep=8" \
  -H "X-Worker-Secret: your_secret"
```

```json
{
  "streams": [
    {
      "quality": "1080p",
      "resolution": 1080,
      "url": "https://spun-moviebox-relay.onrender.com/media/<encoded-target>?e=...&s=...",
      "format": "mp4",
      "size": "426 MB",
      "codecName": "hevc",
      "duration": 4005,
      "captions": [],
      "se": 5,
      "ep": 8
    },
    {
      "quality": "480p",
      "resolution": 480,
      "url": "https://spun-moviebox-relay.onrender.com/media/<encoded-target>?e=...&s=...",
      "format": "mp4",
      "size": "211 MB",
      "codecName": "hevc",
      "duration": 4005,
      "captions": [],
      "se": 5,
      "ep": 8
    }
  ],
  "total": 3
}
```

> **Note:** Stream and download URLs are signed media-proxy URLs returned by the Render relay. The relay forwards browser and player range requests to the MovieBox CDN using the accepted Android-style playback headers. Fetch them fresh on each playback session because the upstream CDN controls the lifetime of the embedded signed URL; do not cache the URLs themselves.
>
> The Render service must be deployed from the monorepo’s `relay/` directory with the same `RELAY_SECRET` configured in the Worker and Render. The relay media proxy only permits signed URLs for `bcdn.hakunaymatata.com`; it is not an open proxy.

---

### `GET /stream/:subjectId/all`

All stream URLs for every episode, grouped by season → episode. Designed for shorts series bulk fetch and full series prefetch. No `se`/`ep` filtering — always returns the complete pack.

```bash
curl -s "https://your-worker.workers.dev/stream/7618577843911803416/all" \
  -H "X-Worker-Secret: your_secret"
```

```json
{
  "seasons": [
    {
      "season": 1,
      "episodes": [
        {
          "episode": 1,
          "streams": [
            {
              "quality": "720p",
              "resolution": 720,
              "url": "https://spun-moviebox-relay.onrender.com/media/<encoded-target>?e=...&s=...",
              "filename": null,
              "format": "mp4",
              "size": "53 MB",
              "codecName": "h264",
              "duration": 1420,
              "captions": [],
              "se": 1,
              "ep": 1
            }
          ],
          "total": 1
        }
      ]
    }
  ],
  "total_seasons": 1
}
```

---

### `GET /download/:subjectId`

Full download pack grouped by season → episode → qualities. Same as `/stream/all` but intended for download managers — the `qualities` key name makes the intent clearer.

```bash
curl -s "https://your-worker.workers.dev/download/5139196938264400928" \
  -H "X-Worker-Secret: your_secret"
```

```json
{
  "seasons": [
    {
      "season": 1,
      "episodes": [
        {
          "episode": 1,
          "qualities": [
            {
              "quality": "1080p",
              "resolution": 1080,
              "url": "https://spun-moviebox-relay.onrender.com/media/<encoded-target>?e=...&s=...&download=1&filename=...",
              "filename": "The_Last_of_Us_1080p_S01E01_bySpün.mp4",
              "format": "mp4",
              "size": "360 MB",
              "codecName": "hevc",
              "duration": 3609,
              "captions": [],
              "se": 1,
              "ep": 1
            }
          ]
        }
      ]
    }
  ],
  "total_seasons": 5
}
```

---

### Media delivery

The Worker does not expose the upstream CDN URL directly anymore. For `bcdn.hakunaymatata.com` resources, it signs a relay URL that preserves HTTP range requests and streams the media response from Render. This is required because the upstream CDN rejects browser-like playback requests with `428 Forbidden` while accepting the Android-style request made by the relay.

Stream URLs remain inline-playable and do not force an attachment download. URLs returned by `/download/:subjectId` include a signed download filename, and the relay adds `Content-Disposition: attachment` so browsers and download managers save the media instead of opening it as an inline stream.

Download filenames use the following format:

```text
Movie_Title_1080p_bySpün.mp4
Series_Title_1080p_S01E02_bySpün.mp4
Shorts_Title_720p_S01E03_bySpün.mp4
```

Movies omit the season and episode segment. TV and shorts retain zero-padded `S##E##` values. The JSON response exposes the same value in each download quality object’s `filename` field. The requested filename is included in the HMAC-signed relay URL, preventing clients from changing the attachment name without invalidating the proxy signature.

If the relay service is redeployed under a different hostname, keep the Worker’s `RELAY_URL` secret synchronized with that hostname. After a Render deployment, verify the media path with a fresh `/stream` response and a small ranged request from a media client.

---

### `GET /home`

Full MovieBox homepage with all rows and their subjects. Africa/Lagos region feed — includes Nollywood, Anime Dubbed, Hot Short TV, Must-watch Black Shows, and more.

```bash
curl -s "https://your-worker.workers.dev/home" \
  -H "X-Worker-Secret: your_secret"
```

```json
{
  "total": 35,
  "rows": [
    {
      "title": "Nollywood Movie",
      "opId": "359580746379676048",
      "type": "SUBJECTS_MOVIE",
      "total": 20,
      "subjects": [
        {
          "subjectId": "6021098917113354936",
          "subjectType": 1,
          "type": "movie",
          "title": "YOURS BEFORE WORDS",
          "poster": "https://pbcdnw.aoneroom.com/image/...",
          "hasResource": true
        }
      ]
    }
  ]
}
```

---

### `GET /home/rows`

Lightweight endpoint — returns just row titles and opIds. Use this first to discover which rows exist and their opIds before fetching subjects. opIds change dynamically so do not hardcode them.

```bash
curl -s "https://your-worker.workers.dev/home/rows" \
  -H "X-Worker-Secret: your_secret"
```

```json
{
  "total": 35,
  "rows": [
    { "title": "Nollywood Movie", "opId": "359580746379676048" },
    { "title": "Anime[English Dubbed]", "opId": "5992193223496810920" },
    { "title": "🔥Hot Short TV", "opId": "4322548590817198760" },
    { "title": "Must-watch Black Shows", "opId": "6956721858884814888" }
  ]
}
```

---

### `GET /home/subjects?opId=X`

Subjects for a specific homepage row identified by `opId`.

**Query Params:**

| Param | Required | Description |
|-------|----------|-------------|
| `opId` | ✅ | The opId of the row. Discover opIds via `/home/rows`. |

```bash
curl -s "https://your-worker.workers.dev/home/subjects?opId=359580746379676048" \
  -H "X-Worker-Secret: your_secret"
```

```json
{
  "opId": "359580746379676048",
  "title": "Nollywood Movie",
  "total": 20,
  "subjects": [
    {
      "subjectId": "6021098917113354936",
      "subjectType": 1,
      "type": "movie",
      "title": "YOURS BEFORE WORDS",
      "description": "",
      "releaseDate": "2026-06-09",
      "runtime": null,
      "genre": "drama",
      "poster": "https://pbcdnw.aoneroom.com/image/...",
      "thumbnail": "",
      "country": "Nigeria",
      "rating": null,
      "hasResource": true,
      "language": null
    }
  ]
}
```

---

## Subject Types

| `subjectType` | `type` field | Description |
|---------------|-------------|-------------|
| `1` | `"movie"` | Feature film |
| `2` | `"tv"` | TV series |
| `7` | `"shorts"` | Vertical short-form content (Dramabox, ReelShorts, etc.) |

All other subject types are filtered out from responses.

---

## Known Quirks

**Signed, time-limited stream URLs** — CDN URLs from the resource endpoint include a `sign` param and a `t` (timestamp) param. They expire. Always fetch fresh from `/stream` at playback time.

**Shorts are structured like TV** — Despite being short-form vertical content, shorts subjects use `se=1` and a flat episode list under season 1. Use `/stream/:id?se=1&ep=X` for individual episodes or `/stream/:id/all` for the full pack.

**opIds change** — Homepage row opIds are dynamic and can change without notice. Always use `/home/rows` to discover current opIds rather than hardcoding them.

**Resolution availability varies** — Not every episode is available in every quality. The `resolutions[].epNum` field in `/season` tells you exactly how many episodes exist per quality tier.

---

## Acknowledgements

**[moviebox-api](https://github.com/Simatwa/moviebox-api) by Simatwa** — Consulted as a reference while discovering MovieBox mirror hosts, endpoint behavior, and request patterns. The Worker and relay implementation in this repository were written independently. This acknowledgement does not imply that this project contains copied code from that repository or that it is licensed by Simatwa.

**[Claude by Anthropic](https://claude.ai)** — Instrumental in building, debugging, and iterating on this worker across multiple sessions. From diagnosing the `perPage: 10` upstream quirk that was silently breaking every stream/download request, to figuring out the `se=0&ep=0` bulk fetch pattern, to tracking down the Nigerian IP geolocation issue that was truncating the home feed — Claude was a genuine engineering partner throughout.

---

## License

This project is licensed under the **MIT License**. The license covers the original Worker, relay, deployment configuration, tests, and documentation in this repository.

The MIT License does not grant rights to MovieBox's service, trademarks, media, CDN assets, or separately licensed dependencies. See the acknowledgement and disclaimer sections above and review third-party terms before redistribution.

See [LICENSE](./LICENSE) for the full license text.

For commercial licensing inquiries, contact **Spün**.

---

<div align="center">

*This API was built entirely on a mobile phone using Termux on Android.*
*If I can do it, you can do it too.* 🙌

**~ Danny Daniels**

</div>