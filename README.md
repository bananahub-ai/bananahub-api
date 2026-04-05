# bananahub-api

Cloudflare Worker for BananaHub install tracking, built-in template usage telemetry, and discovered-template intake.

Production base URL: **https://worker.bananahub.ai/api**

## Endpoints

### POST /api/installs

Record a template install event.

```json
{
  "repo": "user/repo",
  "template_id": "cyberpunk-city",
  "template_path": "references/templates/cyberpunk-city",
  "install_target": "user/repo/cyberpunk-city",
  "cli_version": "0.1.0",
  "timestamp": "2026-03-25T12:00:00Z"
}
```

Besides incrementing install counters, this endpoint also upserts a discovered-template candidate keyed by `repo + template_id`.

Rate limited to 10 writes/min per IP. Returns `{ "ok": true }` on success or 429 when rate limited.

### GET /api/stats

Query install counts.

| Parameter     | Required | Description                    |
|---------------|----------|--------------------------------|
| `repo`        | yes      | Repository in `owner/name` format |
| `template_id` | no       | Specific template to query     |

Returns `{ "repo": "...", "template_id": "...", "installs": 142 }`.

### POST /api/usage

Record a template adoption event.

```json
{
  "repo": "bananahub-ai/bananahub-skill",
  "template_id": "cute-sticker",
  "event": "generate_success",
  "anonymous_id": "6d7d0e4b2f7b4c48b5c0d3d5e1c2a9f4",
  "distribution": "bundled",
  "catalog_source": "curated",
  "command": "generate",
  "client_ts": "2026-04-04T12:00:00Z"
}
```

Supported events:

- `selected`
- `generate_success`
- `edit_success`

Rate limited to 60 writes/min per IP. Returns `{ "ok": true }` on success.

### GET /api/usage-stats

Query usage/adoption counts for a specific template.

| Parameter     | Required | Description                    |
|---------------|----------|--------------------------------|
| `repo`        | yes      | Repository in `owner/name` format |
| `template_id` | yes      | Specific template to query     |

Returns usage totals, 24h counts, and anonymous unique counts for `selected`, `generate_success`, and `edit_success`.

### GET /api/trending

Get trending templates.

| Parameter | Default | Description                     |
|-----------|---------|----------------------------------|
| `period`  | `24h`   | Time window: `24h` or `7d`      |
| `limit`   | `20`    | Max results (1-100)              |

Returns `{ "period": "24h", "templates": [...] }`.

### GET /api/discovered

List discovered template candidates inferred from real install events.

| Parameter | Default | Description                     |
|-----------|---------|----------------------------------|
| `limit`   | `200`   | Max results (1-1000)             |

Returns `{ "total": N, "items": [...] }`.

## KV Key Schema

Namespace binding: `INSTALLS`

| Key pattern                                | Purpose              | TTL     |
|--------------------------------------------|----------------------|---------|
| `count:{repo}:{template_id}`               | Per-template total   | none    |
| `repo-count:{repo}`                        | Repo aggregate       | none    |
| `daily:{YYYY-MM-DD}:{repo}:{template_id}`  | Trending data        | 7 days  |
| `usage-count:{event}:{repo}:{template_id}` | Usage total          | none    |
| `usage-daily:{YYYY-MM-DD}:{event}:{repo}:{template_id}` | Usage 24h | 7 days |
| `usage-unique:{event}:{repo}:{template_id}:{anon}` | Unique marker | none |
| `usage-unique-count:{event}:{repo}:{template_id}` | Unique total | none |
| `discovered:{repo}:{template_id}`          | Discovered metadata  | none    |
| `ratelimit:{ip}:{minute}`                  | Install rate limit   | 120s    |
| `usage-ratelimit:{ip}:{minute}`            | Usage rate limit     | 120s    |

## Development

```bash
npm install
npm run dev
```

## Deployment

```bash
npm run deploy
```

Before deploying, update `wrangler.toml` with real KV namespace IDs and keep the `worker.bananahub.ai` custom-domain route in sync with Cloudflare:
```bash
npx wrangler kv namespace create INSTALLS
```
