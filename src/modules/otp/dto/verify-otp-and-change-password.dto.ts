import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsIn, Matches, MaxLength } from 'class-validator';
import { IsPlaintextPassword } from '../../../shared/dto/is-plaintext-password';
import { OTP_CODE_PATTERN } from '../otp.constants';
import { OTP_TYPES, type OtpType } from '../otp.types';

/**
 * `verifyOtpAndChangePassword` request.
 *
 * `newPassword` is **plaintext** and is hashed server-side (R10 / DEV-033). The
 * legacy contract took an already-hashed value; refusing that shape is the
 * deviation, and `IsPlaintextPassword` is where it is enforced.
 */
export class VerifyOtpAndChangePasswordDto {
  @ApiProperty({ example: 'reader@example.com', maxLength: 320 })
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @ApiProperty({ example: '123456', pattern: OTP_CODE_PATTERN.source })
  @Matches(OTP_CODE_PATTERN)
  code!: string;

  @ApiProperty({ enum: OTP_TYPES, example: 'password_reset' })
  @IsIn(OTP_TYPES)
  type!: OtpType;

  @ApiProperty({
    description:
      'Plaintext new password (8-72 chars). A pre-computed bcrypt hash is refused.',
    example: 'correct horse battery staple',
  })
  @IsPlaintextPassword()
  newPassword!: string;
}
