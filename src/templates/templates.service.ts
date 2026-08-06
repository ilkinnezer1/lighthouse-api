import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { buildDeployUrl } from '../common/url';
import type { Env } from '../config/env';
import { DeploymentsService } from '../deployments/deployments.service';
import { EnvVarsService } from '../env-vars/env-vars.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectsService, type ProjectWithEnvironments } from '../projects/projects.service';
import { slugify } from '../projects/util/slug';
import { generateSubdomain } from '../projects/util/subdomain';
import type { InstantiateTemplateDto } from './dto/instantiate-template.dto';
import { TEMPLATE_CATALOG } from './templates.catalog';
import type {
  TemplateEnvGenerator,
  TemplateSpec,
  TemplateSummary,
} from './templates.types';

const MAX_SUBDOMAIN_TRIES = 5;
// Ambiguous glyphs removed: these passwords get read off a screen and retyped.
const PASSWORD_ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export interface InstantiateResult {
  project: ProjectWithEnvironments;
  environmentId: string;
  url: string;
  deploymentId: string | null;
  postInstall?: string;
}

@Injectable()
export class TemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
    private readonly envVars: EnvVarsService,
    private readonly deployments: DeploymentsService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  list(): TemplateSummary[] {
    return TEMPLATE_CATALOG.map(summarize);
  }

  /**
   * Create a project wired to run the template's image, seed its environment
   * variables, and queue the first deploy.
   *
   * Ordering matters: env vars are written BEFORE the deploy is queued, because
   * the worker decrypts `env_vars_enc` when it runs and an app that boots
   * without its secrets (Ghost without `url`, Gitea without a root URL) writes
   * the wrong value into its own persistent config on first run.
   */
  async instantiate(
    userId: string,
    spec: TemplateSpec,
    dto: InstantiateTemplateDto,
  ): Promise<InstantiateResult> {
    const name = dto.name?.trim() || spec.name;
    // Validate the answers BEFORE anything is created. Generating values needs
    // the deploy URL, which needs the project — but rejecting a bad key must
    // not leave an orphaned project behind, so the check runs on its own first.
    assertEnvAnswerable(spec, dto.env ?? {});

    const project = await this.createProject(userId, spec, dto, name);
    const environment = project.environments[0];

    await this.projects.update(project.id, {
      buildConfig: buildConfigFor(spec),
    });

    const url = await this.urlFor(project.id, project.subdomain, environment.subdomain);
    const vars = resolveEnv(spec, dto.env ?? {}, url);
    if (Object.keys(vars).length > 0) {
      await this.envVars.replace(environment.id, { vars });
    }

    let deploymentId: string | null = null;
    if (dto.deploy !== false) {
      // No branch options: `resolve` short-circuits to an empty branch set, so
      // this never reaches GitHub — which matters, since the template's repoUrl
      // is upstream metadata the caller has no token for.
      const deployment = await this.deployments.create(environment.id, userId);
      deploymentId = deployment.id;
    }

    return {
      project: await this.reload(project.id),
      environmentId: environment.id,
      url,
      deploymentId,
      postInstall: spec.postInstall,
    };
  }

  // Mirrors ProjectsController.create's retry: a generated subdomain can collide,
  // and a caller-supplied one must surface the conflict rather than be replaced.
  private async createProject(
    userId: string,
    spec: TemplateSpec,
    dto: InstantiateTemplateDto,
    name: string,
  ): Promise<ProjectWithEnvironments> {
    const slug = slugify(name) || spec.slug;
    const subdomainProvided = Boolean(dto.subdomain);

    for (let attempt = 1; attempt <= MAX_SUBDOMAIN_TRIES; attempt++) {
      try {
        return await this.projects.create(userId, {
          name,
          slug,
          subdomain: dto.subdomain ?? generateSubdomain(),
          repoUrl: spec.repoUrl,
          defaultBranch: 'main',
          organizationId: dto.organizationId,
        });
      } catch (err) {
        const isSubdomainConflict =
          err instanceof ConflictException &&
          err.message.toLowerCase().includes('subdomain');
        if (isSubdomainConflict && !subdomainProvided && attempt < MAX_SUBDOMAIN_TRIES) {
          continue;
        }
        throw err;
      }
    }
    throw new ConflictException('Could not allocate a unique subdomain');
  }

  private async urlFor(
    projectId: string,
    projectSubdomain: string,
    envSubdomain: string,
  ): Promise<string> {
    const project = await this.prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { organization: { select: { slug: true } } },
    });
    return buildDeployUrl({
      mode: this.config.get('MODE', { infer: true }),
      baseDomain: this.config.get('BASE_DOMAIN', { infer: true }),
      identity: project.organization.slug,
      projectSubdomain,
      envSubdomain,
    });
  }

  private reload(id: string): Promise<ProjectWithEnvironments> {
    return this.prisma.project.findUniqueOrThrow({
      where: { id },
      include: { environments: true },
    });
  }
}

