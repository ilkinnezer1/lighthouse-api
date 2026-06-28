import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { User } from '@prisma/client';
import { Audit } from '../audit/audit.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AuthzService } from '../authz/authz.service';
import { CreateOrgDto } from './dto/create-org.dto';
import { UpdateMemberDto } from './dto/update-member.dto';
import { UpdateOrgDto } from './dto/update-org.dto';
import { OrgsService } from './orgs.service';

@Controller('orgs')
@UseGuards(JwtAuthGuard)
export class OrgsController {
  constructor(
    private readonly orgs: OrgsService,
    private readonly authz: AuthzService,
  ) {}

  @Post()
  @Audit('orgs.create')
  create(@Body() dto: CreateOrgDto, @CurrentUser() user: User) {
    return this.orgs.createShared(user.id, dto.name);
  }

  @Get()
  list(@CurrentUser() user: User) {
    return this.orgs.listForUser(user.id);
  }

  @Patch(':id')
  @Audit('orgs.update')
  async rename(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateOrgDto,
    @CurrentUser() user: User,
  ) {
    await this.authz.ensureCan(user, 'org.update', { organizationId: id });
    return this.orgs.rename(id, dto.name);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Audit('orgs.delete')
  async remove(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: User,
  ) {
    await this.authz.ensureCan(user, 'org.delete', { organizationId: id });
    await this.orgs.remove(id);
  }

  @Get(':id/members')
  async members(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: User,
  ) {
    await this.authz.ensureCan(user, 'members.read', { organizationId: id });
    return this.orgs.listMembers(id);
  }

  @Patch(':id/members/:userId')
  @Audit('members.update')
  async changeRole(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Body() dto: UpdateMemberDto,
    @CurrentUser() user: User,
  ) {
    await this.authz.ensureCan(user, 'members.manage', { organizationId: id });
    return this.orgs.changeRole(id, userId, dto.role, user);
  }

  // No blanket capability gate: leaving (removing yourself) is allowed for any
  // member, while removing someone else requires `members.manage`. The service
  // distinguishes the two and enforces the Owner guardrails.
  @Delete(':id/members/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Audit('members.remove')
  async removeMember(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @CurrentUser() user: User,
  ) {
    await this.orgs.removeMember(id, userId, user);
  }
}
