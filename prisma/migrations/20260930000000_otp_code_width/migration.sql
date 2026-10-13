-- Phase 01 — DEV-027 (security finding P01-SEC-001). Widen `otpCodes.code` from
-- VARCHAR(32) to VARCHAR(128) so the Phase 03/06 auth rebuild can hash OTPs at
-- rest per §CN-1 R9 without a blocking schema change at the moment the fix
-- lands. A 6-digit Convex plaintext OTP still fits, so the Phase 02 import is
-- unaffected. `otpCodes` has 0 rows on the dev branch, so this widening is
-- free and idempotent.

-- AlterTable
ALTER TABLE "otpCodes" ALTER COLUMN "code" TYPE VARCHAR(128);
