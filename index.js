const express = require('express');

const app = express();
app.use(express.urlencoded({ extended: false, limit: '16kb' }));
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ADDON_ID = 'org.xtremio.addon';
const CATEGORY_TIMEOUT_MS = Math.max(15000, Number(process.env.UPSTREAM_CATEGORY_TIMEOUT_MS) || 30000);
const LIST_TIMEOUT_MS = Math.max(30000, Number(process.env.UPSTREAM_LIST_TIMEOUT_MS) || 120000);
const LIST_CONCURRENCY = Math.max(1, Math.min(4, Number(process.env.UPSTREAM_LIST_CONCURRENCY) || 1));
const LIST_CACHE_TTL_MS = Math.max(1000, Number(process.env.UPSTREAM_LIST_TTL_MS) || 20 * 60 * 1000);
const BACKGROUND_REFRESH_MS = Math.max(1000, Number(process.env.UPSTREAM_BACKGROUND_REFRESH_MS) || 2 * 60 * 60 * 1000);
const CATEGORY_REFRESH_MS = Math.max(1000, Number(process.env.UPSTREAM_CATEGORY_REFRESH_MS) || 6 * 60 * 60 * 1000);
const SERIES_INFO_REFRESH_MS = Math.max(1000, Number(process.env.UPSTREAM_SERIES_INFO_REFRESH_MS) || 6 * 60 * 60 * 1000);
const configuredListStale = process.env.UPSTREAM_LIST_STALE_MS;
const FULL_LIST_STALE_MS = !configuredListStale || configuredListStale.toLowerCase() === 'infinite'
    ? Infinity
    : Math.max(LIST_CACHE_TTL_MS, 2 * 60 * 60 * 1000, Number(configuredListStale) || 7 * 24 * 60 * 60 * 1000);

const DEFAULT_SETTINGS = Object.freeze({
    addonName: 'xTremio',
    liveCategoryName: 'Live TV',
    moviesCategoryName: 'XT-Movies',
    seriesCategoryName: 'XT-Series',
    enableLiveSearch: false
});

function settingName(value, fallback) {
    const name = String(value || '').trim();
    return (name || fallback).slice(0, 80);
}

function settingBoolean(value) {
    return value === true || /^(1|true|yes|on)$/i.test(String(value || ''));
}

function getSettings(cfg) {
    const settings = cfg?.settings && typeof cfg.settings === 'object' ? cfg.settings : cfg || {};
    return {
        addonName: settingName(settings.addonName, DEFAULT_SETTINGS.addonName),
        liveCategoryName: settingName(settings.liveCategoryName, DEFAULT_SETTINGS.liveCategoryName),
        moviesCategoryName: settingName(settings.moviesCategoryName, DEFAULT_SETTINGS.moviesCategoryName),
        seriesCategoryName: settingName(settings.seriesCategoryName, DEFAULT_SETTINGS.seriesCategoryName),
        enableLiveSearch: settingBoolean(settings.enableLiveSearch)
    };
}

function settingsFromForm(body, fallback = getSettings()) {
    return {
        addonName: settingName(body?.addonName, fallback.addonName),
        liveCategoryName: settingName(body?.liveCategoryName, fallback.liveCategoryName),
        moviesCategoryName: settingName(body?.moviesCategoryName, fallback.moviesCategoryName),
        seriesCategoryName: settingName(body?.seriesCategoryName, fallback.seriesCategoryName),
        enableLiveSearch: settingBoolean(body?.enableLiveSearch)
    };
}

