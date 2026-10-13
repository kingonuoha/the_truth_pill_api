import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { IsPlaintextPassword } from '../../../shared/dto/is-plaintext-password';

/**
 * Public registration (DEV-037). Identity-free: there is no `role`, no `id`,
 * caller-supplied identity — the account is always created as `role: "user"`.
 */
export class RegisterDto {
  @ApiProperty({ example: 'Ada Lovelace', maxLength: 120 })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiProperty({ example: 'ada@example.com', maxLength: 320 })
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @ApiProperty({ example: 'correct horse battery staple', minLength: 8, maxLength: 72 })
  @IsString()
  @IsPlaintextPassword()
  password!: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  newsletterSubscribed?: boolean;
}

/**
 * Internal upsert for a Google-authenticated user. `provider` is **forced**
 * server-side to `google`; it is not a DTO field (DEV-037).
 */
export class StoreUserDto {
  @ApiProperty({ example: 'Ada Lovelace', maxLength: 120 })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiProperty({ example: 'ada@example.com', maxLength: 320 })
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @ApiPropertyOptional({ maxLength: 2048 })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  profileImage?: string;
}

/** Newsletter double opt-in request (DEV-036, DEV-037). */
export class SubscribeNewsletterDto {
  @ApiProperty({ example: 'ada@example.com', maxLength: 320 })
  @IsEmail()
  @MaxLength(320)
  email!: string;
}

/** Newsletter confirmation (P02-SEC-001). */
export class ConfirmNewsletterDto {
  @ApiProperty({ description: 'Signed, expiring, single-use confirmation token.' })
  @IsString()
  @MinLength(1)
  @MaxLength(2048)
  token!: string;
}

/** Unsubscribe (DEV-035). No bare `?email=` — a signed single-use token only. */
export class UnsubscribeDto {
  @ApiProperty({ description: 'Signed, single-use unsubscribe token.' })
  @IsString()
  @MinLength(1)
  @MaxLength(2048)
  token!: string;
}

/** Password reset consumption (DEV-033, DEV-036). */
export class ResetPasswordDto {
  @ApiProperty({ description: 'Single-use, short-TTL reset token.' })
  @IsString()
  @MinLength(1)
  @MaxLength(2048)
  token!: string;

  @ApiProperty({ example: 'a new plaintext passphrase', minLength: 8, maxLength: 72 })
  @IsString()
  @IsPlaintextPassword()
  password!: string;
}

/** Update the caller's own profile. Identity comes from the token, not the body. */
export class UpdateProfileDto {
  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ maxLength: 2048 })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  profileImage?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  newsletterSubscribed?: boolean;
}

/** Record a completed guided tour for the caller. */
export class CompleteTourDto {
  @ApiProperty({ example: 'welcome-tour' })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  tourId!: string;
}

/** Admin role change (DEV-001). The actor is the verified token, not a body field. */
export class UpdateUserRoleDto {
  @ApiProperty({ enum: ['admin', 'user'] })
  @IsString()
  @IsIn(['admin', 'user'])
  role!: 'admin' | 'user';
}

/** Internal: mint a reset token for an address (server-side CSPRNG). */
export class MintResetTokenDto {
  @ApiProperty({ example: 'ada@example.com', maxLength: 320 })
  @IsEmail()
  @MaxLength(320)
  email!: string;
}
