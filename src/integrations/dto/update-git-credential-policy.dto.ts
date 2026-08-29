import { IsBoolean } from 'class-validator';

export class UpdateGitCredentialPolicyDto {
  @IsBoolean()
  allowMemberGitCredentials!: boolean;
}
