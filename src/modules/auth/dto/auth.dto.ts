import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MaxLength } from 'class-validator';
import { IsPlaintextPassword } from '../../../shared/dto/is-plaintext-password';

/**
 * Credential login. The Nest API verifies against Postgres bcrypt — the login
 * ceremony now talks to Nest (ADR-017, "Option 1"). Identity-free: the only
 * inputs are the credential pair.
 */
export class LoginDto {
  @ApiProperty({ example: 'ada@example.com', maxLength: 320 })
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @ApiProperty({ example: 'correct horse battery staple', minLength: 8, maxLength: 72 })
  @IsString()
  @IsPlaintextPassword()
  password!: string;
}
