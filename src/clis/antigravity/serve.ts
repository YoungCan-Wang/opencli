/**
 * antigravity serve — Anthropic-compatible `/v1/messages` proxy server.
 *
 * Starts an HTTP server that accepts Anthropic Messages API requests,
 * forwards them to a running Antigravity app via CDP, polls for the response,
 * and returns it in Anthropic format.
 *
 * Usage:
 *   OPENCLI_CDP_ENDPOINT=http://127.0.0.1:9224 opencli antigravity serve --port 8082
 *   ANTHROPIC_BASE_URL=http://localhost:8082 claude
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { CDPBridge } from '../../browser/cdp.js';
import type { IPage } from '../../types.js';

// ─── Types ───────────────────────────────────────────────────────────

interface AnthropicRequest {
  model?: string;
  max_tokens?: number;
  system?: string | Array<{ type: string; text: string }>;
  messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>;
  stream?: boolean;
}

interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: Array<{ type: 'text'; text: string }>;
  model: string;
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence';
  stop_sequence: null;
  usage: { input_tokens: number; output_tokens: number };
}

// ─── Helpers ─────────────────────────────────────────────────────────

function generateMsgId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let id = 'msg_';
  for (let i = 0; i < 24; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

function estimateTokens(text: string): number {
  // Rough approximation: ~4 chars per token for English, ~2 for CJK
  return Math.max(1, Math.ceil(text.length / 3));
}

function extractTextContent(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === 'string') return content;
  return content
    .filter(b => b.type === 'text' && b.text)
    .map(b => b.text!)
    .join('\n');
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function jsonResponse(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-api-key, anthropic-version, Authorization',
  });
  res.end(body);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Antigravity CDP Operations ──────────────────────────────────────

async function getConversationText(page: IPage): Promise<string> {
  const text = await page.evaluate(`
    (() => {
      const container = document.getElementById('conversation');
      return container ? container.innerText : '';
    })()
  `);
  return String(text ?? '');
}

async function sendMessage(page: IPage, message: string): Promise<void> {
  await page.evaluate(`
    (async () => {
      const container = document.getElementById('antigravity.agentSidePanelInputBox');
      if (!container) throw new Error('Could not find antigravity.agentSidePanelInputBox');
      const editor = container.querySelector('[data-lexical-editor="true"]');
      if (!editor) throw new Error('Could not find Antigravity input box');
      
      editor.focus();
      document.execCommand('insertText', false, ${JSON.stringify(message)});
    })()
  `);
  await sleep(500);
  await page.pressKey('Enter');
}

async function waitForReply(
  page: IPage,
  beforeText: string,
  opts: { timeout?: number; pollInterval?: number; stableThreshold?: number } = {},
): Promise<string> {
  const timeout = opts.timeout ?? 120_000;     // 2 minutes max
  const pollInterval = opts.pollInterval ?? 500; // 500ms polling
  const stableThreshold = opts.stableThreshold ?? 6; // 6 × 500ms = 3s stable

  const deadline = Date.now() + timeout;
  let lastText = beforeText;
  let stableCount = 0;

  // Wait a bit for the model to start generating
  await sleep(1000);

  while (Date.now() < deadline) {
    const current = await getConversationText(page);

    if (current.length > beforeText.length) {
      // New content appeared
      if (current === lastText) {
        stableCount++;
        if (stableCount >= stableThreshold) {
          // Text has been stable — reply is complete
          return current.slice(beforeText.length).trim();
        }
      } else {
        // Still generating
        stableCount = 0;
        lastText = current;
      }
    }

    await sleep(pollInterval);
  }

  // Timeout — return whatever we have
  const finalText = await getConversationText(page);
  if (finalText.length > beforeText.length) {
    return finalText.slice(beforeText.length).trim();
  }
  throw new Error('Timeout waiting for Antigravity reply');
}

// ─── Request Handlers ────────────────────────────────────────────────

async function handleMessages(
  body: AnthropicRequest,
  page: IPage,
): Promise<AnthropicResponse> {
  // Extract the last user message
  const userMessages = body.messages.filter(m => m.role === 'user');
  if (userMessages.length === 0) {
    throw new Error('No user message found in request');
  }
  const lastUserMsg = userMessages[userMessages.length - 1];
  const userText = extractTextContent(lastUserMsg.content);

  if (!userText.trim()) {
    throw new Error('Empty user message');
  }

  // Get conversation state before sending
  const beforeText = await getConversationText(page);

  // Send the message
  console.error(`[serve] Sending: "${userText.slice(0, 80)}${userText.length > 80 ? '...' : ''}"`);
  await sendMessage(page, userText);

  // Poll for reply
  console.error('[serve] Waiting for reply...');
  const replyText = await waitForReply(page, beforeText);
  console.error(`[serve] Got reply: "${replyText.slice(0, 80)}${replyText.length > 80 ? '...' : ''}"`);

  return {
    id: generateMsgId(),
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: replyText }],
    model: body.model ?? 'antigravity',
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: estimateTokens(userText),
      output_tokens: estimateTokens(replyText),
    },
  };
}

// ─── Server ──────────────────────────────────────────────────────────

export async function startServe(opts: { port?: number } = {}): Promise<void> {
  const port = opts.port ?? 8082;

  // Establish persistent CDP connection
  console.error('[serve] Connecting to Antigravity via CDP...');
  const cdp = new CDPBridge();
  const page = await cdp.connect({ timeout: 15_000 });
  console.error('[serve] CDP connected successfully.');

  // Verify we can read conversation
  const testText = await getConversationText(page);
  console.error(`[serve] Conversation element found (${testText.length} chars).`);

  let requestInFlight = false;

  const server = createServer(async (req, res) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, x-api-key, anthropic-version, Authorization',
      });
      res.end();
      return;
    }

    const url = req.url ?? '/';
    const pathname = url.split('?')[0];

    try {
      // GET /v1/models — return available models
      if (req.method === 'GET' && pathname === '/v1/models') {
        jsonResponse(res, 200, {
          data: [
            {
              id: 'antigravity',
              object: 'model',
              created: Math.floor(Date.now() / 1000),
              owned_by: 'antigravity',
            },
          ],
        });
        return;
      }

      // POST /v1/messages — main endpoint
      if (req.method === 'POST' && pathname === '/v1/messages') {
        if (requestInFlight) {
          jsonResponse(res, 429, {
            type: 'error',
            error: {
              type: 'rate_limit_error',
              message: 'Another request is currently being processed. Antigravity can only handle one request at a time.',
            },
          });
          return;
        }

        requestInFlight = true;
        try {
          const rawBody = await readBody(req);
          const body = JSON.parse(rawBody) as AnthropicRequest;

          if (body.stream) {
            // We don't support streaming — return error
            jsonResponse(res, 400, {
              type: 'error',
              error: {
                type: 'invalid_request_error',
                message: 'Streaming is not supported. Set "stream": false.',
              },
            });
            return;
          }

          const response = await handleMessages(body, page);
          jsonResponse(res, 200, response);
        } finally {
          requestInFlight = false;
        }
        return;
      }

      // Health check
      if (req.method === 'GET' && (pathname === '/' || pathname === '/health')) {
        jsonResponse(res, 200, { ok: true, status: 'connected' });
        return;
      }

      jsonResponse(res, 404, {
        type: 'error',
        error: { type: 'not_found_error', message: `Not found: ${pathname}` },
      });
    } catch (err) {
      console.error('[serve] Error:', err);
      jsonResponse(res, 500, {
        type: 'error',
        error: {
          type: 'api_error',
          message: err instanceof Error ? err.message : 'Internal server error',
        },
      });
    }
  });

  server.listen(port, '127.0.0.1', () => {
    console.error(`\n[serve] ✅ Antigravity API proxy running at http://127.0.0.1:${port}`);
    console.error(`[serve] Compatible with Anthropic /v1/messages API`);
    console.error(`\n[serve] Usage with Claude Code:`);
    console.error(`  ANTHROPIC_BASE_URL=http://localhost:${port} claude\n`);
  });

  // Graceful shutdown
  const shutdown = () => {
    console.error('\n[serve] Shutting down...');
    cdp.close().catch(() => {});
    server.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Keep alive
  await new Promise(() => {});
}
