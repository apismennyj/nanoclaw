import { Api, Bot } from 'grammy';
import { exec } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import { promisify } from 'util';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { downloadTelegramPhoto } from '../image.js';
import { getLatestMessageIdForChat } from '../db.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

const execAsync = promisify(exec);

async function setReaction(botToken: string, chatId: number | string, messageId: number, emoji: string): Promise<void> {
  try {
    // Set reaction (replaces existing ones)
    const res = await fetch(`https://api.telegram.org/bot${botToken}/setMessageReaction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        reaction: [{ type: 'emoji', emoji }],
        is_big: false
      })
    });
    const data = await res.json();
    logger.info({ emoji, messageId, chatId, status: res.status, response: data }, 'Set reaction result');
  } catch (err) {
    logger.error({ err, emoji, messageId, chatId }, 'setReaction failed');
  }
}

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

/**
 * Send a message with Telegram Markdown parse mode, falling back to plain text.
 * Claude's output naturally matches Telegram's Markdown v1 format:
 *   *bold*, _italic_, `code`, ```code blocks```, [links](url)
 */
async function downloadTelegramFile(
  botToken: string,
  fileId: string,
): Promise<Buffer> {
  try {
    // Get file path from Telegram
    const getFileUrl = `https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`;
    const getFileResponse = await fetch(getFileUrl);
    const getFileData = (await getFileResponse.json()) as {
      ok: boolean;
      result?: { file_path: string };
    };

    if (!getFileData.ok || !getFileData.result?.file_path) {
      throw new Error('Failed to get file path from Telegram');
    }

    // Download file
    const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${getFileData.result.file_path}`;
    const response = await fetch(downloadUrl);
    if (!response.ok) {
      throw new Error(`Failed to download file: ${response.statusText}`);
    }

    return Buffer.from(await response.arrayBuffer());
  } catch (err) {
    logger.error({ err }, 'Failed to download Telegram file');
    throw err;
  }
}

async function transcribeVoiceMessage(
  botToken: string,
  fileId: string,
): Promise<string> {
  const tempDir = '/tmp';
  const ts = Date.now();
  const voiceFile = path.join(tempDir, `voice_${ts}.ogg`);
  const wavFile = path.join(tempDir, `voice_${ts}.wav`);
  const whisperPath = '/home/pav/ai-agents/whisper.cpp';
  const modelPath = `${whisperPath}/models/ggml-small.bin`;
  const whisperBin = `${whisperPath}/build/bin/whisper-cli`;

  try {
    // Download voice file
    logger.info({ fileId }, 'Downloading voice message');
    const audioBuffer = await downloadTelegramFile(botToken, fileId);
    await fs.writeFile(voiceFile, audioBuffer);

    // Convert OGG to WAV if needed
    logger.info({ voiceFile }, 'Converting voice to WAV');
    try {
      await execAsync(`ffmpeg -i "${voiceFile}" -ar 16000 -ac 1 -c:a pcm_s16le -y "${wavFile}"`);
    } catch {
      // If conversion fails, try to use the OGG file directly
      logger.warn(
        'WAV conversion failed, attempting transcription on OGG file',
      );
    }

    const audioPath = await fs
      .access(wavFile)
      .then(() => wavFile)
      .catch(() => voiceFile);

    // Transcribe using whisper.cpp
    logger.info({ audioPath }, 'Transcribing voice message');
    const { stdout, stderr } = await execAsync(
      `"${whisperBin}" -m "${modelPath}" -l uk --no-timestamps -f "${audioPath}"`,
      { maxBuffer: 10 * 1024 * 1024 },
    );

    if (!stdout && stderr) {
      logger.error({ stderr }, 'Whisper transcription failed');
      throw new Error(`Transcription error: ${stderr}`);
    }

    const transcript = stdout.trim();
    logger.info({ transcript }, 'Voice transcribed successfully');

    // Clean up temp files
    await Promise.all([
      fs.unlink(voiceFile).catch(() => {}),
      fs.unlink(wavFile).catch(() => {}),
    ]);

    return transcript;
  } catch (err) {
    logger.error({ err, fileId }, 'Voice transcription failed');
    // Clean up on error
    await Promise.all([
      fs.unlink(voiceFile).catch(() => {}),
      fs.unlink(wavFile).catch(() => {}),
    ]);
    throw err;
  }
}

async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<void> {
  try {
    await api.sendMessage(chatId, text, {
      ...options,
      parse_mode: 'Markdown',
    });
  } catch (err) {
    // Fallback: send as plain text if Markdown parsing fails
    logger.debug({ err }, 'Markdown send failed, falling back to plain text');
    await api.sendMessage(chatId, text, options);
  }
}

// Bot pool for agent teams: send-only Api instances (no polling)
const poolApis: Api[] = [];
// Maps "{groupFolder}:{senderName}" → pool Api index for stable assignment
const senderBotMap = new Map<string, number>();
let nextPoolIndex = 0;

/**
 * Initialize send-only Api instances for the bot pool.
 * Each pool bot can send messages but doesn't poll for updates.
 */
export async function initBotPool(tokens: string[]): Promise<void> {
  for (const token of tokens) {
    try {
      const api = new Api(token);
      const me = await api.getMe();
      poolApis.push(api);
      logger.info(
        { username: me.username, id: me.id, poolSize: poolApis.length },
        'Pool bot initialized',
      );
    } catch (err) {
      logger.error({ err }, 'Failed to initialize pool bot');
    }
  }
  if (poolApis.length > 0) {
    logger.info({ count: poolApis.length }, 'Telegram bot pool ready');
  }
}

/**
 * Send a message via a pool bot assigned to the given sender name.
 * Assigns bots round-robin on first use; subsequent messages from the
 * same sender in the same group always use the same bot.
 * On first assignment, renames the bot to match the sender's role.
 */
export async function sendPoolMessage(
  chatId: string,
  text: string,
  sender: string,
  groupFolder: string,
): Promise<void> {
  if (poolApis.length === 0) {
    // No pool bots — fall back to main bot (handled by caller)
    return;
  }

  const key = `${groupFolder}:${sender}`;
  let idx = senderBotMap.get(key);
  if (idx === undefined) {
    idx = nextPoolIndex % poolApis.length;
    nextPoolIndex++;
    senderBotMap.set(key, idx);
    // Rename the bot to match the sender's role, then wait for Telegram to propagate
    try {
      await poolApis[idx].setMyName(sender);
      await new Promise((r) => setTimeout(r, 2000));
      logger.info(
        { sender, groupFolder, poolIndex: idx },
        'Assigned and renamed pool bot',
      );
    } catch (err) {
      logger.warn(
        { sender, err },
        'Failed to rename pool bot (sending anyway)',
      );
    }
  }

  const api = poolApis[idx];
  try {
    const numericId = chatId.replace(/^tg:/, '');
    const MAX_LENGTH = 4096;
    if (text.length <= MAX_LENGTH) {
      await sendTelegramMessage(api, numericId, text);
    } else {
      for (let i = 0; i < text.length; i += MAX_LENGTH) {
        await sendTelegramMessage(
          api,
          numericId,
          text.slice(i, i + MAX_LENGTH),
        );
      }
    }
    logger.info(
      { chatId, sender, poolIndex: idx, length: text.length },
      'Pool message sent',
    );
  } catch (err) {
    logger.error({ chatId, sender, err }, 'Failed to send pool message');
  }
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;
  private lastMessageIdPerChat: Map<string, number> = new Map();

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken);

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    this.bot.on('message:text', async (ctx) => {
      // Skip commands
      if (ctx.message.text.startsWith('/')) return;

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();
      const msgIdNum = ctx.message.message_id;

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      try {
        // Store the message ID for later status updates
        this.lastMessageIdPerChat.set(chatJid, ctx.message.message_id);

        // RIGHT AFTER receiving the message: set 👀 reaction
        await setReaction(this.botToken, ctx.chat.id, ctx.message.message_id, '👀');

        // Deliver message — startMessageLoop() will pick it up
        this.opts.onMessage(chatJid, {
          id: msgId,
          chat_jid: chatJid,
          sender,
          sender_name: senderName,
          content,
          timestamp,
          is_from_me: false,
          platform_message_id: ctx.message.message_id.toString(),
        });

        // Final reaction (👍/👎) will be set via updatePendingMessageStatus()
        // when processing completes in index.ts
      } catch (err) {
        logger.error({ err, chatJid }, 'Error processing message');
        // Final reaction (👍/👎) will be set via updatePendingMessageStatus()
        // when processing completes in index.ts
      }

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = async (ctx: any, placeholder: string) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );

      try {
        // Store the message ID for later status updates
        this.lastMessageIdPerChat.set(chatJid, ctx.message.message_id);

        await setReaction(this.botToken, ctx.chat.id, ctx.message.message_id, '👀');

        this.opts.onMessage(chatJid, {
          id: ctx.message.message_id.toString(),
          chat_jid: chatJid,
          sender: ctx.from?.id?.toString() || '',
          sender_name: senderName,
          content: `${placeholder}${caption}`,
          timestamp,
          is_from_me: false,
          platform_message_id: ctx.message.message_id.toString(),
        });
      } catch (err) {
        logger.error({ err, chatJid }, 'Error in storeNonText');
      }
    };

    this.bot.on('message:photo', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption || '';
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';

      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );

      try {
        // Store the message ID for later status updates
        this.lastMessageIdPerChat.set(chatJid, ctx.message.message_id);

        // React to show message is being processed
        await setReaction(this.botToken, ctx.chat.id, ctx.message.message_id, '👀');

        // Pick second-to-last size (high quality but not the raw original)
        const photos = ctx.message.photo;
        const photo =
          photos.length > 1
            ? photos[photos.length - 2]
            : photos[photos.length - 1];

        const attachment = await downloadTelegramPhoto(
          this.botToken,
          photo.file_id,
        );

        this.opts.onMessage(chatJid, {
          id: ctx.message.message_id.toString(),
          chat_jid: chatJid,
          sender: ctx.from?.id?.toString() || '',
          sender_name: senderName,
          content: caption || '[Photo]',
          timestamp,
          is_from_me: false,
          attachments: attachment ? [attachment] : undefined,
          platform_message_id: ctx.message.message_id.toString(),
        });
      } catch (err) {
        logger.error({ err, chatJid }, 'Error processing photo');
      }
    });
    this.bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    this.bot.on('message:voice', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';

      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );

      try {
        // Store the message ID for later status updates
        this.lastMessageIdPerChat.set(chatJid, ctx.message.message_id);

        await setReaction(this.botToken, ctx.chat.id, ctx.message.message_id, '👀');

        // Transcribe the voice message
        const transcript = await transcribeVoiceMessage(
          this.botToken,
          ctx.message.voice!.file_id,
        );

        this.opts.onMessage(chatJid, {
          id: ctx.message.message_id.toString(),
          chat_jid: chatJid,
          sender: ctx.from?.id?.toString() || '',
          sender_name: senderName,
          content: `[Voice]: ${transcript}`,
          timestamp,
          is_from_me: false,
          platform_message_id: ctx.message.message_id.toString(),
        });
      } catch (err) {
        logger.error({ err, chatJid }, 'Failed to transcribe voice message');
      }
    });
    this.bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
    this.bot.on('message:document', (ctx) => {
      const name = ctx.message.document?.file_name || 'file';
      storeNonText(ctx, `[Document: ${name}]`);
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await sendTelegramMessage(this.bot.api, numericId, text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await sendTelegramMessage(
            this.bot.api,
            numericId,
            text.slice(i, i + MAX_LENGTH),
          );
        }
      }
      logger.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }

  async updatePendingMessageStatus(jid: string, status: 'success' | 'error'): Promise<void> {
    let messageId: number | undefined = this.lastMessageIdPerChat.get(jid);

    // If not in memory, try to get from database
    if (!messageId) {
      const dbMessageId = getLatestMessageIdForChat(jid);
      if (dbMessageId) {
        messageId = parseInt(dbMessageId, 10);
      }
    }

    if (!messageId) {
      logger.debug({ jid }, 'No recent message ID found for status update, unable to set reaction');
      return;
    }

    const emoji = status === 'success' ? '👍' : '👎';
    const numericId = jid.replace(/^tg:/, '');

    try {
      await setReaction(this.botToken, numericId, messageId, emoji);
      logger.info({ jid, messageId, emoji, status }, 'Updated pending message status');
    } catch (err) {
      logger.debug({ jid, messageId, emoji, status, err }, 'Failed to update pending message status');
    }
  }

}

registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  return new TelegramChannel(token, opts);
});
