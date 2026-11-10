import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { User } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AuthzService } from '../authz/authz.service';
import { DatabasesService } from '../databases/databases.service';
import { OUTBOX_EVENT_TYPES } from '../outbox/outbox.constants';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { SnapshotsController } from './snapshots.controller';
import { SnapshotsService } from './snapshots.service';

const DB_ID = '11111111-1111-4111-8111-111111111111';
const SNAP_ID = '22222222-2222-4222-8222-222222222222';
const USER = { id: 'user-1', role: 'USER' } as unknown as User;
const MAX_BYTES = 4096;

interface Row {
  id: string;
  databaseId: string;
  status: 'PENDING' | 'READY' | 'FAILED';
  storageKey: string | null;
  sizeBytes: bigint | null;
  errorSummary: string | null;
  label: string | null;
  isBaseline: boolean;
  origin: 'DUMP' | 'IMPORT';
  fileName: string | null;
  importStatus: 'UPLOADING' | 'RESTORING' | 'SUCCEEDED' | 'FAILED' | null;
  createdAt: Date;
}

interface WorkerCall {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

type WorkerBehaviour = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: Buffer,
) => void;

const storeBlob: WorkerBehaviour = (_req, res, body) => {
  Object.assign(rows.get(SNAP_ID)!, {
    status: 'READY',
    storageKey: `${DB_ID}/${SNAP_ID}.sql`,
    sizeBytes: BigInt(body.length),
  });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ sizeBytes: body.length }));
};

let rows: Map<string, Row>;

function pick(row: Row) {
  return { ...row };
}

