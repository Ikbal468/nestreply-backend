import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WhatsappAuth } from './entities/whatsapp-auth.entity';
import { WASocket } from '@whiskeysockets/baileys';
import { loadEsm } from 'load-esm';
import pino from 'pino';
import * as qrcode from 'qrcode-terminal';
import QRCodeLib from 'qrcode';

// ============================================================================
// 🤖 BOT CONFIGURATION 🤖
// Modify these variables to change how the bot behaves.
// ============================================================================
const TARGET_NUMBERS = ['60122341307', '60183894638', '601121875447', '60148768410'];
const AUTO_REPLY_TEXT = "🤖 *Automated Message*\n\nHi there! You've reached Iqbal's automated assistant. Iqbal is currently busy at the moment, but your message has been received! He will get back to you as soon as he is available.";
const DEBOUNCE_DELAY_MS = 5000;
const HUMAN_MUTE_DURATION_MS = 30 * 60 * 1000; // 30 minutes in milliseconds
// ============================================================================

export interface MessageEntry {
  id: string;
  from: string | null;
  text: string;
  timestamp: number;
}

export interface CheckNumberResult {
  exists: boolean | null;
  jid: string | null;
}

@Injectable()
export class WhatsappService implements OnModuleDestroy {
  private readonly logger = new Logger(WhatsappService.name);

  private baileys: typeof import('@whiskeysockets/baileys');
  private cachedVersion: [number, number, number] | null = null;

  private sock: WASocket | null = null;
  private qrGenerated = false;
  private lastQR: string | null = null;
  private lastQRDataUri: string | null = null;
  private connectedNumber: string | null = null;
  private messagesStore: MessageEntry[] = [];
  private messageIds = new Set<string>();
  private pendingMessages: Array<{
    number: string;
    message: string;
    resolve: (v: any) => void;
    reject: (e: any) => void;
    timeoutId?: NodeJS.Timeout;
  }> = [];

  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private humanMuteTimers = new Map<string, NodeJS.Timeout>();
  private botMessageIds = new Set<string>();

  private normalizeNumber(input: string) {
    if (!input) return '';
    const digits = String(input).replace(/\D/g, '');
    return digits;
  }

  constructor(
    @InjectRepository(WhatsappAuth)
    private readonly authRepo: Repository<WhatsappAuth>,
  ) {
    loadEsm<typeof import('@whiskeysockets/baileys')>('@whiskeysockets/baileys').then(async (module) => {
      this.baileys = module;
      this.connectToWhatsApp();    // i commented for production. to avoid restarting the server every time.
    });
  }

  async onModuleDestroy() {
    if (this.sock) {
      await this.sock.end(undefined);
      this.sock = null;
    }
  }

  private async clearDbAuth() {
    try {
      await this.authRepo.clear();
      this.logger.log('✅ Authentication data cleared successfully');
    } catch (error) {
      this.logger.error('❌ Error clearing auth data:', (error as Error).message);
    }
  }

  private async useTypeOrmAuthState() {
    const { initAuthCreds, BufferJSON } = this.baileys;
    
    let creds: any;
    const credsData = await this.authRepo.findOne({ where: { id: 'creds' } });
    if (credsData && credsData.value) {
      creds = JSON.parse(credsData.value, BufferJSON.reviver);
    } else {
      creds = initAuthCreds();
    }

    const saveCreds = async () => {
      await this.authRepo.save({ id: 'creds', value: JSON.stringify(creds, BufferJSON.replacer) });
    };

    const keys = {
      get: async (type: string, ids: string[]) => {
        const data: { [key: string]: any } = {};
        await Promise.all(
          ids.map(async id => {
            const dbId = `${type}-${id}`;
            let value = null;
            const record = await this.authRepo.findOne({ where: { id: dbId } });
            if (record && record.value) {
              value = JSON.parse(record.value, BufferJSON.reviver);
            }
            if (value) {
              data[id] = value;
            }
          })
        );
        return data;
      },
      set: async (data: any) => {
        const tasks: Promise<any>[] = [];
        for (const category in data) {
          for (const id in data[category]) {
            const value = data[category][id];
            const dbId = `${category}-${id}`;
            if (value) {
              tasks.push(this.authRepo.save({ id: dbId, value: JSON.stringify(value, BufferJSON.replacer) }));
            } else {
              tasks.push(this.authRepo.delete({ id: dbId }));
            }
          }
        }
        await Promise.all(tasks);
      }
    };

    return { state: { creds, keys }, saveCreds };
  }

