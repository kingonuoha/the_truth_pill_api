import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID } from 'class-validator';

/**
 * Request DTOs for the engagement surface (Phase 06).
 *
 * The four frozen caller-supplied identity selectors
 * (`web/convex/engagement.ts:8,73,126,159`) are **absent**: identity resolves
 * only from the verified token `sub`. A body or query carrying a caller-supplied
 * identity selector (a user email, user id, or admin email) is a **400** via the
 * global `ValidationPipe({ whitelist, forbidNonWhitelisted })` — deleted, not
 * ignored (ADR-010, DEV-029).
 */

/** Mirrors the Prisma `ReactionType` enum — never a `v.any()` (ADR-010). */
export const REACTION_TYPES = ['like', 'love', 'insightful'] as const;
export type ReactionTypeValue = (typeof REACTION_TYPES)[number];

/** Mirrors the Prisma `CommentStatus` enum. */
export const COMMENT_STATUSES = ['pending', 'approved', 'spam', 'removed'] as const;
export type CommentStatusValue = (typeof COMMENT_STATUSES)[number];

/** Bound for `addComment.content`. The frozen mutation had none; Nest bounds it. */
export const COMMENT_CONTENT_MAX_LENGTH = 5000;

/** Query for `GET /engagement/engagement` and `GET /engagement/comments`. */
export class ArticleIdQueryDto {
  @ApiProperty({ description: 'Article id (uuid).', format: 'uuid' })
  @IsUUID()
  articleId!: string;
}

/** Query for `DELETE /engagement/delete-comment`. */
export class CommentIdQueryDto {
  @ApiProperty({ description: 'Comment id (uuid).', format: 'uuid' })
  @IsUUID()
  id!: string;
}

/**
 * A DTO with no properties: combined with the global `forbidNonWhitelisted`
 * pipe, any query key is a 400 rather than silently read (DEV-029).
 */
export class EmptyQueryDto {}

/** `toggleReaction` (`engagement.ts:70-121`). */
export class ToggleReactionDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  articleId!: string;

  @ApiProperty({ enum: REACTION_TYPES })
  @IsIn([...REACTION_TYPES])
  type!: ReactionTypeValue;
}

/** `toggleBookmark` (`engagement.ts:123-154`). */
export class ToggleBookmarkDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  articleId!: string;
}

/**
 * `addComment` (`engagement.ts:156-205`). `content` emptiness and the length
 * bound are enforced in the service as a **422** naming the field (the brief's
 * `empty/oversize → 422` contract); `@IsString()` rejects a non-string body with
 * 400. `parentId` must resolve to a comment on the same article (422).
 */
export class AddCommentDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  articleId!: string;

  @ApiProperty({
    description: `Comment body — non-empty, at most ${COMMENT_CONTENT_MAX_LENGTH} characters (validated in the service as 422).`,
  })
  @IsString()
  content!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Parent comment id — must resolve to a comment on the same article (422 otherwise, DEV-043).',
  })
  @IsOptional()
  @IsUUID()
  parentId?: string;
}

/** `updateCommentStatus` (`engagement.ts:249-288`). */
export class UpdateCommentStatusDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  id!: string;

  @ApiProperty({ enum: COMMENT_STATUSES })
  @IsIn([...COMMENT_STATUSES])
  status!: CommentStatusValue;
}