function safeGenreName(name) {
    return String(name || '').replace(/\//g, '∕').replace(/&/g, '＆');
}

function matchSafeCategory(categories, selected) {
    if (!selected) return null;
    return categories.find(c => c.category_name === selected || safeGenreName(c.category_name) === selected) || null;
}

function appendSearchCatalogs(catalogs, settings) {
    if (settings.enableLiveSearch) {
        catalogs.push({
            type: settings.liveCategoryName,
            id: 'xtremio_search_live',
            name: 'Search Live TV',
            extra: [{ name: 'search', isRequired: true }],
            searchProperties: ['name']
        });
    }
    catalogs.push(
        {
            type: settings.moviesCategoryName,
            id: 'xtremio_search_movies',
            name: 'Search Movies',
            extra: [{ name: 'search', isRequired: true }],
            searchProperties: ['name']
        },
        {
            type: settings.seriesCategoryName,
            id: 'xtremio_search_series',
            name: 'Search Series',
            extra: [{ name: 'search', isRequired: true }],
            searchProperties: ['name']
        }
    );
}

function getBaseUrl(req) {
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
    return `${proto}://${host}`;
}

function escapeHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function encodeConfig(cfg, settings = getSettings(cfg)) {
    return Buffer.from(JSON.stringify({
        serverUrl: cfg.serverUrl,
        username: cfg.username,
        password: cfg.password,
        settings: getSettings(settings)
    })).toString('base64url');
}

function decodeConfig(encoded) {
    if (!encoded) return null;
    try {
        const cfg = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
        if (!cfg || typeof cfg !== 'object') return null;
        if (!cfg.serverUrl || !cfg.username || !cfg.password) return null;
        return cfg;
    } catch {
        return null;
    }
}

async function getManifest(baseUrl = `http://localhost:${PORT}`, cfg = null) {
    const catalogs = [];
    const settings = getSettings(cfg);

    if (cfg) {
        try {
            const cats = await getCategories(cfg);
            const movieGenres = [...new Set(cats.movies.map(c => safeGenreName(c.category_name)).filter(Boolean))];
            const seriesGenres = [...new Set(cats.series.map(c => safeGenreName(c.category_name)).filter(Boolean))];
            const liveGenres = [...new Set(cats.live.map(c => safeGenreName(c.category_name)).filter(Boolean))];

            catalogs.push(
                {
                    type: settings.liveCategoryName,
                    id: 'xtremio_live',
                    name: settings.liveCategoryName,
                    extra: [
                        { name: 'genre', options: liveGenres, isRequired: true },
                        { name: 'skip' },
                        { name: 'search' }
                    ]
                },
                {
                    type: settings.moviesCategoryName,
                    id: 'xtremio_movies_popular',
                    name: 'Popular',
                    extra: [
                        { name: 'genre', options: movieGenres, isRequired: true },
                        { name: 'skip' },
                        { name: 'search' }
                    ]
                },
                {
                    type: settings.moviesCategoryName,
                    id: 'xtremio_movies_new',
                    name: 'New',
                    extra: [
                        { name: 'genre', options: movieGenres, isRequired: true },
                        { name: 'skip' },
                        { name: 'search' }
                    ]
                },
                {
                    type: settings.moviesCategoryName,
                    id: 'xtremio_movies_featured',
                    name: 'Featured',
                    extra: [
                        { name: 'genre', options: movieGenres, isRequired: true },
                        { name: 'skip' },
                        { name: 'search' }
                    ]
                },
                {
                    type: settings.seriesCategoryName,
                    id: 'xtremio_series_popular',
                    name: 'Popular',
                    extra: [
                        { name: 'genre', options: seriesGenres, isRequired: true },
                        { name: 'skip' },
                        { name: 'search' }
                    ]
                },
                {
                    type: settings.seriesCategoryName,
                    id: 'xtremio_series_new',
                    name: 'New',
                    extra: [
                        { name: 'genre', options: seriesGenres, isRequired: true },
                        { name: 'skip' },
                        { name: 'search' }
                    ]
                },
                {
                    type: settings.seriesCategoryName,
                    id: 'xtremio_series_featured',
                    name: 'Featured',
                    extra: [
                        { name: 'genre', options: seriesGenres, isRequired: true },
                        { name: 'skip' },
                        { name: 'search' }
                    ]
                }
            );
            appendSearchCatalogs(catalogs, settings);
        } catch (e) {
            catalogs.push(
                { type: settings.liveCategoryName, id: 'xtremio_live', name: settings.liveCategoryName },
                { type: settings.moviesCategoryName, id: 'xtremio_movies_popular', name: 'Popular' },
                { type: settings.moviesCategoryName, id: 'xtremio_movies_new', name: 'New' },
                { type: settings.moviesCategoryName, id: 'xtremio_movies_featured', name: 'Featured' },
                { type: settings.seriesCategoryName, id: 'xtremio_series_popular', name: 'Popular' },
                { type: settings.seriesCategoryName, id: 'xtremio_series_new', name: 'New' },
                { type: settings.seriesCategoryName, id: 'xtremio_series_featured', name: 'Featured' }
            );
            appendSearchCatalogs(catalogs, settings);
        }
    }

    return {
        id: ADDON_ID,
        version: '1.1.1',
        name: settings.addonName,
        description: `${settings.addonName} addon for Stremio`,
        resources: ['catalog', 'meta', 'stream'],
        types: [...new Set([settings.liveCategoryName, settings.moviesCategoryName, settings.seriesCategoryName, 'series'])],
        catalogs,
        idPrefixes: ['xtremio_live_', 'xtremio_movie_', 'xtremio_series_', 'xtremio_episode_'],
        behaviorHints: {
            configurable: true,
            configurationRequired: !cfg
        },
        config: { url: `${baseUrl}/configure` }
    };
}

app.get('/manifest.json', async (req, res) => {
    res.json(await getManifest(getBaseUrl(req), null));
});

app.get('/:config/manifest.json', async (req, res) => {
    const cfg = decodeConfig(req.params.config);
    res.json(await getManifest(getBaseUrl(req), cfg));
});

function normalizeUrl(url) {
    url = url.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
    return url;
}

// Per Stremio SDK: notWebReady must be true when the URL is http:// or
// the file is not an MP4 container. Without this, the player may stop
// after a short period (e.g. ~1 min) and Stremio treats it as "ended",
// returning to details (movies) or auto-advancing (series episodes).
function isNotWebReady(url, ext) {
    const isHttps = /^https:\/\//i.test(url);
    const isMp4 = String(ext || '').toLowerCase() === 'mp4';
    return !(isHttps && isMp4);
}

async function xtremioGet(cfg, action, extraParams = '', { timeoutMs = 15000 } = {}) {
    const base = normalizeUrl(cfg.serverUrl);
    const url = `${base}/player_api.php?username=${encodeURIComponent(cfg.username)}&password=${encodeURIComponent(cfg.password)}&action=${action}${extraParams}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
        if (!res.ok) throw new Error(`xtremio ${action} failed: HTTP ${res.status}`);
        const data = await res.json();
        return data;
    } catch (e) {
        if (e.name === 'AbortError') {
            throw new Error(`xtremio ${action} timed out after ${timeoutMs}ms`, { cause: e });
        }
        throw e;
    } finally {
        clearTimeout(timer);
    }
}

function toIsoDate(s) {
    if (!s) return undefined;
    const d = new Date(s);
    return isNaN(d.getTime()) ? undefined : d.toISOString();
}

// Xtream providers return `cast`/`genre` as either a comma-separated string or an array.
function splitList(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
    return String(value).split(',').map(v => v.trim()).filter(Boolean);
}

// `backdrop_path` can be an array of URLs or a single URL string.
function pickBackdrop(value) {
    if (!value) return undefined;
    if (Array.isArray(value)) return value[0] || undefined;
    return String(value) || undefined;
}

// ---------------------------------------------------------------------------
// High-performance in-memory caching
// ---------------------------------------------------------------------------
// The addon is intentionally stateless: no DB/Redis is needed.  Caches are
// per Xtream account and use stale-while-revalidate so an expired entry can
// still be served immediately while a single background refresh runs.
//
// TTLs are deliberately different:
//   categories      6h fresh / 24h stale
//   catalog lists   20m fresh / 2h stale
//   series info      10m fresh / 1h stale (keeps new episodes reasonably fresh)
//   movie info       6h fresh / 24h stale
//
// Full VOD/series/live lists are only cached when needed (global search or
// a fallback). Normal category browsing uses category-specific snapshots,
// which dramatically reduces RAM for large providers.

const TTL = Object.freeze({
    categories: 6 * 60 * 60 * 1000,
    catalog: LIST_CACHE_TTL_MS,
    seriesInfo: 10 * 60 * 1000,
    movieInfo: 6 * 60 * 60 * 1000
});

const STALE = Object.freeze({
    categories: 24 * 60 * 60 * 1000,
    catalog: 2 * 60 * 60 * 1000,
    seriesInfo: 60 * 60 * 1000,
    movieInfo: 24 * 60 * 60 * 1000
});

const MAX_ACCOUNTS = Math.max(1, Number(process.env.CACHE_MAX_ACCOUNTS) || 2);
const MAX_METADATA = Math.max(32, Number(process.env.CACHE_MAX_METADATA) || 128);

function accountCacheKey(cfg) {
    return `${cfg.serverUrl}\n${cfg.username}\n${cfg.password}`;
}

class AsyncCache {
    constructor(ttl, stale, maxEntries = Infinity, shouldCache = () => true) {
        this.ttl = ttl;
        this.stale = stale;
        this.maxEntries = maxEntries;
        this.shouldCache = shouldCache;
        this.map = new Map();
        this.inflight = new Map();
    }

    getEntry(key) {
        const entry = this.map.get(key);
        if (!entry) return null;
        // Map insertion order becomes LRU order.
        this.map.delete(key);
        this.map.set(key, entry);
        return entry;
    }

    getFresh(key) {
        const entry = this.getEntry(key);
        if (!entry) return null;
        const age = Date.now() - entry.ts;
        return age < this.ttl ? entry.data : null;
    }

    async get(key, loader) {
        const now = Date.now();
        const entry = this.getEntry(key);

        if (entry) {
            entry.loader = loader;
            const age = now - entry.ts;
            if (age < this.ttl) return entry.data;

            // Stale-while-revalidate: never make the user wait for a normal
            // refresh. Only one refresh is allowed for each cache key.
            if (age < this.stale) {
                this.refresh(key, loader).catch(() => {});
                return entry.data;
            }
        }

        return this.refresh(key, loader);
    }

    refresh(key, loader) {
        const running = this.inflight.get(key);
        if (running) return running;

        const promise = Promise.resolve()
            .then(loader)
            .then(data => {
                if (!this.shouldCache(data)) return data;

                this.map.delete(key);
                this.map.set(key, { data, ts: Date.now(), loader });

                while (this.map.size > this.maxEntries) {
                    this.map.delete(this.map.keys().next().value);
                }
                return data;
            })
            .finally(() => this.inflight.delete(key));

        this.inflight.set(key, promise);
        return promise;
    }

    refreshAll(concurrency = Infinity) {
        const entries = [...this.map.entries()].filter(([, entry]) => entry.loader);
        if (!entries.length) return Promise.resolve();

        let next = 0;
        const worker = async () => {
            while (next < entries.length) {
                const [key, entry] = entries[next++];
                if (this.map.get(key) !== entry) continue;
                await this.refresh(key, entry.loader).catch(() => {});
            }
        };

        const workers = concurrency === Infinity
            ? entries.length
            : Math.max(1, Math.min(entries.length, concurrency));
        return Promise.all(Array.from({ length: workers }, worker));
    }

    delete(key) {
        this.map.delete(key);
    }

    clear() {
        this.map.clear();
        this.inflight.clear();
    }

    sweep() {
        const cutoff = Date.now() - this.stale;
        for (const [key, entry] of this.map) {
            if (entry.ts < cutoff) this.map.delete(key);
        }
    }
}

class Semaphore {
    constructor(limit) {
        this.limit = limit;
        this.active = 0;
        this.queue = [];
    }

    async run(task) {
        if (this.active >= this.limit) {
            await new Promise(resolve => this.queue.push(resolve));
        }

        this.active++;
        try {
            return await task();
        } finally {
            this.active--;
            this.queue.shift()?.();
        }
    }
}

const hasListItems = data => Array.isArray(data) && data.length > 0;

const catCache = new AsyncCache(
    TTL.categories,
    STALE.categories,
    MAX_ACCOUNTS,
    data => data?.complete !== false
);
// A previously successful full snapshot remains usable after long idle
// periods. The next request gets it immediately while refreshing in the
// background, avoiding a cold search after the normal stale window.
const liveStreamsCache = new AsyncCache(TTL.catalog, FULL_LIST_STALE_MS, MAX_ACCOUNTS, hasListItems);
const vodStreamsCache = new AsyncCache(TTL.catalog, FULL_LIST_STALE_MS, MAX_ACCOUNTS, hasListItems);
const seriesStreamsCache = new AsyncCache(TTL.catalog, FULL_LIST_STALE_MS, MAX_ACCOUNTS, hasListItems);

// Category-specific caches are the main RAM optimization for large providers.
const liveCategoryCache = new AsyncCache(TTL.catalog, STALE.catalog, MAX_ACCOUNTS * 64);
const vodCategoryCache = new AsyncCache(TTL.catalog, STALE.catalog, MAX_ACCOUNTS * 256);
const seriesCategoryCache = new AsyncCache(TTL.catalog, STALE.catalog, MAX_ACCOUNTS * 256);
const streamListSemaphore = new Semaphore(LIST_CONCURRENCY);

const seriesInfoCache = new AsyncCache(
    TTL.seriesInfo,
    STALE.seriesInfo,
    MAX_METADATA,
    isUsableSeriesInfo
);
const movieInfoCache = new AsyncCache(
    TTL.movieInfo,
    STALE.movieInfo,
    MAX_METADATA,
    isUsableMovieInfo
);

// Refresh only caches that have already been used. This keeps the service
// stateless and avoids downloading every provider's catalog unnecessarily.
const backgroundRefreshTimer = setInterval(() => {
    liveStreamsCache.refreshAll();
    vodStreamsCache.refreshAll();
    seriesStreamsCache.refreshAll();
}, BACKGROUND_REFRESH_MS);
backgroundRefreshTimer.unref();

const categoryRefreshTimer = setInterval(() => {
    catCache.refreshAll();
}, CATEGORY_REFRESH_MS);
categoryRefreshTimer.unref();

const seriesInfoRefreshTimer = setInterval(() => {
    // Series metadata is refreshed one at a time so a large watch history
    // cannot create a burst of provider requests or JSON allocations.
    seriesInfoCache.refreshAll(1);
}, SERIES_INFO_REFRESH_MS);
seriesInfoRefreshTimer.unref();

async function getCategories(cfg) {
    const key = accountCacheKey(cfg);
    return catCache.get(key, async () => {
        const results = await Promise.allSettled([
            xtremioGet(cfg, 'get_live_categories', '', { timeoutMs: CATEGORY_TIMEOUT_MS }),
            xtremioGet(cfg, 'get_vod_categories', '', { timeoutMs: CATEGORY_TIMEOUT_MS }),
            xtremioGet(cfg, 'get_series_categories', '', { timeoutMs: CATEGORY_TIMEOUT_MS })
        ]);

        const pick = r => (r.status === 'fulfilled' && Array.isArray(r.value)) ? r.value : [];

        results.forEach((r, i) => {
            if (r.status === 'rejected') {
                console.error(`[getCategories] source ${i} failed:`, r.reason?.message || r.reason);
            }
        });

        return {
            live: pick(results[0]),
            movies: pick(results[1]),
            series: pick(results[2]),
            complete: results.every(r => r.status === 'fulfilled' && Array.isArray(r.value))
        };
    });
}

async function getAllVodStreams(cfg) {
    return vodStreamsCache.get(accountCacheKey(cfg), async () =>
        getStreams(cfg, 'get_vod_streams', '', 'movie'));
}

async function getAllSeriesStreams(cfg) {
    return seriesStreamsCache.get(accountCacheKey(cfg), async () =>
        getStreams(cfg, 'get_series', '', 'series'));
}

async function getAllLiveStreams(cfg) {
    return liveStreamsCache.get(accountCacheKey(cfg), async () =>
        getStreams(cfg, 'get_live_streams', '', 'live'));
}

async function getCategoryStreams(cfg, kind, categoryId) {
    const id = String(categoryId);
    const key = `${accountCacheKey(cfg)}\n${id}`;

    let cache, action;
    if (kind === 'live') {
        cache = liveCategoryCache;
        action = 'get_live_streams';
    } else if (kind === 'movie') {
        cache = vodCategoryCache;
        action = 'get_vod_streams';
    } else {
        cache = seriesCategoryCache;
        action = 'get_series';
    }

    return cache.get(key, async () =>
        getStreams(cfg, action, `&category_id=${encodeURIComponent(id)}`, kind));
}

function filterCategoryItems(items, categoryId, categoryName) {
    // Some providers omit category fields when the API is already scoped to
    // one category. In that case, preserve the provider's scoped response.
    const hasCategoryFields = items.some(item => item.category_id || item.category_name);
    if (!hasCategoryFields) return items;

    const id = String(categoryId);
    const name = String(categoryName || '').toLowerCase();
    const matches = item => {
        if (item.category_id) return item.category_id === id;
        return Boolean(name) && item.category_name.toLowerCase() === name;
    };

    // Keep the cached array when the provider already returned the requested
    // category. This avoids an allocation on every paginated request.
    if (!items.some(item => !matches(item))) return items;
    return items.filter(matches);
}

const sortedCatalogCache = new WeakMap();
const MAX_SORT_CACHE_ITEMS = 5000;

function sortCatalogItems(items, sort, idField) {
    if (!sort) return items;

    const daySeed = sort === 'featured' ? Math.floor(Date.now() / 86400000) : 0;
    const cacheKey = `${sort}:${daySeed}`;
    const cached = sortedCatalogCache.get(items);
    if (cached?.key === cacheKey) return cached.items;

    const sorted = [...items].sort((a, b) => {
        if (sort === 'new') return b.added - a.added;
        if (sort === 'popular') return b.rating - a.rating;

        const ha = ((Number.parseInt(a[idField], 10) || 0) * 2654435761 + daySeed) & 0x7fffffff;
        const hb = ((Number.parseInt(b[idField], 10) || 0) * 2654435761 + daySeed) & 0x7fffffff;
        return ha - hb;
    });

    // Keep one derived order per category. Large categories are deliberately
    // not retained twice, so sorting cannot become a memory spike.
    if (items.length <= MAX_SORT_CACHE_ITEMS) {
        sortedCatalogCache.set(items, { key: cacheKey, items: sorted });
    }
    return sorted;
}

// Periodically remove old snapshots without requiring a request to trigger GC.
// Unref means this timer never keeps the process alive.
const sweepTimer = setInterval(() => {
    catCache.sweep();
    liveStreamsCache.sweep();
    vodStreamsCache.sweep();
    seriesStreamsCache.sweep();
    liveCategoryCache.sweep();
    vodCategoryCache.sweep();
    seriesCategoryCache.sweep();
    seriesInfoCache.sweep();
    movieInfoCache.sweep();
}, 15 * 60 * 1000);
sweepTimer.unref();

function parseExtra(extra) {
    const params = Object.create(null);
    if (!extra) return params;
    const raw = String(extra);
    // Stremio's ktor-client can send genres like "24/7 ACTION & ADVENTURE VIP"
    // without encoding "/" and "&". The "&" would be mistaken for a param
    // separator by URLSearchParams, so handle continuations manually.
    const parts = raw.split('&');
    let currentKey = null;
    for (const part of parts) {
        if (!part) continue;
        const eq = part.indexOf('=');
        if (eq !== -1) {
            const k = part.slice(0, eq);
            const v = part.slice(eq + 1);
            try {
                const dk = decodeURIComponent(k.replace(/\+/g, ' '));
                const dv = decodeURIComponent(v.replace(/\+/g, ' '));
                params[dk] = dv;
                currentKey = dk;
            } catch {
                params[k] = v;
                currentKey = k;
            }
        } else if (currentKey) {
            try {
                params[currentKey] += '&' + decodeURIComponent(part.replace(/\+/g, ' '));
            } catch {
                params[currentKey] += '&' + part;
            }
        }
    }
    if (Object.keys(params).length === 0) {
        try {
            for (const [k, v] of new URLSearchParams(raw)) params[k] = v;
        } catch {}
    }
    return params;
}

const PAGE_SIZE = 100;

// Catalog responses contain many provider-specific fields that are never
// returned to Stremio. Keep only the fields needed for filtering, sorting,
// catalog pages, and live metadata lookups.
function compactStream(item, kind) {
    item = item && typeof item === 'object' ? item : {};
    const categoryId = item.category_id == null ? '' : String(item.category_id);
    const categoryName = item.category_name == null ? '' : String(item.category_name);
    const id = item.stream_id == null ? '' : String(item.stream_id);

    if (kind === 'live') {
        return {
            stream_id: id,
            name: String(item.name || ''),
            stream_icon: item.stream_icon || '',
            category_id: categoryId,
            category_name: categoryName
        };
    }

    if (kind === 'movie') {
        return {
            stream_id: id,
            name: String(item.name || ''),
            stream_icon: item.stream_icon || '',
            category_id: categoryId,
            category_name: categoryName,
            rating: Number.parseFloat(item.rating) || 0,
            added: Number.parseInt(item.added, 10) || 0
        };
    }

    return {
        series_id: item.series_id == null ? '' : String(item.series_id),
        name: String(item.name || ''),
        cover: item.cover || '',
        category_id: categoryId,
        category_name: categoryName,
        rating: Number.parseFloat(item.rating) || 0,
        added: Number.parseInt(item.last_modified, 10) || 0
    };
}

async function getStreams(cfg, action, catParam = '', kind) {
    return streamListSemaphore.run(async () => {
        const data = await xtremioGet(cfg, action, catParam, { timeoutMs: LIST_TIMEOUT_MS });
        return Array.isArray(data) ? data.map(item => compactStream(item, kind)) : [];
    });
}

function parseYear(s) {
    if (!s) return undefined;
    const m = String(s).match(/\d{4}/);
    return m ? parseInt(m[0]) : undefined;
}

const SERIES_INFO_MAX_ATTEMPTS = 3;
const SERIES_INFO_BACKOFF_MS = 350;

function isUsableSeriesInfo(info) {
    if (!info || typeof info !== 'object') return false;
    const hasInfo = info.info && typeof info.info === 'object'
        && (info.info.name || info.info.plot || info.info.genre || info.info.cover);
    const eps = info.episodes;
    const hasEpisodes = eps && typeof eps === 'object' && Object.keys(eps).length > 0;
    return Boolean(hasInfo || hasEpisodes);
}

function isUsableMovieInfo(info) {
    if (!info || typeof info !== 'object') return false;
    const movie = info.info && typeof info.info === 'object' ? info.info : info;
    return Boolean(
        info.movie_data ||
        movie.name ||
        movie.cover_big ||
        movie.movie_image ||
        movie.plot ||
        movie.releasedate
    );
}

async function getSeriesInfo(cfg, seriesId) {
    const key = `${accountCacheKey(cfg)}\n${seriesId}`;

    return seriesInfoCache.get(key, async () => {
        let lastInfo = null;
        let lastError = null;

        for (let attempt = 1; attempt <= SERIES_INFO_MAX_ATTEMPTS; attempt++) {
            try {
                const info = await xtremioGet(
                    cfg,
                    'get_series_info',
                    `&series_id=${encodeURIComponent(seriesId)}`,
                    { timeoutMs: 8000 }
                );

                if (isUsableSeriesInfo(info)) return info;
                lastInfo = info;
            } catch (e) {
                lastError = e;
            }

            if (attempt < SERIES_INFO_MAX_ATTEMPTS) {
                await new Promise(r => setTimeout(r, SERIES_INFO_BACKOFF_MS * attempt));
            }
        }

        if (lastInfo !== null) return lastInfo;
        throw lastError || new Error(`get_series_info failed for series ${seriesId}`);
    });
}

async function getMovieInfo(cfg, movieId) {
    const key = `${accountCacheKey(cfg)}\n${movieId}`;
    return movieInfoCache.get(key, () =>
        xtremioGet(cfg, 'get_vod_info', `&vod_id=${encodeURIComponent(movieId)}`));
}

async function validateXtremioCredentials(serverUrl, username, password) {
    const base = normalizeUrl(serverUrl);
    const path = `/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
    const urls = [base, base.replace(/^https?/, m => m === 'https' ? 'http' : 'https')];

    for (const url of urls) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        try {
            const res = await fetch(url + path, { signal: controller.signal, redirect: 'follow' });
            const json = await res.json();

            if (!json.user_info) return { valid: false, error: 'Not a valid xTremio server' };
            if (json.user_info.auth !== 1) return { valid: false, error: 'Invalid username or password' };
            if (json.user_info.status !== 'Active') return { valid: false, error: `Account is ${json.user_info.status || 'inactive'}` };

            const expDate = parseInt(json.user_info.exp_date, 10);
            if (expDate && expDate < Math.floor(Date.now() / 1000)) {
                return { valid: false, error: 'Account has expired' };
            }

            let resolvedUrl;
            const si = json.server_info;
            if (si && si.url) {
                const proto = si.server_protocol || 'http';
                const port = (proto === 'https' ? si.https_port : si.port) || si.port;
                resolvedUrl = port ? `${proto}://${si.url}:${port}` : `${proto}://${si.url}`;
            }

            return {
                valid: true,
                userInfo: json.user_info,
                resolvedUrl: resolvedUrl || url
            };
        } catch (e) {
            if (url === urls[0] && urls.length > 1) continue;
            const msg = e.name === 'AbortError' ? 'Connection timed out'
                : e.cause?.code === 'ECONNREFUSED' ? 'Connection refused — check server URL and port'
                    : e.cause?.code === 'ENOTFOUND' ? 'Server not found — check the URL'
                        : e.cause?.code === 'ECONNRESET' ? 'Connection reset by server'
                            : e.message || 'Cannot connect to server';
            return { valid: false, error: msg };
        } finally {
            clearTimeout(timer);
        }
    }
    return { valid: false, error: 'Cannot connect to server' };
}

