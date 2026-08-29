import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import type { User } from '@prisma/client';
import { Audit } from '../audit/audit.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ChecklistService } from './checklist.service';
import type { ChecklistItemView, ChecklistView } from './checklist.view';
import { CheckItemDto } from './dto/check-item.dto';
import { CreateChecklistItemDto } from './dto/create-checklist-item.dto';

/**
 * Every route that records something is reached through a deployment. As with
 * findings, there is deliberately no way to tick against an environment: "it
 * works on staging" expires the next time staging moves, and a tick that cannot
 * name its build is the thing this feature exists to replace.
 */
@Controller()
@UseGuards(JwtAuthGuard)
export class ChecklistController {
  constructor(private readonly checklist: ChecklistService) {}

  @Get('deployments/:id/checklist')
  forDeployment(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: User,
  ): Promise<ChecklistView> {
    return this.checklist.forDeployment(id, user);
  }

  // A write, and only ever on request. The UI offers it when `seedable > 0`.
  @Post('deployments/:id/checklist/seed')
  @HttpCode(HttpStatus.OK)
  @Audit('checklist.seed')
  seed(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: User,
  ): Promise<ChecklistView> {
    return this.checklist.seed(id, user);
  }

  @Post('deployments/:id/checklist/items')
  @HttpCode(HttpStatus.CREATED)
  @Audit('checklist.item_create')
  createItem(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CreateChecklistItemDto,
    @CurrentUser() user: User,
  ): Promise<ChecklistItemView> {
    return this.checklist.createItem(id, dto, user);
  }

  // Environment-scoped, because the item is: deleting it retires the chore
  // everywhere, not just off the build that happens to be on screen.
  @Delete('checklist-items/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Audit('checklist.item_delete')
  deleteItem(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: User,
  ): Promise<void> {
    return this.checklist.deleteItem(id, user);
  }

  // PUT, not POST: an item's state on a build is one fact, so re-checking
  // replaces it rather than appending a second opinion.
  @Put('deployments/:id/checklist/items/:itemId/check')
  @Audit('checklist.check')
  check(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
    @Body() dto: CheckItemDto,
    @CurrentUser() user: User,
  ): Promise<ChecklistItemView> {
    return this.checklist.check(id, itemId, dto, user);
  }

  @Delete('deployments/:id/checklist/items/:itemId/check')
  @Audit('checklist.uncheck')
  uncheck(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
    @CurrentUser() user: User,
  ): Promise<ChecklistItemView> {
    return this.checklist.uncheck(id, itemId, user);
  }
}
