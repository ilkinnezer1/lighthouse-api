# lighthouse-api

The **control plane** for [Lighthouse](https://github.com/ilkinnezer1/lighthouse) — a NestJS 11 +
Prisma 7 service that owns the database, authenticates every request, and hands the real work to
the Go worker over Redis.

Sibling repos: [`lighthouse-worker`](https://github.com/ilkinnezer1/lighthouse-worker) (data plane)
and [`lighthouse-web`](https://github.com/ilkinnezer1/lighthouse-web) (UI). Clone all three as
siblings and run from the parent — see the root repo for the shared infra and design docs.

## Setup

```bash
pnpm install
cp .env.example .env          # fill DATABASE_URL, MASTER_ENCRYPTION_KEY, JWT_SECRET
npx prisma migrate deploy
pnpm start:dev                # :3000
```

Postgres, Redis and MinIO come from `docker-compose.dev.yml` in the parent directory (`make up`).

`MASTER_ENCRYPTION_KEY` must be byte-identical to the worker's: both encrypt secrets with
AES-256-GCM against the same key, and each has to read what the other wrote.

## Commands

| | |
|---|---|
| `pnpm start:dev` | watch-mode dev server |
| `pnpm build` | compile to `dist/` — the check that gates a commit |
| `pnpm lint` | eslint, `--max-warnings 0`; gates CI |
| `pnpm test` | jest |
| `npx prisma migrate dev --name <name>` | author a migration |
| `npx prisma studio` | browse the database |

## Layout

`src/` is one folder per domain module, each a Nest module with its own controller, service and
DTOs:

- **Platform** — `auth` (JWT in an httpOnly cookie, argon2 hashes) · `authz` (role checks) ·
  `orgs` · `invitations` · `users` · `audit` · `bootstrap` (first-run admin)
- **Deploys** — `projects` · `deployments` · `env-vars` · `domains` · `webhooks` · `github`
  (OAuth + repo listing) · `integrations`
- **Data** — `databases` · `snapshots` · `volumes` · `volume-backups` · `backup-schedules` ·
  `managed-files` · `templates` · `scheduled-tasks` · `notifications`
- **Plumbing** — `prisma` · `redis` · `queue` (job streams to the worker) · `outbox` (event
  outbox) · `reaper` (sweeps stuck records) · `crypto` (AES-256-GCM) · `ws` · `config` · `common`
  · `health`

`prisma/` uses Prisma 7's **multi-file schema** — one `.prisma` file per domain, all loaded via
`prisma.config.ts`. There is no `url` in the datasource block: Prisma 7 requires a driver adapter,
and the connection string is injected through `prisma.config.ts` instead.

## Rules that don't bend

- **This service never touches `/var/run/docker.sock`.** Anything needing Docker becomes a job on a
  Redis stream for the worker, or a proxied call to the worker's internal HTTP API.
- **This repo owns the schema.** The worker reads the same database through sqlc + pgx against a
  generated `schema.sql`, so every migration here has to be mirrored there before the worker is
  rebuilt — a drift has broken deploys before.
- **Every mutating endpoint goes through `ensureCan(...)` and carries `@Audit(...)`.** Authorization
  is never left to the controller's own judgement.
- Secrets are stored encrypted, returned masked, and written write-only.
