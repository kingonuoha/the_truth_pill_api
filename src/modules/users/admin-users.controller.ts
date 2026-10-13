import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../shared/guards/auth.decorators';
import { PaginationQueryDto } from '../../shared/dto/pagination-query.dto';
import { UpdateUserRoleDto } from './dto/users.dto';
import {
  AdminUserProjectionDto,
  PaginatedAdminUserDto,
} from './dto/users-responses.dto';
import { AdminUserProjection } from './user-projection';
import { UsersService } from './users.service';

const R401 = { status: 401, description: 'Missing, invalid, expired, or revoked bearer token.' };
const R403 = { status: 403, description: 'The caller is not an admin (DB-resolved role).' };
const R404 = { status: 404, description: 'User not found.' };

/**
 * Admin-only user management. `RolesGuard` resolves the caller's role from the
 * `users` row — never from a token claim (DEV-001, brief §2 prohibition 3).
 */
@ApiTags('admin-users')
@Controller('admin/users')
export class AdminUsersController {
  constructor(private readonly users: UsersService) {}

  @Roles('admin')
  @Get()
  @ApiOperation({ summary: 'List users (admin only, projected)' })
  @ApiOkResponse({ type: PaginatedAdminUserDto })
  @ApiResponse(R401)
  @ApiResponse(R403)
  list(
    @Query() query: PaginationQueryDto,
  ): Promise<{ items: AdminUserProjection[]; total: number }> {
    return this.users.listAllUsers(query.page, query.pageSize);
  }

  @Roles('admin')
  @Patch(':id/role')
  @ApiOperation({ summary: 'Change a user role (admin only)' })
  @ApiOkResponse({ type: AdminUserProjectionDto })
  @ApiResponse(R401)
  @ApiResponse(R403)
  @ApiResponse(R404)
  updateRole(
    @Param('id') id: string,
    @Body() dto: UpdateUserRoleDto,
  ): Promise<AdminUserProjection> {
    return this.users.updateUserRole(id, dto.role);
  }
}
