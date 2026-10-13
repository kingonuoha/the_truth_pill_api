import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AuthenticatedUser,
  CurrentUser,
  Public,
} from '../../shared/guards/auth.decorators';
import { AuthService, LoginResult } from './auth.service';
import { LoginDto } from './dto/auth.dto';
import { LoginResponseDto } from './dto/auth-responses.dto';
import { PublicOperation } from '../../shared/swagger/security';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** Public credential login; the only unauthenticated auth endpoint. */
  @Public()
  @PublicOperation()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify credentials and mint a short-lived API token' })
  @ApiOkResponse({ type: LoginResponseDto, description: 'Access token plus the caller’s own projection' })
  login(@Body() dto: LoginDto): Promise<LoginResult> {
    return this.auth.login(dto);
  }

  /** Revoke the bearer token used on this request. */
  @Post('revoke')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke the presenting token (jti deny-list)' })
  revoke(@CurrentUser() caller: AuthenticatedUser): void {
    this.auth.revoke(caller);
  }
}
