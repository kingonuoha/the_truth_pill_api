import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsObject, IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';

/** The 7 optional keys of `site_settings.ts:39-47`. */
export class SiteSocialsDto {
  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  facebook?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  twitter?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  instagram?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  youtube?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  tiktok?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  linkedin?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  github?: string;
}

/**
 * `updateSiteSettings` (`site_settings.ts:32-66`). The frozen mutation had NO
 * authentication at all (S-012) — the port is admin-only; that IS the intended
 * deviation. Identity fields do not exist on this DTO.
 */
export class UpdateSiteSettingsDto {
  @ApiProperty({ maxLength: 255 })
  @IsString()
  @MaxLength(255)
  siteName!: string;

  @ApiProperty({ maxLength: 2000 })
  @IsString()
  @MaxLength(2000)
  siteDescription!: string;

  /**
   * DEV-064: an absent `email` is ignored (no change); a blank string clears
   * the contact address (stored as `''`); a non-empty value must be a valid
   * email. The frozen mutation accepted any string, so the Phase 05 required
   * `@IsEmail()` 400'd the admin's "clear the field" save.
   *
   * `@ValidateIf` (rather than `@IsOptional()`) is deliberate: `@IsOptional()`
   * also skips `null`, which would reach Prisma as a `NOT NULL` write and 500.
   * Only absent and blank are skipped; `null`/malformed still 400.
   */
  @ApiPropertyOptional({
    description:
      'Public marketing contact address (site settings are public data). A blank string clears it; omit to leave it unchanged.',
  })
  @ValidateIf((o: UpdateSiteSettingsDto) => o.email !== undefined && o.email !== '')
  @IsEmail()
  @MaxLength(320)
  email?: string;

  @ApiPropertyOptional({ maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  phone?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string;

  @ApiProperty({ type: SiteSocialsDto })
  @IsObject()
  socials!: SiteSocialsDto;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  footerText?: string;
}
