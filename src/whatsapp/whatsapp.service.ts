import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WhatsappAuth } from './entities/whatsapp-auth.entity';
import { WASocket } from '@whiskeysockets/baileys';
import { loadEsm } from 'load-esm';
import pino from 'pino';

// ============================================================================
// 🤖 BOT CONFIGURATION 🤖
// Modify these variables to change how the bot behaves.
// ============================================================================
const TARGET_NUMBERS = ['60183894638'];
const AUTO_REPLY_TEXT = "🤖 *Iqbal's WhatsApp Bot* 🤖\n\nHello there! I am Iqbal's custom-built automated assistant. Iqbal is currently busy (likely gaming or working) and cannot come to his phone right now.\n\nYour message has been safely received. He will reply to you as soon as he is free, so please wait for a while and kindly do not spam messages!";
const DEBOUNCE_DELAY_MS = 5000;
const HUMAN_MUTE_DURATION_MS = 60 * 60 * 1000; // 1 hour in milliseconds
const BOT_COOLDOWN_DURATION_MS = 60 * 60 * 1000; // 1 hour in milliseconds
// ============================================================================

@Injectable()
export class WhatsappService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WhatsappService.name);

  private baileys: typeof import('@whiskeysockets/baileys');
  
  // Multi-Tenant Maps
  private sockets = new Map<string, WASocket>();
  private connectedNumbers = new Map<string, string>();
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private humanMuteTimers = new Map<string, NodeJS.Timeout>();
  private botCooldownTimers = new Map<string, NodeJS.Timeout>();
  private botMessageIds = new Set<string>();

  // Anti-Delete Message Cache (stores recent messages)
  private messageCache = new Map<string, any>();

  private normalizeNumber(input: string) {
    if (!input) return '';
    const digits = String(input).replace(/\D/g, '');
    return digits;
  }

  constructor(
    @InjectRepository(WhatsappAuth)
    private readonly authRepo: Repository<WhatsappAuth>,
  ) {}

  async onModuleInit() {
    this.baileys = await loadEsm<typeof import('@whiskeysockets/baileys')>('@whiskeysockets/baileys');
    this.restoreAllSessions();
  }

  async onModuleDestroy() {
    for (const [sessionId, sock] of this.sockets.entries()) {
      await sock.end(undefined);
    }
    this.sockets.clear();
  }

  private async restoreAllSessions() {
    try {
      const allCreds = await this.authRepo.createQueryBuilder('auth')
        .where("auth.id LIKE :id", { id: '%:creds' })
        .getMany();

      for (const cred of allCreds) {
        const sessionId = cred.id.replace(':creds', '');
        this.logger.log(`Restoring session for: ${sessionId}`);
        this.connectToWhatsApp(sessionId);    // need to comment to avoid restarting server at production
      }
    } catch (error) {
      this.logger.error('Error restoring sessions:', (error as Error).message);
    }
  }

  private async clearDbAuth(sessionId: string) {
    try {
      await this.authRepo.createQueryBuilder()
        .delete()
        .from(WhatsappAuth)
        .where("id LIKE :id", { id: `${sessionId}:%` })
        .execute();
      this.logger.log(`✅ Authentication data cleared for ${sessionId}`);
    } catch (error) {
      this.logger.error(`❌ Error clearing auth data for ${sessionId}:`, (error as Error).message);
    }
  }

  private async useTypeOrmAuthState(sessionId: string) {
    const { initAuthCreds, BufferJSON } = this.baileys;
    
    let creds: any;
    const credsData = await this.authRepo.findOne({ where: { id: `${sessionId}:creds` } });
    if (credsData && credsData.value) {
      creds = JSON.parse(credsData.value, BufferJSON.reviver);
    } else {
      creds = initAuthCreds();
    }

    return {
      state: {
        creds,
        keys: {
          get: async (type: string, ids: string[]) => {
            const data: { [key: string]: any } = {};
            for (const id of ids) {
              const key = `${sessionId}:${type}-${id}`;
              const row = await this.authRepo.findOne({ where: { id: key } });
              if (row && row.value) {
                data[id] = JSON.parse(row.value, BufferJSON.reviver);
              }
            }
            return data;
          },
          set: async (data: any) => {
            const tasks: Promise<any>[] = [];
            for (const category in data) {
              for (const id in data[category]) {
                const value = data[category][id];
                const key = `${sessionId}:${category}-${id}`;
                if (value) {
                  const entity = new WhatsappAuth();
                  entity.id = key;
                  entity.value = JSON.stringify(value, BufferJSON.replacer);
                  tasks.push(this.authRepo.save(entity));
                } else {
                  tasks.push(this.authRepo.delete({ id: key }));
                }
              }
            }
            await Promise.all(tasks);
          },
        },
      },
      saveCreds: async () => {
        const entity = new WhatsappAuth();
        entity.id = `${sessionId}:creds`;
        entity.value = JSON.stringify(creds, BufferJSON.replacer);
        await this.authRepo.save(entity);
      },
    };
  }

  async connectToWhatsApp(sessionId: string) {
    if (this.sockets.has(sessionId)) {
      this.logger.warn(`Session ${sessionId} is already connected or connecting.`);
      return;
    }

    const { makeWASocket, DisconnectReason, fetchLatestBaileysVersion } = this.baileys;

    const authState = await this.useTypeOrmAuthState(sessionId);
    
    const { version, isLatest } = await fetchLatestBaileysVersion();
    this.logger.log(`Using WA v${version.join('.')}, isLatest: ${isLatest}`);

    const sock = makeWASocket({
      version,
      auth: authState.state,
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      logger: pino({ level: 'silent' }) as any,
    });

    this.sockets.set(sessionId, sock);

    sock.ev.on('creds.update', authState.saveCreds);

    sock.ev.on('connection.update', async (update: any) => {
      const { connection, lastDisconnect } = update;

      if (connection === 'close') {
        const shouldReconnect = (lastDisconnect?.error as any)?.output?.statusCode !== DisconnectReason.loggedOut;
        this.logger.log(`Connection closed for ${sessionId}. Status: ${(lastDisconnect?.error as any)?.output?.statusCode}. Reconnecting: ${shouldReconnect}`);
        
        if (shouldReconnect) {
          this.logger.log(`🔄 Reconnecting ${sessionId} in 2 seconds...`);
          setTimeout(() => {
            this.sockets.delete(sessionId);
            this.connectToWhatsApp(sessionId);
          }, 2000);
        } else {
          this.logger.log(`❌ ${sessionId} logged out permanently. Clearing credentials.`);
          this.sockets.delete(sessionId);
          this.connectedNumbers.delete(sessionId);
          await this.clearDbAuth(sessionId);
        }
      } else if (connection === 'open') {
        this.logger.log(`✅ ${sessionId} Connected to WhatsApp Successfully!`);
        if (sock.user) {
          const id = sock.user.id.split(':')[0];
          this.connectedNumbers.set(sessionId, id);
        }
      }
    });

    sock.ev.on('messages.upsert', async (m: any) => {
      const msg = m.messages[0];
      try {
        if (m.type === 'notify') {
          // Ignore group messages and status broadcasts completely
          if (msg.key.remoteJid?.endsWith('@g.us') || msg.key.remoteJid === 'status@broadcast') return;

          // --- ANTI-DELETE LOGIC ---
          // Save every incoming message to cache (only keep last 500 to avoid memory leak)
          if (msg.key && msg.key.id) {
            this.messageCache.set(msg.key.id, msg);
            if (this.messageCache.size > 500) {
              const firstKey = this.messageCache.keys().next().value;
              if (firstKey) this.messageCache.delete(firstKey);
            }
          }
          
          // Check if this is a delete message (protocolMessage type 0 = REVOKE)
          const isRevoke = msg.message?.protocolMessage?.type === 0 || msg.message?.protocolMessage?.type === 'REVOKE';
          if (isRevoke) {
             const deletedMsgId = msg.message.protocolMessage.key.id;
             const originalMsg = this.messageCache.get(deletedMsgId);
             
             if (originalMsg && msg.key.remoteJid) {
                // Ignore if it was from me
                if (originalMsg.key.fromMe) return;

                // Extract text from original message if it exists
                let deletedText: string | null = null;
                if (originalMsg.message?.conversation) deletedText = originalMsg.message.conversation as string;
                else if (originalMsg.message?.extendedTextMessage?.text) deletedText = originalMsg.message.extendedTextMessage.text as string;
                
                const activeSock = this.sockets.get(sessionId);
                if (activeSock) {
                   const callOutText = `🤖 *Iqbal's WhatsApp Bot* 🤖\n\n_System detecting a deleted message..._\n\n${deletedText ? `*Recovered Message:*\n${deletedText}` : '*Recovered Media:*\n(Forwarding below)'}`;
                   
                   await activeSock.sendMessage(msg.key.remoteJid, { text: callOutText });
                   
                   if (!deletedText) {
                      // It was media or something else, try to forward the original message
                      await activeSock.sendMessage(msg.key.remoteJid, { forward: originalMsg });
                   }
                }
             }
             return; // Stop processing this as a normal message
          }
          // --- END ANTI-DELETE LOGIC ---
          
          // --- ANTI-VIEW-ONCE LOGIC ---
          // DEBUG: Log message structure safely using console.dir for Protobufs
          if (!msg.message?.conversation && !msg.message?.extendedTextMessage) {
              console.log("[FULL MSG DUMP]");
              console.dir(msg, { depth: null });
          }

          let actualMessage = msg.message;
          if (actualMessage?.ephemeralMessage) {
              actualMessage = actualMessage.ephemeralMessage.message;
          }

          const innerMessage = actualMessage?.viewOnceMessage?.message || actualMessage?.viewOnceMessageV2?.message || actualMessage?.viewOnceMessageV2Extension?.message;
          
          if (innerMessage && msg.key.remoteJid && !msg.key.fromMe) {
              this.logger.log(`[ANTI-VIEW-ONCE] Detected View Once message from ${msg.key.remoteJid}`);
              const activeSock = this.sockets.get(sessionId);
              if (activeSock) {
                  // Strip the viewOnce flag
                  if (innerMessage.imageMessage) innerMessage.imageMessage.viewOnce = false;
                  if (innerMessage.videoMessage) innerMessage.videoMessage.viewOnce = false;
                  if (innerMessage.audioMessage) innerMessage.audioMessage.viewOnce = false;

                  // Overwrite the original message wrapper with the un-wrapped inner message
                  msg.message = innerMessage;

                  const callOutText = `🤖 *Iqbal's WhatsApp Bot* 🤖\n\n_Nice try with the View Once! I saved a permanent copy for Iqbal._ 😎👇`;
                  await activeSock.sendMessage(msg.key.remoteJid, { text: callOutText });
                  
                  // Forward the unwrapped message
                  await activeSock.sendMessage(msg.key.remoteJid, { forward: msg });
              }
          }
          // --- END ANTI-VIEW-ONCE LOGIC ---


          const remoteJid = msg.key.remoteJid;
          if (!remoteJid) return;

          let senderNumber = this.normalizeNumber(remoteJid.split(':')[0]);
          
          if (remoteJid.includes('@lid')) {
            try {
              const pnJid = await (sock as any)?.signalRepository?.lidMapping?.getPNForLID(remoteJid);
              if (pnJid) {
                senderNumber = this.normalizeNumber(pnJid.split(':')[0]);
              }
            } catch (err) {}
          }

          const targetNumbers = TARGET_NUMBERS.map(n => this.normalizeNumber(n.trim()));

          this.logger.log(`[TRACE][${sessionId}] Received msg from ${senderNumber} (raw JID: ${remoteJid})`);

          if (!targetNumbers.includes(senderNumber)) {
            return;
          }

          const timerKey = `${sessionId}:${remoteJid}`;

          if (msg.key.fromMe) {
            const msgId = msg.key.id;
            
            if (msgId && this.botMessageIds.has(msgId)) {
               this.botMessageIds.delete(msgId);
               return;
            }

            this.logger.log(`[HUMAN MUTE][${sessionId}] You manually replied to ${senderNumber}. Muting bot for 1 hour!`);
            
            if (this.humanMuteTimers.has(timerKey)) {
              clearTimeout(this.humanMuteTimers.get(timerKey)!);
            }
            if (this.debounceTimers.has(timerKey)) {
              clearTimeout(this.debounceTimers.get(timerKey)!);
              this.debounceTimers.delete(timerKey);
            }
            if (this.botCooldownTimers.has(timerKey)) {
              clearTimeout(this.botCooldownTimers.get(timerKey)!);
              this.botCooldownTimers.delete(timerKey);
            }

            const muteTimer = setTimeout(() => {
              this.logger.log(`[HUMAN MUTE][${sessionId}] 1 hour has passed. Bot is unmuted for ${senderNumber}.`);
              this.humanMuteTimers.delete(timerKey);
            }, HUMAN_MUTE_DURATION_MS);

            this.humanMuteTimers.set(timerKey, muteTimer);
            return;
          }

          if (this.humanMuteTimers.has(timerKey)) {
            this.logger.log(`[HUMAN MUTE][${sessionId}] Ignoring message from ${senderNumber}. Human mute active.`);
            return;
          }

          if (this.botCooldownTimers.has(timerKey)) {
            this.logger.log(`[BOT COOLDOWN][${sessionId}] Ignoring message from ${senderNumber}. Bot cooldown active.`);
            return;
          }

          let text: string | null = null;
          if (msg.message?.conversation) text = msg.message.conversation as string;
          else if (msg.message?.extendedTextMessage?.text)
            text = msg.message.extendedTextMessage.text as string;

          this.logger.log(`[DEBUG][${sessionId}] Whitelisted message from ${senderNumber}. Text: ${text}`);

          if (!text && !msg.message) return;

          if (this.debounceTimers.has(timerKey)) {
            clearTimeout(this.debounceTimers.get(timerKey)!);
          }

          const delayMs = DEBOUNCE_DELAY_MS;
          const autoReplyText = AUTO_REPLY_TEXT;

          const timer = setTimeout(async () => {
            this.logger.log(`[${sessionId}] Debounce finished for ${senderNumber}, sending auto-reply.`);
            const activeSock = this.sockets.get(sessionId);
            if (activeSock) {
              const sentMsg = await activeSock.sendMessage(remoteJid, { text: autoReplyText });
              if (sentMsg?.key?.id) {
                this.botMessageIds.add(sentMsg.key.id);
              }

              // Set the bot cooldown timer after sending
              const cooldownTimer = setTimeout(() => {
                this.logger.log(`[BOT COOLDOWN][${sessionId}] 1 hour has passed. Bot cooldown finished for ${senderNumber}.`);
                this.botCooldownTimers.delete(timerKey);
              }, BOT_COOLDOWN_DURATION_MS);
              this.botCooldownTimers.set(timerKey, cooldownTimer);
            }
            this.debounceTimers.delete(timerKey);
          }, delayMs);

          this.debounceTimers.set(timerKey, timer);
        }
      } catch (e) {
        this.logger.error(`Error processing incoming message on ${sessionId}:`, (e as Error).message);
      }
    });
  }

  async requestPairingCode(sessionId: string, phoneNumber: string): Promise<{ success: boolean; code?: string; message: string }> {
    let sock = this.sockets.get(sessionId);
    
    if (!sock) {
      await this.connectToWhatsApp(sessionId);
      await new Promise(resolve => setTimeout(resolve, 1500));
      sock = this.sockets.get(sessionId);
    }

    if (!sock) {
      return { success: false, message: 'Failed to initialize session.' };
    }

    if (this.connectedNumbers.get(sessionId)) {
      return { success: false, message: `Session ${sessionId} is already connected to WhatsApp.` };
    }

    try {
      const normalizedNumber = this.normalizeNumber(phoneNumber);
      this.logger.log(`Requesting pairing code for ${normalizedNumber} on session ${sessionId}...`);
      
      const code = await sock.requestPairingCode(normalizedNumber);
      this.logger.log(`Pairing code generated for ${sessionId}: ${code}`);
      
      return { 
        success: true, 
        code, 
        message: 'Pairing code generated. Please enter this code in your WhatsApp app (Linked Devices -> Link with Phone Number).' 
      };
    } catch (error) {
      this.logger.error(`Failed to request pairing code for ${sessionId}`, (error as Error).message);
      return { success: false, message: 'Failed to request pairing code. Ensure the server is waiting for authentication.' };
    }
  }

  getStatus(sessionId: string) {
    const sock = this.sockets.get(sessionId);
    return {
      sessionId,
      connected: !!sock,
      number: this.connectedNumbers.get(sessionId) || null,
    };
  }

  async logout(sessionId: string) {
    const sock = this.sockets.get(sessionId);
    if (sock) {
      await sock.logout();
      this.logger.log(`Logging out session ${sessionId} from WhatsApp...`);
      return { success: true, message: `Logged out session ${sessionId} successfully.` };
    }
    return { success: false, message: `Session ${sessionId} not connected.` };
  }

  @Cron(CronExpression.EVERY_10_MINUTES)
  async handleKeepAlive() {
    try {
      this.logger.log('Pinging Render to keep service awake...');
      await fetch('https://nestreply-backend.onrender.com/whatsapp/status?sessionId=system_ping');
    } catch (error) {
      this.logger.error('Failed to ping Render', (error as Error).message);
    }
  }
}
