// src/index.ts
// Spün MovieBox Worker — main entry point.
// Routes:
//   GET  /                             — API info & route listing (public)
//   GET  /health                       — health check (public)
//   POST /search                       — { keyword, page?, perPage? }
//   GET  /info/:subjectId              — subject detail
//   GET  /season/:subjectId            — season/episode structure
//   GET  /stream/:subjectId            — ?se=X&ep=Y  MP4 URLs for specific episode
//   GET  /stream/:subjectId/all        — all episodes with streams (shorts/series bulk)
//   GET  /download/:subjectId          — full pack grouped by season/episode
//   GET  /home                         — homepage rows + subjects (Africa feed)
//   GET  /home/subjects?opId=X         — subjects for a specific row
//
// /stream, /stream/all, and /download use the Android resource endpoint (7-host pool).
// /home and /home/subjects use the H5 web endpoint (no HMAC signing required).
// All routes except / and /health require X-Worker-Secret header.

import {
  fetchWithHostPool,
  PATHS,
  type MBSearchData,
  type MBDetailData,
  type MBSeasonData,
  type MBResourceData,
  type MBResourceItem,
} from './moviebox.js';
import type { SigningEnv } from './signing.js';

// subjectType: 1=movie, 2=tv, 7=shorts — all others filtered out
const ALLOWED_SUBJECT_TYPES = new Set([1, 2, 7]);

function resolveSubjectType(subjectType: number): 'movie' | 'tv' | 'shorts' {
  if (subjectType === 2) return 'tv';
  if (subjectType === 7) return 'shorts';
  return 'movie';
}

export interface Env extends SigningEnv {
  MOVIEBOX_SECRET: string;
  // Nigerian IP for X-Forwarded-For — ensures the H5 upstream returns the full
  // Africa region feed (35 rows). Cloudflare edge IPs get a truncated feed (30 rows).
  // Set in wrangler.toml or Cloudflare dashboard. Falls back to a known MTN Nigeria IP.
  NIGERIA_IP?: string;
}

// ─── Response helpers ─────────────────────────────────────────────────────────

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function err(message: string, status = 400): Response {
  return json({ error: message }, status);
}

// ─── Auth guard ───────────────────────────────────────────────────────────────

function isAuthorized(request: Request, env: Env): boolean {
  const secret = request.headers.get('X-Worker-Secret');
  return !!secret && secret === env.MOVIEBOX_SECRET;
}

// ─── Language name map ────────────────────────────────────────────────────────

const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',   fr: 'Français',  ar: 'Arabic',    zh: 'Chinese',
  ru: 'Russian',   pt: 'Português', es: 'Spanish',   de: 'German',
  ja: 'Japanese',  ko: 'Korean',    it: 'Italian',   sw: 'Kiswahili',
  ha: 'Hausa',     ms: 'Malay',     bn: 'Bengali',   ur: 'Urdu',
  pa: 'Punjabi',   fil: 'Filipino', id: 'Indonesian',
};

// ─── Shared: fetch full resource pack (all resolutions, all pages) ───────────
// MovieBox's resource endpoint is resolution-filtered — omitting the resolution
// param returns only one quality. We loop over every known resolution and
// paginate each until hasMore=false, deduplicating by resourceId across passes.
// se=0&ep=0 is the magic value that returns all episodes in bulk.
// perPage must be 10 — server silently rejects higher values with code !== 0.

const RESOLUTIONS = [360, 480, 720, 1080];

async function fetchResourcePack(env: Env, subjectId: string): Promise<MBResourceItem[] | null> {
  const seenResourceIds = new Set<string>();
  const allItems: MBResourceItem[] = [];
  const perPage = 10;

  for (const resolution of RESOLUTIONS) {
    let page = 1;

    while (true) {
      const data = await fetchWithHostPool<MBResourceData>(
        env, PATHS.resource, 'GET', { subjectId, se: 0, ep: 0, resolution, page, perPage }
      );

      if (!data?.list?.length) break;

      for (const item of data.list) {
        if (!seenResourceIds.has(item.resourceId)) {
          seenResourceIds.add(item.resourceId);
          allItems.push(item);
        }
      }

      if (!data.pager?.hasMore) break;

      page++;

      // Safety cap — 100 pages x 10 items = 1000 items per resolution,
      // enough for the longest series on MovieBox (e.g. One Piece ~1100 eps).
      if (page > 100) break;
    }
  }

  if (!allItems.length) return null;

  return allItems.sort((a, b) => b.resolution - a.resolution);
}

