import fs from 'node:fs';
import path from 'node:path';

// pnpm installs the Prisma CLI into the production tree as @prisma/client's
// optional peer, and the CLI hard-depends on Prisma Studio (~238MB). The server
// never shells out to it — `migrate deploy` runs from the `migrate` image — so
// the runtime tree drops it, keeping only what the app's own dependencies reach.
const NEVER_AT_RUNTIME = new Set(['prisma']);

const projectRoot = process.argv[2] ?? process.cwd();
const explicitRoots = process.argv.slice(3);
const modules = path.join(projectRoot, 'node_modules');

const manifestOf = (name) => {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(modules, name, 'package.json'), 'utf8'),
    );
  } catch {
    return null;
  }
};

const roots =
  explicitRoots.length > 0
    ? explicitRoots
    : Object.keys(
        JSON.parse(
          fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'),
        ).dependencies ?? {},
      ).filter((name) => !NEVER_AT_RUNTIME.has(name));

const keep = new Set();
const queue = [...roots];

while (queue.length > 0) {
  const name = queue.pop();
  if (keep.has(name)) continue;
  const manifest = manifestOf(name);
  if (!manifest) continue;
  keep.add(name);

  const requiredPeers = Object.keys(manifest.peerDependencies ?? {}).filter(
    (peer) => !manifest.peerDependenciesMeta?.[peer]?.optional,
  );

  queue.push(
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...requiredPeers,
  );
}

const installed = [];
for (const entry of fs.readdirSync(modules)) {
  if (entry.startsWith('.')) continue;
  if (entry.startsWith('@')) {
    for (const scoped of fs.readdirSync(path.join(modules, entry))) {
      installed.push(`${entry}/${scoped}`);
    }
    continue;
  }
  installed.push(entry);
}

let removed = 0;
for (const name of installed) {
  if (keep.has(name)) continue;
  fs.rmSync(path.join(modules, name), { recursive: true, force: true });
  removed += 1;
}

const binDir = path.join(modules, '.bin');
if (fs.existsSync(binDir)) {
  for (const entry of fs.readdirSync(binDir)) {
    const link = path.join(binDir, entry);
    if (!fs.existsSync(link)) fs.rmSync(link, { force: true });
  }
}

console.log(`pruned node_modules: kept ${keep.size}, removed ${removed}`);
