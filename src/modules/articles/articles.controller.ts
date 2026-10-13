import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AuthenticatedUser, CurrentUser, Public, Roles } from '../../shared/guards/auth.decorators';
import {
  ByAuthorQueryDto,
  ByCategoryArticlesQueryDto,
  BySlugQueryDto,
  ByTagQueryDto,
  ArticleIdDto,
  BulkArticleIdsDto,
  CreateArticleDto,
  FeaturedArticlesQueryDto,
  LimitQueryDto,
  ListAdminArticlesQueryDto,
  ListArticlesQueryDto,
  NoQueryDto,
  RecentArticlesQueryDto,
  SearchArticlesQueryDto,
  TopPostTagsQueryDto,
  ToggleFeaturedDto,
  UpdateArticleDto,
} from './dto/articles.dto';
import { ArticlesService } from './articles.service';
import {
  ArticleDetailDto,
  ArticleRecordDto,
  AuthorCardResponseDto,
  FeaturedListItemDto,
  PaginatedArticleDetailDto,
  PaginatedArticleListItemDto,
  RecentListItemDto,
  SearchResultDto,
  SuccessDto,
  TagListItemDto,
} from './dto/article-responses.dto';
import { PublicOperation } from '../../shared/swagger/security';

const R401 = { status: 401, description: 'Missing, invalid, or revoked bearer token.' };
const R403 = { status: 403, description: 'The caller is not an admin (DB-resolved role).' };
const R404 = { status: 404, description: 'Not found.' };
const R409 = { status: 409, description: 'Conflict (slug already exists).' };
const R422 = { status: 422, description: 'Publish-time rule violated or an unresolvable reference (names the field in `details`).' };

/**
 * Public reads + admin writes for articles (Phase 05, DoD #1/5/7/8/9/10).
 * Default-deny is global (`JwtAuthGuard`); `@Public()` marks the allowlist and
 * `@Roles('admin')` gates every write through the DB-resolved `RolesGuard`.
 * No route accepts a client-supplied admin/user email or caller `authorId` — a body or
 * query carrying one is a 400 via `forbidNonWhitelisted` (DEV-029/030/031).
 */
@ApiTags('articles')
@ApiExtraModels(ListArticlesQueryDto)
@Controller('articles')
export class ArticlesController {
  constructor(private readonly articles: ArticlesService) {}

  /* ── public reads (§10 projection, no user document) ── */

  @Public()
  @PublicOperation()
  @Get()
  @ApiOperation({ summary: 'Paginated published articles (frozen `articles.list`)' })
  @ApiOkResponse({ type: PaginatedArticleListItemDto, description: 'Public projection: author name/image only, never a user document.' })
  list(@Query() q: ListArticlesQueryDto) {
    return this.articles.list(q);
  }

  @ApiOkResponse({ type: [RecentListItemDto] })
  @Public()
  @PublicOperation()
  @Get('recent')
  @ApiOperation({ summary: 'Lightweight recent list, hard cap 100 (frozen `articles.listRecent`)' })
  recent(@Query() q: RecentArticlesQueryDto) {
    return this.articles.listRecent(q);
  }

  @ApiOkResponse({ type: [TagListItemDto] })
  @Public()
  @PublicOperation()
  @Get('by-tag')
  @ApiOperation({ summary: 'Published articles carrying a tag (frozen `articles.listByTag`)' })
  byTag(@Query() q: ByTagQueryDto) {
    return this.articles.listByTag(q);
  }

  @ApiOkResponse({ type: ArticleDetailDto })
  @Public()
  @PublicOperation()
  @Get('by-slug')
  @ApiOperation({ summary: 'Full published article by public slug (frozen `articles.getBySlug`)' })
  @ApiResponse(R404)
  bySlug(@Query() q: BySlugQueryDto) {
    return this.articles.getBySlug(q.slug);
  }

  @ApiOkResponse({ type: [FeaturedListItemDto] })
  @Public()
  @PublicOperation()
  @Get('featured')
  @ApiOperation({ summary: 'Featured published articles (frozen `articles.getFeatured`)' })
  featured(@Query() q: FeaturedArticlesQueryDto) {
    return this.articles.getFeatured(q);
  }

  @ApiOkResponse({ type: [FeaturedListItemDto], description: 'Empty array for an unknown category slug (frozen semantics).' })
  @Public()
  @PublicOperation()
  @Get('by-category')
  @ApiOperation({ summary: 'Published articles in a category slug (frozen `articles.getByCategory`)' })
  byCategory(@Query() q: ByCategoryArticlesQueryDto) {
    return this.articles.getByCategory(q.categorySlug, q.limit);
  }