// ─── Shared: map a resource item to a stream/download object ─────────────────

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function signMediaProxyTarget(expires: number, targetUrl: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${expires}\n${targetUrl}`)
  );
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function proxyMediaUrl(resourceLink: string, env: Env): Promise<string> {
  const relayBaseUrl = env.RELAY_URL?.trim().replace(/\/+$/, '');
  const relaySecret = env.RELAY_SECRET?.trim();
  let target: URL;
  try {
    target = new URL(resourceLink);
  } catch {
    return resourceLink;
  }

  if (!relayBaseUrl || !relaySecret || target.protocol !== 'https:' || target.hostname.toLowerCase() !== 'bcdn.hakunaymatata.com') {
    return resourceLink;
  }

  const expires = Number.parseInt(target.searchParams.get('t') ?? '', 10);
  if (!Number.isInteger(expires)) return resourceLink;

  const signature = await signMediaProxyTarget(expires, target.toString(), relaySecret);
  const proxy = new URL(`${relayBaseUrl}/media/${base64UrlEncode(target.toString())}`);
  proxy.searchParams.set('e', String(expires));
  proxy.searchParams.set('s', signature);
  return proxy.toString();
}

async function mapResourceItem(item: MBResourceItem, env: Env) {
  const sizeMb = item.size
    ? `${Math.round(parseInt(item.size) / (1024 * 1024))} MB`
    : null;

  const captions = (item.extCaptions || []).map((cap) => ({
    language:      cap.lanName || LANGUAGE_NAMES[cap.lan] || cap.lan,
    language_code: cap.lan,
    url:           cap.url,
  }));

  return {
    quality:    `${item.resolution}p`,
    resolution: item.resolution,
    url:        await proxyMediaUrl(item.resourceLink, env),
    format:     'mp4' as const,
    size:       sizeMb,
    codecName:  item.codecName ?? null,
    duration:   item.duration ?? null,
    captions,
    se:         item.se,
    ep:         item.ep,
  };
}

// ─── H5 homepage fetcher ──────────────────────────────────────────────────────
// No HMAC signing needed — the H5 API only requires standard browser headers.
// The Africa/Lagos timezone pin in X-Client-Info is what produces the Africa
// region feed (Nollywood, Anime Dub, Black Shows rows). Do not change it.

const H5_HOSTS = [
  'https://netnaija.film',
  'https://h5.aoneroom.com',
  'https://moviebox.pk',
];

const H5_PATH = '/wefeed-h5-bff/web/home';

interface H5Subject {
  subjectId:        string;
  subjectType:      number;
  title:            string;
  description?:     string;
  releaseDate?:     string;
  duration?:        number;
  genre?:           string;
  cover?:           { url?: string; thumbnail?: string };
  countryName?:     string;
  imdbRatingValue?: string;
  hasResource?:     boolean;
  language?:        string;
}

interface H5Row {
  title:    string;
  opId:     string;
  type:     string;
  subjects: H5Subject[];
}

interface H5HomeData {
  operatingList: H5Row[];
}

async function fetchH5Home(nigeriaIp?: string): Promise<H5HomeData | null> {
  // Use provided IP or fall back to a known stable MTN Nigeria IP.
  // This is needed because Cloudflare edge nodes have non-Nigerian IPs and the
  // upstream server returns a region-filtered feed based on the requester's IP.
  const forwardedIp = nigeriaIp || '197.210.65.1';

  for (const base of H5_HOSTS) {
    try {
      const response = await fetch(`${base}${H5_PATH}`, {
        method: 'GET',
        headers: {
          'X-Client-Info':   '{"timezone":"Africa/Lagos"}',
          'Accept':           'application/json',
          'User-Agent':       'Mozilla/5.0 (X11; Linux x86_64; rv:137.0) Gecko/20100101 Firefox/137.0',
          'Referer':          `${base}/`,
          'X-Forwarded-For':  forwardedIp,
        },
        signal: AbortSignal.timeout(12000),
      });

      if (!response.ok) {
        console.warn(`[H5] Host ${base} returned ${response.status} — trying next`);
        continue;
      }

      const data = await response.json() as { code: number; data?: H5HomeData };

      if (data.code === 0 && data.data) {
        return data.data;
      }

      console.warn(`[H5] Host ${base} returned API code ${data.code} — trying next`);
    } catch (e) {
      console.warn(`[H5] Host ${base} failed: ${e} — trying next`);
    }
  }

  console.error('[H5] All hosts exhausted');
  return null;
}

function normalizeH5Subject(item: H5Subject) {
  const rawDuration = item.duration;
  const runtimeMinutes = rawDuration && rawDuration > 0
    ? Math.round(rawDuration / 60)
    : null;

  return {
    subjectId:   item.subjectId,
    subjectType: item.subjectType,
    type:        resolveSubjectType(item.subjectType),
    title:       item.title,
    description: item.description ?? '',
    releaseDate: item.releaseDate ?? null,
    runtime:     runtimeMinutes,
    genre:       item.genre ?? null,
    poster:      item.cover?.url ?? null,
    thumbnail:   item.cover?.thumbnail ?? '',
    country:     item.countryName ?? null,
    rating:      item.imdbRatingValue && item.imdbRatingValue !== '0'
                   ? parseFloat(item.imdbRatingValue)
                   : null,
    hasResource: item.hasResource ?? false,
    language:    item.language ?? null,
  };
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

function handleRoot(): Response {
  return json({
    name:        'Spün MovieBox API',
    description: 'An unofficial REST API built by Spün for MovieBox — wrapping the MovieBox Android & H5 APIs with host pool fallback, request signing, and structured responses.',
    version:     '1.1.0',
    routes: [
      { method: 'GET',  path: '/',                          auth: false,  description: 'API info and route listing' },
      { method: 'GET',  path: '/health',                    auth: false,  description: 'Worker health check' },
      { method: 'POST', path: '/search',                    auth: true,   description: 'Search for movies, TV shows, and shorts. Body: { keyword, page?, perPage? }' },
      { method: 'GET',  path: '/info/:subjectId',           auth: true,   description: 'Get detail for a subject' },
      { method: 'GET',  path: '/season/:subjectId',         auth: true,   description: 'Get season and episode structure for a TV show or shorts series' },
      { method: 'GET',  path: '/stream/:subjectId',         auth: true,   description: 'Stream URLs for a specific episode. Params: se (season), ep (episode). Use se=0&ep=0 for movies.' },
      { method: 'GET',  path: '/stream/:subjectId/all',     auth: true,   description: 'All stream URLs for all episodes grouped by episode. Useful for shorts and full series bulk fetch.' },
      { method: 'GET',  path: '/download/:subjectId',       auth: true,   description: 'Full download pack grouped by season → episode → quality' },
      { method: 'GET',  path: '/home',                      auth: true,   description: 'MovieBox homepage rows with subjects (Africa/Lagos feed)' },
      { method: 'GET',  path: '/home/rows',                 auth: true,   description: 'All homepage row titles and opIds — use to discover rows before fetching subjects' },
      { method: 'GET',  path: '/home/subjects?opId=X',      auth: true,   description: 'Subjects for a specific homepage row by opId' },
    ],
  });
}

async function handleSearch(request: Request, env: Env): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return err('Invalid JSON body');
  }

  const keyword = body.keyword as string;
  if (!keyword?.trim()) return err('keyword is required');

  const page    = Number(body.page ?? 1);
  const perPage = Number(body.perPage ?? 20);

  const data = await fetchWithHostPool<MBSearchData>(
    env, PATHS.search, 'POST', undefined,
    { keyword, page, perPage, subjectType: 0 }
  );

  if (!data) return json({ items: [], pager: null });

  const items = (data.items || [])
    .filter((item) => ALLOWED_SUBJECT_TYPES.has(item.subjectType))
    .map((item) => ({
      subjectId:   item.subjectId,
      subjectType: item.subjectType,
      title:       item.title,
      description: item.description ?? '',
      releaseDate: item.releaseDate ?? null,
      duration:    item.duration ?? null,
      genre:       item.genre ?? null,
      poster:      item.cover?.url ?? null,
      thumbnail:   item.cover?.thumbnail ?? null,
      country:     item.countryName ?? null,
      rating:      item.imdbRatingValue && item.imdbRatingValue !== '0'
                     ? parseFloat(item.imdbRatingValue)
                     : null,
      language:    item.language ?? null,
      type:        resolveSubjectType(item.subjectType),
    }));

  return json({ items, pager: data.pager });
}

async function handleInfo(subjectId: string, env: Env): Promise<Response> {
  const data = await fetchWithHostPool<MBDetailData>(
    env, PATHS.get, 'GET', { subjectId }
  );

  if (!data?.subjectId) return err('Not found', 404);

  const staffList = (data as any).staffList || [];

  const rawDuration = (data as any).duration;
  let runtimeMinutes: number | null = null;
  if (typeof rawDuration === 'number') {
    runtimeMinutes = Math.round(rawDuration / 60);
  } else if (typeof rawDuration === 'string') {
    const hMatch = rawDuration.match(/(\d+)h/);
    const mMatch = rawDuration.match(/(\d+)m/);
    const h = hMatch ? parseInt(hMatch[1]) : 0;
    const m = mMatch ? parseInt(mMatch[1]) : 0;
    runtimeMinutes = h * 60 + m || null;
  }

  return json({
    subjectId:   data.subjectId,
    subjectType: data.subjectType,
    type:        resolveSubjectType(data.subjectType),
    title:       data.title,
    description: data.description ?? '',
    releaseDate: data.releaseDate ?? null,
    runtime:     runtimeMinutes,
    genre:       data.genre ?? null,
    poster:      data.cover?.url ?? null,
    country:     data.countryName ?? null,
    rating:      data.imdbRatingValue && data.imdbRatingValue !== '0'
                   ? parseFloat(data.imdbRatingValue)
                   : null,
    hasResource: data.hasResource ?? false,
    language:    data.language ?? null,
    staff:       staffList.map((s: any) => ({
      name:   s.name,
      role:   s.role,
      avatar: s.avatar?.url ?? null,
    })),
  });
}

async function handleSeason(subjectId: string, env: Env): Promise<Response> {
  const data = await fetchWithHostPool<MBSeasonData>(
    env, PATHS.seasonInfo, 'GET', { subjectId }
  );

  if (!data?.seasons?.length) return json({ seasons: [] });

  return json({
    seasons: data.seasons.map((s) => {
      const bestEpCount = s.resolutions?.length
        ? Math.max(...s.resolutions.map((r) => r.epNum))
        : s.maxEp;

      return {
        season:            s.se,
        totalEpisode:      s.maxEp,
        episodesAvailable: bestEpCount,
        resolutions:       s.resolutions || [],
        episodes:          Array.from({ length: s.maxEp }, (_, i) => ({
          episode:     i + 1,
          title:       null,
          releaseDate: null,
        })),
      };
    }),
  });
}

// GET /stream/:subjectId?se=X&ep=Y
// Returns MP4 URLs for a specific episode, deduplicated by quality.
// Use se=0&ep=0 for movies (returns full pack as one item per quality).

async function handleStream(subjectId: string, se: number, ep: number, env: Env): Promise<Response> {
  const pack = await fetchResourcePack(env, subjectId);
  if (!pack) return err('No streams available', 404);

  const isMovie = se === 0 && ep === 0;
  let items = pack;

  if (!isMovie) {
    const filtered = pack.filter((r) => r.se === se && r.ep === ep);
    if (!filtered.length) return err('No streams available for this episode', 404);
    items = filtered;
  }

  // Deduplicate by quality — keep first (highest resolution sort already applied)
  const seenQualities = new Set<string>();
  const streams = items
    .filter((item) => {
      const q = `${item.resolution}p`;
      if (seenQualities.has(q)) return false;
      seenQualities.add(q);
      return true;
    })
    .map((item) => mapResourceItem(item, env));

  const resolvedStreams = await Promise.all(streams);

  return json({ streams: resolvedStreams, total: resolvedStreams.length });
}

// GET /stream/:subjectId/all
// Returns ALL stream URLs grouped by season → episode.
// Works for both shorts (se=1, flat episode list) and full TV series.
// No se/ep filtering — always returns the complete pack.

async function handleStreamAll(subjectId: string, env: Env): Promise<Response> {
  const pack = await fetchResourcePack(env, subjectId);
  if (!pack) return err('No streams available', 404);

  // Group by season (se) → episode (ep) — deduplicate by quality within each episode
  const seasonMap = new Map<number, Map<number, Awaited<ReturnType<typeof mapResourceItem>>[]>>();

  for (const item of pack) {
    const seKey = item.se;
    const epKey = item.ep;

    if (!seasonMap.has(seKey)) seasonMap.set(seKey, new Map());
    const epMap = seasonMap.get(seKey)!;

    if (!epMap.has(epKey)) epMap.set(epKey, []);
    const streams = epMap.get(epKey)!;

    const q = `${item.resolution}p`;
    if (!streams.find((x) => x.quality === q)) {
      streams.push(await mapResourceItem(item, env));
    }
  }

  const seasons = [...seasonMap.entries()]
    .sort(([a], [b]) => a - b)
    .map(([seasonNum, epMap]) => ({
      season: seasonNum,
      episodes: [...epMap.entries()]
        .sort(([a], [b]) => a - b)
        .map(([epNum, streams]) => ({
          episode: epNum,
          streams,
          total:   streams.length,
        })),
    }));

  return json({ seasons, total_seasons: seasons.length });
}

// GET /download/:subjectId
// Returns full pack grouped by season → episodes → qualities.

async function handleDownload(subjectId: string, env: Env): Promise<Response> {
  const pack = await fetchResourcePack(env, subjectId);
  if (!pack) return err('No downloads available', 404);

  const seasonMap = new Map<number, Map<number, Awaited<ReturnType<typeof mapResourceItem>>[]>>();

  for (const item of pack) {
    const seKey = item.se;
    const epKey = item.ep;

    if (!seasonMap.has(seKey)) seasonMap.set(seKey, new Map());
    const epMap = seasonMap.get(seKey)!;

    if (!epMap.has(epKey)) epMap.set(epKey, []);
    const qualities = epMap.get(epKey)!;

    const q = `${item.resolution}p`;
    if (!qualities.find((x) => x.quality === q)) {
      qualities.push(await mapResourceItem(item, env));
    }
  }

  const seasons = [...seasonMap.entries()]
    .sort(([a], [b]) => a - b)
    .map(([seasonNum, epMap]) => ({
      season: seasonNum,
      episodes: [...epMap.entries()]
        .sort(([a], [b]) => a - b)
        .map(([epNum, qualities]) => ({
          episode:  epNum,
          qualities,
        })),
    }));

  return json({ seasons, total_seasons: seasons.length });
}

// GET /home/rows
// Returns all homepage row titles and opIds — lightweight discovery endpoint.
// Use this to find opIds before calling /home/subjects.

async function handleHomeRows(env: Env): Promise<Response> {
  const data = await fetchH5Home(env.NIGERIA_IP);
  if (!data) return err('Failed to fetch homepage', 502);

  const rows = (data.operatingList || []).map((row) => ({
    title: row.title,
    opId:  row.opId,
  }));

  return json({ total: rows.length, rows });
}

// GET /home
// Returns all homepage rows with their subjects (Africa/Lagos feed).

async function handleHome(env: Env): Promise<Response> {
  const data = await fetchH5Home(env.NIGERIA_IP);
  if (!data) return err('Failed to fetch homepage', 502);

  const rows = (data.operatingList || []).map((row) => ({
    title:    row.title,
    opId:     row.opId,
    type:     row.type,
    total:    (row.subjects || []).length,
    subjects: (row.subjects || [])
      .filter((s) => ALLOWED_SUBJECT_TYPES.has(s.subjectType))
      .map(normalizeH5Subject),
  }));

  return json({ total: rows.length, rows });
}

// GET /home/subjects?opId=X
// Returns subjects for a specific homepage row.

async function handleHomeSubjects(opId: string, env: Env): Promise<Response> {
  const data = await fetchH5Home(env.NIGERIA_IP);
  if (!data) return err('Failed to fetch homepage', 502);

  const row = (data.operatingList || []).find((r) => r.opId === opId);
  if (!row) return err('Row not found', 404);

  const subjects = (row.subjects || [])
    .filter((s) => ALLOWED_SUBJECT_TYPES.has(s.subjectType))
    .map(normalizeH5Subject);

  return json({
    opId:     row.opId,
    title:    row.title,
    total:    subjects.length,
    subjects,
  });
}

// ─── Router ───────────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin':  '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-Worker-Secret',
        },
      });
    }

    const url  = new URL(request.url);
    const path = url.pathname;

    // Public routes — no auth required
    if (path === '/' && request.method === 'GET') {
      return handleRoot();
    }

    if (path === '/health' && request.method === 'GET') {
      return json({ status: 'ok', worker: 'moviebox-worker', ts: Date.now() });
    }

    if (!isAuthorized(request, env)) {
      return err('Unauthorized', 401);
    }

    // POST /search
    if (path === '/search' && request.method === 'POST') {
      return handleSearch(request, env);
    }

    // GET /info/:subjectId
    const infoMatch = path.match(/^\/info\/([^/]+)$/);
    if (infoMatch && request.method === 'GET') {
      return handleInfo(infoMatch[1], env);
    }

    // GET /season/:subjectId
    const seasonMatch = path.match(/^\/season\/([^/]+)$/);
    if (seasonMatch && request.method === 'GET') {
      return handleSeason(seasonMatch[1], env);
    }

    // GET /stream/:subjectId/all — must be checked before /stream/:subjectId
    const streamAllMatch = path.match(/^\/stream\/([^/]+)\/all$/);
    if (streamAllMatch && request.method === 'GET') {
      return handleStreamAll(streamAllMatch[1], env);
    }

    // GET /stream/:subjectId?se=X&ep=Y
    const streamMatch = path.match(/^\/stream\/([^/]+)$/);
    if (streamMatch && request.method === 'GET') {
      const se = parseInt(url.searchParams.get('se') ?? '0');
      const ep = parseInt(url.searchParams.get('ep') ?? '0');
      return handleStream(streamMatch[1], se, ep, env);
    }

    // GET /download/:subjectId
    const downloadMatch = path.match(/^\/download\/([^/]+)$/);
    if (downloadMatch && request.method === 'GET') {
      return handleDownload(downloadMatch[1], env);
    }

    // GET /home/rows — must be checked before /home
    if (path === '/home/rows' && request.method === 'GET') {
      return handleHomeRows(env);
    }

    // GET /home/subjects?opId=X — must be checked before /home
    if (path === '/home/subjects' && request.method === 'GET') {
      const opId = url.searchParams.get('opId');
      if (!opId) return err('opId is required');
      return handleHomeSubjects(opId, env);
    }

    // GET /home
    if (path === '/home' && request.method === 'GET') {
      return handleHome(env);
    }

    return err('Not found', 404);
  },
};