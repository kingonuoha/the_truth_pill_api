import { Body, Controller, Get, HttpCode, HttpStatus, Patch } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Public, Roles } from '../../shared/guards/auth.decorators';
import { PrismaService } from '../../core/prisma/prisma.service';
import { UpdateSiteSettingsDto } from './dto/site-settings.dto';
import { SiteSettingsResponseDto } from './dto/site-settings-responses.dto';
import { PublicOperation } from '../../shared/swagger/security';

interface SiteSettingsRecord {
  siteName: string;
  siteDescription: string;
  email: string;
  phone: string | null;
  address: string | null;
  socials: unknown;
  footerText: string | null;
  updatedAt: Date;
}

function toSiteSettings(s: SiteSettingsRecord) {
  return {
    siteName: s.siteName,
    siteDescription: s.siteDescription,
    email: s.email,
    phone: s.phone,
    address: s.address,
    socials: s.socials,
    footerText: s.footerText,
    updatedAt: s.updatedAt.toISOString(),
  };
}

/**
 * The frozen minimal defaults (`site_settings.ts:10-26`) — every field is
 * public marketing data. ⚠️ DEV-018 check: NO secret key (SITE_KEY or any
 * credential) exists on this surface or in the underlying row shape.
 */
const SITE_DEFAULTS = {
  siteName: 'The Truth Pill',
  siteDescription:
    'Deciphering the human experience through deep psychological research and unfiltered insights.',
  email: '',
  phone: '',
  address: null,
  socials: {
    facebook: '',
    twitter: '',
    instagram: '',
    youtube: '',
    tiktok: '',
    linkedin: '',
    github: '',
  },
  footerText: 'Unfiltered Evolution.',
};

/**
 * `web/convex/site_settings.ts` → 2 endpoints. The frozen `updateSiteSettings`
 * was an unauthenticated, site-wide write — S-012 is CLOSED in the Nest port:
 * only a DB-resolved admin may write (brief DoD #11).
 */
@ApiTags('site-settings')
@Controller('site-settings')
export class SiteSettingsController {
  constructor(private readonly prisma: PrismaService) {}

  @ApiOkResponse({ type: SiteSettingsResponseDto })
  @Public()
  @PublicOperation()
  @Get('site-settings')
  @ApiOperation({ summary: 'Public site settings with frozen defaults (`site_settings.getSiteSettings`)' })
  async getSiteSettings() {
    const settings = await this.prisma.siteSettings.findFirst();
    if (!settings) return { ...SITE_DEFAULTS, updatedAt: new Date().toISOString() };
    return toSiteSettings(settings);
  }

  @ApiOkResponse({ type: SiteSettingsResponseDto })
  @Roles('admin')
  @Patch('update-site-settings')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Upsert the site settings singleton (frozen `updateSiteSettings`, admin-gated — S-012 closed)' })
  @ApiResponse({ status: 401, description: 'Missing, invalid, or revoked bearer token.' })
  @ApiResponse({ status: 403, description: 'The caller is not an admin (DB-resolved role).' })
  async updateSiteSettings(@Body() dto: UpdateSiteSettingsDto) {
    const socials = { ...dto.socials };
    const row = await this.prisma.siteSettings.upsert({
      where: { id: 'site_settings' },
      update: {
        siteName: dto.siteName,
        siteDescription: dto.siteDescription,
        email: dto.email,
        phone: dto.phone,
        address: dto.address,
        socials,
        footerText: dto.footerText,
        updatedAt: new Date(),
      },
      create: {
        id: 'site_settings',
        siteName: dto.siteName,
        siteDescription: dto.siteDescription,
        // DEV-064: `email` is optional; an omitted value falls back to the
        // frozen default `''` on the first-ever write.
        email: dto.email ?? '',
        phone: dto.phone,
        address: dto.address,
        socials,
        footerText: dto.footerText,
        updatedAt: new Date(),
      },
    });
    return toSiteSettings(row);
  }
}
