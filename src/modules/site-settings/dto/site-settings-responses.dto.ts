import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** The 7 social keys as stored (written only through `UpdateSiteSettingsDto`). */
export class SiteSocialsResponseDto {
  @ApiPropertyOptional({ type: String, nullable: true }) facebook?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) twitter?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) instagram?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) youtube?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) tiktok?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) linkedin?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) github?: string | null;
}

/**
 * The site-settings singleton — all public marketing data (DEV-018: no
 * `SITE_KEY` or credential exists on this surface).
 */
export class SiteSettingsResponseDto {
  @ApiProperty() siteName: string = '';
  @ApiProperty() siteDescription: string = '';
  @ApiProperty({ description: 'Public marketing contact address (site settings are public data).' }) email: string = '';
  @ApiProperty({ type: String, nullable: true }) phone: string | null = null;
  @ApiProperty({ type: String, nullable: true }) address: string | null = null;
  @ApiProperty({ type: SiteSocialsResponseDto }) socials: SiteSocialsResponseDto = new SiteSocialsResponseDto();
  @ApiProperty({ type: String, nullable: true }) footerText: string | null = null;
  @ApiProperty({ type: String, format: 'date-time' }) updatedAt: string = '';
}