function renderConfigPage({ serverUrl = '', username = '', password = '', status = null, baseUrl = `http://localhost:${PORT}`, settings = DEFAULT_SETTINGS }) {
    const currentSettings = getSettings(settings);
    const safeAddonName = escapeHtml(currentSettings.addonName);
    const safeServerUrl = escapeHtml(serverUrl);
    const safeUsername = escapeHtml(username);
    const safePassword = escapeHtml(password);
    const safeLiveCategoryName = escapeHtml(currentSettings.liveCategoryName);
    const safeMoviesCategoryName = escapeHtml(currentSettings.moviesCategoryName);
    const safeSeriesCategoryName = escapeHtml(currentSettings.seriesCategoryName);
    const liveSearchChecked = currentSettings.enableLiveSearch ? ' checked' : '';
    let statusHtml = '';
    if (status) {
        if (status.valid) {
            const encoded = encodeConfig({ serverUrl, username, password }, currentSettings);
            const installUrl = `stremio://${baseUrl.replace(/^https?:\/\//, '')}/${encoded}/manifest.json`;
            const httpUrl = `${baseUrl}/${encoded}/manifest.json`;
            const safeInstallUrl = escapeHtml(installUrl);
            const safeHttpUrl = escapeHtml(httpUrl);
            statusHtml = `
                <div class="status-section">
                    <div class="status-banner status-success">
                        <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"/></svg>
                        <span class="status-text">Connected! Welcome, ${escapeHtml(status.userInfo.username || username)}</span>
                    </div>
                    <a href="${safeInstallUrl}" class="btn full install-link">
                        <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
                        Install in Stremio
                    </a>
                    <div style="margin-top: 16px;">
                        <p style="font-size: 13px; color: #555; margin-bottom: 8px; font-weight: 600; text-align: left;">Or copy this link to install:</p>
                        <input type="text" value="${safeHttpUrl}" readonly onclick="this.select(); document.execCommand('copy'); const p = this.previousElementSibling; const orig = p.innerText; p.innerText = '✓ Copied to clipboard!'; p.style.color = '#2e7d32'; setTimeout(() => { p.innerText = orig; p.style.color = '#555'; }, 2000);" style="width: 100%; padding: 12px; border: 2px solid #e0e0e0; border-radius: 10px; font-size: 14px; color: #333; background: #f9f9f9; cursor: pointer; text-align: center; transition: border-color 0.2s;" title="Click to copy install link" onmouseover="this.style.borderColor='#7c4dff'" onmouseout="this.style.borderColor='#e0e0e0'" />
                    </div>
                </div>`;
        } else {
            statusHtml = `
                <div class="status-section">
                    <div class="status-banner status-error">
                        <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M6 18L18 6M6 6l12 12"/></svg>
                        <span class="status-text">${escapeHtml(status.error)}</span>
                    </div>
                </div>`;
        }
    }

    return `<!DOCTYPE html>
    <html><head>
        <title>${safeAddonName} Configuration</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
            * { box-sizing: border-box; margin: 0; padding: 0; }
            body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
                min-height: 100vh; display: flex; align-items: center; justify-content: center;
                background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
                padding: 20px;
            }
            .card {
                background: #fff; border-radius: 16px;
                box-shadow: 0 20px 60px rgba(0,0,0,0.3);
                max-width: 420px; width: 100%; overflow: hidden;
            }
            .header {
                background: linear-gradient(135deg, #7c4dff 0%, #5c6bc0 100%);
                padding: 30px; text-align: center;
            }
            .header h1 { color: #fff; font-size: 24px; font-weight: 600; }
            .header p { color: rgba(255,255,255,0.8); font-size: 14px; margin-top: 8px; }
            .btn {
                display: inline-flex; align-items: center; gap: 10px;
                padding: 14px 32px;
                background: linear-gradient(135deg, #7c4dff 0%, #5c6bc0 100%);
                color: #fff; text-decoration: none; border: none;
                border-radius: 10px; font-size: 16px; font-weight: 600; cursor: pointer;
                transition: transform 0.2s, box-shadow 0.2s;
            }
            .btn:hover { transform: translateY(-2px); box-shadow: 0 8px 25px rgba(124,77,255,0.4); }
            .btn:active { transform: translateY(0); }
            .btn svg { width: 20px; height: 20px; }
            .form-container { padding: 30px; }
            .input-group { margin-bottom: 20px; }
            .input-group label { display: block; font-size: 13px; font-weight: 600; color: #333; margin-bottom: 8px; }
            .input-wrapper { position: relative; }
            .input-wrapper svg { position: absolute; left: 14px; top: 50%; transform: translateY(-50%); width: 18px; height: 18px; color: #999; }
            .input-wrapper input { width: 100%; padding: 14px 14px 14px 44px; border: 2px solid #e0e0e0; border-radius: 10px; font-size: 15px; transition: border-color 0.2s, box-shadow 0.2s; }
            .input-wrapper input:focus { outline: none; border-color: #7c4dff; box-shadow: 0 0 0 3px rgba(124,77,255,0.1); }
            .input-wrapper input::placeholder { color: #aaa; }
             .btn.full { width: 100%; justify-content: center; }
             .customization { border-top: 1px solid #eee; margin-top: 8px; padding-top: 20px; }
             .customization h2 { color: #333; font-size: 15px; margin-bottom: 14px; }
             .customization .input-group { margin-bottom: 14px; }
             .customization input[type="text"] { width: 100%; padding: 11px 12px; border: 2px solid #e0e0e0; border-radius: 8px; font-size: 14px; }
             .customization input[type="text"]:focus { outline: none; border-color: #7c4dff; }
             .checkbox-label { display: flex; align-items: center; gap: 9px; color: #444; font-size: 13px; cursor: pointer; }
             .checkbox-label input { width: 16px; height: 16px; accent-color: #7c4dff; }
             .status-section { padding: 0 30px 30px; text-align: center; }
            .status-banner { padding: 16px; border-radius: 10px; display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
            .status-banner svg { width: 22px; height: 22px; flex-shrink: 0; }
            .status-banner .status-text { font-size: 14px; font-weight: 500; text-align: left; }
            .status-success { background: #e8f5e9; color: #2e7d32; }
            .status-error { background: #ffebee; color: #c62828; }
            .install-link { margin-top: 4px; }
            .disclaimer {
                background: #fff8e1;
                border: 1px solid #ffe082;
                color: #5d4037;
                border-radius: 10px;
                padding: 12px 14px;
                font-size: 12px;
                line-height: 1.5;
                margin-bottom: 22px;
            }
            .disclaimer strong { color: #ef6c00; display: block; margin-bottom: 4px; font-size: 13px; }
            .disclaimer ul { margin: 6px 0 0 18px; padding: 0; }
            .disclaimer li { margin-bottom: 3px; }
        </style>
    </head><body>
        <div class="card">
            <div class="header">
                <h1>${safeAddonName} Addon</h1>
                <p>Configure your credentials</p>
            </div>
            <div class="form-container">
                <div class="disclaimer">
                    <strong>⚠ Disclaimer</strong>
                    This addon is a technical gateway only. It does <b>not</b> host, store, or provide any media content.
                    <ul>
                        <li>You must have a valid, legally obtained Xtream Codes account.</li>
                        <li>You are solely responsible for the content accessed through your provider.</li>
                        <li>Credentials are encoded into your install URL &mdash; keep it private, do not share it.</li>
                    </ul>
                </div>
                <form method="POST">
                    <div class="input-group">
                        <label>Server URL</label>
                        <div class="input-wrapper">
                            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9"/></svg>
                            <input type="url" name="serverUrl" value="${safeServerUrl}" placeholder="http://example.com:port" required />
                        </div>
                    </div>
                    <div class="input-group">
                        <label>Username</label>
                        <div class="input-wrapper">
                            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/></svg>
                            <input type="text" name="username" value="${safeUsername}" placeholder="Enter username" required />
                        </div>
                    </div>
                     <div class="input-group">
                         <label>Password</label>
                        <div class="input-wrapper">
                            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/></svg>
                            <input type="password" name="password" value="${safePassword}" placeholder="Enter password" required />
                         </div>
                     </div>
                     <div class="customization">
                         <h2>Customize this addon</h2>
                         <div class="input-group">
                             <label>Addon name</label>
                             <input type="text" name="addonName" value="${escapeHtml(currentSettings.addonName)}" maxlength="80" placeholder="xTremio" />
                         </div>
                         <div class="input-group">
                             <label>Live TV category name</label>
                             <input type="text" name="liveCategoryName" value="${safeLiveCategoryName}" maxlength="80" placeholder="Live TV" />
                         </div>
                         <div class="input-group">
                             <label>Movies category name</label>
                             <input type="text" name="moviesCategoryName" value="${safeMoviesCategoryName}" maxlength="80" placeholder="XT-Movies" />
                         </div>
                         <div class="input-group">
                             <label>Series category name</label>
                             <input type="text" name="seriesCategoryName" value="${safeSeriesCategoryName}" maxlength="80" placeholder="XT-Series" />
                         </div>
                         <label class="checkbox-label">
                             <input type="checkbox" name="enableLiveSearch" value="true"${liveSearchChecked} />
                             Include Live TV in global search
                         </label>
                     </div>
                     <button type="submit" class="btn full">Save & Install</button>
                </form>
            </div>
            ${statusHtml}
        </div>
    </body></html>`;
}

