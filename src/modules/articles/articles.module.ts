import { Module } from '@nestjs/common';
import { PrismaModule } from '../../core/prisma/prisma.module';
import { ArticlesController } from './articles.controller';
import { InternalArticlesController, InternalAiDraftsController } from './internal-articles.controller';
import { ArticlesService } from './articles.service';

@Module({
  imports: [PrismaModule],
  controllers: [ArticlesController, InternalArticlesController, InternalAiDraftsController],
  providers: [ArticlesService],
  exports: [ArticlesService],
})
export class ArticlesModule {}
