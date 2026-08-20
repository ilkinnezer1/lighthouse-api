import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
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
import { CreateFindingDto } from './dto/create-finding.dto';
import { ListFindingsDto } from './dto/list-findings.dto';
import { UpdateFindingDto } from './dto/update-finding.dto';
import type { FindingDetail, FindingView } from './finding.view';
import { FindingsService } from './findings.service';

/**
 * There is deliberately no `POST /environments/:id/findings`. A finding is
 * filed against the build that was running, never against the environment that
 * was showing it — the moment you can pick an environment you are back to
 * "it's broken on staging", which stops being true the next time staging moves.
 */
@Controller()
@UseGuards(JwtAuthGuard)
export class FindingsController {
  constructor(private readonly findings: FindingsService) {}

  // Answers with the summary, snapshot status included but never the log text:
  // whether capture worked is what the filer needs to see, and the text itself
  // would land in the audit row.
  @Post('deployments/:id/findings')
  @HttpCode(HttpStatus.CREATED)
  @Audit('findings.create')
  create(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CreateFindingDto,
    @CurrentUser() user: User,
  ): Promise<FindingView> {
    return this.findings.create(id, dto, user);
  }

  @Get('deployments/:id/findings')
  listForDeployment(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query() query: ListFindingsDto,
    @CurrentUser() user: User,
  ): Promise<FindingView[]> {
    return this.findings.listForDeployment(id, user, query.status);
  }

  // Everything found on this environment, whichever build it was found on —
  // the environment page's list, and the only place `?status=OPEN` earns its
  // keep.
  @Get('environments/:envId/findings')
  listForEnvironment(
    @Param('envId', new ParseUUIDPipe()) envId: string,
    @Query() query: ListFindingsDto,
    @CurrentUser() user: User,
  ): Promise<FindingView[]> {
    return this.findings.listForEnvironment(envId, user, query.status);
  }

  // The only response carrying the captured log snapshot; a list would ship one
  // blob per row for output nobody has asked to read yet.
  @Get('findings/:id')
  findOne(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: User,
  ): Promise<FindingDetail> {
    return this.findings.findOne(id, user);
  }

  @Patch('findings/:id')
  @Audit('findings.update')
  updateStatus(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateFindingDto,
    @CurrentUser() user: User,
  ): Promise<FindingView> {
    return this.findings.updateStatus(id, dto, user);
  }
}
