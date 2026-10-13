import { Body, Controller, Get, HttpCode, HttpStatus, Patch, Post, Query } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Public, Roles } from '../../shared/guards/auth.decorators';
import {
  CreatePillarDto,
  PillarByCategoryQueryDto,
  PillarBySlugQueryDto,
  RemovePillarDto,
  UpdatePillarDto,
} from './dto/pillars.dto';
import { PillarsService } from './pillars.service';
import { SuccessDto } from '../articles/dto/article-responses.dto';
import { PillarListItemDto, PillarResponseDto } from './dto/pillar-responses.dto';
import { PublicOperation } from '../../shared/swagger/security';

const R401 = { status: 401, description: 'Missing, invalid, or revoked bearer token.' };
const R403 = { status: 403, description: 'The caller is not an admin (DB-resolved role).' };
const R404 = { status: 404, description: 'Pillar not found.' };
const R409 = { status: 409, description: 'Duplicate slug, or articles are still linked (frozen delete guard).' };
const R422 = { status: 422, description: '`categoryId` does not reference an existing category (names the field).' };

/**
 * `web/convex/pillars.ts` → 6 endpoints. The frozen `create`/`update`/`remove`
 * were unauthenticated public writes; the port gates them on the DB-resolved
 * admin role (brief DoD #5).
 */
@ApiTags('pillars')
@Controller('pillars')
export class PillarsController {
  constructor(private readonly pillars: PillarsService) {}

  @ApiOkResponse({ type: [PillarResponseDto] })
  @Public()
  @PublicOperation()
  @Get('by-category')
  @ApiOperation({ summary: 'Pillars of a category, creation order (frozen `pillars.listByCategory`)' })
  byCategory(@Query() q: PillarByCategoryQueryDto) {
    return this.pillars.listByCategory(q.categoryId);
  }

  @ApiOkResponse({ type: [PillarListItemDto] })
  @Public()
  @PublicOperation()
  @Get('all')
  @ApiOperation({ summary: 'All pillars with category name/slug (frozen `pillars.listAll`)' })
  all() {
    return this.pillars.listAll();
  }

  @ApiOkResponse({ type: PillarResponseDto })
  @Public()
  @PublicOperation()
  @Get('by-slug')
  @ApiOperation({ summary: 'Pillar by public slug (frozen `pillars.getBySlug`)' })
  @ApiResponse(R404)
  bySlug(@Query() q: PillarBySlugQueryDto) {
    return this.pillars.getBySlug(q.slug);
  }

  @ApiOkResponse({ type: PillarResponseDto })
  @Roles('admin')
  @Post('create')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Create a pillar (frozen `pillars.create`, now admin-only)' })
  @ApiResponse(R401)
  @ApiResponse(R403)
  @ApiResponse(R409)
  @ApiResponse(R422)
  create(@Body() dto: CreatePillarDto) {
    return this.pillars.create(dto);
  }

  @ApiOkResponse({ type: PillarResponseDto })
  @Roles('admin')
  @Patch('update')
  @ApiOperation({ summary: 'Update a pillar (frozen `pillars.update`, now admin-only)' })
  @ApiResponse(R401)
  @ApiResponse(R403)
  @ApiResponse(R404)
  @ApiResponse(R409)
  @ApiResponse(R422)
  update(@Body() dto: UpdatePillarDto) {
    return this.pillars.update(dto);
  }

  @ApiOkResponse({ type: SuccessDto })
  @Roles('admin')
  @Patch('remove')
  @ApiOperation({
    summary: 'Delete a pillar (frozen `pillars.remove`, now admin-only)',
    description: 'The frozen linked-article delete guard is preserved: 409 while articles reference the pillar slug.',
  })
  @ApiResponse(R401)
  @ApiResponse(R403)
  @ApiResponse(R404)
  @ApiResponse(R409)
  remove(@Body() dto: RemovePillarDto) {
    return this.pillars.remove(dto.id);
  }
}
