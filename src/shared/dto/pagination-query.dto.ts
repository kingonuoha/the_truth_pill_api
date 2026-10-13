import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/** Largest page the API will serve. Prevents accidental full-table reads. */
export const MAX_PAGE_SIZE = 100;

/** Default page size when the client does not specify one. */
export const DEFAULT_PAGE_SIZE = 20;

/**
 * Shared pagination convention (D5). Every list endpoint extends this so the
 * query contract is identical across domains.
 *
 * `ValidationPipe({ transform: true })` + `@Type(() => Number)` coerce the
 * string query params into numbers before validation.
 */
export class PaginationQueryDto {
  @ApiPropertyOptional({
    description: '1-based page number.',
    minimum: 1,
    default: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({
    description: `Items per page (1-${MAX_PAGE_SIZE}).`,
    minimum: 1,
    maximum: MAX_PAGE_SIZE,
    default: DEFAULT_PAGE_SIZE,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  pageSize: number = DEFAULT_PAGE_SIZE;
}
