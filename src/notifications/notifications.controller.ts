import {
  BadRequestException,
  Body,
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
  UseGuards,
} from '@nestjs/common';
import type { NotificationChannel, User } from '@prisma/client';
import { NotificationKind } from '@prisma/client';
import { Audit } from '../audit/audit.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AuthzService } from '../authz/authz.service';
import { PrismaService } from '../prisma/prisma.service';
import type { ZodIssue } from 'zod';
import {
  CreateNotificationChannelSchema,
  UpdateNotificationChannelSchema,
} from './dto/notification-channel.schema';

type SafeParse<T> =
  | { success: true; data: T }
  | { success: false; error: { issues: ZodIssue[] } };
import { ALL_NOTIFICATION_EVENTS } from './notifications.constants';
import { NotificationsService } from './notifications.service';

// The stored webhook URL is a credential and is never returned — only whether
// one is set, mirroring how env-var values are write-only.
interface ChannelView {
  id: string;
  name: string;
  kind: NotificationKind;
  enabled: boolean;
  events: string[];
  createdAt: Date;
}

@Controller('orgs/:orgId/notification-channels')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthzService,
    private readonly notifications: NotificationsService,
  ) {}

  @Get()
  async list(
    @Param('orgId', new ParseUUIDPipe()) orgId: string,
    @CurrentUser() user: User,
  ): Promise<{ channels: ChannelView[]; events: string[] }> {
    await this.authz.ensureCan(user, 'notifications.read', {
      organizationId: orgId,
    });
    const channels = await this.prisma.notificationChannel.findMany({
      where: { orgId },
      orderBy: { createdAt: 'asc' },
    });
    return {
      channels: channels.map((c) => this.view(c)),
      events: ALL_NOTIFICATION_EVENTS,
    };
  }

  @Post()
  @Audit('notifications.channel-create')
  async create(
    @Param('orgId', new ParseUUIDPipe()) orgId: string,
    @Body() body: unknown,
    @CurrentUser() user: User,
  ): Promise<ChannelView> {
    await this.authz.ensureCan(user, 'notifications.manage', {
      organizationId: orgId,
    });
    const dto = this.parse(CreateNotificationChannelSchema, body);
    const channel = await this.prisma.notificationChannel.create({
      data: {
        orgId,
        name: dto.name,
        kind: dto.kind,
        configEnc: this.notifications.encryptConfig({ url: dto.url }),
        enabled: dto.enabled ?? true,
        events: dto.events ?? [],
      },
    });
    return this.view(channel);
  }

  @Patch(':id')
  @Audit('notifications.channel-update')
  async update(
    @Param('orgId', new ParseUUIDPipe()) orgId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
    @CurrentUser() user: User,
  ): Promise<ChannelView> {
    await this.authz.ensureCan(user, 'notifications.manage', {
      organizationId: orgId,
    });
    await this.find(orgId, id);
    const dto = this.parse(UpdateNotificationChannelSchema, body);

    const channel = await this.prisma.notificationChannel.update({
      where: { id },
      data: {
        name: dto.name,
        enabled: dto.enabled,
        events: dto.events,
        configEnc: dto.url
          ? this.notifications.encryptConfig({ url: dto.url })
          : undefined,
      },
    });
    return this.view(channel);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Audit('notifications.channel-delete')
  async remove(
    @Param('orgId', new ParseUUIDPipe()) orgId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: User,
  ): Promise<void> {
    await this.authz.ensureCan(user, 'notifications.manage', {
      organizationId: orgId,
    });
    await this.find(orgId, id);
    await this.prisma.notificationChannel.delete({ where: { id } });
  }

  // A test send is the difference between "configured" and "actually works" —
  // without it a wrong URL only surfaces the next time a deploy fails.
  @Post(':id/test')
  @HttpCode(HttpStatus.OK)
  @Audit('notifications.channel-test')
  async test(
    @Param('orgId', new ParseUUIDPipe()) orgId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: User,
  ): Promise<{ ok: boolean; error?: string }> {
    await this.authz.ensureCan(user, 'notifications.manage', {
      organizationId: orgId,
    });
    const channel = await this.find(orgId, id);
    try {
      await this.notifications.sendTest(channel);
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'failed',
      };
    }
  }

  private parse<T>(
    schema: { safeParse: (v: unknown) => SafeParse<T> },
    body: unknown,
  ): T {
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: 'Invalid notification channel',
        issues: parsed.error.issues,
      });
    }
    return parsed.data;
  }

  private async find(orgId: string, id: string): Promise<NotificationChannel> {
    const channel = await this.prisma.notificationChannel.findFirst({
      where: { id, orgId },
    });
    if (!channel) throw new NotFoundException('Channel not found');
    return channel;
  }

  private view(c: NotificationChannel): ChannelView {
    return {
      id: c.id,
      name: c.name,
      kind: c.kind,
      enabled: c.enabled,
      events: c.events,
      createdAt: c.createdAt,
    };
  }
}
