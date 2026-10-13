import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsString, MaxLength } from 'class-validator';

/**
 * `updateAdsSettings` (`ads.ts:30-71`). All seven fields required — the frozen
 * contract. The legacy `identity`-email lookup is replaced by the DB-resolved
 * guard; no identity field exists on the DTO.
 */
export class UpdateAdsSettingsDto {
  @ApiProperty()
  @IsBoolean()
  adsEnabled!: boolean;

  @ApiProperty({ description: 'Admin-supplied script body. Stored as data; never executed server-side.' })
  @IsString()
  @MaxLength(20000)
  adsenseScriptCode!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(255)
  adsenseAdUnitCode!: string;

  @ApiProperty()
  @IsBoolean()
  showAdTopOfArticle!: boolean;

  @ApiProperty()
  @IsBoolean()
  showAdMiddleOfArticle!: boolean;

  @ApiProperty()
  @IsBoolean()
  showAdBottomOfArticle!: boolean;

  @ApiProperty()
  @IsBoolean()
  showAdSidebar!: boolean;
}
