import type { TemplateSpec } from './templates.types';

// Built-in one-click templates. Static data, not a table — same call as the
// framework maintenance presets: adding an app is a code change, reviewed and
// versioned, with no migration and no user-writable surface.
//
// Every entry is SINGLE-CONTAINER on purpose. A template instantiates a project
// with buildConfig.strategy 'image', which the worker's clone stage returns
// early from, so nothing here is ever built or fetched from git. Multi-container
// apps (Plausible, Supabase, Immich) need a compose path that can materialize a
// file with no repo to clone it from — deliberately out of v1.
//
// Image tags are pinned and were verified to exist in the registry. A user who
// wants a different version overrides `image` in the project's build settings.
//
// Deliberately absent: anything wanting /var/run/docker.sock (Portainer,
// Watchtower, Dozzle). The worker is the only process allowed to touch it, and
// a template that hands the socket to a user container would route around that.
export const TEMPLATE_CATALOG: TemplateSpec[] = [
  {
    slug: 'n8n',
    name: 'n8n',
    description:
      'Workflow automation with a visual editor — connect APIs, schedule jobs, build integrations without glue code.',
    category: 'Automation',
    website: 'https://n8n.io',
    repoUrl: 'https://github.com/n8n-io/n8n',
    image: 'n8nio/n8n:1.70.1',
    port: 5678,
    volumes: [{ name: 'data', path: '/home/node/.n8n' }],
    env: [
      { key: 'N8N_ENCRYPTION_KEY', label: 'Encryption key', generate: 'secret32' },
      { key: 'N8N_HOST', label: 'Host', generate: 'domain' },
      { key: 'WEBHOOK_URL', label: 'Webhook URL', generate: 'url' },
      {
        key: 'GENERIC_TIMEZONE',
        label: 'Timezone',
        description: 'IANA name used for cron schedules, e.g. Europe/Berlin.',
        default: 'UTC',
      },
    ],
    postInstall:
      'Open the URL and create the owner account on first visit. The encryption key was generated for you and protects stored credentials — losing it makes existing credentials unreadable.',
  },
  {
    slug: 'uptime-kuma',
    name: 'Uptime Kuma',
    description:
      'Self-hosted uptime monitoring with status pages and notifications for HTTP, TCP, ping and DNS checks.',
    category: 'Monitoring',
    website: 'https://uptime.kuma.pet',
    repoUrl: 'https://github.com/louislam/uptime-kuma',
    image: 'louislam/uptime-kuma:1.23.16',
    port: 3001,
    volumes: [{ name: 'data', path: '/app/data' }],
    postInstall:
      'The first visit asks you to create the admin account. Nothing is exposed until you do.',
  },
  {
    slug: 'ghost',
    name: 'Ghost',
    description:
      'Publishing platform for blogs and newsletters, with a built-in editor, memberships and RSS.',
    category: 'Publishing',
    website: 'https://ghost.org',
    repoUrl: 'https://github.com/TryGhost/Ghost',
    image: 'ghost:5-alpine',
    port: 2368,
    volumes: [{ name: 'content', path: '/var/lib/ghost/content' }],
    env: [
      { key: 'url', label: 'Site URL', generate: 'url' },
      { key: 'NODE_ENV', label: 'Node environment', default: 'production' },
    ],
    postInstall:
      'Finish setup at /ghost on first visit. This runs on the bundled SQLite database, which is fine for a personal site; a busy site should be pointed at a managed MySQL instance.',
  },
  {
    slug: 'vaultwarden',
    name: 'Vaultwarden',
    description:
      'Lightweight Bitwarden-compatible password server — works with the official Bitwarden apps and browser extensions.',
    category: 'Security',
    website: 'https://github.com/dani-garcia/vaultwarden',
    repoUrl: 'https://github.com/dani-garcia/vaultwarden',
    image: 'vaultwarden/server:1.32.7',
    port: 80,
    volumes: [{ name: 'data', path: '/data' }],
    env: [
      { key: 'ADMIN_TOKEN', label: 'Admin token', generate: 'secret32' },
      { key: 'DOMAIN', label: 'Domain', generate: 'url' },
      {
        key: 'SIGNUPS_ALLOWED',
        label: 'Allow signups',
        description: 'Set to false once your own account exists.',
        default: 'true',
      },
    ],
    postInstall:
      'Register your account first, then set SIGNUPS_ALLOWED to false in environment variables and redeploy. The admin panel is at /admin using the generated token. Passkeys and WebAuthn need the deployment served over HTTPS.',
  },
  {
    slug: 'gitea',
    name: 'Gitea',
    description:
      'Self-hosted git service with pull requests, issues, actions and a package registry.',
    category: 'Developer',
    website: 'https://about.gitea.com',
    repoUrl: 'https://github.com/go-gitea/gitea',
    image: 'gitea/gitea:1.22.6',
    port: 3000,
    volumes: [{ name: 'data', path: '/data' }],
    env: [
      { key: 'GITEA__server__ROOT_URL', label: 'Root URL', generate: 'url' },
      { key: 'GITEA__server__DOMAIN', label: 'Domain', generate: 'domain' },
      { key: 'USER_UID', label: 'Run as UID', default: '1000' },
      { key: 'USER_GID', label: 'Run as GID', default: '1000' },
    ],
    postInstall:
      'The first registered user becomes the administrator. Only the web port is routed — git over SSH is not exposed, so clone over HTTPS.',
  },
  {
    slug: 'metabase',
    name: 'Metabase',
    description:
      'Business intelligence — point it at a database and build dashboards and questions without SQL.',
    category: 'Analytics',
    website: 'https://www.metabase.com',
    repoUrl: 'https://github.com/metabase/metabase',
    image: 'metabase/metabase:v0.51.8',
    port: 3000,
    volumes: [{ name: 'data', path: '/metabase-data' }],
    env: [
      { key: 'MB_DB_FILE', label: 'Internal database file', default: '/metabase-data/metabase.db' },
    ],
    memoryMb: 2048,
    postInstall:
      'First boot takes a minute while the internal database initializes. Metabase is memory-hungry — the 2 GB limit here is a floor, not a ceiling.',
  },
  {
    slug: 'grafana',
    name: 'Grafana',
    description:
      'Dashboards and alerting over Prometheus, Postgres, Loki and dozens of other data sources.',
    category: 'Monitoring',
    website: 'https://grafana.com',
    repoUrl: 'https://github.com/grafana/grafana',
    image: 'grafana/grafana:11.3.0',
    port: 3000,
    volumes: [{ name: 'data', path: '/var/lib/grafana' }],
    env: [
      { key: 'GF_SECURITY_ADMIN_PASSWORD', label: 'Admin password', generate: 'password' },
      { key: 'GF_SERVER_ROOT_URL', label: 'Root URL', generate: 'url' },
    ],
    postInstall:
      'Log in as "admin" with the generated password, which you can read back from environment variables.',
  },
  {
    slug: 'memos',
    name: 'Memos',
    description:
      'Lightweight, privacy-first note taking — a self-hosted place for quick thoughts, with an API.',
    category: 'Productivity',
    website: 'https://usememos.com',
    repoUrl: 'https://github.com/usememos/memos',
    image: 'neosmemo/memos:stable',
    port: 5230,
    volumes: [{ name: 'data', path: '/var/opt/memos' }],
    postInstall: 'The first account created becomes the host account.',
  },
  {
    slug: 'filebrowser',
    name: 'File Browser',
    description:
      'Web file manager — browse, upload, edit and share files from the browser.',
    category: 'Productivity',
    website: 'https://filebrowser.org',
    repoUrl: 'https://github.com/filebrowser/filebrowser',
    image: 'filebrowser/filebrowser:v2',
    port: 80,
    volumes: [
      { name: 'srv', path: '/srv' },
      { name: 'database', path: '/database' },
    ],
    env: [
      { key: 'FB_DATABASE', label: 'Database file', default: '/database/filebrowser.db' },
    ],
    postInstall:
      'Default credentials are admin / admin — change the password immediately after the first login.',
  },
  {
    slug: 'stirling-pdf',
    name: 'Stirling PDF',
    description:
      'Local PDF toolkit — merge, split, convert, OCR, sign and compress, with nothing leaving the server.',
    category: 'Utilities',
    website: 'https://stirlingtools.com',
    repoUrl: 'https://github.com/Stirling-Tools/Stirling-PDF',
    image: 'stirlingtools/stirling-pdf:latest',
    port: 8080,
    volumes: [{ name: 'configs', path: '/configs' }],
    memoryMb: 2048,
  },
  {
    slug: 'it-tools',
    name: 'IT Tools',
    description:
      'A grab bag of developer utilities — encoders, hashes, JWT decoding, converters, generators.',
    category: 'Developer',
    website: 'https://it-tools.tech',
    repoUrl: 'https://github.com/CorentinTh/it-tools',
    image: 'corentinth/it-tools:latest',
    port: 80,
    postInstall: 'Entirely stateless — no volume, no login, safe to redeploy at any time.',
  },
  {
    slug: 'excalidraw',
    name: 'Excalidraw',
    description:
      'Hand-drawn-feel whiteboard for diagrams and sketches, running entirely in the browser.',
    category: 'Productivity',
    website: 'https://excalidraw.com',
    repoUrl: 'https://github.com/excalidraw/excalidraw',
    image: 'excalidraw/excalidraw:latest',
    port: 80,
    postInstall:
      'Drawings are stored in the browser, not on the server. This deployment has no volume and no accounts.',
  },
];

export function findTemplate(slug: string): TemplateSpec | undefined {
  return TEMPLATE_CATALOG.find((t) => t.slug === slug);
}
