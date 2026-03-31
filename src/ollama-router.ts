/**
 * Ollama routing module for NanoClaw.
 * Classifies incoming messages and routes simple ones to a local Ollama instance,
 * while complex/tool-requiring messages go to Claude via the normal container path.
 * Supports multimodal (image) messages via Ollama vision API.
 */

import { ImageAttachment, NewMessage } from './types.js';
import { logger } from './logger.js';

const OLLAMA_BASE_URL = 'http://localhost:11434';
const OLLAMA_TIMEOUT_MS = 300_000; // 5 min — qwen3.5:4b on CPU can be slow

// Keywords that indicate the request requires tools or complex processing
const TOOL_KEYWORDS = [
  // Ukrainian
  'знайди', 'пошукай', 'відкрий', 'завантаж', 'перевір', 'нагадай',
  'поставити', 'запусти', 'статс', 'пошта', 'linkedin', 'github',
  'задачу', 'розклад', 'ярмарок', 'виправ', 'напиши код', 'фікс',
  'патч', 'встанови',
  // English
  'stats', 'search', 'find', 'open', 'download', 'check', 'remind',
  'schedule', 'run', 'install', 'fix', 'patch',
];

const URL_PATTERN = /https?:\/\/\S+/i;
const CODE_BLOCK_PATTERN = /```[\s\S]*?```|`[^`]+`/;

/**
 * Classify a set of messages to determine if they should be routed to
 * the local Ollama model or to Claude.
 *
 * Returns 'claude' when:
 *   - Any message contains a URL
 *   - Any message contains a code block
 *   - Any message contains tool-related keywords
 *   - Total message content length exceeds 200 characters
 *
 * Returns 'local' for simple chat, short questions, greetings, images, etc.
 * Images are handled locally via Ollama vision (qwen3.5 is multimodal).
 */
export function classifyRequest(messages: NewMessage[]): 'local' | 'claude' {
  let totalLength = 0;

  for (const msg of messages) {
    const content = msg.content || '';
    totalLength += content.length;

    // URL check
    if (URL_PATTERN.test(content)) {
      logger.debug({ reason: 'url' }, 'Routing to Claude');
      return 'claude';
    }

    // Code block check
    if (CODE_BLOCK_PATTERN.test(content)) {
      logger.debug({ reason: 'code_block' }, 'Routing to Claude');
      return 'claude';
    }

    // Tool keyword check (case-insensitive)
    const lower = content.toLowerCase();
    for (const keyword of TOOL_KEYWORDS) {
      if (lower.includes(keyword)) {
        logger.debug({ reason: 'tool_keyword', keyword }, 'Routing to Claude');
        return 'claude';
      }
    }
  }

  // Total length check
  if (totalLength > 200) {
    logger.debug({ reason: 'length', totalLength }, 'Routing to Claude');
    return 'claude';
  }

  return 'local';
}

/**
 * Detect which model is available in the local Ollama instance.
 * Prefers qwen3.5:4b; falls back to first available model.
 * Returns null if Ollama is not reachable or has no models.
 */
async function detectOllamaModel(): Promise<string | null> {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 5_000); // 5s for tags check
  try {
    const resp = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { signal: ctrl.signal });
    if (!resp.ok) return null;

    const data = (await resp.json()) as { models?: Array<{ name: string }> };
    const models = data.models || [];
    if (models.length === 0) return null;

    // Prefer qwen3.5:4b (9b doesn't fit in 8GB RAM)
    const priority = ['qwen3.5:4b', 'qwen3.5:9b'];
    for (const p of priority) {
      const found = models.find((m) => m.name === p || m.name.startsWith(p));
      if (found) return found.name;
    }
    const preferred = models.find(
      (m) => m.name.startsWith('qwen3.5') || m.name.startsWith('qwen3') || m.name.startsWith('qwen2.5'),
    );
    if (preferred) return preferred.name;

    // Fall back to first available
    return models[0].name;
  } catch {
    return null;
  }
}

type OllamaContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

type OllamaChatMessage = {
  role: string;
  content: string | OllamaContentPart[];
};

/**
 * Build an Ollama-compatible content array for a message that may have images.
 */
function buildContent(
  text: string,
  attachments?: ImageAttachment[],
): string | OllamaContentPart[] {
  if (!attachments || attachments.length === 0) return text;

  const parts: OllamaContentPart[] = [];
  if (text && text !== '[Photo]') {
    parts.push({ type: 'text', text });
  }
  for (const att of attachments) {
    parts.push({
      type: 'image_url',
      image_url: { url: `data:${att.mediaType};base64,${att.data}` },
    });
  }
  if (parts.length === 0) {
    parts.push({ type: 'text', text: 'Що на цьому зображенні?' });
  }
  return parts;
}

/**
 * Send messages to the local Ollama instance and return the response text.
 * Supports multimodal messages (images via base64).
 *
 * @param messages - The conversation messages (may include image attachments)
 * @param systemPrompt - Optional system prompt
 * @throws Error if Ollama is unreachable, times out, or returns an error
 */
export async function askOllama(
  messages: NewMessage[],
  systemPrompt?: string,
): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);

  try {
    // Detect available model
    const model = await detectOllamaModel();
    if (!model) {
      throw new Error('Ollama has no available models');
    }

    // Build message list for OpenAI-compatible API
    const chatMessages: OllamaChatMessage[] = [];

    if (systemPrompt) {
      chatMessages.push({ role: 'system', content: systemPrompt });
    }

    for (const msg of messages) {
      const role = msg.is_from_me || msg.is_bot_message ? 'assistant' : 'user';
      const content = buildContent(msg.content, msg.attachments);
      chatMessages.push({ role, content });
    }

    const body = JSON.stringify({
      model,
      messages: chatMessages,
      stream: false,
      keep_alive: -1, // keep model loaded in RAM indefinitely
    });

    const resp = await fetch(`${OLLAMA_BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => resp.statusText);
      throw new Error(`Ollama HTTP ${resp.status}: ${errText}`);
    }

    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: string;
    };

    if (data.error) {
      throw new Error(`Ollama error: ${data.error}`);
    }

    const text = data.choices?.[0]?.message?.content;
    if (!text) {
      throw new Error('Ollama returned empty response');
    }

    return text.trim();
  } finally {
    clearTimeout(timeoutId);
  }
}
