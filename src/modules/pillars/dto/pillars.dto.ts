import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class PillarByCategoryQueryDto {
  @ApiProperty()
  @IsUUID()
  categoryId!: string;
}

export class PillarBySlugQueryDto {
  @ApiProperty({ example: 'dark-psychology' })
  @IsString()
  @MaxLength(255)
  slug!: string;
}

export class CreatePillarDto {
  @ApiProperty({ maxLength: 255 })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name!: string;

  @ApiProperty({ description: 'Public URL segment — byte-preserved; unique (409 on collision).' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  slug!: string;

  @ApiProperty()
  @IsUUID()
  categoryId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @ApiPropertyOptional({ description: 'Stored image URL — no vendor call is made here.' })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  coverImage?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  pexelsImages?: string[];
}

export class UpdatePillarDto {
  @ApiProperty()
  @IsUUID()
  id!: string;

  @ApiPropertyOptional({ maxLength: 255 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  slug?: string;

  @ApiPropertyOptional({ description: 'Unresolvable id → 422 naming the field (DEV-011 class).' })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  coverImage?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  pexelsImages?: string[];
}

export class RemovePillarDto {
  @ApiProperty()
  @IsUUID()
  id!: string;
}
