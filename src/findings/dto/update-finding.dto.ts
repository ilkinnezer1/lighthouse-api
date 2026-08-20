import { FindingStatus } from '@prisma/client';
import { IsEnum } from 'class-validator';

// Status is the only mutable field. `fixedIn` is deliberately absent: the
// server pins the fixing build from what is actually deployed, so it cannot be
// asserted by a client.
export class UpdateFindingDto {
  @IsEnum(FindingStatus)
  status!: FindingStatus;
}
