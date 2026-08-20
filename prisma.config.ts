import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { defineConfig } from 'prisma/config';

// Load .env so DATABASE_URL is available to Prisma CLI commands
// (migrate, db push, studio). Uses Node's built-in env loader (>= 21.7);
// no `dotenv` dep needed. Absent in the container image, where DATABASE_URL
// is already in the environment.
const envFile = path.join(process.cwd(), '.env');
if (fs.existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

export default defineConfig({
  // Multi-file schema: every *.prisma file under `prisma/` is loaded.
  schema: 'prisma',
  migrations: {
    path: path.join('prisma', 'migrations'),
  },
  datasource: {
    url: process.env.DATABASE_URL!,
  },
});
