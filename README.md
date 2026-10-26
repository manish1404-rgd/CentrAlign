# Atlas — Enterprise AI Operator

Atlas is an enterprise-style AI operator proof of concept: a web UI plus an Express backend, constrained planning, local tool execution, approval gates, persistence, and verification evidence. It demonstrates a real end-to-end loop for a deliberately narrow set of safe local tasks. It is not a production-ready unattended agent.

## Stack
- Frontend: vanilla HTML/CSS/JavaScript in `public/` (the only directory served statically).
- Backend: Node.js 20+, Express REST API (`server.js`).
- Planner: OpenAI Chat Completions when `OPENAI_API_KEY` is set; deterministic local planner otherwise.
- Persistence: MongoDB when `MONGODB_URI` is set; in-memory fallback otherwise.
- Tools: local company-knowledge search, local Markdown artifact creation, post-write verification.

## Run locally
1. Install Node.js 20 or later.
2. `npm install`
3. `cp .env.example .env` (all values are optional).
4. `npm start`, then open http://localhost:3000
5. `npm test` runs unit and API tests; `npm run check` syntax-checks all JS.

## API
- `GET /api/health` — health, database mode, planner mode, and available tools.
- `GET /api/tasks` — list recent task runs.
- `POST /api/tasks` with `{ "prompt": "Prepare a weekly operations brief" }` — plan a task and evaluate policy.
- `GET /api/tasks/:id` — inspect plan, trace, evidence, and result.
- `POST /api/tasks/:id/run` — execute permitted local tools and verify the result.
- `POST /api/tasks/:id/approval` with `{ "decision": "approve" }` or `{ "decision": "reject" }` — record an approval decision.
- `GET /api/knowledge/search?q=approval` — search seeded company policy snippets.
- `GET /api/artifacts` — list generated local workspace artifacts.

## Try the loop
```bash
curl -s -X POST http://localhost:3000/api/tasks -H 'Content-Type: application/json' \
  -d '{"prompt":"Prepare a weekly operations brief from company policy and create a report"}'
curl -s -X POST http://localhost:3000/api/tasks/<id>/run
```
A prompt such as `Send an email to a customer about the renewal` pauses for approval; approving only records the decision. The prototype never sends email, makes payments, or mutates external systems.

## Deploy
### Render (recommended; `render.yaml` included)
Create a Blueprint from the repo. Set `MONGODB_URI` (MongoDB Atlas free tier works), optionally `OPENAI_API_KEY`, and `CORS_ORIGINS` (only needed if the UI is hosted on a different origin). Health check: `/api/health`.

### Docker / Railway / Fly / any container host
```bash
docker build -t atlas-operator .
docker run -p 3000:3000 --env-file .env atlas-operator
```

### Vercel
`api/index.js` exposes the Express app as a serverless function and `vercel.json` routes `/api/*` to it; static files come from `public/`. Serverless caveats: the filesystem is read-only except `/tmp`, so generated artifacts are ephemeral, and in-memory storage does not persist between invocations, so **set `MONGODB_URI`** on Vercel.

### UI and API on different hosts
Set `window.ATLAS_API_BASE` in `public/config.js` to the API origin and add the UI origin to `CORS_ORIGINS`.

Generated artifacts are written to `WORKSPACE_DIR` (default `./workspace`), which is ephemeral on most hosts; attach a persistent disk or volume if they must survive deploys.

## Safety and limitations
- Tool names are allowlisted; the LLM cannot directly invoke arbitrary shell commands or external URLs.
- Sensitive-action detection is a lightweight demo policy, not a substitute for a real policy engine.
- Approval endpoints have no authentication in this POC. Do not expose publicly with real data until authentication, authorization, audit logging, rate limiting, CSRF protections as applicable, secrets management, and tenant isolation are implemented.
- Local file writes are only for generated Markdown artifacts in the configured workspace.
- Company context is a small seeded demo knowledge base, not a live connector.
- LLM output is validated against the allowlisted tool schema, but production systems also need prompt-injection defenses, least-privilege credentials, robust structured validation, and independent verification.