app.get('/configure', (req, res) => {
    const existing = decodeConfig(req.query.config) || {};
    res.send(renderConfigPage({
        serverUrl: req.query.serverUrl || existing.serverUrl || '',
        username: req.query.username || existing.username || '',
        password: req.query.password || existing.password || '',
        settings: getSettings(existing),
        baseUrl: getBaseUrl(req)
    }));
});

app.post('/configure', async (req, res) => {
    const rawServerUrl = (req.body.serverUrl || '').trim().replace(/\/+$/, '');
    const username = req.body.username || '';
    const password = req.body.password || '';
    const settings = settingsFromForm(req.body);

    try {
        const validation = await validateXtremioCredentials(rawServerUrl, username, password);
        const finalServerUrl = validation.valid
            ? (validation.resolvedUrl || normalizeUrl(rawServerUrl))
            : rawServerUrl;

        res.send(renderConfigPage({
            serverUrl: finalServerUrl,
            username,
            password,
            settings,
            status: validation,
            baseUrl: getBaseUrl(req)
        }));
    } catch (e) {
        res.send(renderConfigPage({
            serverUrl: rawServerUrl,
            username,
            password,
            settings,
            status: { valid: false, error: 'Something went wrong. Please try again.' },
            baseUrl: getBaseUrl(req)
        }));
    }
});

