import {
  Controller,
  Get,
  Put,
  Patch,
  Post,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';

import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';

import { IsOptional, IsString, IsNotEmpty, IsEmail } from 'class-validator';

import { UsersService } from './users.service';
import { JwtGuard } from '../common/guards/jwt.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Permissions } from '../common/decorators/permissions.decorator';
import { Throttle } from '@nestjs/throttler';

class UpdateProfileDto {
  @IsOptional()
  @IsString()
  bio?: string;

  @IsOptional()
  @IsString()
  country?: string;

  @IsOptional()
  @IsString()
  city?: string;
}

class ChangeEmailDto {
  @IsNotEmpty()
  @IsEmail()
  new_email!: string;

  @IsNotEmpty()
  @IsString()
  current_password!: string;
}

class ChangePhoneDto {
  @IsNotEmpty()
  @IsString()
  new_phone!: string;

  @IsNotEmpty()
  @IsString()
  current_password!: string;
}

class AddContactDto {
  @IsString()
  identifier!: string;

  @IsOptional()
  @IsString()
  nickname?: string;
}

@ApiTags('Users')
@ApiBearerAuth('JWT')
@UseGuards(JwtGuard)
@Controller({
  path: 'users',
  version: '1',
})
export class UsersController {
  constructor(private readonly svc: UsersService) {}

  @Permissions('profile:read')
  @Get('me')
  getMe(@CurrentUser() u: any) {
    return this.svc.getProfile(u.id);
  }

  @Permissions('profile:write')
  @Put('me')
  updateMe(@CurrentUser() u: any, @Body() dto: UpdateProfileDto) {
    return this.svc.updateProfile(u.id, dto);
  }

  @Patch('me/email')
  changeEmail(@CurrentUser() u: any, @Body() dto: ChangeEmailDto) {
    return this.svc.changeEmail(u.id, dto);
  }

  @Patch('me/phone')
  changePhone(@CurrentUser() u: any, @Body() dto: ChangePhoneDto) {
    return this.svc.changePhone(u.id, dto);
  }

  @Get('search')
  search(@Query('q') q: string) {
    return this.svc.searchUsers(q);
  }

  @Get('contacts')
  contacts(@CurrentUser() u: any) {
    return this.svc.getContacts(u.id);
  }

  @Post('contacts')
  addContact(@CurrentUser() u: any, @Body() dto: AddContactDto) {
    return this.svc.addContact(u.id, dto.identifier, dto.nickname);
  }

  @Delete('contacts/:id')
  removeContact(@CurrentUser() u: any, @Param('id') id: string) {
    return this.svc.removeContact(u.id, id);
  }

  @Get('notifications')
  @Throttle({ default: { limit: 300, ttl: 60_000 } })
  notifications(@CurrentUser() u: any, @Query() q: any) {
    return this.svc.getNotifications(u.id, q);
  }

  @Put('notifications/:id/read')
  markRead(@CurrentUser() u: any, @Param('id') id: string) {
    return this.svc.markNotificationRead(u.id, id);
  }

  @Put('notifications/read-all')
  markAllRead(@CurrentUser() u: any) {
    return this.svc.markAllNotificationsRead(u.id);
  }

  @Delete('notifications/:id')
  deleteNotification(@CurrentUser() u: any, @Param('id') id: string) {
    return this.svc.deleteNotification(u.id, id);
  }

  @Delete('notifications')
  deleteAllNotifications(@CurrentUser() u: any) {
    return this.svc.deleteAllNotifications(u.id);
  }
}
