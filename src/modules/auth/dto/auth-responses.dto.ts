/**
 * Response schema for the credential login ceremony (`POST /auth/login`).
 *
 * `AuthService.login` returns `LoginResult` (`auth.service.ts`) — the ADR-017
 * bearer plus the caller's own secret-free projection. That projection is
 * `SelfUserProjection`, published here as the shared `SelfUserResponseDto` so
 * the two can never drift. The login operation previously carried only a
 * description and no `type`, so `docs/types/api.ts` had no type for it and a
 * generated client could not type the call.
 */
import { ApiProperty } from '@nestjs/swagger';
import { SelfUserResponseDto } from '../../users/dto/users-responses.dto';

export class LoginResponseDto {
  @ApiProperty({ description: 'Short-lived ADR-017 bearer token.' })
  accessToken: string = '';

  @ApiProperty({ enum: ['Bearer'], example: 'Bearer' })
  tokenType = 'Bearer' as const;

  @ApiProperty({ description: 'Token lifetime in seconds.' })
  expiresIn: number = 0;

  @ApiProperty({
    type: SelfUserResponseDto,
    description: 'The caller’s own projection — enumerated, secret-free (DEV-034).',
  })
  user: SelfUserResponseDto = new SelfUserResponseDto();
}
