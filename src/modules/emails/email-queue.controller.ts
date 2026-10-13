import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Public, Roles } from '../../shared/guards/auth.decorators';
import { EmailsService } from './emails.service';
import {
  RequestPasswordResetDto,
  SendTestEmailDto,
} from './dto/emails.dto';
import {
  PasswordResetNeutralDto,
  SendTestEmailResultDto,
} from './dto/email-responses.dto';
import { PublicOperation } from '../../shared/swagger/security';

const R400 = { status: 400, description: 'Invalid input or an unknown-field body.' };
const R401 = { status: 401, description: 'Missing or invalid bearer token (default-deny).' };
const R403 = { status: 403, description: 'The caller is not an admin (DB-resolved role).' };

/**
 * The action-backed email surface: the admin `sendTestEmail`, and the single
 * **public**, **neutral** `requestPasswordReset` (frozen matrix §2.1/§2.3).
 */
@ApiTags('email-queue')
@Controller('email-queue')
export class EmailQueueController {
  constructor(private readonly emails: EmailsService) {}

  @Post('send-test-email')
  @HttpCode(HttpStatus.OK)
  @Roles('admin')
  @ApiOperation({
    summary: 'Send a test email (frozen `sendTestEmail`)',
    description: 'Admin only. A failure returns a generic message with no SMTP internals or stack (Hard Rule 4).',
  })
  @ApiOkResponse({ type: SendTestEmailResultDto })
  @ApiBadRequestResponse(R400)
  @ApiUnauthorizedResponse(R401)
  @ApiForbiddenResponse(R403)
  sendTestEmail(@Body() dto: SendTestEmailDto) {
    return this.emails.sendTestEmail(dto);
  }

  @Post('request-password-reset')
  @HttpCode(HttpStatus.OK)
  @Public()
  @PublicOperation()
  @ApiOperation({
    summary: 'Request a password reset (frozen `requestPasswordReset`, DEV-036/DEV-033)',
    description:
      'Public and neutral: a known and an unknown address return the identical `{success:true}` (no enumeration). The token is CSPRNG and stored server-side; it never appears in the response or a log.',
  })
  @ApiOkResponse({ type: PasswordResetNeutralDto })
  @ApiBadRequestResponse(R400)
  requestPasswordReset(@Body() dto: RequestPasswordResetDto) {
    return this.emails.requestPasswordReset(dto);
  }
}
