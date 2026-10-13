/**
 * Response schemas for the `users` surface. Plain property classes with explicit
 * `@ApiProperty` types — never `any`, never an empty schema object. Shapes mirror
 * the projections in `user-projection.ts` and `SelfFull` in `users.service.ts`;
 * dates are ISO strings (Phase 04 convention), nullable columns are declared
 * `nullable`.
 *
 * This file closes the Item 1 gap: the `users` module was the only one shipping
 * no response DTO, so every `users` operation published `description: ''` with no
 * `content` block and `docs/types/api.ts` had no generated type for any of them.
 * Field-for-field, the order below is the order of `SelfUserProjection`.
 */
import { ApiProperty } from '@nestjs/swagger';

/** `APP_ROLES` — mirrors `AppRole` in `shared/guards/auth.decorators.ts`. */
const USER_ROLES = ['admin', 'user'];

/**
 * `SelfUserProjection` — the owner/admin view of a row.
 *
 * Enumerated, never a DB spread, so `password`, `resetToken`,
 * `resetTokenExpires`, `confirmationToken`, and `confirmationTokenExpires`
 * cannot appear (DEV-034, §1.6.2 test 6). Keep in lockstep with
 * `USER_PROJECTION_FIELDS` in `../user-projection.ts` — that select is the
 * control, this class is only its published description.
 */
export class SelfUserResponseDto {
  @ApiProperty() id: string = '';
  @ApiProperty() name: string = '';
  @ApiProperty() email: string = '';
  @ApiProperty({ type: String, nullable: true }) profileImage: string | null = null;
  @ApiProperty({ description: 'Account origin, e.g. `credentials` or `google`.' }) provider: string = '';
  @ApiProperty({ enum: USER_ROLES, description: 'DB-resolved, never a token claim (DEV-032).' }) role: string = '';
  @ApiProperty() newsletterSubscribed: boolean = false;
  @ApiProperty({ type: Boolean, nullable: true, description: 'NULL when no confirmation has been attempted.' })
  emailConfirmed: boolean | null = null;
  @ApiProperty({ type: [String], description: 'Tour ids already completed.' }) completedTours: string[] = [];
  @ApiProperty({ type: String, format: 'date-time' }) createdAt: string = '';
}

/** `NewsletterStats` — the three counts `GET /users/me/full` adds. */
export class SelfUserStatsDto {
  @ApiProperty() bookmarks: number = 0;
  @ApiProperty() comments: number = 0;
  @ApiProperty() reactions: number = 0;
}

/** `SelfFull` — `SelfUserProjection` plus the engagement counts. */
export class SelfUserFullResponseDto extends SelfUserResponseDto {
  @ApiProperty({ type: SelfUserStatsDto }) stats: SelfUserStatsDto = new SelfUserStatsDto();
}

/**
 * `PublicAuthorCard` — `GET /users/:id` for `/author/[id]`.
 *
 * No email, no role, none of the secret/token columns. Byte-identical in shape
 * to `AuthorCardResponseDto` in the articles module; duplicated rather than
 * imported so no module's public contract depends on another module's DTO.
 */
export class PublicAuthorCardResponseDto {
  @ApiProperty() id: string = '';
  @ApiProperty() name: string = '';
  @ApiProperty({ type: String, nullable: true }) profileImage: string | null = null;
}

/**
 * `AdminUserProjection` — identical to `SelfUserProjection` in code
 * (`user-projection.ts` types it as an alias), published under its own name so
 * an admin reader does not have to know that aliasing exists.
 */
export class AdminUserProjectionDto extends SelfUserResponseDto {}

/** The `GET /admin/users` envelope. */
export class PaginatedAdminUserDto {
  @ApiProperty({ type: [AdminUserProjectionDto] }) items: AdminUserProjectionDto[] = [];
  @ApiProperty() total: number = 0;
}

/** Neutral acknowledgement — `POST /users/me/tours`, newsletter confirm/unsubscribe, password reset. */
export class SuccessResponseDto {
  @ApiProperty({ example: true }) success: boolean = true;
}

/** `POST /users/me/tours` — literally always `{ success: true }`. */
export class TourCompletedResponseDto {
  @ApiProperty({ example: true, description: 'Always `true`; the tour record is written or already present.' })
  success = true as const;
}

/**
 * `POST /users/newsletter/subscribe` status. The double-opt-in token is minted
 * server-side for the email worker and **never** crosses HTTP (the controller
 * strips it) — so this object can carry no token field.
 */
export class SubscribeStatusResponseDto {
  @ApiProperty({ enum: ['verification_sent', 'subscribed'] }) status: string = '';
}

/** `POST /users/register` — deliberately neutral, identical for taken and free addresses. */
export class RegisterResponseDto {
  @ApiProperty({ example: 'ok' }) status: string = '';
}

/** `POST /internal/users/store` — the Google sign-in upsert result. */
export class StoredUserResponseDto {
  @ApiProperty() id: string = '';
}

/** `POST /internal/users/reset-token` — null when no account holds that address. */
export class ResetTokenResponseDto {
  @ApiProperty() token: string = '';
  @ApiProperty({ type: String, format: 'date-time' }) expiresAt: string = '';
}