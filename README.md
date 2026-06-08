# k6 Distributed Load Tester

A headless, k6-native control plane for running **standard k6 tests distributed
across Cloudflare regions**, built on Workers, Workflows, Durable Objects, and
Containers.

There is no bespoke test format and no UI. The platform speaks k6's own
vocabulary end to end:

- **Input** — a standard inline k6 script, or a portable `k6 archive` tar
  (`metadata.json` + scripts + `open()`ed data files).
- **Distribution** — native k6 [execution segments](https://grafana.com/docs/k6/latest/using-k6/execution-segments/)
  (`--execution-segment` / `--execution-segment-sequence`), one segment per shard.
- **Control & live metrics** — the native k6 [REST API](https://grafana.com/docs/k6/latest/misc/k6-rest-api/)
  (`/v1/status`, `/v1/metrics`, ...), aggregated across shards and also
  addressable per shard.
- **Results** — native k6 outputs in R2: raw `--out json` NDJSON per shard plus
  an exact, merged end-of-test summary in k6's summary-export format.

## Architecture

```
client ──HTTP Basic Auth──▶ Worker (Hono API)
                                 │ create workflow instance
                                 ▼
                       K6RunWorkflow (fan-out lifecycle)
                          • launch one step per shard
                          • sleep/poll one step per shard
                          • finalize exact merged summary
                                 │ RPC
                                 ▼
                        RunCoordinator (Durable Object, SQLite)
                          • run registry + shard plan
                          • idempotent shard operations
                                 │ getContainer()
            ┌────────────────────┼────────────────────┐
            ▼                    ▼                    ▼
     K6Runner ENAM        K6Runner WEUR         K6Runner APAC   ... (6 regions)
     (Container: real k6 + Node control server)
                                 │
                                 ▼
                        R2 (native k6 artifacts)
```

Each run is managed by a Cloudflare Workflow whose instance ID is the run ID.
The Workflow uses a fan-out pattern: launch steps run in parallel per shard,
then poll/collect steps run in parallel per shard until every k6 process exits.
The Durable Object is intentionally kept as state and idempotent operations; it
does not own lifecycle polling.

Workflow retries are scoped to individual lifecycle steps and preserve k6
execution semantics:

- launch failures are retried only while the shard has not been marked running;
- once a shard is running or completed, retries never relaunch that execution
  segment;
- if one launch exhausts retries, the Workflow stops any shards that did start,
  collects available artifacts, and finalizes the run as failed;
- transient status/artifact collection failures throw back to Workflows and are
  retried by the individual collect step;
- a non-zero k6 exit code is terminal k6 state, not an orchestration retry;
- rerunning a test means creating a new run ID, never replaying one shard of an
  existing run.

Each region has its own `Container` class pinned via `constraints.regions` in
`wrangler.jsonc`, so load is generated close to (or deliberately far from) the
target. Inside every container, `runner/server.mjs` wraps the real `k6` binary
and exposes its native REST API plus the raw JSON output file.

## API

All endpoints require HTTP Basic Auth except `GET /openapi.json`.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/openapi.json` | OpenAPI 3.1 description (public) |
| `GET` | `/v1/health` | Health + supported regions |
| `POST` | `/v1/tests` | Create a run (inline JSON **or** archive tar) |
| `GET` | `/v1/tests` | List runs |
| `GET` | `/v1/tests/{id}` | Get a run record |
| `POST` | `/v1/tests/{id}/start` | Create the Workflow instance that manages the run lifecycle |
| `POST` | `/v1/tests/{id}/stop` | Stop all shards (native k6 stop) |
| `GET` | `/v1/tests/{id}/status` | Aggregated k6 `/v1/status` |
| `PATCH` | `/v1/tests/{id}/status` | Forward pause/resume/scale to all shards |
| `GET` | `/v1/tests/{id}/metrics` | Aggregated k6 `/v1/metrics` (live) |
| `GET` | `/v1/tests/{id}/summary` | Exact merged end-of-test summary |
| `GET` | `/v1/tests/{id}/shards/{shard}/results` | Raw k6 JSON output for one shard |
| `*` | `/v1/tests/{id}/shards/{shard}/k6/v1/{path}` | Passthrough to one shard's native k6 REST API |

## Stock k6 CLI cloud execution

The Worker also implements the subset of k6's `/cloud/v6` API used by the
stock `k6 cloud run` command, so the normal k6 CLI can upload a standard k6
archive, start the remote sharded Container runtime, poll progress, and receive
the exact merged summary as cloud log output.

Authentication reuses the existing Basic Auth credential as a bearer token:

```bash
export K6_CLOUD_TOKEN="$BASIC_AUTH_USER:$BASIC_AUTH_PASS"
export K6_CLOUD_STACK_ID=1
export K6_CLOUD_PROJECT_ID=1
export K6_CLOUD_HOST_V6="https://loadtester.example.com"
export K6_CLOUD_LOGS_TAIL_URL="wss://loadtester.example.com/api/v1/tail"

k6 cloud run script.js
```

This targets the k6 `/cloud/v6` client used by current k6 v1.x/v2.x releases.
Because this is an internal Grafana Cloud API surface, pin the k6 version used
in CI and production.

### CLI distribution options

Use the platform region names directly as k6 cloud load zones. The custom
`shardsPerRegion` option controls how many execution-segment shards are created
per selected region.

```js
export const options = {
  cloud: {
    distribution: {
      ENAM: { loadZone: 'ENAM', percent: 50 },
      WEUR: { loadZone: 'WEUR', percent: 50 },
    },
    shardsPerRegion: 2,
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<500'],
  },
};
```

If `options.cloud.distribution` is omitted, the run defaults to `ENAM` with one
shard. Supported load zones are `ENAM`, `WNAM`, `EEUR`, `WEUR`, `APAC`, and
`SAM`. The `percent` values are accepted for k6 compatibility; the current
runtime splits work uniformly across the selected shards.

### CLI aggregated output

The stock k6 CLI does not render the local summary table for cloud execution.
Instead, this platform streams the exact merged end-of-test summary over k6's
cloud-log WebSocket, so the aggregate stats appear directly in the terminal.
Thresholds are evaluated against the exact merged summary and drive the normal
k6 cloud exit behavior: failed thresholds cause `k6 cloud run` to exit non-zero.

The same exact summary remains available through the existing API:

```bash
curl -u "$BASIC_AUTH_USER:$BASIC_AUTH_PASS" \
  "https://loadtester.example.com/v1/tests/<run-id>/summary"
```

### Create from an inline script

```bash
curl -u "$USER:$PASS" https://loadtester.example.com/v1/tests \
  -H 'content-type: application/json' \
  -d '{
        "script": { "type": "inline", "source": "import http from \"k6/http\";\nexport default function(){ http.get(\"https://test.k6.io\"); }" },
        "options": { "vus": 50, "duration": "1m", "thresholds": { "http_req_failed": ["rate<0.01"] } },
        "distribution": { "regions": ["ENAM", "WEUR"], "shardsPerRegion": 2 }
      }'
```

### Create from a k6 archive (multi-file tests, data files, TLS certs)

```bash
k6 archive script.js -O archive.tar
curl -u "$USER:$PASS" \
  "https://loadtester.example.com/v1/tests?regions=ENAM,APAC&shardsPerRegion=2" \
  -H 'content-type: application/x-tar' \
  --data-binary @archive.tar
# Optional pass-through query params: env=<json-object>&args=<json-array>
```

### Run lifecycle

```bash
ID=...                                   # from the create response
curl -u "$USER:$PASS" -X POST https://loadtester.example.com/v1/tests/$ID/start
curl -u "$USER:$PASS"       https://loadtester.example.com/v1/tests/$ID/metrics
curl -u "$USER:$PASS" -X POST https://loadtester.example.com/v1/tests/$ID/stop
curl -u "$USER:$PASS"       https://loadtester.example.com/v1/tests/$ID/summary
```

## Result aggregation & correctness

Counters and gauges merge exactly across shards. **Trend percentiles (p95, ...)
cannot be merged correctly from per-shard summaries**, so live
`/v1/tests/{id}/metrics` reports them as approximations and flags them in
`meta.approximate`.

The authoritative result is the **end-of-test summary**: when every shard's k6
process exits, the coordinator streams each shard's raw `--out json` NDJSON into
R2 and recomputes exact aggregate statistics from the merged raw samples —
identical to what a single k6 instance would report — written to
`runs/{id}/summary.json` in k6's native summary-export format.

> Workers Analytics Engine is intentionally **not** used for the authoritative
> numbers: it applies adaptive sampling and extrapolates percentiles, which is
> incompatible with exact k6 reporting.

## Authentication

HTTP Basic Auth against a single credential held in Worker secrets, compared
timing-safely (see the [k6 basic-auth example](https://grafana.com/docs/k6/latest/examples/http-authentication/#basic-authentication)).

```bash
npx wrangler secret put BASIC_AUTH_USER
npx wrangler secret put BASIC_AUTH_PASS
```

## Local development

1. Copy `.env.example` to `.dev.vars` (loaded by `wrangler dev`).
2. `npm run dev`.

Containers require a local Docker/container runtime for `wrangler dev`.

## Deploy

```bash
npm run deploy   # wrangler deploy (builds and pushes the runner image)
```

## Tests

```bash
npm test         # vitest + @cloudflare/vitest-pool-workers
npm run test:e2e # local wrangler dev + container-sharded k6 archive test
npm run test:remote # authenticated remote 3-shard Container run
```

`npm run test:remote` reads `BASIC_AUTH_USER` and `BASIC_AUTH_PASS` from `.env`
or `process.env`, targets `https://container-loadtester.tiwicf.workers.dev` by
default, creates a k6 archive, starts a remote run with three Container
shards, waits for completion, and verifies per-shard k6 result artifacts.

Override the target, region, or timeout if needed:

```bash
REMOTE_BASE_URL="https://your-worker.example.com" \
REMOTE_TEST_REGION="WEUR" \
REMOTE_TEST_TIMEOUT_MS=600000 \
npm run test:remote
```