  async connectToWhatsApp() {
    const { state, saveCreds } = await this.useTypeOrmAuthState();

    if (!this.cachedVersion) {
      try {
        const latest = await this.baileys.fetchLatestBaileysVersion();
        if (latest && latest.version) {
          this.cachedVersion = latest.version;
          this.logger.log(`Cached latest WhatsApp version: ${this.cachedVersion?.join('.')}`);
        }
      } catch (e) {
        this.logger.warn(`Version fetch failed: ${(e as Error).message}`);
        // Fallback to a recent known version if fetch fails
        this.cachedVersion = [2, 3000, 1017539710];
      }
    }
    
    let version: [number, number, number] = this.cachedVersion || [2, 3000, 1017539710];

    this.sock = this.baileys.makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      qrTimeout: 300000, // 5 minutes
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('connection.update', async (update: any) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr && !this.qrGenerated) {
        this.logger.log('\n=== SCAN THIS QR CODE WITH WHATSAPP ===\n');
        qrcode.generate(qr, { small: true });
        this.logger.log(
          '\nOpen WhatsApp on your phone → Settings → Linked Devices → Link a Device\n',
        );
        this.lastQR = qr;
        this.qrGenerated = true;
        // Also generate a data URI so the frontend can render it as an <img>
        try {
          this.lastQRDataUri = await QRCodeLib.toDataURL(qr);
          this.logger.log('✅ QR data URI generated successfully.');
        } catch (e) {
          this.logger.warn('Failed to generate QR data URI:', (e as Error).message);
        }
      }

      if (connection === 'close') {
        const error = lastDisconnect?.error as any;
        const statusCode = error?.output?.statusCode;
        const shouldReconnect = statusCode !== this.baileys.DisconnectReason.loggedOut;

        this.logger.log(`Connection closed. Status: ${statusCode}. Reconnecting: ${shouldReconnect}`);

        if (this.sock) {
          this.sock.ev.removeAllListeners('connection.update');
          this.sock.ev.removeAllListeners('creds.update');
          this.sock.ev.removeAllListeners('messages.upsert');
          this.sock = null;
        }

        this.qrGenerated = false;

        if (shouldReconnect) {
          this.logger.log('🔄 Reconnecting in 2 seconds...');
          setTimeout(() => this.connectToWhatsApp(), 2000);
        } else {
          this.logger.log('⚠️  Logged out. Clearing authentication data...');
          this.clearDbAuth().then(() => {
            this.connectedNumber = null;
            this.lastQR = null;
            this.lastQRDataUri = null;
            setTimeout(() => {
              this.logger.log('🔄 Reconnecting to generate new QR code...');
              this.connectToWhatsApp();
            }, 2000);
          });
        }
      } else if (connection === 'open') {
        this.logger.log('\n✅ Connected to WhatsApp Successfully!\n');
        this.connectedNumber = this.sock?.user?.id || null;
        this.lastQR = null;
        this.lastQRDataUri = null;
        this.qrGenerated = false;

        if (this.pendingMessages.length > 0) {
          const pending = [...this.pendingMessages];
          this.pendingMessages = [];
          for (const p of pending) {
            (async () => {
              try {
                const clean = this.normalizeNumber(p.number);
                const jid = p.number.includes('@s.whatsapp.net')
                  ? p.number
                  : `${clean}@s.whatsapp.net`;
                await this.sock?.sendMessage(jid, { text: p.message });
                if (p.timeoutId) clearTimeout(p.timeoutId);
                p.resolve({ success: true, sent: true });
              } catch (e) {
                if (p.timeoutId) clearTimeout(p.timeoutId);
                p.reject(e);
              }
            })();
          }
        }
      }
    });

    this.sock.ev.on('messages.upsert', async (m: any) => {
      const msg = m.messages[0];
      try {
        if (m.type === 'notify') {
          // Ignore group chats and broadcast statuses
          if (msg.key.remoteJid?.endsWith('@g.us') || msg.key.remoteJid === 'status@broadcast') return;

          const remoteJid = msg.key.remoteJid;
          if (!remoteJid) return;

          let senderNumber = this.normalizeNumber(remoteJid.split(':')[0]);
          
          // Experimental: Try to resolve @lid back to a real phone number
          if (remoteJid.includes('@lid')) {
            try {
              const pnJid = await (this.sock as any)?.signalRepository?.lidMapping?.getPNForLID(remoteJid);
              if (pnJid) {
                senderNumber = this.normalizeNumber(pnJid.split(':')[0]);
              }
            } catch (err) {
              // Ignore resolution errors
            }
          }

          const targetNumbers = TARGET_NUMBERS.map(n => this.normalizeNumber(n.trim()));

          // Verify if the sender is in the TARGET_NUMBERS whitelist
          if (!targetNumbers.includes(senderNumber)) {
            return;
          }

          // Handle outgoing messages (fromMe)
          if (msg.key.fromMe) {
            const msgId = msg.key.id;
            
            // If this outgoing message was sent by our bot, just ignore it
            if (msgId && this.botMessageIds.has(msgId)) {
               this.botMessageIds.delete(msgId);
               return;
            }

            // The real human (Iqbal) just sent a manual reply! Mute the bot for 30 mins.
            this.logger.log(`[HUMAN MUTE] You manually replied to ${senderNumber}. Muting bot for 30 minutes!`);
            
            if (this.humanMuteTimers.has(remoteJid)) {
              clearTimeout(this.humanMuteTimers.get(remoteJid)!);
            }
            if (this.debounceTimers.has(remoteJid)) {
              clearTimeout(this.debounceTimers.get(remoteJid)!);
              this.debounceTimers.delete(remoteJid);
            }

            const muteTimer = setTimeout(() => {
              this.logger.log(`[HUMAN MUTE] 30 minutes have passed. Bot is unmuted for ${senderNumber}.`);
              this.humanMuteTimers.delete(remoteJid);
            }, HUMAN_MUTE_DURATION_MS);

            this.humanMuteTimers.set(remoteJid, muteTimer);
            return;
          }

          // From this point, it is an INCOMING message from a targeted user.

          // Check if this user is currently muted because you manually replied
          if (this.humanMuteTimers.has(remoteJid)) {
            this.logger.log(`[HUMAN MUTE] Ignoring incoming message from ${senderNumber} because human mute is active.`);
            return;
          }

          let text: string | null = null;
          if (msg.message?.conversation) text = msg.message.conversation as string;
          else if (msg.message?.extendedTextMessage?.text)
            text = msg.message.extendedTextMessage.text as string;

          if (!text && !msg.message) return; // Skip if empty and not media

          this.logger.log(`[DEBUG] Incoming message from targeted number: ${senderNumber}`);

          // Debounce Logic
          if (this.debounceTimers.has(remoteJid)) {
            clearTimeout(this.debounceTimers.get(remoteJid)!);
          }

          const delayMs = DEBOUNCE_DELAY_MS;
          const autoReplyText = AUTO_REPLY_TEXT;

          const timer = setTimeout(async () => {
            this.logger.log(`Debounce finished for ${senderNumber}, sending auto-reply.`);
            if (this.sock) {
              const sentMsg = await this.sock.sendMessage(remoteJid, { text: autoReplyText });
              if (sentMsg?.key?.id) {
                this.botMessageIds.add(sentMsg.key.id);
              }
            }
            this.debounceTimers.delete(remoteJid);
          }, delayMs);

          this.debounceTimers.set(remoteJid, timer);
        }
      } catch (e) {
        this.logger.error('Error processing incoming message:', (e as Error).message);
      }
    });
  }

  async sendMessage(number: string, message: string) {
    if (!this.sock) {
      this.logger.warn('WhatsApp socket not connected. Queuing message.');
      return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          this.pendingMessages = this.pendingMessages.filter(
            (p) => p.timeoutId !== timeoutId,
          );
          reject(new Error('Timed out waiting for WhatsApp connection'));
        }, 120000);

        this.pendingMessages.push({ number, message, resolve, reject, timeoutId });
      });
    }

    const cleanNumber = this.normalizeNumber(number);
    const formattedNumber = number.includes('@s.whatsapp.net')
      ? number
      : `${cleanNumber}@s.whatsapp.net`;

    await this.sock.sendMessage(formattedNumber, { text: message });
    this.logger.log(`✉️  Message sent to ${formattedNumber}`);

    return { success: true, message: 'Message sent successfully', to: formattedNumber, text: message };
  }

  getStatus() {
    return {
      connected: this.sock !== null,
      authenticated: this.qrGenerated === false && this.sock !== null,
      needsQR: this.qrGenerated,
      number: this.connectedNumber,
    };
  }

  getQR() {
    return {
      qr: this.lastQR,
      qrDataUri: this.lastQRDataUri,
    };
  }

  async logout() {
    if (this.sock) {
      await this.sock.logout();
      this.logger.log('🔓 Logging out from WhatsApp...');
      return { success: true, message: 'Logged out successfully. New QR code will be generated automatically.' };
    }
    return { success: false, message: 'Not connected.' };
  }

  async refreshQR() {
    this.logger.log('🔄 Force refreshing WhatsApp QR code...');
    if (this.sock) {
      try {
        this.sock.ev.removeAllListeners('connection.update');
        this.sock.ev.removeAllListeners('creds.update');
        this.sock.ev.removeAllListeners('messages.upsert');
        await this.sock.end(undefined);
      } catch (e) {
        this.logger.error('Error ending socket during QR refresh:', (e as Error).message);
      }
      this.sock = null;
    }
    this.qrGenerated = false;
    this.lastQR = null;
    this.clearDbAuth().then(() => {
      setTimeout(() => this.connectToWhatsApp(), 2000);
    });
    return { success: true, message: 'WhatsApp QR code refresh initiated.' };
  }

  async reset() {
    this.logger.log('🔄 Resetting WhatsApp connection...');
    if (this.sock) {
      try {
        this.sock.ev.removeAllListeners('connection.update');
        this.sock.ev.removeAllListeners('creds.update');
        this.sock.ev.removeAllListeners('messages.upsert');
        await this.sock.end(undefined);
      } catch (e) {
        this.logger.error('Error ending socket during reset:', (e as Error).message);
      }
      this.sock = null;
    }
    this.clearDbAuth().then(() => {
      this.qrGenerated = false;
      this.lastQR = null;
      this.lastQRDataUri = null;
      this.connectedNumber = null;
      setTimeout(() => this.connectToWhatsApp(), 2000);
    });
    return { success: true, message: 'WhatsApp connection reset. Generating new QR code...' };
  }
}
