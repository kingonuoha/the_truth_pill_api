import { ApiProperty } from '@nestjs/swagger';

/** `toPillar` — the document shape returned by every pillar read/write. */
export class PillarResponseDto {
  @ApiProperty() id: string = '';
  @ApiProperty() name: string = '';
  @ApiProperty({ description: 'Public URL segment — byte-preserved; unique.' }) slug: string = '';
  @ApiProperty({ type: String, nullable: true }) description: string | null = null;
  @ApiProperty({ type: String, nullable: true }) coverImage: string | null = null;
  @ApiProperty({ type: [String], description: 'Stored image URLs; no vendor call is made here.' }) pexelsImages: string[] = [];
  @ApiProperty() categoryId: string = '';
  @ApiProperty({ type: String, format: 'date-time' }) createdAt: string = '';
}

/** `listAll` item — the document plus the resolved category fields. */
export class PillarListItemDto extends PillarResponseDto {
  @ApiProperty() categoryName: string = '';
  @ApiProperty() categorySlug: string = '';
}
