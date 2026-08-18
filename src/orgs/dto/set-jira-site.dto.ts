import { IsString, MaxLength, MinLength } from 'class-validator';

// Only the cloud id is accepted. The site URL is read back from Atlassian's
// accessible-resources for the calling user, never taken from the request —
// this URL becomes a link rendered next to every branch, so letting a client
// name it would let one be pointed anywhere.
export class SetJiraSiteDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  cloudId!: string;
}
