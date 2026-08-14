<div align="center">

# 🎬 Spün MovieBox API

**An unofficial REST API built by [Spün](https://byspun.xyz) for MovieBox — wrapping the MovieBox Android & H5 APIs with host pool fallback, HMAC request signing, multi-quality stream resolution, and structured JSON responses, deployed on Cloudflare Workers.**

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat&logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/License-BSL%201.1-green?style=flat)](./LICENSE)
[![Status](https://img.shields.io/badge/Status-Production-brightgreen?style=flat)]()

</div>

---

> The API is currently down until I can fix the Cloudflare IP blocking 🤧

## 📖 Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Environment Variables](#environment-variables)
- [Deployment](#deployment)
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
      │         └── fetchWithHostPool() → 7-host pool with sequential fallback
      │                   │               + HMAC-MD5 signing (src/signing.ts)
      │                   └── api6.aoneroom.com
      │                       api5.aoneroom.com
      │                       api4.aoneroom.com
      │                       api4sg.aoneroom.com
      │                       api3.aoneroom.com
      │                       api6sg.aoneroom.com
      │                       api.inmoviebox.com
      │
      └── H5 Routes (home, home/rows, home/subjects)
                │
                └── fetchH5Home() → 2-host fallback, no signing
                          │         + X-Forwarded-For Nigerian IP pin
                          └── netnaija.film (primary)
                              h5.aoneroom.com
                              moviebox.pk
```

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
| `NIGERIA_IP` | ✅ Yes | A Nigerian IP address for `X-Forwarded-For`. Ensures the H5 upstream returns the full Africa region feed. Update in Cloudflare dashboard without redeploying. Falls back to `197.210.65.1` (MTN Nigeria) if not set. |

---

## Deployment

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) — `npm install -g wrangler`
- A Cloudflare account with Workers enabled

### Steps

**1. Star and fork this repo**

Hit ⭐ Star then click **Fork** at the top right of this page.

**2. Clone your fork**

```bash
git clone https://github.com/YOUR_USERNAME/spun-moviebox-api
cd spun-moviebox-api
```

**3. Install dependencies**

```bash
npm install
```

**4. Authenticate Wrangler**

```bash
wrangler login
```

**5. Set your secret**

```bash
wrangler secret put MOVIEBOX_SECRET
# Enter your chosen secret when prompted
```

**6. Configure `wrangler.toml`**

```toml
name = "spun-moviebox"
main = "src/index.ts"
compatibility_date = "2024-11-01"
compatibility_flags = ["nodejs_compat"]

[vars]
NIGERIA_IP = "YOUR_NIGERIAN_IP"  # curl https://api.ipify.org to get yours

[[routes]]
pattern = "your-domain.com/*"
zone_name = "your-domain.com"
```

**7. Deploy**

```bash
wrangler deploy
```

**8. Test your deployment**

```bash
curl -s "https://your-worker.workers.dev/health" | python3 -m json.tool
```

---

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
      "url": "https://bcdn.hakunaymatata.com/resource/....mp4?sign=...&t=...",
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
      "url": "https://bcdn.hakunaymatata.com/resource/....mp4?sign=...&t=...",
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

> **Note:** Stream URLs are signed and time-limited by the upstream CDN. Fetch them fresh on each playback session — do not cache the URLs themselves.

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
              "url": "https://bcdn.hakunaymatata.com/...",
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
              "url": "https://bcdn.hakunaymatata.com/...",
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

**[moviebox-api](https://github.com/Simatwa/moviebox-api) by Simatwa** — The foundation this worker is built on. The host pool URLs (both Android mobile and H5 web), the request signing algorithm, and the API endpoint structure were all discovered through their Python library. None of this would have been possible without their reverse engineering work.

**[Claude by Anthropic](https://claude.ai)** — Instrumental in building, debugging, and iterating on this worker across multiple sessions. From diagnosing the `perPage: 10` upstream quirk that was silently breaking every stream/download request, to figuring out the `se=0&ep=0` bulk fetch pattern, to tracking down the Nigerian IP geolocation issue that was truncating the home feed — Claude was a genuine engineering partner throughout.

---

## License

This project is licensed under the **Business Source License 1.1 (BSL 1.1)**.

- ✅ Free for personal and non-commercial use
- ✅ You may study, fork, and self-host
- ❌ You may not sell, sublicense, or use this in a commercial product without written permission from the author
- 🔄 Converts to MIT License 4 years from the date of each release

See [LICENSE](./LICENSE) for full terms.

For commercial licensing inquiries, contact **Spün**.

---

<div align="center">

*This API was built entirely on a mobile phone using Termux on Android.*
*If I can do it, you can do it too.* 🙌

**~ Danny Daniels**

</div>