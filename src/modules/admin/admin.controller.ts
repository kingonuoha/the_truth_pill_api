import { Controller, Get, HttpCode, HttpStatus, Post, Query, UseGuards } from '@nestjs/common';
import {
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { Public, Roles } from '../../shared/guards/auth.decorators';
import { InternalSecretGuard } from '../../shared/guards/internal-secret.guard';
import { INTERNAL_SECRET_SECURITY_SCHEME } from '../../shared/swagger/security';
import { AdminService } from './admin.service';
import { ActivityItemDto, DashboardStatsDto, DedupeResultDto } from './dto/admin-responses.dto';

class RecentActivityQueryDto {
  @ApiProperty({ default: 10, minimum: 1, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

/**
 * `web/convex/admin.ts` — the admin analytics surface. The ownership table's
 * Target row predates the internal-namespace ruling; `adminDedupeArticles`
 * ships under `/internal/admin/*` exactly as the §"public namespace"
 * corrections table and the Phase 05 task file prescribe (brief DoD #12).
 */
@ApiTags('admin')
@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @ApiOkResponse({ type: DashboardStatsDto })
  @Roles('admin')
  @Get('dashboard-stats')
  @ApiOperation({
    summary: 'Dashboard counters from the derived globalStats cache (frozen `admin.getDashboardStats`)',
    description: 'Reads the cache row — never a full-table scan. No user document or secret is projected.',
  })
  @ApiResponse({ status: 401, description: 'Missing, invalid, or revoked bearer token.' })
  @ApiResponse({ status: 403, description: 'The caller is not an admin (DB-resolved role).' })
  dashboardStats() {
    return this.admin.getDashboardStats();
  }

  @ApiOkResponse({ type: [ActivityItemDto] })
  @Roles('admin')
  @Get('recent-activity')
  @ApiOperation({ summary: 'Recent comments/signups/articles feed (frozen `admin.getRecentActivity`)' })
  @ApiResponse({ status: 401, description: 'Missing, invalid, or revoked bearer token.' })
  @ApiResponse({ status: 403, description: 'The caller is not an admin (DB-resolved role).' })
  recentActivity(@Query() q: RecentActivityQueryDto) {
    return this.admin.getRecentActivity(q.limit);
  }
}

@ApiTags('internal-admin')
@Public()
@ApiSecurity(INTERNAL_SECRET_SECURITY_SCHEME)
@UseGuards(InternalSecretGuard)
@ApiHeader({ name: 'x-internal-secret', required: true, description: 'INTERNAL_JOB_SECRET' })
@Controller('internal/admin')
export class InternalAdminController {
  constructor(private readonly admin: AdminService) {}

  @ApiOkResponse({ type: DedupeResultDto })
  @Post('admin-dedupe-articles')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Collapse duplicate-slug published articles (frozen `admin.adminDedupeArticles`)',
    description:
      'Worker-only, transaction-scoped advisory lock; repoints views/reactions/comments/bookmarks then ' +
      'deletes losers in one $transaction (DEV-025 class). Idempotent: a second run is a no-op.',
  })
  @ApiResponse({ status: 401, description: 'Missing or incorrect `x-internal-secret` (Hard Rule 6).' })
  dedupe() {
    return this.admin.adminDedupeArticles();
  }
}
