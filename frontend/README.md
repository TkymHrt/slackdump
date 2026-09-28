# Viewer frontend

The live `slackdump view` interface is a Vite, React, and TypeScript app. It uses
shadcn/ui components with Tailwind CSS v4, TanStack Query for archive requests,
and TanStack Virtual for message lists. Oxlint and Oxfmt handle linting and
formatting.

## Development

Run the Go server with an archive and start Vite in another terminal:

```bash
go run ./cmd/slackdump view -listen 127.0.0.1:8080 /path/to/archive
cd frontend
npm ci
npm run dev
```

Open `http://localhost:5173`. Vite proxies `/api`, downloaded files, and canvas
content to the Go server. The archive API lives in `internal/viewer/api.go`;
browser requests and response types live in `src/api.ts`.

## Checks and release assets

```bash
npm run format:check
npm run lint
npm test
npm run build
```

For browser interaction tests, install Chromium once and run:

```bash
npx playwright install chromium
npm run test:e2e
```

`npm run build` writes the production app to `internal/viewer/web`. Commit those
assets alongside frontend changes. Go embeds them, so a normal `go build` or
`make all` produces one standalone executable without requiring Node at build
time. `make viewer-assets` rebuilds the embedded files after UI edits.

The static HTML converter still uses the existing Go templates; only the live
viewer uses this app.
