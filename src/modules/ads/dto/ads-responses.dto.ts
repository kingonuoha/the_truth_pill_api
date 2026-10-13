import { ApiProperty } from '@nestjs/swagger';

/** The ad-settings singleton, incl. the frozen defaults when absent (`ads.ts:11-22`). */
export class AdsSettingsResponseDto {
  @ApiProperty() adsEnabled: boolean = false;
  @ApiProperty({ description: 'Admin-supplied script body. Stored as data; never executed server-side.' }) adsenseScriptCode: string = '';
  @ApiProperty() adsenseAdUnitCode: string = '';
  @ApiProperty() showAdTopOfArticle: boolean = false;
  @ApiProperty() showAdMiddleOfArticle: boolean = false;
  @ApiProperty() showAdBottomOfArticle: boolean = false;
  @ApiProperty() showAdSidebar: boolean = false;
  @ApiProperty({ type: String, format: 'date-time' }) updatedAt: string = '';
}
