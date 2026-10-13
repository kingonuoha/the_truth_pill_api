/**
 * Response schemas for the engagement surface (Phase 06). Plain property
 * classes with explicit `@ApiProperty` types — never `any`, never an empty
 * schema object. Shapes mirror the projection functions in
 * `engagement-projection.ts`; dates are ISO-8601 strings (Phase 04/05
 * convention), nullable columns are declared `nullable`.
 *
 * No DTO field can carry a user secret: the rows are built from an explicit
 * `select` set and the author card is `authorName` / `authorImage` only
 * (DEV-034 class).
 */
import { ApiProperty } from '@nestjs/swagger';
import { COMMENT_STATUSES, REACTION_TYPES } from './engagement.dto';

/** The exact 8-key `getEngagement` payload (`engagement.ts:57-66`, DEV-044). */
export class EngagementDto {
  @ApiProperty() likeCount: number = 0;
  @ApiProperty() loveCount: number = 0;
  @ApiProperty() insightfulCount: number = 0;
  @ApiProperty() totalReactions: number = 0;
  @ApiProperty() commentsCount: number = 0;
  @ApiProperty() bookmarksCount: number = 0;
  @ApiProperty({ type: String, enum: REACTION_TYPES, nullable: true, description: 'The caller’s own reaction, from the token `sub`; null when anonymous or none.' })
  userReaction: 'like' | 'love' | 'insightful' | null = null;
  @ApiProperty({ description: 'The caller’s own bookmark state, from the token `sub`; false when anonymous.' })
  isBookmarked: boolean = false;
}

/** A public comment (`listComments`): frozen fields + the public author card. */
export class CommentDto {
  @ApiProperty() id: string = '';
  @ApiProperty() articleId: string = '';
  @ApiProperty({ description: 'Bare user UUID reference — not caller identity, not a selector.' })
  userId: string = '';
  @ApiProperty({ type: String, nullable: true }) parentId: string | null = null;
  @ApiProperty() content: string = '';
  @ApiProperty({ enum: COMMENT_STATUSES }) status: string = 'approved';
  @ApiProperty({ type: String, format: 'date-time' }) createdAt: string = '';
  @ApiProperty({ description: 'Frozen fallback "Unknown" (`engagement.ts:222`).' })
  authorName: string = '';
  @ApiProperty({ type: String, nullable: true }) authorImage: string | null = null;
}

/** The admin moderation item (`listAllComments`): public shape + article context. */
export class AdminCommentDto extends CommentDto {
  @ApiProperty({ description: 'Frozen fallback "Deleted Article" (`engagement.ts:241`).' })
  articleTitle: string = '';
  @ApiProperty({ type: String, nullable: true }) articleSlug: string | null = null;
}

/** `toggleReaction` result — the written state, never a secret. */
export class ReactionToggleDto {
  @ApiProperty({ description: 'true when a reaction is now stored; false when it was removed.' })
  active: boolean = false;
  @ApiProperty({ type: String, enum: REACTION_TYPES, nullable: true })
  type: 'like' | 'love' | 'insightful' | null = null;
}

/** `addComment` result — the created comment id (frozen returned the id). */
export class CommentCreatedDto {
  @ApiProperty() id: string = '';
}

/** Void-mutation acknowledgement (`updateCommentStatus`, `deleteComment`). */
export class EngagementSuccessDto {
  @ApiProperty({ example: true }) success: boolean = true;
}
