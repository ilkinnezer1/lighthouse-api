import { IsUUID } from 'class-validator';

export class TransferProjectDto {
  // Destination org. The actor must be a Member+ there (`projects.create`) and,
  // when it's a personal org, it must be their own.
  @IsUUID()
  organizationId!: string;
}
