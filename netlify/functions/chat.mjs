// Netlify Function: secure proxy between the Corvit website and the Dify.ai Chat API.
// Route: POST /.netlify/functions/chat
// Request body:  { "query": string, "conversation_id"?: string, "user"?: string }
// Response body: { "answer": string, "conversation_id": string, "message_id": string | null }
// Errors:        { "error": string, "code": string, ... } with a matching HTTP status.
//
// Environment variables (Netlify dashboard -> Site configuration -> Environment variables):
//   DIFY_API_KEY   (required)  the API key of your Dify app. It is read only on the server.
//   DIFY_BASE_URL  (optional)  defaults to https://dify.ai
//
// Base URL handling: Dify's Service API lives under /v1. For Dify Cloud, https://dify.ai
// (or https://api.dify.ai/v1) resolves to https://api.dify.ai/v1. For self-hosted
// installs, give your own base URL, with or without the trailing /v1.

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

const MAX_QUERY_LENGTH = 2000;
const UPSTREAM_TIMEOUT_MS = 25000;

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function resolveBaseUrl(raw) {
  const base = String(raw || 'https://dify.ai').trim().replace(/\/+$/, '');
  let parsed;
  try {
    parsed = new URL(base);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;

  const host = parsed.hostname.toLowerCase();
  if (host === 'dify.ai' || host === 'www.dify.ai' || host === 'cloud.dify.ai') {
    return 'https://api.dify.ai/v1';
  }
  return /\/v1$/.test(parsed.pathname) ? base : `${base}/v1`;
}

function cleanUserId(value) {
  const cleaned = String(value || '').replace(/[^\w.@-]/g, '').slice(0, 64);
  return cleaned || 'corvit-student';
}

export default async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== 'POST') {
    return json(405, { error: 'Method not allowed. Use POST.', code: 'method_not_allowed' });
  }

  const apiKey = process.env.DIFY_API_KEY;
  if (!apiKey) {
    return json(500, {
      error: 'The AI service is not configured on the server (DIFY_API_KEY is missing).',
      code: 'missing_api_key',
    });
  }

  const baseUrl = resolveBaseUrl(process.env.DIFY_BASE_URL);
  if (!baseUrl) {
    return json(500, {
      error: 'DIFY_BASE_URL is not a valid http(s) URL.',
      code: 'invalid_base_url',
    });
  }

  let payload;
  try {
    payload = await req.json();
  } catch {
    return json(400, { error: 'Request body must be valid JSON.', code: 'invalid_json' });
  }
  if (!payload || typeof payload !== 'object') {
    return json(400, { error: 'Request body must be a JSON object.', code: 'invalid_body' });
  }

  const query = typeof payload.query === 'string' ? payload.query.trim() : '';
  if (!query) {
    return json(400, { error: 'The "query" field is required.', code: 'missing_query' });
  }
  if (query.length > MAX_QUERY_LENGTH) {
    return json(400, {
      error: `The message is too long (maximum ${MAX_QUERY_LENGTH} characters).`,
      code: 'query_too_long',
    });
  }

  const conversationId = payload.conversation_id == null ? '' : String(payload.conversation_id);
  if (conversationId && !/^[\w-]{1,64}$/.test(conversationId)) {
    return json(400, { error: 'The "conversation_id" field is invalid.', code: 'invalid_conversation_id' });
  }

  const user = cleanUserId(payload.user);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  let upstream;
  let rawText;
  try {
    upstream = await fetch(`${baseUrl}/chat-messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        inputs: {},
        query,
        response_mode: 'blocking',
        conversation_id: conversationId || '',
        user,
      }),
      signal: controller.signal,
    });
    rawText = await upstream.text();
  } catch (err) {
    if (err && err.name === 'AbortError') {
      return json(504, {
        error: 'The AI service took too long to respond. Please try again.',
        code: 'upstream_timeout',
      });
    }
    console.error('Dify request failed:', err && err.message ? err.message : err);
    return json(502, {
      error: 'Could not reach the AI service. Please try again shortly.',
      code: 'upstream_unreachable',
    });
  } finally {
    clearTimeout(timer);
  }

  let data = null;
  try {
    data = JSON.parse(rawText);
  } catch {
    data = null;
  }

  if (!upstream.ok) {
    const upstreamMessage =
      (data && (data.message || data.error)) || `The AI service returned HTTP ${upstream.status}.`;
    console.error('Dify error', upstream.status, upstreamMessage);

    if (upstream.status === 404 && conversationId) {
      return json(404, {
        error: 'That conversation no longer exists. Please start a new chat.',
        code: 'conversation_not_found',
      });
    }
    if (upstream.status === 401 || upstream.status === 403) {
      return json(502, {
        error: 'The AI service rejected the server credentials. Check DIFY_API_KEY and DIFY_BASE_URL.',
        code: 'upstream_auth_failed',
        upstream_status: upstream.status,
      });
    }
    if (upstream.status === 429) {
      return json(429, {
        error: 'The AI service is busy right now. Please try again in a moment.',
        code: 'upstream_rate_limited',
        upstream_status: 429,
      });
    }
    return json(502, {
      error: upstreamMessage,
      code: (data && data.code) || 'upstream_error',
      upstream_status: upstream.status,
    });
  }

  if (!data || typeof data.answer !== 'string') {
    console.error('Unexpected Dify response shape');
    return json(502, {
      error: 'The AI service returned an unexpected response.',
      code: 'invalid_upstream_response',
    });
  }

  return json(200, {
    answer: data.answer,
    conversation_id: data.conversation_id || conversationId || '',
    message_id: data.message_id || null,
  });
};
