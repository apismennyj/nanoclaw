import https from 'https';
import http from 'http';

import { ImageAttachment } from './types.js';
import { logger } from './logger.js';

const MAX_BASE64_BYTES = 4 * 1024 * 1024; // 4MB base64 limit

function fetchUrl(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client
      .get(url, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          fetchUrl(res.headers.location).then(resolve).catch(reject);
          return;
        }
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      })
      .on('error', reject);
  });
}

/**
 * Download a Telegram photo by file_id and return it as a base64 ImageAttachment.
 * Picks a mid-size photo variant to keep payload under Claude's 5MB image limit.
 */
export async function downloadTelegramPhoto(
  botToken: string,
  fileId: string,
): Promise<ImageAttachment | null> {
  try {
    // Get file path from Telegram API
    const infoUrl = `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`;
    const infoBuffer = await fetchUrl(infoUrl);
    const info = JSON.parse(infoBuffer.toString('utf-8'));

    if (!info.ok || !info.result?.file_path) {
      logger.warn({ fileId }, 'Telegram getFile failed');
      return null;
    }

    const filePath: string = info.result.file_path;
    const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;

    const imageBuffer = await fetchUrl(downloadUrl);
    const base64 = imageBuffer.toString('base64');

    if (base64.length > MAX_BASE64_BYTES) {
      logger.warn({ fileId, bytes: base64.length }, 'Telegram photo too large, skipping');
      return null;
    }

    // Detect media type from file extension
    const ext = filePath.split('.').pop()?.toLowerCase();
    const mediaType: ImageAttachment['mediaType'] =
      ext === 'png' ? 'image/png'
      : ext === 'webp' ? 'image/webp'
      : ext === 'gif' ? 'image/gif'
      : 'image/jpeg';

    logger.info({ fileId, bytes: imageBuffer.length, mediaType }, 'Telegram photo downloaded');
    return { mediaType, data: base64 };
  } catch (err) {
    logger.error({ fileId, err }, 'Failed to download Telegram photo');
    return null;
  }
}