describe('POST /databases/:id/imports', () => {
  let app: INestApplication;
  let apiUrl: string;
  let worker: http.Server;
  let workerBaseUrl: string;
  let workerUrl: string;
  let workerCalls: WorkerCall[];
  let workerBehaviour: WorkerBehaviour;
  let database: {
    id: string;
    type: string;
    status: string;
    environment: { project: { organizationId: string; deletedAt: null } };
  };
  let prisma: Record<string, unknown> & {
    eventOutbox: { create: jest.Mock };
    databaseSnapshot: Record<string, jest.Mock>;
  };
  let queue: { enqueueSnapshotRestore: jest.Mock };
  let authz: { ensureCan: jest.Mock };

  beforeAll(async () => {
    worker = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('error', () => undefined);
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        workerCalls.push({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body,
        });
        workerBehaviour(req, res, body);
      });
    });
    await new Promise<void>((r) => worker.listen(0, '127.0.0.1', r));
    workerBaseUrl = `http://127.0.0.1:${(worker.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((r) => worker.close(r));
  });

  beforeEach(async () => {
    rows = new Map();
    workerUrl = workerBaseUrl;
    workerCalls = [];
    workerBehaviour = storeBlob;
    database = {
      id: DB_ID,
      type: 'MYSQL',
      status: 'READY',
      environment: { project: { organizationId: 'org-1', deletedAt: null } },
    };

    const snapshotModel = {
      findFirst: jest.fn(({ where }: { where: { databaseId: string } }) =>
        Promise.resolve(
          [...rows.values()].find(
            (r) =>
              r.databaseId === where.databaseId &&
              (r.importStatus === 'UPLOADING' ||
                r.importStatus === 'RESTORING'),
          ) ?? null,
        ),
      ),
      create: jest.fn(({ data }: { data: Partial<Row> }) => {
        const row: Row = {
          id: SNAP_ID,
          databaseId: data.databaseId!,
          status: 'PENDING',
          storageKey: null,
          sizeBytes: null,
          errorSummary: null,
          label: null,
          isBaseline: false,
          origin: 'DUMP',
          fileName: null,
          importStatus: null,
          createdAt: new Date('2026-11-10T12:00:00.000Z'),
          ...data,
        };
        rows.set(row.id, row);
        return Promise.resolve(pick(row));
      }),
      update: jest.fn(
        ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
          const row = rows.get(where.id)!;
          Object.assign(row, data);
          return Promise.resolve(pick(row));
        },
      ),
      updateMany: jest.fn(
        ({
          where,
          data,
        }: {
          where: { id: string; origin?: string };
          data: Partial<Row>;
        }) => {
          const row = rows.get(where.id);
          if (!row || (where.origin && row.origin !== where.origin)) {
            return Promise.resolve({ count: 0 });
          }
          Object.assign(row, data);
          return Promise.resolve({ count: 1 });
        },
      ),
      findUniqueOrThrow: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(pick(rows.get(where.id)!)),
      ),
    };
    prisma = {
      databaseSnapshot: snapshotModel,
      eventOutbox: { create: jest.fn(() => Promise.resolve({})) },
      $queryRaw: jest.fn(() => Promise.resolve([])),
    };
    prisma.$transaction = jest.fn((arg: unknown) =>
      typeof arg === 'function'
        ? (arg as (tx: unknown) => Promise<unknown>)(prisma)
        : Promise.all(arg as Promise<unknown>[]),
    );
    queue = {
      enqueueSnapshotRestore: jest.fn(() => Promise.resolve('1-0')),
    };
    authz = { ensureCan: jest.fn(() => Promise.resolve()) };

    const moduleRef = await Test.createTestingModule({
      controllers: [SnapshotsController],
      providers: [
        SnapshotsService,
        { provide: PrismaService, useValue: prisma },
        { provide: QueueService, useValue: queue },
        { provide: AuthzService, useValue: authz },
        {
          provide: DatabasesService,
          useValue: {
            findByIdWithOwner: jest.fn(() => Promise.resolve(database)),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              ({ WORKER_HTTP_URL: workerUrl, DB_IMPORT_MAX_BYTES: MAX_BYTES })[
                key
              ],
          },
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          ctx.switchToHttp().getRequest<{ user: User }>().user = USER;
          return true;
        },
      })
      .compile();

    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    apiUrl = await app.getUrl();
  });

  afterEach(async () => {
    await app.close();
  });

  function post(
    headers: http.OutgoingHttpHeaders,
    body?: Buffer,
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        `${apiUrl}/databases/${DB_ID}/imports`,
        {
          method: 'POST',
          headers: Object.fromEntries(
            Object.entries(headers).filter(([, v]) => v !== undefined),
          ),
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () =>
            resolve({
              status: res.statusCode!,
              json: JSON.parse(
                Buffer.concat(chunks).toString() || '{}',
              ) as Record<string, unknown>,
            }),
          );
        },
      );
      req.on('error', reject);
      req.end(body);
    });
  }

  const dump = Buffer.from(
    'CREATE TABLE t (id int);\nINSERT INTO t VALUES (1);\n',
  );
  const goodHeaders = (overrides: http.OutgoingHttpHeaders = {}) => ({
    'Content-Type': 'application/octet-stream',
    'Content-Length': dump.length,
    'X-Import-Filename': encodeURIComponent('wj dev3.sql'),
    ...overrides,
  });

  it('streams the dump to the worker, queues the restore and returns the snapshot DTO', async () => {
    const res = await post(goodHeaders(), dump);

    expect(res.status).toBe(202);
    expect(res.json).toEqual({
      id: SNAP_ID,
      databaseId: DB_ID,
      status: 'READY',
      storageKey: `${DB_ID}/${SNAP_ID}.sql`,
      sizeBytes: String(dump.length),
      errorSummary: null,
      label: null,
      isBaseline: false,
      origin: 'IMPORT',
      fileName: 'wj dev3.sql',
      importStatus: 'RESTORING',
      createdAt: '2026-11-10T12:00:00.000Z',
    });

    expect(workerCalls).toHaveLength(1);
    const call = workerCalls[0];
    expect(call.method).toBe('PUT');
    expect(call.url).toBe(`/databases/${DB_ID}/snapshots/${SNAP_ID}/upload`);
    expect(call.headers['content-length']).toBe(String(dump.length));
    expect(call.headers['transfer-encoding']).toBeUndefined();
    expect(call.headers['content-type']).toBe('application/octet-stream');
    expect(call.headers['x-import-filename']).toBe('wj%20dev3.sql');
    expect(call.body.equals(dump)).toBe(true);

    expect(authz.ensureCan).toHaveBeenCalledWith(
      USER,
      'snapshots.restore',
      database.environment.project,
    );
    expect(queue.enqueueSnapshotRestore).toHaveBeenCalledWith(DB_ID, SNAP_ID);
    const outboxTypes = prisma.eventOutbox.create.mock.calls.map(
      ([a]: [{ data: { type: string } }]) => a.data.type,
    );
    expect(outboxTypes).toEqual([
      OUTBOX_EVENT_TYPES.SnapshotImportQueued,
      OUTBOX_EVENT_TYPES.SnapshotRestoreQueued,
    ]);
  });

  it('answers 411 without a Content-Length', async () => {
    const res = await post(
      goodHeaders({
        'Content-Length': undefined,
        'Transfer-Encoding': 'chunked',
      }),
      dump,
    );
    expect(res.status).toBe(411);
    expect(workerCalls).toHaveLength(0);
    expect(rows.size).toBe(0);
  });

  it('answers 413 above DB_IMPORT_MAX_BYTES without reading the body', async () => {
    const res = await post(goodHeaders({ 'Content-Length': MAX_BYTES + 1 }));
    expect(res.status).toBe(413);
    expect(rows.size).toBe(0);
  });

  it('answers 415 for anything but application/octet-stream', async () => {
    const res = await post(
      goodHeaders({ 'Content-Type': 'application/json' }),
      Buffer.from('{}'.padEnd(dump.length)),
    );
    expect(res.status).toBe(415);
  });

  it.each([
    ['MYSQL', 'dump.dump'],
    ['MYSQL', 'dump.txt'],
    ['POSTGRES', 'dump.zip'],
    ['POSTGRES', '.sql'],
    ['POSTGRES', '..%2Fetc%2Fdump.sql'],
  ])('answers 400 for a %s import named %s', async (type, name) => {
    database.type = type;
    const res = await post(goodHeaders({ 'X-Import-Filename': name }), dump);
    expect(res.status).toBe(400);
    expect(rows.size).toBe(0);
  });

  it.each([
    ['POSTGRES', 'prod.dump'],
    ['POSTGRES', 'prod.sql.gz'],
    ['MYSQL', 'prod.SQL.GZ'],
  ])('accepts a %s import named %s', async (type, name) => {
    database.type = type;
    const res = await post(goodHeaders({ 'X-Import-Filename': name }), dump);
    expect(res.status).toBe(202);
  });

  it('answers 400 for engines that cannot import', async () => {
    database.type = 'REDIS';
    const res = await post(goodHeaders(), dump);
    expect(res.status).toBe(400);
  });

  it('answers 409 while the database is not READY', async () => {
    database.status = 'PROVISIONING';
    const res = await post(goodHeaders(), dump);
    expect(res.status).toBe(409);
    expect(rows.size).toBe(0);
  });

  it('answers 409 while another import is in flight', async () => {
    rows.set('other', {
      ...({} as Row),
      id: 'other',
      databaseId: DB_ID,
      importStatus: 'RESTORING',
    });
    const res = await post(goodHeaders(), dump);
    expect(res.status).toBe(409);
    expect(workerCalls).toHaveLength(0);
  });

  it('marks the import FAILED with the worker error when the worker rejects it', async () => {
    workerBehaviour = (_req, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not a gzip stream' }));
    };
    const res = await post(goodHeaders(), dump);

    expect(res.status).toBe(400);
    expect(res.json.message).toBe('not a gzip stream');
    expect(rows.get(SNAP_ID)).toMatchObject({
      status: 'FAILED',
      importStatus: 'FAILED',
      errorSummary: 'not a gzip stream',
    });
    expect(queue.enqueueSnapshotRestore).not.toHaveBeenCalled();
  });

  it('marks the import FAILED when the worker is unreachable', async () => {
    const closed = http.createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((r) => closed.close(r));
    workerUrl = `http://127.0.0.1:${port}`;

    const res = await post(goodHeaders(), dump);

    expect(res.status).toBe(502);
    expect(rows.get(SNAP_ID)).toMatchObject({
      status: 'FAILED',
      importStatus: 'FAILED',
    });
  });

  it('marks the import FAILED when the browser aborts mid-upload', async () => {
    const req = http.request(`${apiUrl}/databases/${DB_ID}/imports`, {
      method: 'POST',
      headers: goodHeaders({ 'Content-Length': 1000 }),
    });
    req.on('error', () => undefined);
    req.write(Buffer.alloc(100));
    await waitFor(() => rows.has(SNAP_ID));
    req.destroy();

    await waitFor(() => rows.get(SNAP_ID)?.status === 'FAILED');
    expect(rows.get(SNAP_ID)).toMatchObject({
      importStatus: 'FAILED',
      errorSummary: 'upload aborted by the client',
    });
    expect(queue.enqueueSnapshotRestore).not.toHaveBeenCalled();
  });

  it('keeps the stored dump but fails the import when the restore cannot be queued', async () => {
    queue.enqueueSnapshotRestore.mockRejectedValueOnce(new Error('redis down'));
    const res = await post(goodHeaders(), dump);

    expect(res.status).toBe(503);
    expect(rows.get(SNAP_ID)).toMatchObject({
      status: 'READY',
      importStatus: 'FAILED',
    });
  });
});

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}