app.get(['/:config/catalog/:type/:id.json', '/:config/catalog/:type/:id/:extra.json'], async (req, res) => {
    const cfg = decodeConfig(req.params.config);
    if (!cfg) return res.json({ metas: [] });
    const settings = getSettings(cfg);

    const { id } = req.params;
    const extra = parseExtra(req.params.extra);
    const skip = Math.max(0, Number.parseInt(extra.skip, 10) || 0);
    const genre = extra.genre;

    try {
        if (id === 'xtremio_live') {
            const cats = await getCategories(cfg);
            const selectedGenre = genre || safeGenreName(cats.live[0] && cats.live[0].category_name);
            const cat = matchSafeCategory(cats.live, selectedGenre);
            const categoryId = cat && cat.category_id;

            // No genre selected and none resolvable -> nothing to show.
            if (!categoryId) return res.json({ metas: [] });

            // Fetch only the selected category. This avoids retaining the entire
            // live-TV library in RAM just to render one page.
            let items = await getCategoryStreams(cfg, 'live', categoryId);
            items = filterCategoryItems(items, categoryId, cat.category_name);

            if (extra.search) {
                const q = extra.search.toLowerCase();
                items = items.filter(s => s.name?.toLowerCase().includes(q));
            }

            const page = items.slice(skip, skip + PAGE_SIZE);
            const metas = page.map(s => ({
                id: `xtremio_live_${s.stream_id}`,
                type: settings.liveCategoryName,
                name: s.name,
                poster: s.stream_icon || undefined,
                posterShape: 'square'
            }));

            return res.json({ metas, cacheMaxAge: 300, staleRevalidate: 600 });
        }

        if (id.startsWith('xtremio_movies_')) {
            const cats = await getCategories(cfg);
            const selectedGenre = genre || safeGenreName(cats.movies[0] && cats.movies[0].category_name);
            const cat = matchSafeCategory(cats.movies, selectedGenre);
            if (!cat) return res.json({ metas: [] });

            // Category browsing uses a small per-category snapshot. The full
            // library is fetched only when global search actually needs it.
            let items = await getCategoryStreams(cfg, 'movie', cat.category_id);
            items = filterCategoryItems(items, cat.category_id, cat.category_name);

            if (extra.search) {
                const q = extra.search.toLowerCase();
                items = items.filter(s => s.name?.toLowerCase().includes(q));
            }

            const sort = id === 'xtremio_movies_new' ? 'new'
                : id === 'xtremio_movies_popular' ? 'popular'
                    : 'featured';
            items = sortCatalogItems(items, sort, 'stream_id');

            const page = items.slice(skip, skip + PAGE_SIZE);
            const metas = page.map(s => ({
                id: `xtremio_movie_${s.stream_id}`,
                type: settings.moviesCategoryName,
                name: s.name,
                poster: s.stream_icon || undefined,
                posterShape: 'poster'
            }));

            return res.json({ metas, cacheMaxAge: 300, staleRevalidate: 600 });
        }

        if (id.startsWith('xtremio_series_')) {
            const cats = await getCategories(cfg);
            const selectedGenre = genre || safeGenreName(cats.series[0] && cats.series[0].category_name);
            const cat = matchSafeCategory(cats.series, selectedGenre);
            if (!cat) return res.json({ metas: [] });

            // Category browsing uses a small per-category snapshot. The full
            // library is fetched only when global search actually needs it.
            let items = await getCategoryStreams(cfg, 'series', cat.category_id);
            items = filterCategoryItems(items, cat.category_id, cat.category_name);

            if (extra.search) {
                const q = extra.search.toLowerCase();
                items = items.filter(s => s.name?.toLowerCase().includes(q));
            }

            const sort = id === 'xtremio_series_new' ? 'new'
                : id === 'xtremio_series_popular' ? 'popular'
                    : 'featured';
            items = sortCatalogItems(items, sort, 'series_id');

            const page = items.slice(skip, skip + PAGE_SIZE);
            const metas = page.map(s => ({
                id: `xtremio_series_${s.series_id}`,
                type: 'series',
                name: s.name,
                poster: s.cover || undefined,
                posterShape: 'poster'
            }));

            return res.json({ metas, cacheMaxAge: 300, staleRevalidate: 600 });
        }

        // Global search catalogs - fetch all streams once, filter in memory
        if (id === 'xtremio_search_live' && extra.search) {
            const q = extra.search.toLowerCase();
            const allLive = await getAllLiveStreams(cfg);
            const filtered = allLive.filter(s => s.name?.toLowerCase().includes(q));
            const page = filtered.slice(skip, skip + PAGE_SIZE);
            const metas = page.map(s => ({
                id: `xtremio_live_${s.stream_id}`,
                type: settings.liveCategoryName,
                name: s.name,
                poster: s.stream_icon || undefined,
                posterShape: 'square'
            }));
            return res.json({ metas, cacheMaxAge: 300, staleRevalidate: 600 });
        }

        if (id === 'xtremio_search_movies' && extra.search) {
            const q = extra.search.toLowerCase();
            const allMovies = await getAllVodStreams(cfg);
            const filtered = allMovies.filter(s => s.name?.toLowerCase().includes(q));
            const page = filtered.slice(skip, skip + PAGE_SIZE);
            const metas = page.map(s => ({
                id: `xtremio_movie_${s.stream_id}`,
                type: settings.moviesCategoryName,
                name: s.name,
                poster: s.stream_icon || undefined,
                posterShape: 'poster'
            }));
            return res.json({ metas, cacheMaxAge: 300, staleRevalidate: 600 });
        }

        if (id === 'xtremio_search_series' && extra.search) {
            const q = extra.search.toLowerCase();
            const allSeries = await getAllSeriesStreams(cfg);
            const filtered = allSeries.filter(s => s.name?.toLowerCase().includes(q));
            const page = filtered.slice(skip, skip + PAGE_SIZE);
            const metas = page.map(s => ({
                id: `xtremio_series_${s.series_id}`,
                type: 'series',
                name: s.name,
                poster: s.cover || undefined,
                posterShape: 'poster'
            }));
            return res.json({ metas, cacheMaxAge: 300, staleRevalidate: 600 });
        }

        res.json({ metas: [] });
    } catch (e) {
        console.error('[catalog] Error:', e.message);
        res.json({ metas: [] });
    }
});

