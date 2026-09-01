import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { WhatsappService } from './whatsapp.service';

@Controller('whatsapp')
export class WhatsappController {
  constructor(private readonly whatsappService: WhatsappService) {}

  @Get('status')
  getStatus(@Query('sessionId') sessionId: string) {
    if (!sessionId) {
      return { success: false, message: 'sessionId is required as a query parameter: ?sessionId=...' };
    }
    return this.whatsappService.getStatus(sessionId);
  }

  @Post('pair')
  requestPairingCode(@Body() body: { sessionId: string; phoneNumber: string }) {
    if (!body.sessionId || !body.phoneNumber) {
      return { success: false, message: 'sessionId and phoneNumber are required in the body.' };
    }
    return this.whatsappService.requestPairingCode(body.sessionId, body.phoneNumber);
  }

  @Post('logout')
  logout(@Body('sessionId') sessionId: string) {
    if (!sessionId) {
      return { success: false, message: 'sessionId is required in the body.' };
    }
    return this.whatsappService.logout(sessionId);
  }
}
