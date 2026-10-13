import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class AddQuoteDto {
  @ApiProperty({ maxLength: 5000 })
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  text!: string;

  @ApiProperty({ maxLength: 255 })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  author!: string;

  @ApiPropertyOptional({ maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  category?: string;
}

export class RemoveQuoteDto {
  @ApiProperty()
  @IsUUID()
  id!: string;
}

export class RandomQuoteQueryDto {
  @ApiPropertyOptional({ description: 'Restrict the pool to one quote category.' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  category?: string;
}
