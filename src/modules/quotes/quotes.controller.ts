import { Body, Controller, Get, HttpCode, HttpStatus, NotFoundException, Patch, Query } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Public, Roles } from '../../shared/guards/auth.decorators';
import { PrismaService } from '../../core/prisma/prisma.service';
import { AddQuoteDto, RandomQuoteQueryDto, RemoveQuoteDto } from './dto/quotes.dto';
import { QuoteResponseDto } from './dto/quote-responses.dto';
import { SuccessDto } from '../articles/dto/article-responses.dto';
import { PublicOperation } from '../../shared/swagger/security';

function toQuote(q: {
  id: string;
  text: string;
  author: string;
  category: string | null;
  createdAt: Date;
}) {
  return {
    id: q.id,
    text: q.text,
    author: q.author,
    category: q.category,
    createdAt: q.createdAt.toISOString(),
  };
}

/**
 * `web/convex/quotes.ts` → 4 endpoints. The frozen `add`/`remove` were
 * UNGUARDED public writes (S-015/S-016 class) — the port makes them
 * admin-only; that gating IS the intended deviation (brief DoD #5).
 */
@ApiTags('quotes')
@Controller('quotes')
export class QuotesController {
  constructor(private readonly prisma: PrismaService) {}

  @ApiOkResponse({ type: QuoteResponseDto })
  @Roles('admin')
  @Patch('add')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Add a quote (frozen `quotes.add`, now admin-only)' })
  @ApiResponse({ status: 401, description: 'Missing, invalid, or revoked bearer token.' })
  @ApiResponse({ status: 403, description: 'The caller is not an admin (DB-resolved role).' })
  async add(@Body() dto: AddQuoteDto) {
    const created = await this.prisma.quote.create({
      data: {
        text: dto.text,
        author: dto.author,
        category: dto.category,
        createdAt: new Date(),
      },
    });
    return toQuote(created);
  }

  @ApiOkResponse({ type: SuccessDto })
  @Roles('admin')
  @Patch('remove')
  @ApiOperation({ summary: 'Delete a quote (frozen `quotes.remove`, now admin-only)' })
  @ApiResponse({ status: 401, description: 'Missing, invalid, or revoked bearer token.' })
  @ApiResponse({ status: 403, description: 'The caller is not an admin (DB-resolved role).' })
  @ApiResponse({ status: 404, description: 'Quote not found.' })
  async remove(@Body() dto: RemoveQuoteDto): Promise<{ success: true }> {
    const deleted = await this.prisma.quote.deleteMany({ where: { id: dto.id } });
    if (deleted.count === 0) throw new NotFoundException('Quote not found');
    return { success: true };
  }

  /**
   * `getRandom` (`quotes.ts:25-31`). The frozen query collected the whole
   * table and picked uniformly at random; the port keeps the uniform pick but
   * reads only ids, and preserves the `null` body for an empty pool.
   */
  @ApiOkResponse({
    type: QuoteResponseDto,
    nullable: true,
    description:
      'A uniformly random quote; a null body when the pool is empty (frozen semantics).',
  })
  @Public()
  @PublicOperation()
  @Get('random')
  @ApiOperation({ summary: 'A random quote (frozen `quotes.getRandom`); null body when the pool is empty' })
  async random(@Query() q: RandomQuoteQueryDto) {
    const rows = await this.prisma.quote.findMany({
      where: q.category ? { category: q.category } : {},
      select: { id: true },
    });
    if (rows.length === 0) return null;
    const pick = rows[Math.floor(Math.random() * rows.length)];
    const quote = await this.prisma.quote.findUnique({ where: { id: pick.id } });
    return quote ? toQuote(quote) : null;
  }

  @ApiOkResponse({ type: [QuoteResponseDto] })
  @Public()
  @PublicOperation()
  @Get('all')
  @ApiOperation({ summary: 'All quotes, newest first (frozen `quotes.listAll`)' })
  async all() {
    const rows = await this.prisma.quote.findMany({ orderBy: { createdAt: 'desc' } });
    return rows.map(toQuote);
  }
}
