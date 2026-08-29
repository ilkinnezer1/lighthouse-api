import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * A free-text chore. Everything a seeded item carries — ticket key, link,
 * source — is the server's to attach, so there is nothing here a client could
 * use to forge one.
 */
export class CreateChecklistItemDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;
}
