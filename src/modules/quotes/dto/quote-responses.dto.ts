import { ApiProperty } from '@nestjs/swagger';

/** `toQuote` — the document shape returned by `PATCH /quotes/add`. */
export class QuoteResponseDto {
  @ApiProperty() id: string = '';
  @ApiProperty() text: string = '';
  @ApiProperty() author: string = '';
  @ApiProperty({ type: String, nullable: true }) category: string | null = null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt: string = '';
}