app.get('/:config/meta/:type/:id.json', async (req, res) => {
    const cfg = decodeConfig(req.params.config);
    if (!cfg) return res.json({ meta: null });
    const settings = getSettings(cfg);
    const { id, type } = req.params;

    try {
        if (id.startsWith('xtremio_live_')) {
            const streamId = id.replace('xtremio_live_', '');
            const allLive = await getAllLiveStreams(cfg);
            let s = allLive.find(i => String(i.stream_id) === streamId);

            if (!s) return res.json({ meta: null });
            const meta = {
                id: `xtremio_live_${s.stream_id}`,
                type: settings.liveCategoryName,
                name: s.name,
                poster: s.stream_icon || undefined,
                posterShape: 'square',
                genres: s.category_name ? [s.category_name] : [],
                description: s.name || undefined
            };
            return res.json({ meta, cacheMaxAge: 300 });
        }

        if (id.startsWith('xtremio_movie_')) {
            const streamId = id.replace('xtremio_movie_', '');
            const info = await getMovieInfo(cfg, streamId);
            const movie = info?.info ?? info ?? {};
            const cast = splitList(movie.cast);
            const backdrop = pickBackdrop(movie.backdrop_path);

            const meta = {
                id: `xtremio_movie_${streamId}`,
                type: settings.moviesCategoryName,
                name: movie.name || movie.o_name || 'Unknown',
                poster: movie.cover_big || movie.movie_image || undefined,
                posterShape: 'poster',
                background: backdrop,
                description: movie.plot || movie.description || undefined,
                releaseInfo: movie.releasedate ? String(movie.releasedate) : undefined,
                genres: splitList(movie.genre),
                runtime: movie.duration ? String(movie.duration) + ' min' : (movie.episode_run_time ? String(movie.episode_run_time) + ' min' : undefined),
                director: movie.director || undefined,
                cast,
                imdbRating: movie.rating ? String(movie.rating) : undefined,
                year: parseYear(movie.releasedate),
                country: movie.country || undefined,
                trailer: movie.youtube_trailer || undefined
            };
            return res.json({ meta, cacheMaxAge: 21600, staleRevalidate: 43200 });
        }

        if (id.startsWith('xtremio_series_')) {
            const seriesId = id.replace('xtremio_series_', '');
            let info = null;
            try {
                info = await getSeriesInfo(cfg, seriesId);
            } catch (e) {
                const causeMsg = e.cause ? ` (cause: ${e.cause.code || e.cause.message || e.cause})` : '';
                console.warn(`[meta] getSeriesInfo(${seriesId}) failed after retries: ${e.message}${causeMsg}`);
            }
            const series = info?.info ?? info ?? {};

            const videos = [];
            const episodes = info?.episodes ?? {};
            for (const [seasonNum, eps] of Object.entries(episodes)) {
                if (!Array.isArray(eps)) continue;
                for (const ep of eps) {
                    videos.push({
                        id: `xtremio_episode_${seriesId}:${seasonNum}:${ep.id}`,
                        title: ep.title || `Episode ${ep.episode_num}`,
                        season: parseInt(seasonNum),
                        episode: parseInt(ep.episode_num) || 1,
                        released: toIsoDate(ep.info?.releasedate) || '1970-01-01T00:00:00.000Z',
                        overview: ep.info?.plot || undefined,
                        thumbnail: ep.info?.movie_image || undefined
                    });
                }
            }

            const hasContent = Boolean(series.name || videos.length);
            if (!hasContent) {
                console.warn(`[meta] no usable data for series ${seriesId}`);
                return res.json({ meta: null });
            }

            const cast = splitList(series.cast);
            const backdrop = pickBackdrop(series.backdrop_path);

            const meta = {
                id: `xtremio_series_${seriesId}`,
                type: 'series',
                name: series.name || 'Unknown',
                poster: series.cover || undefined,
                posterShape: 'poster',
                background: backdrop,
                description: series.plot || undefined,
                releaseInfo: series.releaseDate ? String(series.releaseDate) : undefined,
                genres: splitList(series.genre),
                runtime: series.episode_run_time ? String(series.episode_run_time) + ' min' : undefined,
                director: series.director || undefined,
                cast,
                imdbRating: series.rating ? String(series.rating) : undefined,
                year: parseYear(series.releaseDate),
                videos
            };
            return res.json({ meta, cacheMaxAge: 600, staleRevalidate: 1200 });
        }

        res.json({ meta: null });
    } catch (e) {
        console.error('[meta] Error:', e.message);
        res.json({ meta: null });
    }
});

