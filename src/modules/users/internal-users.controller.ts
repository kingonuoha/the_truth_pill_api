import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { Public } from '../../shared/guards/auth.decorators';
import { InternalSecretGuard } from '../../shared/guards/internal-secret.guard';
import { INTERNAL_SECRET_SECURITY_SCHEME } from '../../shared/swagger/security';
import { MintResetTokenDto, StoreUserDto } from './dto/users.dto';
import {
  ResetTokenResponseDto,
  StoredUserResponseDto,
} from './dto/users-responses.dto';
import { UsersService } from './users.service';

const R401 = { status: 401, description: 'Missing or incorrect `x-internal-secret` (Hard Rule 6).' };

/**
 * Internal `/internal/*` ops behind `INTERNAL_JOB_SECRET`, compared timing-safely
 * (AGENTS.md Hard Rule 6, DEV-012-class). Marked `@Public()` so the global JWT
 * guard does not also demand a bearer token; `InternalSecretGuard` is the sole
 * boundary and fails closed when the secret is unset.
 */
@ApiTags('internal-users')
@Public()
@ApiSecurity(INTERNAL_SECRET_SECURITY_SCHEME)
@UseGuards(InternalSecretGuard)
@Controller('internal/users')
export class InternalUsersController {
  constructor(private readonly users: UsersService) {}

  @Post('store')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Google sign-in upsert (internal secret)' })
  @ApiOkResponse({ type: StoredUserResponseDto })
  @ApiResponse(R401)
  store(@Body() dto: StoreUserDto): Promise<{ id: string }> {
    return this.users.storeUser(dto);
  }

  @Post('reset-token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mint a password-reset token (internal secret)' })
  @ApiOkResponse({
    type: ResetTokenResponseDto,
    description: 'Omitted entirely (empty body, 200) when no account holds that address — the mint is not an existence oracle.',
  })
  @ApiResponse(R401)
  mintResetToken(
    @Body() dto: MintResetTokenDto,
  ): Promise<{ token: string; expiresAt: string } | null> {
    return this.users.mintResetToken(dto);
  }
}
