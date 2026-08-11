import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CryptoService } from '../crypto/crypto.service';
import { PrismaService } from '../prisma/prisma.service';
import { SetEnvVarsDto } from './dto/set-env-vars.dto';

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Values are write-only over the API: the worker decrypts the blob server-side,
// the web never needs the plaintext back.
const MASK = '••••••';

export interface EnvVarSummary {
  key: string;
  value: string;
}

@Injectable()
export class EnvVarsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  async list(environmentId: string): Promise<EnvVarSummary[]> {
    return summarize(await this.load(environmentId));
  }

  /** Replace the whole set with the request's vars. */
  async replace(
    environmentId: string,
    dto: SetEnvVarsDto,
  ): Promise<EnvVarSummary[]> {
    const next = this.normalize(dto);
    await this.save(environmentId, next);
    return summarize(next);
  }

  /** Upsert a subset, leaving untouched keys in place. */
  async merge(
    environmentId: string,
    dto: SetEnvVarsDto,
  ): Promise<EnvVarSummary[]> {
    const next = {
      ...(await this.load(environmentId)),
      ...this.normalize(dto),
    };
    await this.save(environmentId, next);
    return summarize(next);
  }

  async remove(environmentId: string, key: string): Promise<EnvVarSummary[]> {
    const current = await this.load(environmentId);
    if (!(key in current)) {
      throw new NotFoundException(`No env var "${key}"`);
    }
    delete current[key];
    await this.save(environmentId, current);
    return summarize(current);
  }

  private async load(environmentId: string): Promise<Record<string, string>> {
    const env = await this.prisma.environment.findUnique({
      where: { id: environmentId },
      select: { envVarsEnc: true },
    });
    if (!env) {
      throw new NotFoundException('Environment not found');
    }
    return env.envVarsEnc
      ? (JSON.parse(this.crypto.decrypt(env.envVarsEnc)) as Record<
          string,
          string
        >)
      : {};
  }

  private async save(
    environmentId: string,
    vars: Record<string, string>,
  ): Promise<void> {
    await this.prisma.environment.update({
      where: { id: environmentId },
      data: {
        envVarsEnc:
          Object.keys(vars).length === 0
            ? null
            : this.crypto.encrypt(JSON.stringify(vars)),
      },
    });
  }

  /** Combine `vars` + parsed `dotenv` into one map, validating key names. */
  private normalize(dto: SetEnvVarsDto): Record<string, string> {
    const merged: Record<string, unknown> = {
      ...(dto.vars ?? {}),
      ...(dto.dotenv ? parseDotenv(dto.dotenv) : {}),
    };
    if (Object.keys(merged).length === 0) {
      throw new BadRequestException('Provide `vars` or `dotenv`');
    }
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(merged)) {
      if (!KEY_PATTERN.test(key)) {
        throw new BadRequestException(`Invalid env var name: "${key}"`);
      }
      if (typeof value !== 'string') {
        throw new BadRequestException(`Value for "${key}" must be a string`);
      }
      out[key] = value;
    }
    return out;
  }
}

function summarize(vars: Record<string, string>): EnvVarSummary[] {
  return Object.keys(vars)
    .sort()
    .map((key) => ({ key, value: MASK }));
}

/** Parse a `.env` block: skips blanks/comments, strips `export` + quotes. */
function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const eq = line.indexOf('=');
    if (eq === -1) {
      continue;
    }
    const key = line
      .slice(0, eq)
      .trim()
      .replace(/^export\s+/, '');
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}
