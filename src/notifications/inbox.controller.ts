import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { User } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ListNotificationsDto } from './dto/list-notifications.dto';
import { InboxService, type NotificationFeed } from './inbox.service';

/**
 * The caller's own inbox. There is no `ensureCan` anywhere in here on purpose:
 * a notification belongs to exactly one person, so this is ownership, not an
 * org capability — and the service enforces it by scoping every query to
 * `user.id` rather than by loading a row and then checking it.
 */
@Controller('me/notifications')
@UseGuards(JwtAuthGuard)
export class InboxController {
  constructor(private readonly inbox: InboxService) {}

  @Get()
  list(
    @Query() query: ListNotificationsDto,
    @CurrentUser() user: User,
  ): Promise<NotificationFeed> {
    return this.inbox.list(user.id, query);
  }

  // Both mutations answer with the new unread count so the badge settles
  // without a follow-up request.
  @Post(':id/read')
  @HttpCode(HttpStatus.OK)
  async read(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: User,
  ): Promise<{ unreadCount: number }> {
    return { unreadCount: await this.inbox.markRead(user.id, id) };
  }

  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  async readAll(@CurrentUser() user: User): Promise<{ unreadCount: number }> {
    return { unreadCount: await this.inbox.markAllRead(user.id) };
  }
}
