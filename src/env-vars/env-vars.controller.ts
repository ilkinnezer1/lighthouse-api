import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Put,
  UseGuards,
} from '@nestjs/common';
import type { User } from '@prisma/client';
import { Audit } from '../audit/audit.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Action, ensureCan } from '../common/authz';
import { PrismaService } from '../prisma/prisma.service';
import { SetEnvVarsDto } from './dto/set-env-vars.dto';
import { EnvVarsService } from './env-vars.service';

@Controller('environments/:envId/env-vars')
@UseGuards(JwtAuthGuard)
export class EnvVarsController {
  constructor(
    private readonly envVars: EnvVarsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  async list(
    @Param('envId', new ParseUUIDPipe()) envId: string,
    @CurrentUser() user: User,
  ) {
    await this.authorize(envId, user, 'environments.read');
    return this.envVars.list(envId);
  }

  @Put()
  @Audit('env-vars.replace')
  async replace(
    @Param('envId', new ParseUUIDPipe()) envId: string,
    @Body() dto: SetEnvVarsDto,
    @CurrentUser() user: User,
  ) {
    await this.authorize(envId, user, 'environments.update');
    return this.envVars.replace(envId, dto);
  }

  @Patch()
  @Audit('env-vars.update')
  async merge(
    @Param('envId', new ParseUUIDPipe()) envId: string,
    @Body() dto: SetEnvVarsDto,
    @CurrentUser() user: User,
  ) {
    await this.authorize(envId, user, 'environments.update');
    return this.envVars.merge(envId, dto);
  }

  @Delete(':key')
  @Audit('env-vars.delete')
  async remove(
    @Param('envId', new ParseUUIDPipe()) envId: string,
    @Param('key') key: string,
    @CurrentUser() user: User,
  ) {
    await this.authorize(envId, user, 'environments.update');
    return this.envVars.remove(envId, key);
  }

  /** Load the owning project for the authz check; 404s a missing/deleted env. */
  private async authorize(
    envId: string,
    user: User,
    action: Action,
  ): Promise<void> {
    const env = await this.prisma.environment.findUnique({
      where: { id: envId },
      select: { project: { select: { ownerId: true, deletedAt: true } } },
    });
    if (!env || env.project.deletedAt) {
      throw new NotFoundException('Environment not found');
    }
    ensureCan(user, action, env.project);
  }
}
