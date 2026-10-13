import { ApiProperty } from '@nestjs/swagger';

/** `toCategory` — the document shape returned by every category read/write. */
export class CategoryResponseDto {
  @ApiProperty() id: string = '';
  @ApiProperty() name: string = '';
  @ApiProperty({ description: 'Public URL segment — byte-preserved.' }) slug: string = '';
  @ApiProperty({ type: String, nullable: true }) description: string | null = null;
  @ApiProperty({ type: String, nullable: true }) coverImage: string | null = null;
  @ApiProperty({ type: [String], description: 'Stored image URLs; no vendor call is made here.' }) pexelsImages: string[] = [];
  @ApiProperty() articleCount: number = 0;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt: string = '';
}

/** `listAll` item — the document plus the pillar count (`categories.ts:33-43`). */
export class CategoryListItemDto extends CategoryResponseDto {
  @ApiProperty({ description: 'Pillars attached to this category.' }) pillarCount: number = 0;
}
