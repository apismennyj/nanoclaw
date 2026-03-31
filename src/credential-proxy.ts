/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 */
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';
import { Transform } from 'stream';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

export interface ApiUsageData {
  model?: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

export type OnUsageCallback = (usage: ApiUsageData) => void;

/**
 * Create a stream transform that taps into the upstream response to extract
 * token usage data while passing all bytes through unmodified.
 *
 * Handles both:
 *   - Non-streaming: buffers full JSON response, extracts usage.usage
 *   - Streaming SSE: looks for "data: {...}" lines containing usage_metadata
 *     or message_delta events with usage
 */
function createUsageTapTransform(
  isStreaming: boolean,
  onUsage: OnUsageCallback,
): Transform {
  let buffer = '';
  let usageReported = false;

  return new Transform({
    transform(chunk, _encoding, callback) {
      const text = chunk.toString('utf8');

      if (!usageReported) {
        buffer += text;

        if (isStreaming) {
          // Parse SSE lines looking for usage data
          // Claude API sends usage in message_start and/or message_delta events
          const lines = buffer.split('\n');
          // Keep last potentially incomplete line
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const jsonStr = line.slice('data: '.length).trim();
            if (jsonStr === '[DONE]') continue;
            try {
              const event = JSON.parse(jsonStr);
              // message_start contains usage in event.message.usage
              if (event.type === 'message_start' && event.message?.usage) {
                const u = event.message.usage;
                const model = event.message?.model;
                onUsage({
                  model,
                  input_tokens: u.input_tokens || 0,
                  output_tokens: u.output_tokens || 0,
                  cache_read_tokens: u.cache_read_input_tokens || 0,
                  cache_write_tokens: u.cache_creation_input_tokens || 0,
                });
                usageReported = true;
                buffer = '';
                break;
              }
              // message_delta may have output_tokens update
              if (event.type === 'message_delta' && event.usage) {
                const u = event.usage;
                if (!usageReported) {
                  onUsage({
                    input_tokens: 0,
                    output_tokens: u.output_tokens || 0,
                    cache_read_tokens: 0,
                    cache_write_tokens: 0,
                  });
                  usageReported = true;
                  buffer = '';
                  break;
                }
              }
            } catch {
              // ignore parse errors
            }
          }
          // Cap buffer to avoid memory leak if no usage found
          if (buffer.length > 65536) buffer = buffer.slice(-4096);
        } else {
          // Non-streaming: cap buffer and try to parse when we have enough
          if (buffer.length > 512 * 1024) buffer = buffer.slice(-64 * 1024);
        }
      }

      // Always pass the chunk through unmodified
      callback(null, chunk);
    },

    flush(callback) {
      // For non-streaming responses, try to parse the full buffered response
      if (!usageReported && !isStreaming && buffer.length > 0) {
        try {
          const json = JSON.parse(buffer);
          if (json.usage) {
            const u = json.usage;
            onUsage({
              model: json.model,
              input_tokens: u.input_tokens || 0,
              output_tokens: u.output_tokens || 0,
              cache_read_tokens: u.cache_read_input_tokens || 0,
              cache_write_tokens: u.cache_creation_input_tokens || 0,
            });
          }
        } catch {
          // not valid JSON or no usage, ignore
        }
      }
      callback();
    },
  });
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
  onUsage?: OnUsageCallback,
): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  const oauthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        if (authMode === 'api-key') {
          // API key mode: inject x-api-key on every request
          delete headers['x-api-key'];
          headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
        } else {
          // OAuth mode: replace placeholder Bearer token with the real one
          // only when the container actually sends an Authorization header
          // (exchange request + auth probes). Post-exchange requests use
          // x-api-key only, so they pass through without token injection.
          if (headers['authorization']) {
            delete headers['authorization'];
            if (oauthToken) {
              headers['authorization'] = `Bearer ${oauthToken}`;
            }
          }
        }

        // Determine if this is a messages API request where we want to tap usage
        const isMessagesRequest =
          onUsage != null &&
          req.method === 'POST' &&
          (req.url?.includes('/messages') ?? false);

        // Detect streaming from request body
        let isStreaming = false;
        if (isMessagesRequest) {
          try {
            const reqBody = JSON.parse(body.toString('utf8'));
            isStreaming = reqBody.stream === true;
          } catch {
            // ignore
          }
        }

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: req.url,
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            res.writeHead(upRes.statusCode!, upRes.headers);

            if (isMessagesRequest && onUsage && upRes.statusCode === 200) {
              // Tap the response stream to extract usage without modifying it
              const tap = createUsageTapTransform(isStreaming, onUsage);
              upRes.pipe(tap).pipe(res);
            } else {
              upRes.pipe(res);
            }
          },
        );

        upstream.on('error', (err) => {
          logger.error(
            { err, url: req.url },
            'Credential proxy upstream error',
          );
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });

        upstream.write(body);
        upstream.end();
      });
    });

    server.listen(port, host, () => {
      logger.info({ port, host, authMode }, 'Credential proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}
