import { Controller, Get, Post } from '@nestjs/common';
import { WhatsappService } from './whatsapp.service';
@Controller('whatsapp')
export class WhatsappController {
  constructor(private readonly whatsappService: WhatsappService) {}

  // READ: Any authenticated user with NOTIFICATION_SETUP.LISTING can check status/QR
  @Get('status')
  getStatus() {
    return this.whatsappService.getStatus();
  }

  @Get('qr')
  getQR() {
    return this.whatsappService.getQR();
  }

  // WRITE: Only users with NOTIFICATION_SETUP.WHATSAPP_MANAGE (Admin only by default)
  @Post('refresh-qr')
  refreshQR() {
    return this.whatsappService.refreshQR();
  }

  @Post('reset')
  reset() {
    return this.whatsappService.reset();
  }

  @Post('logout')
  logout() {
    return this.whatsappService.logout();
  }
}
