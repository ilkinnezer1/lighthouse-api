import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { EnvironmentHibernationService } from './environment-hibernation.service';
import { LOCK_SELECT, lockState, type LockColumns } from './environment-lock';
import { decideHibernation } from './hibernation-decision';
import { parseServiceRequestTotals } from './traefik-metrics';

const METRICS_TIMEOUT_MS = 5_000;

interface Candidate extends LockColumns {
  id: string;
  hibernationEnabled: boolean;
  idleTimeoutMinutes: number;
  lastRequestCount: bigint | null;
  lastActivityAt: Date | null;
}

@Injectable()
export class HibernationScheduler {
  private readonly logger = new Logger(HibernationScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly hibernation: EnvironmentHibernationService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async sweep(): Promise<void> {
    const candidates = await this.candidates();
    if (candidates.length === 0) return;

    // Unreachable Traefik is not "no traffic" — reading it that way would sleep
    // every environment at once. Skip the tick; the clocks keep their values.
    const metrics = await this.readMetrics();
    if (!metrics) return;

    const observed = await this.observedPerEnvironment(
      metrics,
      candidates.map((c) => c.id),
    );
    const now = new Date();

    for (const env of candidates) {
      try {
        await this.evaluate(env, observed.get(env.id) ?? null, now);
      } catch (err) {
        this.logger.error(`hibernation sweep failed for ${env.id}`, err);
      }
    }
  }

  private async evaluate(
    env: Candidate,
    observedRequestCount: number | null,
    now: Date,
  ): Promise<void> {
    const current = await this.hibernation.currentDeployment(env.id);

    const decision = decideHibernation({
      lastRequestCount:
        env.lastRequestCount === null ? null : Number(env.lastRequestCount),
      observedRequestCount,
      lastActivityAt: env.lastActivityAt,
      idleTimeoutMinutes: env.idleTimeoutMinutes,
      now,
      vetoes: {
        enabled: env.hibernationEnabled,
        locked: lockState(env, now) !== null,
        deploymentInFlight: await this.hibernation.deploymentInFlight(env.id),
        hasRunningDeployment: current?.hasContainers ?? false,
      },
    });

    if (decision.patch) {
      const { lastRequestCount, lastActivityAt } = decision.patch;
      await this.prisma.environment.update({
        where: { id: env.id },
        data: {
          ...(lastRequestCount === undefined
            ? {}
            : { lastRequestCount: BigInt(Math.round(lastRequestCount)) }),
          ...(lastActivityAt === undefined ? {} : { lastActivityAt }),
        },
      });
    }

    if (!decision.hibernate || !current) return;

    await this.hibernation.stopDeployment(current.id);
    // Guarded so a second API instance that stopped the same containers does
    // not overwrite the first one's timestamp. A duplicate stop is harmless;
    // the write is what has to happen once.
    const slept = await this.prisma.environment.updateMany({
      where: { id: env.id, hibernatedAt: null },
      data: { hibernatedAt: new Date() },
    });
    if (slept.count > 0) {
      this.logger.log(
        `hibernated environment ${env.id} (idle since ${env.lastActivityAt?.toISOString() ?? 'unknown'})`,
      );
    }
  }

  /**
   * Environments opted in and currently awake. Already-sleeping ones are
   * excluded rather than vetoed: their containers are stopped, so Traefik has
   * no series for them and there is nothing left to measure or to stop.
   */
  private candidates(): Promise<Candidate[]> {
    return this.prisma.environment.findMany({
      where: {
        hibernationEnabled: true,
        hibernatedAt: null,
        active: true,
        project: { deletedAt: null },
      },
      select: {
        id: true,
        hibernationEnabled: true,
        idleTimeoutMinutes: true,
        lastRequestCount: true,
        lastActivityAt: true,
        ...LOCK_SELECT,
      },
    });
  }

  /**
   * Per-environment totals, summed over the deployments Traefik currently has
   * a series for. An environment with no series at all maps to no entry —
   * absence is not a reading, and must never be flattened to zero.
   */
  private async observedPerEnvironment(
    perDeployment: Map<string, number>,
    environmentIds: string[],
  ): Promise<Map<string, number>> {
    const totals = new Map<string, number>();
    const deploymentIds = [...perDeployment.keys()];
    if (deploymentIds.length === 0) return totals;

    const rows = await this.prisma.deployment.findMany({
      where: {
        id: { in: deploymentIds },
        environmentId: { in: environmentIds },
      },
      select: { id: true, environmentId: true },
    });

    for (const row of rows) {
      const count = perDeployment.get(row.id) ?? 0;
      totals.set(
        row.environmentId,
        (totals.get(row.environmentId) ?? 0) + count,
      );
    }
    return totals;
  }

  private async readMetrics(): Promise<Map<string, number> | null> {
    const url = this.config.get('TRAEFIK_METRICS_URL', { infer: true });
    try {
      const resp = await fetch(url, {
        signal: AbortSignal.timeout(METRICS_TIMEOUT_MS),
      });
      if (!resp.ok) {
        this.logger.warn(`traefik metrics returned ${resp.status}`);
        return null;
      }
      return parseServiceRequestTotals(await resp.text());
    } catch (err) {
      this.logger.warn(
        `traefik metrics unreachable: ${(err as Error).message}`,
      );
      return null;
    }
  }
}
