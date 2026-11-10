import {
  Body,
  Controller,
  Delete,
  Get,
  Patch,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';

import { AuthGuard } from '@nestjs/passport';
import { Throttle } from '@nestjs/throttler';

import { NotificationsService } from './notifications.service';
import { RegisterDeviceTokenDto } from './dto/register-device-token.dto';
import { Permissions } from '../common/decorators/permissions.decorator';

@Controller('notifications')
@UseGuards(AuthGuard('jwt'))
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Permissions('notifications:read')
  @Get('settings')
  async getSettings(@Req() req) {
    return this.notificationsService.getSettings(req.user.id);
  }

  @Permissions('notifications:write')
  @Put('settings')
  async updateSettings(
    @Req() req,

    @Body() body,
  ) {
    return this.notificationsService.updateSettings(req.user.id, body);
  }

  @Permissions('notifications:write')
  @Post(['device-token', 'register-device'])
  async registerDeviceToken(@Req() req, @Body() body: RegisterDeviceTokenDto) {
    const token = body.deviceToken || body.token;
    return this.notificationsService.registerDeviceToken(
      req.user.id,
      token || '',
      body.platform,
    );
  }

  @Get()
  @Permissions('notifications:read')
  @Throttle({ default: { limit: 300, ttl: 60_000 } })
  async getNotifications(@Req() req, @Query() query: any) {
    return this.notificationsService.getNotifications(req.user.id, query);
  }

  @Patch(':id/read')
  @Permissions('notifications:write')
  async markRead(@Req() req, @Param('id') id: string) {
    return this.notificationsService.markRead(req.user.id, id);
  }

  @Patch('read-all')
  @Permissions('notifications:write')
  async markAllRead(@Req() req) {
    return this.notificationsService.markAllRead(req.user.id);
  }

  @Delete(':id')
  @Permissions('notifications:write')
  async deleteNotification(@Req() req, @Param('id') id: string) {
    return this.notificationsService.deleteNotification(req.user.id, id);
  }

  @Delete()
  @Permissions('notifications:write')
  async deleteAllNotifications(@Req() req) {
    return this.notificationsService.deleteAllNotifications(req.user.id);
  }

  @Permissions('notifications:write')
  @Delete('device-token')
  async removeDeviceToken(@Req() req, @Body() body: { token: string }) {
    return this.notificationsService.removeDeviceToken(req.user.id, body.token);
  }
}
