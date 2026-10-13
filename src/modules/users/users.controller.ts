import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import {
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import {
  AuthenticatedUser,
  CurrentUser,
  Public,
} from '../../shared/guards/auth.decorators';
import {
  CompleteTourDto,
  ConfirmNewsletterDto,
  RegisterDto,
  ResetPasswordDto,
  SubscribeNewsletterDto,
  UnsubscribeDto,
  UpdateProfileDto,
} from './dto/users.dto';
import {
  PublicAuthorCard,
  SelfUserProjection,
} from './user-projection';
import {
  IssuedNewsletterToken,
  SelfFull,
  UsersService,
} from './users.service';
import {
  PublicAuthorCardResponseDto,
  RegisterResponseDto,
  SelfUserFullResponseDto,
  SelfUserResponseDto,
  SubscribeStatusResponseDto,
  SuccessResponseDto,
  TourCompletedResponseDto,
} from './dto/users-responses.dto';
import { PublicOperation } from '../../shared/swagger/security';

const R401 = { status: 401, description: 'Missing, invalid, expired, or revoked bearer token.' };
const R404 = { status: 404, description: 'Not found.' };

/**
 * The public/self `users` surface. Identity comes only from the verified token;
 * no endpoint accepts a caller-supplied identity selector; `forbidNonWhitelisted`
 * rejects such a field with 400.
 */
@ApiTags('users')
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  /* ----- self (auth required) — declared before `:id` so it is not captured ----- */

  @Get('me')
  @ApiOperation({ summary: 'The caller’s own projected profile' })
  @ApiOkResponse({ type: SelfUserResponseDto })
  @ApiResponse(R401)
  getMe(@CurrentUser() caller: AuthenticatedUser): Promise<SelfUserProjection> {
    return this.users.getSelf(caller.sub);
  }

  @Get('me/full')
  @ApiOperation({ summary: 'The caller’s profile plus engagement counts' })
  @ApiOkResponse({ type: SelfUserFullResponseDto })
  @ApiResponse(R401)
  getMeFull(@CurrentUser() caller: AuthenticatedUser): Promise<SelfFull> {
    return this.users.getSelfFull(caller.sub);
  }

  @Patch('me')
  @ApiOperation({ summary: 'Update the caller’s own profile' })
  @ApiOkResponse({ type: SelfUserResponseDto })
  @ApiResponse(R401)
  updateMe(
    @CurrentUser() caller: AuthenticatedUser,
    @Body() dto: UpdateProfileDto,
  ): Promise<SelfUserProjection> {
    return this.users.updateProfile(caller.sub, dto);
  }

  @Delete('me')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete the caller’s own account' })
  @ApiNoContentResponse({ description: 'Deleted. No body, by HTTP semantics for 204.' })
  @ApiResponse(R401)
  deleteMe(@CurrentUser() caller: AuthenticatedUser): Promise<void> {
    return this.users.deleteAccount(caller.sub);
  }

  @Post('me/tours')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Record a completed tour for the caller' })
  @ApiOkResponse({ type: TourCompletedResponseDto })
  @ApiResponse(R401)
  completeTour(
    @CurrentUser() caller: AuthenticatedUser,
    @Body() dto: CompleteTourDto,
  ): Promise<{ success: true }> {
    return this.users.completeTour(caller.sub, dto);
  }

  /* ----- truly public read ----- */

  @Public()
  @PublicOperation()
  @Get(':id')
  @ApiOperation({ summary: 'Public author card for /author/[id]' })
  @ApiOkResponse({
    type: PublicAuthorCardResponseDto,
    description: 'id/name/profileImage only — no email, no role, no token field can appear (DEV-034).',
  })
  @ApiResponse(R404)
  getUserById(@Param('id') id: string): Promise<PublicAuthorCard> {
    return this.users.getUserById(id);
  }

  /* ----- public writes ----- */

  @Public()
  @PublicOperation()
  @Post('register')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Register a new account (neutral response)' })
  @ApiOkResponse({
    type: RegisterResponseDto,
    description: 'Deliberately identical whether or not the address was already taken.',
  })
  register(@Body() dto: RegisterDto): Promise<{ status: 'ok' }> {
    return this.users.register(dto);
  }

  @Public()
  @PublicOperation()
  @Post('newsletter/subscribe')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Subscribe to the newsletter (double opt-in)' })
  @ApiOkResponse({
    type: SubscribeStatusResponseDto,
    description: 'The double-opt-in token is minted for the email worker and never returned over HTTP.',
  })
  async subscribe(
    @Body() dto: SubscribeNewsletterDto,
  ): Promise<{ status: string }> {
    const result: IssuedNewsletterToken =
      await this.users.subscribeToNewsletter(dto);
    // The token is returned to internal callers only; never over HTTP.
    return { status: result.status };
  }

  @Public()
  @PublicOperation()
  @Post('newsletter/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirm a newsletter subscription' })
  @ApiOkResponse({ type: SuccessResponseDto })
  @ApiResponse(R401)
  confirm(
    @Body() dto: ConfirmNewsletterDto,
    @Req() request: Request,
  ): Promise<{ success: boolean }> {
    return this.users.confirmNewsletter(dto, request.ip ?? 'unknown');
  }

  @Public()
  @PublicOperation()
  @Post('newsletter/unsubscribe')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unsubscribe via a signed single-use token' })
  @ApiOkResponse({ type: SuccessResponseDto })
  @ApiResponse(R401)
  unsubscribe(@Body() dto: UnsubscribeDto): Promise<{ success: true }> {
    return this.users.unsubscribe(dto);
  }

  @Public()
  @PublicOperation()
  @Post('password/reset')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Consume a reset token and set a new password' })
  @ApiOkResponse({ type: SuccessResponseDto })
  @ApiResponse(R401)
  resetPassword(@Body() dto: ResetPasswordDto): Promise<{ success: true }> {
    return this.users.resetPassword(dto);
  }
}