  @Public()
  @PublicOperation()
  @Get('search')
  @ApiOperation({
    summary: 'Ranked search (frozen `articles.search`, DEV-008)',
    description:
      'Weighted tokenised scoring ported verbatim from the frozen JavaScript ranker — ' +
      'normalisation, 83-word stopword list, additive weights, `score DESC, viewCount DESC LIMIT 8`. ' +
      'Deliberately not a Postgres relevance-ranked full-text search.',
  })
  @ApiOkResponse({ type: [SearchResultDto], description: 'Top 8 augmented results; `[]` for an empty/stopword-only query.' })
  search(@Query() q: SearchArticlesQueryDto) {
    return this.articles.search(q);
  }

  @ApiOkResponse({ type: [String] })
  @Public()
  @PublicOperation()
  @Get('popular-topics')
  @ApiOperation({ summary: 'Most-used topics over the published sample (frozen `articles.getPopularTopics`)' })
  popularTopics(@Query() q: LimitQueryDto) {
    return this.articles.getPopularTopics(q);
  }

  @ApiOkResponse({ type: [String] })
  @Public()
  @PublicOperation()
  @Get('all-topics')
  @ApiOperation({ summary: 'Sorted distinct topics (frozen `articles.getAllTopics`)' })
  allTopics() {
    return this.articles.getAllTopics();
  }

  @ApiOkResponse({ type: [String] })
  @Public()
  @PublicOperation()
  @Get('all-tags')
  @ApiOperation({ summary: 'Sorted distinct tags (frozen `articles.getAllTags`)' })
  allTags() {
    return this.articles.getAllTags();
  }

  @ApiOkResponse({ type: [String] })
  @Public()
  @PublicOperation()
  @Get('top-post-tags')
  @ApiOperation({ summary: 'Tags of the two most-viewed sampled posts (frozen `articles.getTopPostTags`)' })
  topPostTags(@Query() q: TopPostTagsQueryDto) {
    return this.articles.getTopPostTags(q);
  }

  @ApiOkResponse({ type: [ArticleDetailDto], description: 'Non-archived published rows only (DEV-041).' })
  @Public()
  @PublicOperation()
  @Get('by-author')
  @ApiOperation({
    summary: 'Published, non-archived byline list for an author id (frozen `articles.getByAuthor`)',
    description:
      'DEV-041: the frozen public query omitted the archived filter; the port adds the ' +
      'NULL-safe `isArchived IS NOT TRUE` predicate so soft-deleted articles do not surface here.',
  })
  byAuthor(@Query() q: ByAuthorQueryDto) {
    return this.articles.getByAuthor(q.authorId, q.limit);
  }

  @Public()
  @PublicOperation()
  @Get('authors')
  @ApiOperation({
    summary: 'Public author cards (frozen `articles.listAuthors`, S-014 closed in Nest)',
    description: 'The frozen query returned whole admin user documents. This returns id/name/profileImage only.',
  })
  @ApiOkResponse({ type: [AuthorCardResponseDto], description: 'Array of {id, name, profileImage}. No email/role/password/token field can appear.' })
  authors() {
    return this.articles.listAuthors();
  }

  /* ── auth required (own bookmarks) ── */

  @ApiOkResponse({ type: [ArticleDetailDto] })
  @Get('bookmarked-articles')
  @ApiOperation({
    summary: 'The caller’s bookmarked articles (frozen `articles.getBookmarkedArticles`)',
    description: 'Subject comes from the verified token `sub`; the frozen `email` selector is deleted (DEV-029).',
  })
  @ApiResponse(R401)
  bookmarked(@CurrentUser() caller: AuthenticatedUser, @Query() whitelistProbe: NoQueryDto) {
    void whitelistProbe; // bound only so forbidNonWhitelisted 400s any query key (DEV-029)
    return this.articles.getBookmarkedArticles(caller.sub);
  }

  /* ── admin ── */

  @ApiOkResponse({ type: PaginatedArticleDetailDto })
  @Roles('admin')
  @Get('admin')
  @ApiOperation({ summary: 'Admin article browse incl. full-text search (frozen `articles.listAdmin`, §7.1)' })
  @ApiResponse(R401)
  @ApiResponse(R403)
  listAdmin(@Query() q: ListAdminArticlesQueryDto) {
    return this.articles.listAdmin(q);
  }

