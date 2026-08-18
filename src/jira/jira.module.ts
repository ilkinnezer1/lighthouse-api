import { Module } from '@nestjs/common';
import { BranchLabelsService } from './branch-labels.service';
import { JiraApiService } from './jira-api.service';

@Module({
  providers: [JiraApiService, BranchLabelsService],
  exports: [JiraApiService, BranchLabelsService],
})
export class JiraModule {}
