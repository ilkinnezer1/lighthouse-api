import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { User } from '@prisma/client';
import { Audit } from '../audit/audit.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AuthzService } from '../authz/authz.service';
import type { Action } from '../common/authz';
import { PrismaService } from '../prisma/prisma.service';
import { CreateScheduledTaskDto } from './dto/create-scheduled-task.dto';
import { ListScheduledTasksDto } from './dto/list-scheduled-tasks.dto';
import { UpdateScheduledTaskDto } from './dto/update-scheduled-task.dto';
import { ScheduledTasksRunner } from './scheduled-tasks.runner';
import { ScheduledTasksService } from './scheduled-tasks.service';

@Controller()
@UseGuards(JwtAuthGuard)
export class ScheduledTasksController {
  constructor(
    private readonly tasks: ScheduledTasksService,
    private readonly runner: ScheduledTasksRunner,
    private readonly prisma: PrismaService,
    private readonly authz: AuthzService,
  ) {}

  // Global feed across every project in the caller's active org.
  @Get('scheduled-tasks')
  async listAll(
    @Query() query: ListScheduledTasksDto,
    @CurrentUser() user: User,
  ) {
    const orgId = await this.authz.resolveScopeOrgId(user, query.orgId);
    return this.tasks.listForOrg(orgId, query);
  }

  @Get('environments/:envId/scheduled-tasks')
  async list(
    @Param('envId', new ParseUUIDPipe()) envId: string,
    @CurrentUser() user: User,
  ) {
    await this.authorizeEnv(envId, user, 'environments.read');
    return this.tasks.list(envId);
  }

  @Post('environments/:envId/scheduled-tasks')
  @Audit('scheduled-tasks.create')
  async create(
    @Param('envId', new ParseUUIDPipe()) envId: string,
    @Body() dto: CreateScheduledTaskDto,
    @CurrentUser() user: User,
  ) {
    const env = await this.authorizeEnv(envId, user, 'environments.update');
    // Preview environments are torn down with their PR; a schedule attached to
    // one would never fire, so refuse rather than create a dead task.
    if (env.type === 'PREVIEW') {
      throw new BadRequestException(
        'Scheduled tasks are not available on preview environments',
      );
    }
    return this.tasks.create(envId, dto);
  }

  @Patch('scheduled-tasks/:id')
  @Audit('scheduled-tasks.update')
  async update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateScheduledTaskDto,
    @CurrentUser() user: User,
  ) {
    await this.authorizeTask(id, user, 'environments.update');
    return this.tasks.update(id, dto);
  }

  @Delete('scheduled-tasks/:id')
  @Audit('scheduled-tasks.delete')
  async remove(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: User,
  ) {
    await this.authorizeTask(id, user, 'environments.update');
    await this.tasks.remove(id);
  }

  @Get('scheduled-tasks/:id/runs')
  async runs(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: User,
  ) {
    await this.authorizeTask(id, user, 'environments.read');
    return this.tasks.runs(id);
  }

  // Running a task by hand executes a command in a container, so it is gated on
  // the same capability as the terminal rather than on environment writes.
  @Post('scheduled-tasks/:id/run')
  @Audit('scheduled-tasks.run')
  async runNow(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: User,
  ) {
    await this.authorizeTask(id, user, 'deployments.exec');
    const task = await this.tasks.findOrThrow(id);
    return this.runner.run(task, 'MANUAL');
  }

  private async authorizeEnv(envId: string, user: User, action: Action) {
    const env = await this.prisma.environment.findUnique({
      where: { id: envId },
      select: { id: true, type: true, project: true },
    });
    if (!env || env.project.deletedAt) throw new NotFoundException();
    await this.authz.ensureCan(user, action, env.project);
    return env;
  }

  private async authorizeTask(id: string, user: User, action: Action) {
    const env = await this.tasks.environmentOf(id);
    if (env.project.deletedAt) throw new NotFoundException();
    await this.authz.ensureCan(user, action, env.project);
    return env;
  }
}
