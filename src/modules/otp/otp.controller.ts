import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ThrottlerGuard } from '@nestjs/throttler';
import { Public } from '../../shared/guards/auth.decorators';
import { PublicOperation } from '../../shared/swagger/security';
import { GenerateOtpDto } from './dto/generate-otp.dto';
import {
  OtpSendResultDto,
  OtpVerifyResultDto,
} from './dto/otp-response.dto';
import { VerifyOtpAndChangePasswordDto } from './dto/verify-otp-and-change-password.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { OtpService } from './otp.service';
import type { OtpSendResult, OtpVerifyResult } from './otp.types';

/**
 * OTP routes — §10 group (b): public, projection-constrained.
 *
 * `@Public()` is mandatory: the global default-deny `JwtAuthGuard`
 * (`shared/guards/jwt-auth.guard.ts`) 401s every route not carrying it. These
 * three are the allowlisted public auth flow (Phase 00 §10(b)). The optional
 * bearer token is ignored here — OTP possession is the authenticator.
 *
 * R8 is enforced here: `ThrottlerGuard` applies both the `otp-ip` and
 * `otp-account` throttlers configured in `OtpModule`.
 *
 * Routes are `POST`/`PATCH`, never `GET`: `verifyOtp` charges an attempt
 * (side effect) and `verifyOtpAndChangePassword` writes, so neither may be a
 * `GET` (AGENTS.md Migration Rule; `api:check` convention lint).
 */
@ApiTags('otp')
@Public()
@PublicOperation()
@Controller('otp')
@UseGuards(ThrottlerGuard)
export class OtpController {
  constructor(private readonly otpService: OtpService) {}

  @Post('generate-otp')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Request a one-time password for an address.',
    description:
      'Always returns the same neutral body, whether or not the address ' +
      'exists and whether or not the resend cooldown is in effect (R3/R5).',
  })
  @ApiOkResponse({ type: OtpSendResultDto })
  generateOtp(@Body() dto: GenerateOtpDto): Promise<OtpSendResult> {
    return this.otpService.generateOtp(dto);
  }

  @Patch('verify-otp')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Verify a one-time password.',
    description:
      'One identical failure body on every path (R4). Charges an attempt on ' +
      'failure, consumes the code on success (R1/R7).',
  })
  @ApiOkResponse({ type: OtpVerifyResultDto })
  verifyOtp(@Body() dto: VerifyOtpDto): Promise<OtpVerifyResult> {
    return this.otpService.verifyOtp(dto);
  }

  @Patch('verify-otp-and-change-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Verify a one-time password and set a new password.',
    description:
      'The new password is plaintext and hashed server-side (R10); a ' +
      'pre-hashed value is refused. Consume + password write are one ' +
      'transaction (R7).',
  })
  @ApiOkResponse({ type: OtpVerifyResultDto })
  verifyOtpAndChangePassword(
    @Body() dto: VerifyOtpAndChangePasswordDto,
  ): Promise<OtpVerifyResult> {
    return this.otpService.verifyOtpAndChangePassword(dto);
  }
}
