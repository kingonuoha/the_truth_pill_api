import { Body, Controller, Delete, Get, Patch, Query } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  AuthenticatedUser,
  CurrentUser,
  Public,
  Roles,
} from '../../shared/guards/auth.decorators';
import { OptionalAuth, OptionalCurrentUser } from '../../shared/guards/optional-auth.guard';
import {
  AddCommentDto,
  ArticleIdQueryDto,
  CommentIdQueryDto,
  EmptyQueryDto,
  ToggleBookmarkDto,
  ToggleReactionDto,
  UpdateCommentStatusDto,
} from './dto/engagement.dto';
import {
  AdminCommentDto,
  CommentCreatedDto,
  CommentDto,
  EngagementDto,
  EngagementSuccessDto,
  ReactionToggleDto,
} from './dto/engagement-responses.dto';
import { EngagementService } from './engagement.service';
import { OptionalAuthOperation, PublicOperation } from '../../shared/swagger/security';

const R400 = {
  status: 400,
  description: 'Invalid input, or a deleted caller-supplied identity selector in the body or query (DEV-029).',
};
const R401 = { status: 401, description: 'Missing, invalid, expired, or revoked bearer token.' };
const R403 = { status: 403, description: 'The caller is not an admin (DB-resolved role).' };
const R404 = { status: 404, description: 'Referenced article or comment not found.' };
const R422 = {
  status: 422,
  description: 'Validation rule violated (names the field or `parentId` in `details`).',
};

/**
 * The engagement surface — the 8 frozen `web/convex/engagement.ts` functions.
 *
 * Groups (frozen matrix `docs/endpoints/engagement-guard-matrix.md`):
 * - **Public-read (2):** `GET /engagement/engagement` (`@Public()` +
 *   `@OptionalAuth()`, DEV-044) and `GET /engagement/comments` (`@Public()`).
 * - **Auth-owner (3):** the toggles + add-comment carry **no** `@Public()`, so
 *   the global `JwtAuthGuard` is the boundary and identity is `@CurrentUser().sub`.
 * - **Admin (3):** `@Roles('admin')` (DB-resolved role) — the frozen
 *   `deleteComment`/`listAllComments`/`updateCommentStatus` were unauthorized
 *   (DEV-042).
 *
 * No route accepts a caller-supplied identity selector; a body or query
 * carrying one is a 400 (DEV-029, ADR-007).
 */
@ApiTags('engagement')
@Controller('engagement')
export class EngagementController {
  constructor(private readonly engagement: EngagementService) {}

  /* ─────────────────────────── public-read (token-optional) ─────────────────────────── */

  @Public()
  @OptionalAuthOperation() // DEV-058: anonymous permitted, token honoured — not PublicOperation()
  @OptionalAuth()
  @Get('engagement')
  @ApiOperation({
    summary: 'Aggregate engagement counts + the caller’s own state (frozen `getEngagement`, DEV-044)',
    description:
      'Exactly 8 keys. Counts are public; `userReaction`/`isBookmarked` come from the verified token `sub` when present, else `null`/`false`. A present-but-invalid/expired/revoked token is a 401 — never a silent anonymous downgrade.',
  })
  @ApiOkResponse({ type: EngagementDto, description: 'The exact frozen 8-key shape.' })
  @ApiResponse(R400)
  @ApiResponse(R401)
  getEngagement(
    @Query() q: ArticleIdQueryDto,
    @OptionalCurrentUser() caller: AuthenticatedUser | null,
  ) {
    return this.engagement.getEngagement(q.articleId, caller ? caller.sub : null);
  }

  /* ─────────────────────────── auth-owner writes ─────────────────────────── */

  @Patch('toggle-reaction')
  @ApiOperation({
    summary: 'Toggle the caller’s reaction (frozen `toggleReaction`)',
    description: 'None → insert, same type → delete, different type → patch. `articles.reactionsCount` stays in step in the same `$transaction` (DEV-021).',
  })
  @ApiOkResponse({ type: ReactionToggleDto })
  @ApiResponse(R400)
  @ApiResponse(R401)
  @ApiResponse(R404)
  toggleReaction(
    @CurrentUser() caller: AuthenticatedUser,
    @Body() dto: ToggleReactionDto,
  ) {
    return this.engagement.toggleReaction(caller.sub, dto);
  }

