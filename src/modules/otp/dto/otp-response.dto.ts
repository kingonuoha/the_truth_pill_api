import { ApiProperty } from '@nestjs/swagger';

/** OpenAPI shape for every send response (R5). */
export class OtpSendResultDto {
  @ApiProperty({ example: true })
  success!: boolean;

  @ApiProperty({
    example: 'If you have an account with us, you should get an email',
  })
  message!: string;
}

/** OpenAPI shape for every verification response (R4). */
export class OtpVerifyResultDto {
  @ApiProperty({ example: false })
  success!: boolean;

  @ApiProperty({ example: 'Invalid or expired code' })
  message!: string;
}
