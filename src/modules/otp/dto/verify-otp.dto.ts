import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsIn, Matches, MaxLength } from 'class-validator';
import { OTP_CODE_PATTERN } from '../otp.constants';
import { OTP_TYPES, type OtpType } from '../otp.types';

/** `verifyOtp` request. Possession of the 6-digit code is the authenticator. */
export class VerifyOtpDto {
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
}