app.get('/:config/stream/:type/:id.json', async (req, res) => {
    const cfg = decodeConfig(req.params.config);
    if (!cfg) return res.json({ streams: [] });
    const { id, type } = req.params;

    try {
        const { username, password } = cfg;
        const serverUrl = normalizeUrl(cfg.serverUrl);
        const encodedUsername = encodeURIComponent(username);
        const encodedPassword = encodeURIComponent(password);

        // --- Handle xTremio's own IDs ---
        if (id.startsWith('xtremio_live_')) {
            const streamId = id.replace('xtremio_live_', '');
            return res.json({
                streams: [
                    { url: `${serverUrl}/live/${encodedUsername}/${encodedPassword}/${streamId}.m3u8`, title: 'HLS' },
                    { url: `${serverUrl}/live/${encodedUsername}/${encodedPassword}/${streamId}.ts`, title: 'MPEG-TS' }
                ],
                cacheMaxAge: 3600
            });
        }

        if (id.startsWith('xtremio_movie_')) {
            const streamId = id.replace('xtremio_movie_', '');
            const info = await getMovieInfo(cfg, streamId);
            const ext = info?.movie_data?.container_extension || 'mp4';
            const directUrl = `${serverUrl}/movie/${encodedUsername}/${encodedPassword}/${encodeURIComponent(streamId)}.${ext}`;
            return res.json({
                streams: [
                    {
                        url: directUrl,
                        title: '▶ Play',
                        behaviorHints: {
                            notWebReady: isNotWebReady(directUrl, ext),
                            bingeGroup: `xtremio-movie-${ext}`
                        }
                    }
                ]
            });
        }

        if (id.startsWith('xtremio_episode_')) {
            // Format: xtremio_episode_{seriesId}:{season}:{episodeId}
            const [seriesId, , episodeId] = id.replace('xtremio_episode_', '').split(':');

            const findExt = (data) => {
                const episodes = data?.episodes ?? {};
                for (const eps of Object.values(episodes)) {
                    if (!Array.isArray(eps)) continue;
                    const ep = eps.find(e => String(e.id) === episodeId);
                    if (ep) return ep.container_extension || 'mp4';
                }
                return null;
            };

            const info = await getSeriesInfo(cfg, seriesId);
            let ext = findExt(info);
            if (!ext) {
                console.warn(`[stream] episode ${episodeId} not found in series ${seriesId} info; defaulting to mp4`);
                ext = 'mp4';
            }

            const directUrl = `${serverUrl}/series/${encodedUsername}/${encodedPassword}/${encodeURIComponent(episodeId)}.${ext}`;
            return res.json({
                streams: [
                    {
                        url: directUrl,
                        title: '▶ Play',
                        behaviorHints: {
                            notWebReady: isNotWebReady(directUrl, ext),
                            bingeGroup: `xtremio-series-${seriesId}-${ext}`
                        }
                    }
                ]
            });
        }

        res.json({ streams: [] });
    } catch (e) {
        console.error('[stream] Error:', e.message);
        res.json({ streams: [] });
    }
});

