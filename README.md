# xTremio

Optimized self-hosted Stremio addon for Xtream Codes.

## Optimizations

- Stateless: no database and no Redis required.
- Stale-while-revalidate caching: expired data is served immediately while refresh happens in the background.
- Per-category catalog caching avoids keeping entire provider libraries in RAM during normal browsing.
- Full VOD/series snapshots are loaded only for global search; live snapshots are loaded only when live metadata needs them.
- Cached catalog records are projected down to only the fields required by Stremio.
- Sorted category orders are reused across pagination without retaining unlimited sort copies.
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

## Cache configuration

| Variable | Default | Purpose |
|---|---:|---|
| `CACHE_MAX_ACCOUNTS` | `2` | Maximum account snapshots retained in the main caches |
| `CACHE_MAX_METADATA` | `128` | Maximum movie/series metadata entries retained |

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
