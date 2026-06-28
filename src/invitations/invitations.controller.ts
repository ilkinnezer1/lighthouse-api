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
  UseGuards,
} from '@nestjs/common';
import type { User } from '@prisma/client';
import { Audit } from '../audit/audit.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AuthzService } from '../authz/authz.service';
import { CreateInvitationDto } from './dto/create-invitation.dto';
import { InvitationsService } from './invitations.service';

@Controller()
@UseGuards(JwtAuthGuard)
export class InvitationsController {
  constructor(
    private readonly invitations: InvitationsService,
    private readonly authz: AuthzService,
  ) {}

  @Post('orgs/:id/invitations')
  @Audit('invitations.create')
  async create(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CreateInvitationDto,
    @CurrentUser() user: User,
  ) {
    await this.authz.ensureCan(user, 'members.manage', { organizationId: id });
    return this.invitations.create(id, user, dto);
  }

  @Get('orgs/:id/invitations')
  async listForOrg(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: User,
  ) {
    await this.authz.ensureCan(user, 'members.manage', { organizationId: id });
    return this.invitations.listForOrg(id);
  }

  // Gated inside the service against the invite's own org (`members.manage`).
  @Delete('invitations/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Audit('invitations.revoke')
  async revoke(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: User,
  ) {
    await this.invitations.revoke(id, user);
  }

  @Get('me/invitations')
  listMine(@CurrentUser() user: User) {
    return this.invitations.listMine(user.id);
  }

  @Post('invitations/:id/accept')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Audit('invitations.accept')
  async accept(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: User,
  ) {
    await this.invitations.accept(id, user);
  }

  @Post('invitations/:id/decline')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Audit('invitations.decline')
  async decline(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: User,
  ) {
    await this.invitations.decline(id, user);
  }

  @Get('invite/:token')
  preview(@Param('token') token: string) {
    return this.invitations.previewByToken(token);
  }

  @Post('invite/:token/accept')
  @Audit('invitations.accept')
  acceptLink(@Param('token') token: string, @CurrentUser() user: User) {
    return this.invitations.acceptByToken(token, user);
  }
}
