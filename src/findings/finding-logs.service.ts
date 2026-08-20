import { Injectable, Logger } from '@nestjs/common';
import { LogSnapshotStatus } from '@prisma/client';
import { WorkerProxyService } from '../deployments/worker-proxy.service';

const TAIL_LINES = 200;
const MAX_SNAPSHOT_BYTES = 64 * 1024;
const CAPTURE_TIMEOUT_MS = 5_000;

export interface CapturedLogs {
  status: LogSnapshotStatus;
  text: string | null;
  truncated: boolean;
}

const UNAVAILABLE: CapturedLogs = {
  status: LogSnapshotStatus.UNAVAILABLE,
  text: null,
  truncated: false,
};

export interface LogTarget {
  name: string;
  containerId: string | null;
}

/**
 * The one piece of evidence that cannot be recovered by joining the deployment
 * later: runtime logs are `docker logs` on a container the next deploy throws
 * away. Captured here, at creation, or not at all.
 *
 * Best-effort by construction — every failure path returns UNAVAILABLE and
 * nothing throws, because a finding must still be filable when the container is
 * already gone or the worker is unreachable. Losing the logs is a shame; losing
 * the bug report is the failure this feature exists to prevent.
 */
@Injectable()
export class FindingLogsService {
  private readonly logger = new Logger(FindingLogsService.name);

  constructor(private readonly worker: WorkerProxyService) {}

  async capture(
    deploymentId: string,
    target: LogTarget | undefined,
  ): Promise<CapturedLogs> {
    if (!target?.containerId) return UNAVAILABLE;

    const params = new URLSearchParams({
      follow: '0',
      tail: String(TAIL_LINES),
      service: target.name,
    });

    try {
      const { text, truncated } = await this.worker.text(
        `/deployments/${deploymentId}/logs?${params.toString()}`,
        { signal: AbortSignal.timeout(CAPTURE_TIMEOUT_MS) },
        {
          notFound: 'No running container for this deployment',
          failed: 'Worker log capture failed',
        },
        MAX_SNAPSHOT_BYTES,
      );
      // CAPTURED with empty text is a real answer: the app printed nothing.
      return { status: LogSnapshotStatus.CAPTURED, text, truncated };
    } catch (err) {
      this.logger.warn(
        `log capture unavailable for deployment ${deploymentId}: ${
          (err as Error).message
        }`,
      );
      return UNAVAILABLE;
    }
  }
}
