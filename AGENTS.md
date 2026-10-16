# Agent Instructions

- When asked to create a PR or do commits, infer branch name, commit message, and PR title/body from the changes without asking.
- Code hosting is Forgejo: `https://forgejo.diestoeckels.de/diestoeckels/consens-lock` (GitHub is the read-only mirror). Never push to GitHub; open PRs against `master` on Forgejo.
- Monorepo of independent packages with no root `package.json`: `consens-lock-server/` (the daemon), `consens-lock-npm-client/` (standalone client), `consens-lock-ruby-client/` (stub). Run npm commands inside the package you touch.
- Commands: `cd consens-lock-server && npm test` / `npm run lint` / `npm start`; same in `consens-lock-npm-client/`. Run only the changed spec files locally; the CI workflow (`.forgejo/workflows/ci.yml`) runs lint + full tests for both packages.
- The daemon's lock authority is **in-memory** (leases + fencing epochs; SQLite only mirrors epochs on grant). Never reintroduce database rows as the lock authority. HTTP/websocket handlers must stay `inProcess: true` — worker threads would see a separate module graph without the authority.
- Protocol and lease/fencing model: see `docs/protocol.md`. The design contract lives in `velocious/docs/advisory-lock-backends.md` (STC-210).
- Add changelog fragments as `changelog.d/YYYYMMDDHHMMSS-short-slug.md`.
- Keep the e2e specs in `consens-lock-server/tests/` (they boot the real daemon); the npm-client package keeps only unit specs.
