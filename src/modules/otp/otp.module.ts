import { Module } from '@nestjs/common';
import { PrismaModule } from '../../core/prisma/prisma.module';
import { OtpController } from './otp.controller';
import { OtpService } from './otp.service';
import { OtpThrottlerModule } from './throttling/otp-throttler.config';

/**
 * The OTP module (Phase 04, `truth-pill-backend`).
 *
 * Owns `generateOtp` / `verifyOtp` / `verifyOtpAndChangePassword` and the
 * §CN-1 R1–R10 controls. Imports the shared `ThrottlerModule` for R8 by IP and
 * by account. `PrismaModule` is imported explicitly (not `@Global()`), keeping
 * the data dependency visible (D1/D2).
 */
@Module({
  imports: [PrismaModule, OtpThrottlerModule],
  controllers: [OtpController],
  providers: [OtpService],
  exports: [OtpService],
})
export class OtpModule {}
