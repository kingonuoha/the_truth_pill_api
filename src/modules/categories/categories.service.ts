import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../core/prisma/prisma.service';

/** Category response — the frozen document shape (`categories.ts:33-43`), no secret fields exist. */
function toCategory(c: {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  coverImage: string | null;
  pexelsImages: string[];
  articleCount: number;
  createdAt: Date;
}) {
  return {
    id: c.id,
    name: c.name,
    slug: c.slug,
    description: c.description,
    coverImage: c.coverImage,
    pexelsImages: c.pexelsImages,
    articleCount: c.articleCount ?? 0,
    createdAt: c.createdAt.toISOString(),
  };
}

@Injectable()
export class CategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  async getBySlug(slug: string) {
    const category = await this.prisma.category.findUnique({ where: { slug } });
    if (!category) throw new NotFoundException('Category not found');
    return toCategory(category);
  }

  async getById(id: string) {
    const category = await this.prisma.category.findUnique({ where: { id } });
    if (!category) throw new NotFoundException('Category not found');
    return toCategory(category);
  }

  /** `listAll` (`categories.ts:22-47`): every category with its `pillarCount`. */
  async listAll() {
    const categories = await this.prisma.category.findMany({
      orderBy: { createdAt: 'asc' },
      take: 200,
      include: { _count: { select: { pillars: true } } },
    });
    return categories.map((c) => ({
      ...toCategory(c),
      pillarCount: c._count.pillars,
    }));
  }

  /**
   * `create` (`categories.ts:48-63`). The frozen mutation was an UNGUARDED
   * public write; the port is admin-only (brief DoD #5).
   */
  async create(dto: {
    name: string;
    slug: string;
    description?: string;
    coverImage?: string;
    pexelsImages?: string[];
  }) {
    const taken = await this.prisma.category.findUnique({
      where: { slug: dto.slug },
      select: { id: true },
    });
    if (taken) throw new ConflictException('A category with this slug already exists');
    const created = await this.prisma.category.create({
      data: {
        name: dto.name,
        slug: dto.slug,
        description: dto.description,
        coverImage: dto.coverImage,
        pexelsImages: dto.pexelsImages,
        createdAt: new Date(),
      },
    });
    return toCategory(created);
  }

  async update(dto: {
    id: string;
    name?: string;
    slug?: string;
    description?: string;
    coverImage?: string;
    pexelsImages?: string[];
  }) {
    const { id, ...fields } = dto;
    const existing = await this.prisma.category.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Category not found');
    if (fields.slug && fields.slug !== existing.slug) {
      const taken = await this.prisma.category.findUnique({
        where: { slug: fields.slug },
        select: { id: true },
      });
      if (taken) throw new ConflictException('A category with this slug already exists');
    }
    const updated = await this.prisma.category.update({
      where: { id },
      data: {
        ...(fields.name !== undefined && { name: fields.name }),
        ...(fields.slug !== undefined && { slug: fields.slug }),
        ...(fields.description !== undefined && { description: fields.description }),
        ...(fields.coverImage !== undefined && { coverImage: fields.coverImage }),
        ...(fields.pexelsImages !== undefined && { pexelsImages: fields.pexelsImages }),
      },
    });
    return toCategory(updated);
  }

  /** `remove` (`categories.ts:79-94`): the frozen linked-article delete guard, preserved. */
  async remove(id: string): Promise<{ success: true }> {
    const existing = await this.prisma.category.findUnique({ where: { id }, select: { id: true } });
    if (!existing) throw new NotFoundException('Category not found');
    const linked = await this.prisma.article.count({ where: { categoryId: id } });
    if (linked > 0) {
      throw new ConflictException(
        'Cannot delete this category — it has articles linked to it. Remove or reassign those articles first.',
      );
    }
    await this.prisma.category.delete({ where: { id } });
    return { success: true };
  }
}
