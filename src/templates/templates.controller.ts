import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { User } from '@prisma/client';
import type { Request } from 'express';
import { Audit } from '../audit/audit.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AuthzService } from '../authz/authz.service';
import { isReservedSubdomain } from '../projects/util/subdomain';
import { InstantiateTemplateDto } from './dto/instantiate-template.dto';
import { findTemplate } from './templates.catalog';
import { TemplatesService } from './templates.service';

// The catalog is static and identical for everyone, so listing needs auth but
// no authz. Instantiating creates a project and is gated exactly like creating
// one by hand — `projects.create`, Member and up.
@Controller('templates')
@UseGuards(JwtAuthGuard)
export class TemplatesController {
  constructor(
    private readonly templates: TemplatesService,
    private readonly authz: AuthzService,
  ) {}

  @Get()
  list() {
    return this.templates.list();
  }

  @Get(':slug')
  findOne(@Param('slug') slug: string) {
    const spec = findTemplate(slug);
    if (!spec) {
      throw new NotFoundException('Unknown template');
    }
    return this.templates.list().find((t) => t.slug === spec.slug);
  }

  @Post(':slug/instantiate')
  @Audit('templates.instantiate')
  async instantiate(
    @Param('slug') slug: string,
    @Body() dto: InstantiateTemplateDto,
    @CurrentUser() user: User,
    @Req() req: Request,
  ) {
    const spec = findTemplate(slug);
    if (!spec) {
      throw new NotFoundException('Unknown template');
    }
    if (dto.subdomain && isReservedSubdomain(dto.subdomain)) {
      throw new BadRequestException('Subdomain is reserved');
    }

    // Same gate as POST /projects: targeting a shared org needs membership;
    // absent, the service falls back to the caller's personal org.
    if (dto.organizationId) {
      await this.authz.ensureCan(user, 'projects.create', {
        organizationId: dto.organizationId,
      });
    }

    const result = await this.templates.instantiate(user.id, spec, dto);
    req.auditContext = {
      template: spec.slug,
      projectId: result.project.id,
      deploymentId: result.deploymentId,
    };
    return result;
  }
}
