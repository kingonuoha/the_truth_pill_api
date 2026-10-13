/**
 * OTP domain types.
 *
 * `type` mirrors the Prisma `OtpCodeType` enum exactly (`web/convex/otp.ts:7`),
 * so this union is assignable to the Prisma column without a cast.
 */
export const OTP_TYPES = ['password_reset', 'password_change'] as const;

export type OtpType = (typeof OTP_TYPES)[number];

/**
 * Every send response is this shape, on every branch (R5). It deliberately
 * carries no evidence of whether the address exists or is on cooldown.
 */
export interface OtpSendResult {
  success: true;
  message: string;
}

/**
 * Every verification response is this shape. A failure is one identical body on
 * every path (R4) — invalid, expired, locked, consumed, or unknown all look the
 * same to the caller.
 */
export interface OtpVerifyResult {
  success: boolean;
  message: string;
}
