import { Body, Controller, Get, HttpCode, HttpStatus, Patch, Post, Query } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Public, Roles } from '../../shared/guards/auth.decorators';
import { CategoriesService } from './categories.service';
import { SuccessDto } from '../articles/dto/article-responses.dto';
import { CategoryListItemDto, CategoryResponseDto } from './dto/category-responses.dto';
import {
  CategoryByIdQueryDto,
  CategoryBySlugQueryDto,
  CreateCategoryDto,
  RemoveCategoryDto,
  UpdateCategoryDto,
} from './dto/categories.dto';
import { PublicOperation } from '../../shared/swagger/security';

const R401 = { status: 401, description: 'Missing, invalid, or revoked bearer token.' };
const R403 = { status: 403, description: 'The caller is not an admin (DB-resolved role).' };
const R404 = { status: 404, description: 'Category not found.' };
const R409 = { status: 409, description: 'Slug conflict, or the category still has linked articles (frozen delete guard).' };

/**
 * `web/convex/categories.ts` → 6 endpoints. The frozen `create`/`update`/`remove`
 * were unauthenticated public writes; the port gates them on the DB-resolved
 * admin role (brief DoD #5, S-015/S-016 class).
 */
@ApiTags('categories')
@Controller('categories')
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @ApiOkResponse({ type: CategoryResponseDto })
  @Public()
  @PublicOperation()
  @Get('by-slug')
  @ApiOperation({ summary: 'Category by public slug (frozen `categories.getBySlug`)' })
  @ApiResponse(R404)
  bySlug(@Query() q: CategoryBySlugQueryDto) {
    return this.categories.getBySlug(q.slug);
  }

  @ApiOkResponse({ type: CategoryResponseDto })
  @Public()
  @PublicOperation()
  @Get('by-id')
  @ApiOperation({ summary: 'Category by id (frozen `categories.getById`)' })
  @ApiResponse(R404)
  byId(@Query() q: CategoryByIdQueryDto) {
    return this.categories.getById(q.id);
  }

  @ApiOkResponse({ type: [CategoryListItemDto] })
  @Public()
  @PublicOperation()
  @Get('all')
  @ApiOperation({ summary: 'All categories with pillarCount (frozen `categories.listAll`)' })
  all() {
    return this.categories.listAll();
  }

  @ApiOkResponse({ type: CategoryResponseDto })
  @Roles('admin')
  @Post('create')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Create a category (frozen `categories.create`, now admin-only)' })
  @ApiResponse(R401)
  @ApiResponse(R403)
  @ApiResponse(R409)
  create(@Body() dto: CreateCategoryDto) {
    return this.categories.create(dto);
  }

  @ApiOkResponse({ type: CategoryResponseDto })
  @Roles('admin')
  @Patch('update')
  @ApiOperation({ summary: 'Update a category (frozen `categories.update`, now admin-only)' })
  @ApiResponse(R401)
  @ApiResponse(R403)
  @ApiResponse(R404)
  @ApiResponse(R409)
  update(@Body() dto: UpdateCategoryDto) {
    return this.categories.update(dto);
  }

  @ApiOkResponse({ type: SuccessDto })
  @Roles('admin')
  @Patch('remove')
  @ApiOperation({
    summary: 'Delete a category (frozen `categories.remove`, now admin-only)',
    description: 'The frozen linked-article delete guard is preserved: 409 while articles reference the category.',
  })
  @ApiResponse(R401)
  @ApiResponse(R403)
  @ApiResponse(R404)
  @ApiResponse(R409)
  remove(@Body() dto: RemoveCategoryDto) {
    return this.categories.remove(dto.id);
  }
}
