import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { User } from '@prisma/client';
import type { Request, Response } from 'express';
import { Audit } from '../audit/audit.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import {
  MaintenanceActionsSchema,
  type MaintenanceAction,
} from '../projects/dto/build-config.schema';
import {
  DeploymentAccessService,
  type DeploymentDetail,
} from './deployment-access.service';
import { FRAMEWORK_PRESETS } from './maintenance-presets';
import { WorkerProxyService } from './worker-proxy.service';

// What the client receives for a maintenance action — never the command.
interface PublicMaintenanceAction {
  id: string;
  label: string;
  service: string;
  destructive: boolean;
}

@Controller()
@UseGuards(JwtAuthGuard)
export class DeploymentActionsController {
  constructor(
    private readonly access: DeploymentAccessService,
    private readonly worker: WorkerProxyService,
  ) {}

  // Lists the curated maintenance actions available for this deployment — the
  // project's allowlist, filtered to actions whose target service has a live
  // container. The `command` is never exposed; the client triggers by id only.
  @Get('deployments/:id/actions')
  async listActions(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: User,
  ): Promise<{ actions: PublicMaintenanceAction[] }> {
    const dep = await this.access.detail(id, user, 'deployments.exec');

    const actions = maintenanceActionsFor(dep)
      .filter((a) => hasContainer(dep, a.service))
      .map(
        (a): PublicMaintenanceAction => ({
          id: a.id,
          label: a.label,
          service: a.service,
          destructive: a.destructive ?? false,
        }),
      );
    return { actions };
  }

  // Runs a curated maintenance command in the target service's container and
  // streams its merged stdout/stderr (then a `\x1e{"exitCode":N}` frame) straight
  // through from the worker — same streaming path as runtime-logs. The client
  // sends only an action id; the API resolves the command from the allowlist.
  @Post('deployments/:id/actions/:actionId')
  @Audit('deployments.action')
  async runAction(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('actionId') actionId: string,
    @CurrentUser() user: User,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const dep = await this.access.detail(id, user, 'deployments.exec');

    const action = maintenanceActionsFor(dep).find((a) => a.id === actionId);
    if (!action) {
      throw new BadRequestException(`Unknown action: ${actionId}`);
    }
    const target = dep.services.find((s) => s.name === action.service);
    if (!target?.containerId) {
      throw new NotFoundException('No running container for this action');
    }

    const ac = new AbortController();
    req.on('close', () => ac.abort());

    await this.worker.stream(
      res,
      `/deployments/${id}/services/${encodeURIComponent(action.service)}/run`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: action.command }),
        signal: ac.signal,
      },
      {
        notFound: 'No running container for this action',
        failed: 'Maintenance command failed',
      },
    );
  }
}

// Resolves the maintenance action allowlist for a deployment: the built-in
// presets for its detected framework, merged with the project's hand-written
// actions by id (a project action overrides the preset of the same id; project-
// only ids are appended). Unknown/NULL framework contributes no presets. The
// project actions are validated on their own so a stale/extra buildConfig field
// can't hide the catalog.
function maintenanceActionsFor(dep: DeploymentDetail): MaintenanceAction[] {
  const presets = FRAMEWORK_PRESETS[dep.framework ?? ''] ?? [];

  const raw = (
    dep.environment.project.buildConfig as {
      maintenanceActions?: unknown;
    } | null
  )?.maintenanceActions;
  const parsed = MaintenanceActionsSchema.safeParse(raw);
  const custom = parsed.success ? parsed.data : [];

  const byId = new Map<string, MaintenanceAction>();
  for (const action of [...presets, ...custom]) {
    byId.set(action.id, action);
  }
  return [...byId.values()];
}

function hasContainer(dep: DeploymentDetail, service: string): boolean {
  return !!dep.services.find((s) => s.name === service)?.containerId;
}
