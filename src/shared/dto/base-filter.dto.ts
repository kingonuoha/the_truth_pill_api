import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationQueryDto } from './pagination-query.dto';

/** Sort direction shared by every filtered list endpoint. */
export type SortOrder = 'asc' | 'desc';

/**
 * Shared filtering convention (D5). A list endpoint that supports a search
 * term or a sort column extends this on top of `PaginationQueryDto`, so the
 * query contract does not drift between domains.
 */
export class BaseFilterDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: 'Free-text search term.',
    maxLength: 200,
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({
    description: 'Field/column to sort by. Endpoint-specific allowlist.',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  sort?: string;

  @ApiPropertyOptional({
    description: 'Sort direction.',
    enum: ['asc', 'desc'],
    default: 'desc',
  })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  order: SortOrder = 'desc';
}
