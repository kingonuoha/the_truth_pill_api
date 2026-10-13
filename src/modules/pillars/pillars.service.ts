import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService } from '../../core/prisma/prisma.service';

function toPillar(p: {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  coverImage: string | null;
  pexelsImages: string[];
  categoryId: string;
  createdAt: Date;
}) {
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    description: p.description,
    coverImage: p.coverImage,
    pexelsImages: p.pexelsImages,
    categoryId: p.categoryId,
    createdAt: p.createdAt.toISOString(),
  };
}

@Injectable()
export class PillarsService {
  constructor(private readonly prisma: PrismaService) {}

  /** `listByCategory` (`pillars.ts:4-13`): creation order, ported via the time-sortable uuid(7) id. */
  async listByCategory(categoryId: string) {
    const rows = await this.prisma.pillar.findMany({
      where: { categoryId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toPillar);
  }

  /** `listAll` (`pillars.ts:15-30`): augmented with category name/slug. */
  async listAll() {
    const rows = await this.prisma.pillar.findMany({
      orderBy: { createdAt: 'asc' },
      take: 200,
      include: { category: { select: { name: true, slug: true } } },
    });
    return rows.map((p) => ({
      ...toPillar(p),
      categoryName: p.category?.name || 'Uncategorized',
      categorySlug: p.category?.slug || '',
    }));
  }

  async getBySlug(slug: string) {
    const pillar = await this.prisma.pillar.findUnique({ where: { slug } });
    if (!pillar) throw new NotFoundException('Pillar not found');
    return toPillar(pillar);
  }

  /** `create` (`pillars.ts:42-69`): duplicate-slug guard preserved; admin-gated (the frozen write was public). */
  async create(dto: {
    name: string;
    slug: string;
    categoryId: string;
    description?: string;
    coverImage?: string;
    pexelsImages?: string[];
  }) {
    await this.assertCategory(dto.categoryId);
    const taken = await this.prisma.pillar.findUnique({
      where: { slug: dto.slug },
      select: { id: true },
    });
    if (taken) {
      throw new ConflictException(`A pillar with slug "${dto.slug}" already exists.`);
    }
    const created = await this.prisma.pillar.create({
      data: {
        name: dto.name,
        slug: dto.slug,
        categoryId: dto.categoryId,
        description: dto.description,
        coverImage: dto.coverImage,
        pexelsImages: dto.pexelsImages,
        createdAt: new Date(),
      },
    });
    return toPillar(created);
  }

  async update(dto: {
    id: string;
    name?: string;
    slug?: string;
    categoryId?: string;
    description?: string;
    coverImage?: string;
    pexelsImages?: string[];
  }) {
    const { id, ...fields } = dto;
    const existing = await this.prisma.pillar.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Pillar not found');
    if (fields.categoryId) await this.assertCategory(fields.categoryId);
    if (fields.slug && fields.slug !== existing.slug) {
      const taken = await this.prisma.pillar.findUnique({
        where: { slug: fields.slug },
        select: { id: true },
      });
      if (taken) throw new ConflictException(`A pillar with slug "${fields.slug}" already exists.`);
    }
    const updated = await this.prisma.pillar.update({
      where: { id },
      data: {
        ...(fields.name !== undefined && { name: fields.name }),
        ...(fields.slug !== undefined && { slug: fields.slug }),
        ...(fields.categoryId !== undefined && { categoryId: fields.categoryId }),
        ...(fields.description !== undefined && { description: fields.description }),
        ...(fields.coverImage !== undefined && { coverImage: fields.coverImage }),
        ...(fields.pexelsImages !== undefined && { pexelsImages: fields.pexelsImages }),
      },
    });
    return toPillar(updated);
  }

  /** `remove` (`pillars.ts:86-106`): the frozen linked-article delete guard, preserved. */
  async remove(id: string): Promise<{ success: true }> {
    const pillar = await this.prisma.pillar.findUnique({ where: { id } });
    if (!pillar) throw new NotFoundException('Pillar not found');
    const linked = await this.prisma.article.count({ where: { pillar: pillar.slug } });
    if (linked > 0) {
      throw new ConflictException(
        `Cannot delete pillar "${pillar.name}" — it has articles linked to it. Remove or reassign those articles first.`,
      );
    }
    await this.prisma.pillar.delete({ where: { id } });
    return { success: true };
  }

  /** DEV-011 class: an unresolvable reference is a 422 naming the field, before any write. */
  private async assertCategory(categoryId: string): Promise<void> {
    const found = await this.prisma.category.findUnique({
      where: { id: categoryId },
      select: { id: true },
    });
    if (!found) {
      throw new UnprocessableEntityException({
        message: ['categoryId: does not reference an existing category'],
      });
    }
  }
}
