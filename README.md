# k6 Distributed Load Tester

A small Cloudflare Workers control plane for running normal k6 tests across multiple Cloudflare Container shards.

It uses Workers, Hono, OpenAPI, Workflows, Durable Objects, R2, and Containers. Test input stays k6-native: inline scripts or `k6 archive` tar files.

## Features

- Hono API with OpenAPI at `/openapi.json` and Swagger UI at `/docs`.
- HTTP Basic Auth for the control-plane API.
- Distributed execution with k6 execution segments.
- Raw per-shard k6 NDJSON results stored in R2.
- Merged end-of-test k6 summary output.
- Optional compatibility layer for stock `k6 cloud run`.

## Requirements

- Bun 1.3+ or Node.js 22+.
- Cloudflare account with Workers, Workflows, Durable Objects, R2, and Containers enabled.
- Docker or another container runtime for local development.
- k6 CLI for e2e tests.

## Setup

```bash
bun install
cp .env.example .dev.vars
```

Create the R2 bucket from `wrangler.jsonc`:

```bash
bunx wrangler r2 bucket create container-loadtester-artifacts
```

Set production secrets:

```bash
bunx wrangler secret put BASIC_AUTH_USER
bunx wrangler secret put BASIC_AUTH_PASS
```

## Development

```bash
bun run dev
```

## Deploy

```bash
bun run deploy
```

The deploy builds the runner container image from `Dockerfile`. For production, pin the k6 image by changing the `K6_IMAGE` build arg default in the Dockerfile.

## API

All `/v1/*` endpoints require Basic Auth.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/openapi.json` | OpenAPI document |
| `GET` | `/docs` | Swagger UI |
| `GET` | `/v1/health` | Health check |
| `POST` | `/v1/tests` | Create a run from JSON or a k6 archive |
| `GET` | `/v1/tests` | List runs |
| `GET` | `/v1/tests/{id}` | Get a run |
| `POST` | `/v1/tests/{id}/start` | Start a run workflow |
| `POST` | `/v1/tests/{id}/stop` | Stop a run |
| `GET` | `/v1/tests/{id}/status` | Aggregated k6 status |
| `PATCH` | `/v1/tests/{id}/status` | Pause, resume, scale, or stop shards |
| `GET` | `/v1/tests/{id}/metrics` | Live aggregated metrics |
| `GET` | `/v1/tests/{id}/summary` | Final merged summary |
| `GET` | `/v1/tests/{id}/shards/{shard}/results` | Raw shard NDJSON results |

Create an inline run:

```bash
curl -u "$BASIC_AUTH_USER:$BASIC_AUTH_PASS" https://your-worker.example.com/v1/tests \
  -H 'content-type: application/json' \
  -d '{
    "script": { "type": "inline", "source": "import http from \"k6/http\"; export default function(){ http.get(\"https://test.k6.io\"); }" },
    "options": { "vus": 10, "duration": "30s" },
    "distribution": { "regions": ["ENAM"], "shardsPerRegion": 2 }
  }'
```

Create from a k6 archive:

```bash
k6 archive script.js -O archive.tar
curl -u "$BASIC_AUTH_USER:$BASIC_AUTH_PASS" \
  "https://your-worker.example.com/v1/tests?regions=ENAM,WEUR&shardsPerRegion=1" \
  -H 'content-type: application/x-tar' \
  --data-binary @archive.tar
```

Start and inspect a run:

```bash
curl -u "$BASIC_AUTH_USER:$BASIC_AUTH_PASS" -X POST https://your-worker.example.com/v1/tests/$ID/start
curl -u "$BASIC_AUTH_USER:$BASIC_AUTH_PASS" https://your-worker.example.com/v1/tests/$ID/status
curl -u "$BASIC_AUTH_USER:$BASIC_AUTH_PASS" https://your-worker.example.com/v1/tests/$ID/summary
```

## Tests

```bash
bun run typecheck
bun run test
bun run test:e2e
```

Remote e2e tests require an explicit deployment target:

```bash
REMOTE_BASE_URL="https://your-worker.example.com" bun run test:remote
REMOTE_BASE_URL="https://your-worker.example.com" bun run test:remote:cli
```

## Notes

- This is early-stage infrastructure software. Review Cloudflare limits and costs before running large tests.
- The `/cloud/v6/*` compatibility surface targets the k6 CLI behavior used by `k6 cloud run`; pin and test k6 versions in production.
- Configure R2 lifecycle rules if you do not want run artifacts retained indefinitely.

## License

MIT