  @Patch('toggle-bookmark')
  @ApiOperation({
    summary: 'Toggle the caller’s bookmark (frozen `toggleBookmark`)',
    description: 'Returns the frozen boolean (`true` = now bookmarked). Shared `bookmarks` table + `(userId, articleId)` key with `GET /articles/bookmarked-articles`.',
  })
  @ApiOkResponse({ type: Boolean, description: 'true = now bookmarked; false = removed.' })
  @ApiResponse(R400)
  @ApiResponse(R401)
  @ApiResponse(R404)
  toggleBookmark(
    @CurrentUser() caller: AuthenticatedUser,
    @Body() dto: ToggleBookmarkDto,
  ) {
    return this.engagement.toggleBookmark(caller.sub, dto);
  }

  @Patch('add-comment')
  @ApiOperation({
    summary: 'Add a comment as the caller (frozen `addComment`)',
    description: 'Commenter = token `sub`; content non-empty/bounded (422); optional `parentId` must resolve to a comment on the same article (422, DEV-043). Increments `globalStats.commentsCount` in the same `$transaction` (DEV-022) and queues the frozen `comment_alert` email row.',
  })
  @ApiOkResponse({ type: CommentCreatedDto })
  @ApiResponse(R400)
  @ApiResponse(R401)
  @ApiResponse(R404)
  @ApiResponse(R422)
  addComment(
    @CurrentUser() caller: AuthenticatedUser,
    @Body() dto: AddCommentDto,
  ) {
    return this.engagement.addComment(caller.sub, dto);
  }

  /* ─────────────────────────── public read (projection) ─────────────────────────── */

  @Public()
  @PublicOperation()
  @Get('comments')
  @ApiOperation({
    summary: 'Approved comments for an article (frozen `listComments`)',
    description: 'Approved only, `createdAt DESC`, capped; each item carries the public author card (`authorName`/`authorImage`) — never a user document (DEV-034).',
  })
  @ApiOkResponse({ type: [CommentDto] })
  @ApiResponse(R400)
  listComments(@Query() q: ArticleIdQueryDto) {
    return this.engagement.listComments(q.articleId);
  }

  /* ─────────────────────────── admin moderation ─────────────────────────── */

  @Roles('admin')
  @Get('all-comments')
  @ApiOperation({
    summary: 'Moderation view of all comments (frozen `listAllComments`, admin-gated per DEV-042)',
    description: 'Adds `articleTitle`/`articleSlug`; still no user secret.',
  })
  @ApiOkResponse({ type: [AdminCommentDto] })
  @ApiResponse(R400)
  @ApiResponse(R401)
  @ApiResponse(R403)
  listAllComments(@Query() whitelist: EmptyQueryDto) {
    void whitelist; // bound so `forbidNonWhitelisted` 400s any query key (DEV-029)
    return this.engagement.listAllComments();
  }

  @Roles('admin')
  @Patch('update-comment-status')
  @ApiOperation({
    summary: 'Set a comment status (frozen `updateCommentStatus`, admin-gated per DEV-042)',
    description: '`pendingCommentsCount` delta applied in the same `$transaction` only when the status actually changes (DEV-022).',
  })
  @ApiOkResponse({ type: EngagementSuccessDto })
  @ApiResponse(R400)
  @ApiResponse(R401)
  @ApiResponse(R403)
  @ApiResponse(R404)
  updateCommentStatus(@Body() dto: UpdateCommentStatusDto) {
    return this.engagement.updateCommentStatus(dto.id, dto.status);
  }

  @Roles('admin')
  @Delete('delete-comment')
  @ApiOperation({
    summary: 'Delete a comment; replies cascade (frozen `deleteComment`, admin-gated per DEV-042)',
    description: 'Decrements `globalStats.commentsCount` by the exact removed subtree in the same `$transaction`; leaves 0 orphaned replies (DEV-043).',
  })
  @ApiOkResponse({ type: EngagementSuccessDto })
  @ApiResponse(R400)
  @ApiResponse(R401)
  @ApiResponse(R403)
  deleteComment(@Query() q: CommentIdQueryDto) {
    return this.engagement.deleteComment(q.id);
  }
}