  @ApiOkResponse({ type: ArticleRecordDto })
  @Roles('admin')
  @Get('by-id')
  @ApiOperation({
    summary: 'Any article by id incl. drafts (frozen `articles.getById`)',
    description:
      'The frozen query was public and returned drafts to anyone; its only consumer is the admin edit page ' +
      '(`web/app/admin/articles/[articleId]/edit/page.tsx`), so the port is admin-gated (flagged for the auditor).',
  })
  @ApiResponse(R401)
  @ApiResponse(R403)
  @ApiResponse(R404)
  byId(@Query() q: ArticleIdDto) {
    return this.articles.getById(q.id);
  }

  @ApiOkResponse({ type: ArticleDetailDto })
  @Roles('admin')
  @Post('create')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Create an article (frozen `articles.create`); author attribution = token subject' })
  @ApiResponse(R401)
  @ApiResponse(R403)
  @ApiResponse(R409)
  @ApiResponse(R422)
  create(@CurrentUser() caller: AuthenticatedUser, @Body() dto: CreateArticleDto) {
    return this.articles.create(caller.sub, dto);
  }

  @ApiOkResponse({ type: ArticleDetailDto })
  @Roles('admin')
  @Patch('update')
  @ApiOperation({ summary: 'Update an article (frozen `articles.update`). Invalid category/pillar → 422 naming the field, row unchanged (DEV-011)' })
  @ApiResponse(R401)
  @ApiResponse(R403)
  @ApiResponse(R404)
  @ApiResponse(R409)
  @ApiResponse(R422)
  update(@CurrentUser() caller: AuthenticatedUser, @Body() dto: UpdateArticleDto) {
    return this.articles.update(caller.sub, dto);
  }

  @ApiOkResponse({ type: SuccessDto })
  @Roles('admin')
  @Patch('remove')
  @ApiOperation({ summary: 'Archive an article — soft delete (frozen `articles.remove`)' })
  @ApiResponse(R401)
  @ApiResponse(R403)
  remove(@Body() dto: ArticleIdDto) {
    return this.articles.remove(dto.id);
  }

  @ApiOkResponse({ type: SuccessDto })
  @Roles('admin')
  @Post('restore')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Restore an archived article (frozen `articles.restore`)' })
  @ApiResponse(R401)
  @ApiResponse(R403)
  restore(@Body() dto: ArticleIdDto) {
    return this.articles.restore(dto.id);
  }

  @ApiOkResponse({ type: SuccessDto })
  @Roles('admin')
  @Delete('delete-forever')
  @ApiOperation({ summary: 'Hard-delete an article; children cascade (frozen `articles.deleteForever`, DEV-025)' })
  @ApiResponse(R401)
  @ApiResponse(R403)
  deleteForever(@Query() q: ArticleIdDto) {
    return this.articles.deleteForever(q.id);
  }

  @ApiOkResponse({ type: SuccessDto })
  @Roles('admin')
  @Post('bulk-archive')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Archive many (frozen `articles.bulkArchive`)' })
  @ApiResponse(R401)
  @ApiResponse(R403)
  bulkArchive(@Body() dto: BulkArticleIdsDto) {
    return this.articles.bulkArchive(dto.ids);
  }

  @ApiOkResponse({ type: SuccessDto })
  @Roles('admin')
  @Post('bulk-restore')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Restore many (frozen `articles.bulkRestore`)' })
  @ApiResponse(R401)
  @ApiResponse(R403)
  bulkRestore(@Body() dto: BulkArticleIdsDto) {
    return this.articles.bulkRestore(dto.ids);
  }

  @ApiOkResponse({ type: SuccessDto })
  @Roles('admin')
  @Post('bulk-delete-forever')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Hard-delete many; children cascade (frozen `articles.bulkDeleteForever`, DEV-025)' })
  @ApiResponse(R401)
  @ApiResponse(R403)
  bulkDeleteForever(@Body() dto: BulkArticleIdsDto) {
    return this.articles.bulkDeleteForever(dto.ids);
  }

  @ApiOkResponse({ type: SuccessDto })
  @Roles('admin')
  @Patch('toggle-featured')
  @ApiOperation({ summary: 'Set the featured flag (frozen `articles.toggleFeatured`)' })
  @ApiResponse(R401)
  @ApiResponse(R403)
  @ApiResponse(R404)
  toggleFeatured(@Body() dto: ToggleFeaturedDto) {
    return this.articles.toggleFeatured(dto.id, dto.isFeatured);
  }
}
