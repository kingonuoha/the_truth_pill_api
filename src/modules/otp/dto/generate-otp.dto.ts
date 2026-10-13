import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsIn, MaxLength } from 'class-validator';
import { OTP_TYPES, type OtpType } from '../otp.types';

/**
 * `generateOtp` request. The `email` here is the **subject** of the send — the
 * address a code is requested *for* — not a caller identity. It is explicitly
 * legitimate per `phase-00/auth-security-task.md` §6.5, and it is bounded and
 * format-validated.
 *
 * DEV-006: every field carries an explicit validator — no `v.any()`, no
 * permissive/optional argument survives (ADR-010).
 */
export class GenerateOtpDto {
  @ApiProperty({ example: 'reader@example.com', maxLength: 320 })
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @ApiProperty({ enum: OTP_TYPES, example: 'password_reset' })
  @IsIn(OTP_TYPES)
  type!: OtpType;
}
