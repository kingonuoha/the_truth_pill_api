import { Module } from '@nestjs/common';
import { PrismaModule } from '../../core/prisma/prisma.module';
import { AdminController, InternalAdminController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({
  imports: [PrismaModule],
  controllers: [AdminController, InternalAdminController],
  providers: [AdminService],
})
export class AdminModule {}
