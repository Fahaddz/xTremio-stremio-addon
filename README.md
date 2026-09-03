# xTremio

Optimized self-hosted Stremio addon for Xtream Codes.

## Optimizations

- Stateless: no database and no Redis required.
- Stale-while-revalidate caching: expired data is served immediately while refresh happens in the background.
- Per-category catalog caching avoids keeping entire provider libraries in RAM during normal browsing.
- Full VOD/series snapshots are loaded only for global search; live snapshots are loaded only when live metadata needs them.
- Cached catalog records are projected down to only the fields required by Stremio.
- Sorted category orders are reused across pagination without retaining unlimited sort copies.
- Large stream-list downloads are serialized to keep concurrent Stremio catalog requests from exhausting memory.
- Previously used full snapshots refresh every two hours in the background; categories refresh every six hours.
- Previously opened series metadata refreshes every six hours in the background so new episodes are ready before the next visit.
- Request de-duplication: concurrent cache misses for the same key share one upstream request.
- Separate cache lifetimes:
  - Categories: 6h fresh / 24h stale
  - Catalogs: 20m fresh / 2h stale
  - Series info/episodes: 10m fresh / 1h stale
  - Movie info: 6h fresh / 24h stale
- Bounded caches and periodic stale-entry cleanup.
- Movie metadata is cached.
- Production-only dependencies.
- Lightweight Node 22 Alpine container.
- Non-root, read-only container with dropped capabilities.
- Defensive category filtering when providers return mixed or incomplete category data.
- Optional addon name, category labels, and a Live TV search toggle.

## Run

```bash
docker compose up -d --build
```

The addon listens on port 3000 inside the container and is exposed as port 3005 by the included Compose file.

Configure at:

```text
http://YOUR_SERVER_IP:3005/configure
```

For a direct Node.js deployment, run `npm ci --omit=dev && npm start`.

## Vercel

The root `index.js` is supported by Vercel's zero-configuration Express runtime.
`vercel.json` allows catalog requests up to five minutes, which is useful for
large provider lists. Vercel instances and in-memory caches are ephemeral, so
the background refresh timers are best-effort there. Use an external scheduler
and persistent cache if guaranteed periodic refresh is required.
Movie, episode, and Live TV playback all use direct provider URLs. The addon
returns stream links and never relays or stores media bytes. Any legacy
`/proxy/...` URL is only redirected (302) to the provider for backward
compatibility and does not proxy bytes.

## Cache configuration

| Variable | Default | Purpose |
|---|---:|---|
| `CACHE_MAX_ACCOUNTS` | `2` | Maximum account snapshots retained in the main caches |
| `CACHE_MAX_METADATA` | `128` | Maximum movie/series metadata entries retained |
| `UPSTREAM_CATEGORY_TIMEOUT_MS` | `30000` | Maximum time for category API calls |
| `UPSTREAM_LIST_TIMEOUT_MS` | `120000` | Maximum time for stream-list API calls |
| `UPSTREAM_LIST_TTL_MS` | `1200000` | Freshness period for stream-list caches |
| `UPSTREAM_LIST_CONCURRENCY` | `1` | Maximum simultaneous large stream-list downloads |
| `UPSTREAM_LIST_STALE_MS` | `infinite` | How long a successful full snapshot may be served while refreshing |
| `UPSTREAM_BACKGROUND_REFRESH_MS` | `7200000` | Refresh interval for used full snapshots |
| `UPSTREAM_CATEGORY_REFRESH_MS` | `21600000` | Refresh interval for used category snapshots |
| `UPSTREAM_SERIES_INFO_REFRESH_MS` | `21600000` | Refresh interval for cached series metadata |

## Customization

Open `/configure` and set the options directly in the web form:

- Addon name
- Live TV category name
- Movies category name
- Series category name
- Include or exclude Live TV from global search

These settings are stored in the generated Stremio install URL, so different
users can choose different names. The internal IDs and the original catalog
structure remain unchanged. Live TV search is off by default and adds only a
search entry when enabled.

The caches use stale-while-revalidate. Complete responses can be served stale while
one background refresh runs; incomplete category and metadata responses are not retained.

## Updating

Pull the new code in your fork, then:

```bash
docker compose build --no-cache
docker compose up -d
```

## Cache behavior

There is intentionally no persistent database. Xtream API responses are snapshots, so cache refreshes replace the corresponding in-memory snapshot. New episodes are picked up through the 10-minute series-info freshness window without requiring a DB/Redis synchronization layer.
