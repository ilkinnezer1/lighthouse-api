import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
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
import { CryptoService } from '../crypto/crypto.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { ProjectsService } from './projects.service';
import { generateSubdomain, isReservedSubdomain } from './util/subdomain';
import { slugify } from './util/slug';

const MAX_SUBDOMAIN_TRIES = 5;
@Controller('projects')
@UseGuards(JwtAuthGuard)
export class ProjectsController {
  constructor(
    private readonly projects: ProjectsService,
    private readonly crypto: CryptoService,
    private readonly authz: AuthzService,
  ) {}

  @Post()
  @Audit('projects.create')
  async create(@Body() dto: CreateProjectDto, @CurrentUser() user: User) {
    if (dto.subdomain && isReservedSubdomain(dto.subdomain)) {
      throw new BadRequestException('Subdomain is reserved');
    }

    // Targeting a shared org requires membership + `projects.create` (Member+);
    // ensureCan denies non-members. Absent → the service uses the personal org.
    if (dto.organizationId) {
      await this.authz.ensureCan(user, 'projects.create', {
        organizationId: dto.organizationId,
      });
    }

    const slug = slugify(dto.name) || generateSubdomain();
    const subdomainProvided = Boolean(dto.subdomain);

    for (let attempt = 1; attempt <= MAX_SUBDOMAIN_TRIES; attempt++) {
      const subdomain = dto.subdomain ?? generateSubdomain();

      try {
        return await this.projects.create(user.id, {
          name: dto.name,
          slug,
          subdomain,
          repoUrl: dto.repoUrl,
          defaultBranch: dto.defaultBranch,
          organizationId: dto.organizationId,
        });
      } catch (err) {
        const isSubdomainConflict =
          err instanceof ConflictException &&
          err.message.toLowerCase().includes('subdomain');

        if (
          isSubdomainConflict &&
          !subdomainProvided &&
          attempt < MAX_SUBDOMAIN_TRIES
        ) {
          continue;
        }
        throw err;
      }
    }
    throw new ConflictException('Could not allocate a unique subdomain');
  }

  @Get()
  async list(
    @CurrentUser() user: User,
    @Query('orgId', new ParseUUIDPipe({ optional: true })) orgId?: string,
  ) {
    const scopeOrgId = await this.authz.resolveScopeOrgId(user, orgId);
    return this.projects.listForOrg(scopeOrgId);
  }

  @Get(':id')
  async findOne(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: User,
  ) {
    const project = await this.projects.findById(id);
    if (!project) {
      throw new NotFoundException();
    }
    await this.authz.ensureCan(user, 'projects.read', project);

    // tolerate an undecryptable secret (e.g. encrypted under a rotated key) so
    // the detail page loads instead of 500-ing
    let webhookSecret: string | null = null;
    if (project.webhookSecretEnc) {
      try {
        webhookSecret = this.crypto.decrypt(project.webhookSecretEnc);
      } catch {
        webhookSecret = null;
      }
    }
    return { ...project, webhookSecret };
  }

  @Get(':id/branches')
  async branches(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('base') base: string | undefined,
    @Query('refresh') refresh: string | undefined,
    @CurrentUser() user: User,
  ) {
    const project = await this.projects.findById(id);
    if (!project) {
      throw new NotFoundException();
    }
    await this.authz.ensureCan(user, 'projects.read', project);
    return this.projects.listBranches(
      project,
      base?.trim() || undefined,
      refresh === '1' || refresh === 'true',
    );
  }

  @Patch(':id')
  @Audit('projects.update')
  async update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateProjectDto,
    @CurrentUser() user: User,
  ) {
    const existing = await this.projects.findById(id);
    if (!existing) {
      throw new NotFoundException();
    }
    await this.authz.ensureCan(user, 'projects.update', existing);
    return this.projects.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Audit('projects.delete')
  async remove(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: User,
  ) {
    const existing = await this.projects.findById(id);
    if (!existing) {
      throw new NotFoundException();
    }
    await this.authz.ensureCan(user, 'projects.delete', existing);
    await this.projects.softDelete(id);
  }
}
