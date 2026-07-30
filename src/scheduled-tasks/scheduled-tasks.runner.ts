import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TaskRunTrigger, type ScheduledTask } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { Env } from '../config/env';

const RS = '\x1e';
// A task on `* * * * *` is 1440 runs a day; only a tail is ever kept.
const OUTPUT_TAIL_CHARS = 8_000;

export interface RunOutcome {
  runId: string;
  status: 'SUCCEEDED' | 'FAILED' | 'SKIPPED';
  exitCode: number | null;
}

@Injectable()
export class ScheduledTasksRunner {
  private readonly logger = new Logger(ScheduledTasksRunner.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * Runs a task's command in the environment's currently-live deployment.
   *
   * Reuses the worker's existing exec endpoint — the same one that powers
   * manual maintenance actions — so scheduling adds no new execution path and
   * no new worker surface.
   */
  async run(task: ScheduledTask, trigger: TaskRunTrigger): Promise<RunOutcome> {
    if (task.overlap === 'SKIP') {
      const inFlight = await this.prisma.taskRun.findFirst({
        where: { taskId: task.id, status: 'RUNNING' },
        select: { id: true },
      });
      if (inFlight) {
        const run = await this.prisma.taskRun.create({
          data: {
            taskId: task.id,
            status: 'SKIPPED',
            trigger,
            finishedAt: new Date(),
            errorSummary: 'previous run still in progress',
          },
          select: { id: true },
        });
        return { runId: run.id, status: 'SKIPPED', exitCode: null };
      }
    }

    const deployment = await this.resolveLiveDeployment(task.environmentId);

    const run = await this.prisma.taskRun.create({
      data: {
        taskId: task.id,
        deploymentId: deployment?.id ?? null,
        status: 'RUNNING',
        trigger,
      },
      select: { id: true },
    });

    if (!deployment) {
      return this.finish(run.id, task.id, {
        status: 'FAILED',
        exitCode: null,
        errorSummary: 'no live deployment for this environment',
      });
    }

    const target = deployment.services.find((s) => s.name === task.service);
    if (!target?.containerId) {
      return this.finish(run.id, task.id, {
        status: 'FAILED',
        exitCode: null,
        errorSummary: `service "${task.service}" has no running container`,
      });
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), task.timeoutSec * 1000);

    try {
      const workerUrl = this.config.get('WORKER_HTTP_URL', { infer: true });
      const url = `${workerUrl}/deployments/${deployment.id}/services/${encodeURIComponent(task.service)}/run`;

      const upstream = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: task.command }),
        signal: ac.signal,
      });

      if (!upstream.ok || !upstream.body) {
        return this.finish(run.id, task.id, {
          status: 'FAILED',
          exitCode: null,
          errorSummary: `worker returned ${upstream.status}`,
        });
      }

      const { output, exitCode } = await this.drain(upstream.body);
      const ok = exitCode === 0;
      return this.finish(run.id, task.id, {
        status: ok ? 'SUCCEEDED' : 'FAILED',
        exitCode,
        output,
        errorSummary: ok
          ? null
          : this.explainFailure(exitCode, output, task.command),
      });
    } catch (err) {
      const aborted = ac.signal.aborted;
      return this.finish(run.id, task.id, {
        status: 'FAILED',
        exitCode: null,
        errorSummary: aborted
          ? `timed out after ${task.timeoutSec}s`
          : `worker unreachable: ${(err as Error).message}`,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * "Live" is the newest deployment that reached a serving state. Rollback
   * creates a *newer* deployment, so newest-first is correct.
   */
  private async resolveLiveDeployment(environmentId: string) {
    return this.prisma.deployment.findFirst({
      where: { environmentId, status: { in: ['SUCCEEDED', 'RUNNING'] } },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        services: { select: { name: true, containerId: true } },
      },
    });
  }

  private async drain(
    body: ReadableStream<Uint8Array>,
  ): Promise<{ output: string; exitCode: number | null }> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // Keep memory bounded on a chatty command; only the tail is stored.
      if (buf.length > OUTPUT_TAIL_CHARS * 4) {
        buf = buf.slice(-OUTPUT_TAIL_CHARS * 2);
      }
    }
    buf += decoder.decode();

    // The worker terminates the stream with `\x1e{"exitCode":N}`.
    let exitCode: number | null = null;
    const rs = buf.lastIndexOf(RS);
    if (rs !== -1) {
      try {
        const frame = JSON.parse(buf.slice(rs + 1)) as { exitCode?: number };
        exitCode = frame.exitCode ?? null;
      } catch {
        // Malformed trailer — treat as unknown rather than failing the parse.
      }
      buf = buf.slice(0, rs);
    }

    return { output: buf.slice(-OUTPUT_TAIL_CHARS), exitCode };
  }

  /**
   * The two failures that are painful to diagnose from an exit code alone:
   * a missing interpreter (alpine has no bash) and a non-executable script.
   */
  private explainFailure(
    exitCode: number | null,
    output: string,
    command: string,
  ): string {
    const tail = output.toLowerCase();
    if (exitCode === 127 || tail.includes('not found')) {
      const bin = command.trim().split(/\s+/)[0];
      return `"${bin}" not found in the container — alpine images ship sh, not bash; install it or invoke a different interpreter`;
    }
    if (exitCode === 126 || tail.includes('permission denied')) {
      return 'permission denied — the script is not executable; invoke it through an interpreter (e.g. `sh scripts/task.sh`)';
    }
    return `exited with code ${exitCode ?? 'unknown'}`;
  }

  private async finish(
    runId: string,
    taskId: string,
    data: {
      status: 'SUCCEEDED' | 'FAILED';
      exitCode: number | null;
      output?: string;
      errorSummary?: string | null;
    },
  ): Promise<RunOutcome> {
    const finishedAt = new Date();
    await this.prisma.$transaction([
      this.prisma.taskRun.update({
        where: { id: runId },
        data: {
          status: data.status,
          exitCode: data.exitCode,
          output: data.output ?? null,
          errorSummary: data.errorSummary ?? null,
          finishedAt,
        },
      }),
      this.prisma.scheduledTask.update({
        where: { id: taskId },
        data: { lastRunAt: finishedAt },
      }),
    ]);

    if (data.status === 'FAILED') {
      this.logger.warn(`task ${taskId} failed: ${data.errorSummary}`);
    }
    return { runId, status: data.status, exitCode: data.exitCode };
  }
}
