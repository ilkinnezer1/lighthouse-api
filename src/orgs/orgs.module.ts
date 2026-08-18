import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { JiraModule } from '../jira/jira.module';
import { OrgsController } from './orgs.controller';
import { OrgsService } from './orgs.service';

@Module({
  imports: [AuthModule, JiraModule],
  controllers: [OrgsController],
  providers: [OrgsService],
  exports: [OrgsService],
})
export class OrgsModule {}
