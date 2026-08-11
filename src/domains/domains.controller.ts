import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Put,
  UseGuards,
} from '@nestjs/common';
import type { User } from '@prisma/client';
import { Audit } from '../audit/audit.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AuthzService } from '../authz/authz.service';
import type { Action } from '../common/authz';
import { PrismaService } from '../prisma/prisma.service';
import { SetDomainDto } from './dto/set-domain.dto';
import { DomainsService } from './domains.service';

// A custom domain replaces the generated `<env>.<project>.<org>.<base>` host.
// Nothing here touches the worker: it already prefers `custom_domain` when
// building both the deploy URL and the Traefik Host rule. Labels are baked when
// a container is created, so a change only takes effect on the next deploy.
@Controller('environments/:id/domain')
@UseGuards(JwtAuthGuard)
export class DomainsController {
  constructor(
    private readonly domains: DomainsService,
    private readonly prisma: PrismaService,
    private readonly authz: AuthzService,
  ) {}

  @Get()
  async get(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: User,
  ) {
    await this.authorize(id, user, 'environments.read');
    return this.domains.get(id);
  }

  @Put()
  @Audit('environments.domain-set')
  async set(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: SetDomainDto,
    @CurrentUser() user: User,
  ) {
    await this.authorize(id, user, 'environments.update');
    return this.domains.set(id, dto.domain);
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Audit('environments.domain-clear')
  async clear(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: User,
  ): Promise<void> {
    await this.authorize(id, user, 'environments.update');
    await this.domains.clear(id);
  }

  @Get('check')
  async check(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: User,
  ) {
    await this.authorize(id, user, 'environments.read');
    return this.domains.check(id);
  }

  private async authorize(
    id: string,
    user: User,
    action: Action,
  ): Promise<void> {
    const env = await this.prisma.environment.findUnique({
      where: { id },
      select: {
        project: { select: { organizationId: true, deletedAt: true } },
      },
    });
    if (!env || env.project.deletedAt) {
      throw new NotFoundException('Environment not found');
    }
    await this.authz.ensureCan(user, action, env.project);
  }
}