// Legacy proxy URL — no byte relay, just redirect to the provider's
// direct stream. This keeps old cached stream responses (from before
// the proxy removal) working while ensuring the addon never proxies
// media bytes.
app.all('/:config/proxy/:kind/:file', (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        return res.status(405).end('method not allowed');
    }
    const cfg = decodeConfig(req.params.config);
    if (!cfg) return res.status(401).end('unauthorized');

    const { kind, file } = req.params;
    if (!['movie', 'series', 'live'].includes(kind)) {
        return res.status(400).end('bad kind');
    }
    const match = /^([^./]+)\.([A-Za-z0-9]+)$/.exec(file);
    if (!match) return res.status(400).end('bad file');
    const [, streamId, ext] = match;

    const serverUrl = normalizeUrl(cfg.serverUrl);
    const directUrl = `${serverUrl}/${kind}/${encodeURIComponent(cfg.username)}/${encodeURIComponent(cfg.password)}/${streamId}.${ext}`;
    return res.redirect(302, directUrl);
});

app.get('/', (req, res) => {
    const safeAddonName = escapeHtml(DEFAULT_SETTINGS.addonName);
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>${safeAddonName} &mdash; Stremio Addon</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="description" content="Stremio addon that exposes any Xtream Codes IPTV provider as Live TV, Movies and Series.">
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
            color: #fff;
            padding: 20px;
            text-align: center;
        }
        .wrap { max-width: 560px; width: 100%; }
        .logo {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 72px; height: 72px;
            background: linear-gradient(135deg, #7c4dff 0%, #5c6bc0 100%);
            border-radius: 20px;
            margin-bottom: 24px;
            box-shadow: 0 10px 30px rgba(124,77,255,0.4);
        }
        .logo svg { width: 38px; height: 38px; color: #fff; }
        h1 { font-size: 36px; font-weight: 700; margin-bottom: 12px; letter-spacing: -0.5px; }
        .tagline { font-size: 17px; color: rgba(255,255,255,0.75); margin-bottom: 36px; line-height: 1.5; }
        .features {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 12px;
            margin-bottom: 36px;
        }
        .feature {
            background: rgba(255,255,255,0.06);
            border: 1px solid rgba(255,255,255,0.1);
            border-radius: 12px;
            padding: 16px 10px;
            font-size: 13px;
            color: rgba(255,255,255,0.85);
        }
        .feature b { display: block; color: #fff; font-size: 14px; margin-bottom: 4px; }
        .btn {
            display: inline-flex; align-items: center; gap: 10px;
            padding: 16px 36px;
            background: linear-gradient(135deg, #7c4dff 0%, #5c6bc0 100%);
            color: #fff; text-decoration: none;
            border-radius: 12px;
            font-size: 16px; font-weight: 600;
            transition: transform 0.2s, box-shadow 0.2s;
            box-shadow: 0 8px 20px rgba(124,77,255,0.3);
        }
        .btn:hover { transform: translateY(-2px); box-shadow: 0 12px 30px rgba(124,77,255,0.5); }
        .btn svg { width: 20px; height: 20px; }
        .links {
            margin-top: 28px;
            font-size: 14px;
            color: rgba(255,255,255,0.6);
        }
        .links a {
            color: rgba(255,255,255,0.85);
            text-decoration: none;
            border-bottom: 1px solid rgba(255,255,255,0.3);
            padding-bottom: 1px;
        }
        .links a:hover { color: #fff; border-bottom-color: #fff; }
        .footer {
            margin-top: 40px;
            font-size: 12px;
            color: rgba(255,255,255,0.4);
            line-height: 1.6;
        }
        @media (max-width: 520px) {
            h1 { font-size: 28px; }
            .features { grid-template-columns: 1fr; }
        }
    </style>
</head>
<body>
    <div class="wrap">
        <div class="logo">
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>
        </div>
        <h1>${safeAddonName}</h1>
        <p class="tagline">A Stremio addon that turns your Xtream Codes IPTV provider into browseable Live TV, Movies, and Series catalogs.</p>

        <div class="features">
            <div class="feature"><b>Live TV</b>Watch your channels</div>
            <div class="feature"><b>Movies &amp; Series</b>Full VOD catalog</div>
            <div class="feature"><b>Global Search</b>Across everything</div>
        </div>

        <a href="/configure" class="btn">
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
            Install Addon
        </a>

        <div class="links">
            <a href="https://github.com/izemhsn/xTremio-stremio-addon" target="_blank" rel="noopener">View on GitHub</a>
        </div>

        <div class="footer">
            This is a self-hosted technical gateway. No media is hosted here.<br>
            You must supply your own legally obtained Xtream Codes account.
        </div>
    </div>
</body>
</html>`);
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
});

// Keep HTTP connections reusable without retaining them for too long.
const server = app.listen(PORT, HOST, () => {
    console.log(`Addon running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    console.log(`Configure: http://localhost:${PORT}/configure`);
});

server.keepAliveTimeout = 30000;
server.headersTimeout = 35000;
server.requestTimeout = 30000;

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} is already in use. Kill the existing process or use a different port: PORT=3001 npm start`);
    } else {
        console.error('Server error:', err.message);
    }
    process.exit(1);
});

process.on('SIGTERM', () => { console.log('SIGTERM received, shutting down...'); server.close(() => process.exit(0)); });
process.on('SIGINT', () => { console.log('SIGINT received, shutting down...'); server.close(() => process.exit(0)); });
process.on('uncaughtException', (err) => {
    // AbortErrors are expected when a client disconnects during a request.
    if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) return;
    console.error('Uncaught exception:', err);
});
process.on('unhandledRejection', (err) => {
    if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) return;
    console.error('Unhandled rejection:', err);
});
