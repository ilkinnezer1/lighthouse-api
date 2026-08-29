import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

/**
 * The two guarantees that live in the DATABASE, not in TypeScript, and that no
 * mock can prove: an org credential outliving the admin who added it, and a
 * credential never being able to belong to nobody.
 *
 * Everything runs inside a transaction that is always rolled back, so the
 * database is untouched. Skipped when there is no DATABASE_URL, so a machine
 * without infra still gets a green suite.
 */
/**
 * `process.loadEnvFile` writes to the real process env, which jest's per-file
 * env sandbox does not see — so the one value these tests need is read out of
 * .env directly. No .env and no DATABASE_URL (CI) → the suite skips rather than
 * failing on a connection it was never given.
 */
function databaseUrl(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const env = readFileSync(path.join(process.cwd(), '.env'), 'utf8');
    return /^DATABASE_URL=(.*)$/m.exec(env)?.[1]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

const url = databaseUrl();
const describeDb = url ? describe : describe.skip;

class Rollback extends Error {}

const unique = () => Math.random().toString(36).slice(2, 10);

describeDb('git credential ownership (database constraints)', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: url }),
    });
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  /** Runs `body` in a transaction and always rolls it back. */
  async function inRollback(
    body: (tx: Omit<PrismaClient, `$${string}`>) => Promise<void>,
  ): Promise<void> {
    await prisma
      .$transaction(async (tx) => {
        await body(tx);
        throw new Rollback();
      })
      .catch((err: unknown) => {
        if (!(err instanceof Rollback)) throw err;
      });
  }

  async function seed(tx: Omit<PrismaClient, `$${string}`>) {
    const tag = unique();
    const user = await tx.user.create({
      data: { email: `admin-${tag}@example.com`, username: `admin-${tag}` },
    });
    const org = await tx.organization.create({
      data: { name: `Acme ${tag}`, slug: `acme-${tag}` },
    });
    return { user, org };
  }

  // The failure this whole feature exists to prevent: a company credential
  // that vanishes when the admin who added it leaves.
  it('keeps an org credential when the admin who added it is deleted', async () => {
    await inRollback(async (tx) => {
      const { user, org } = await seed(tx);
      const credential = await tx.gitCredential.create({
        data: {
          organizationId: org.id,
          userId: user.id,
          kind: 'PAT',
          secretEnc: 'enc(token)',
        },
      });

      await tx.user.delete({ where: { id: user.id } });

      const after = await tx.gitCredential.findUnique({
        where: { id: credential.id },
      });
      expect(after).not.toBeNull();
      expect(after?.organizationId).toBe(org.id);
      // Demoted to attribution, and now unknown — but the credential lives.
      expect(after?.userId).toBeNull();
    });
  });

  // A personal credential has no other owner, so it SHOULD go with its user.
  it('deletes a personal credential with its user', async () => {
    await inRollback(async (tx) => {
      const { user } = await seed(tx);
      const credential = await tx.gitCredential.create({
        data: { userId: user.id, kind: 'PAT', secretEnc: 'enc(token)' },
      });

      await tx.user.delete({ where: { id: user.id } });

      expect(
        await tx.gitCredential.findUnique({ where: { id: credential.id } }),
      ).toBeNull();
    });
  });

  it('removes org credentials when the organization is deleted', async () => {
    await inRollback(async (tx) => {
      const { user, org } = await seed(tx);
      const credential = await tx.gitCredential.create({
        data: {
          organizationId: org.id,
          userId: user.id,
          kind: 'PAT',
          secretEnc: 'enc(token)',
        },
      });

      await tx.organization.delete({ where: { id: org.id } });

      expect(
        await tx.gitCredential.findUnique({ where: { id: credential.id } }),
      ).toBeNull();
    });
  });

  // Nullable user_id makes an orphan representable; the CHECK is what stops it.
  it('refuses a credential belonging to nobody', async () => {
    await inRollback(async (tx) => {
      await expect(
        tx.gitCredential.create({
          data: { kind: 'PAT', secretEnc: 'enc(token)' },
        }),
      ).rejects.toThrow(/git_credentials_owner_present|constraint/i);
    });
  });

  it('allows an org credential with no adder recorded', async () => {
    await inRollback(async (tx) => {
      const { org } = await seed(tx);
      const credential = await tx.gitCredential.create({
        data: {
          organizationId: org.id,
          kind: 'PAT',
          secretEnc: 'enc(token)',
        },
      });
      expect(credential.userId).toBeNull();
    });
  });

  it('defaults a new organization to allowing member credentials', async () => {
    await inRollback(async (tx) => {
      const { org } = await seed(tx);
      expect(org.allowMemberGitCredentials).toBe(true);
    });
  });
});