// The template's runtime, expressed entirely in fields the worker already reads.
// No new buildConfig key, and therefore no worker change: 'image' retags the
// pulled image as the deployment's own, so run/health/retire/rollback are the
// same code path every other strategy uses.
function buildConfigFor(spec: TemplateSpec): Record<string, unknown> {
  const config: Record<string, unknown> = {
    strategy: 'image',
    image: spec.image,
    port: spec.port,
  };
  if (spec.volumes?.length) {
    config.volumes = spec.volumes;
  }
  if (spec.cpuLimit !== undefined) {
    config.cpuLimit = spec.cpuLimit;
  }
  if (spec.memoryMb !== undefined) {
    config.memoryMb = spec.memoryMb;
  }
  return config;
}

/**
 * Reject answers the template can't accept, without touching the database.
 *
 * Generated fields are produced server-side and are NOT accepted from the
 * request — a caller who could pass `N8N_ENCRYPTION_KEY` or `ADMIN_TOKEN`
 * straight through would turn "we made you a secret" into "we stored the one
 * you sent", which is a different security property than the UI advertises.
 */
function assertEnvAnswerable(spec: TemplateSpec, supplied: Record<string, string>): void {
  const fields = spec.env ?? [];
  const promptable = new Set(fields.filter((f) => !f.generate).map((f) => f.key));

  const unknown = Object.keys(supplied).filter((k) => !promptable.has(k));
  if (unknown.length > 0) {
    const generated = fields.filter((f) => f.generate).map((f) => f.key);
    const rejected = unknown.filter((k) => generated.includes(k));
    throw new BadRequestException(
      rejected.length > 0
        ? `These values are generated by the server and cannot be set: ${rejected.join(', ')}`
        : `Unknown environment key(s) for this template: ${unknown.join(', ')}`,
    );
  }

  for (const field of fields) {
    if (field.generate || !field.required) continue;
    if (!(supplied[field.key]?.trim() || field.default)) {
      throw new BadRequestException(`Missing required value: ${field.label} (${field.key})`);
    }
  }
}

// Merge the caller's answers with the values only the server can produce.
// Assumes assertEnvAnswerable already passed.
function resolveEnv(
  spec: TemplateSpec,
  supplied: Record<string, string>,
  url: string,
): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const field of spec.env ?? []) {
    if (field.generate) {
      vars[field.key] = generateValue(field.generate, url);
      continue;
    }
    const value = supplied[field.key]?.trim() || field.default;
    if (value) {
      vars[field.key] = value;
    }
  }
  return vars;
}

function generateValue(kind: TemplateEnvGenerator, url: string): string {
  switch (kind) {
    case 'secret32':
      return randomBytes(32).toString('base64');
    case 'hex32':
      return randomBytes(32).toString('hex');
    case 'password':
      return Array.from(
        { length: 24 },
        () => PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)],
      ).join('');
    case 'uuid':
      return randomUUID();
    case 'domain':
      return new URL(url).host;
    case 'url':
      return url;
  }
}

function summarize(spec: TemplateSpec): TemplateSummary {
  const fields = spec.env ?? [];
  return {
    slug: spec.slug,
    name: spec.name,
    description: spec.description,
    category: spec.category,
    website: spec.website,
    image: spec.image,
    port: spec.port,
    volumeCount: spec.volumes?.length ?? 0,
    promptedEnv: fields.filter((f) => !f.generate),
    generatedEnvCount: fields.filter((f) => f.generate).length,
    postInstall: spec.postInstall,
  };
}
