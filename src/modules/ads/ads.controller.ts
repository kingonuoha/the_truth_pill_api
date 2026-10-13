import { Body, Controller, Get, HttpCode, HttpStatus, Patch } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Public, Roles } from '../../shared/guards/auth.decorators';
import { PrismaService } from '../../core/prisma/prisma.service';
import { UpdateAdsSettingsDto } from './dto/ads.dto';
import { AdsSettingsResponseDto } from './dto/ads-responses.dto';
import { PublicOperation } from '../../shared/swagger/security';

function toAdsSettings(s: {
  adsEnabled: boolean;
  adsenseScriptCode: string;
  adsenseAdUnitCode: string;
  showAdTopOfArticle: boolean;
  showAdMiddleOfArticle: boolean;
  showAdBottomOfArticle: boolean;
  showAdSidebar: boolean;
  updatedAt: Date;
}) {
  return {
    adsEnabled: s.adsEnabled,
    adsenseScriptCode: s.adsenseScriptCode,
    adsenseAdUnitCode: s.adsenseAdUnitCode,
    showAdTopOfArticle: s.showAdTopOfArticle,
    showAdMiddleOfArticle: s.showAdMiddleOfArticle,
    showAdBottomOfArticle: s.showAdBottomOfArticle,
    showAdSidebar: s.showAdSidebar,
    updatedAt: s.updatedAt.toISOString(),
  };
}

/** The frozen defaults of `ads.ts:11-22` — an absent row and a disabled row are different states. */
const ADS_DEFAULTS = {
  adsEnabled: false,
  adsenseScriptCode: '',
  adsenseAdUnitCode: '',
  showAdTopOfArticle: false,
  showAdMiddleOfArticle: false,
  showAdBottomOfArticle: false,
  showAdSidebar: false,
};

/**
 * `web/convex/ads.ts` → 2 endpoints. The frozen read is public (the frontend
 * needs it to decide whether to render ads); the frozen write authenticated on
 * a client-usable identity path and is now admin-gated (brief DoD #11).
 */
@ApiTags('ads-settings')
@Controller('ads-settings')
export class AdsController {
  constructor(private readonly prisma: PrismaService) {}

  @ApiOkResponse({ type: AdsSettingsResponseDto })
  @Public()
  @PublicOperation()
  @Get('ads-settings')
  @ApiOperation({ summary: 'Current ad settings, frozen defaults when absent (`ads.getAdsSettings`)' })
  async getAdsSettings() {
    const settings = await this.prisma.adsSettings.findFirst();
    return toAdsSettings(settings ?? { ...ADS_DEFAULTS, updatedAt: new Date() });
  }

  @ApiOkResponse({ type: AdsSettingsResponseDto })
  @Roles('admin')
  @Patch('update-ads-settings')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Upsert the ad settings singleton (frozen `ads.updateAdsSettings`, admin-gated)' })
  @ApiResponse({ status: 401, description: 'Missing, invalid, or revoked bearer token.' })
  @ApiResponse({ status: 403, description: 'The caller is not an admin (DB-resolved role).' })
  async updateAdsSettings(@Body() dto: UpdateAdsSettingsDto) {
    const row = await this.prisma.adsSettings.upsert({
      where: { id: 'ads_settings' },
      update: { ...dto, updatedAt: new Date() },
      create: { ...dto, id: 'ads_settings', updatedAt: new Date() },
    });
    return toAdsSettings(row);
  }
}
