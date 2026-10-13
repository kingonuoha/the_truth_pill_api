import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CategoryBySlugQueryDto {
  @ApiProperty({ example: 'psychology' })
  @IsString()
  @MaxLength(255)
  slug!: string;
}

export class CategoryByIdQueryDto {
  @ApiProperty()
  @IsUUID()
  id!: string;
}

export class CreateCategoryDto {
  @ApiProperty({ maxLength: 255 })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name!: string;

  @ApiProperty({ description: 'Public URL segment — byte-preserved (AGENTS.md rule 6).' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  slug!: string;

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

  @ApiPropertyOptional({ type: [String], description: 'Stored Pexels image URLs. Empty by default — the Pexels API is not called from this module.' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  pexelsImages?: string[];
}

/** `update` (`categories.ts:65-77`): everything optional except the id. */
export class UpdateCategoryDto {
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

export class RemoveCategoryDto {
  @ApiProperty()
  @IsUUID()
  id!: string;
}
