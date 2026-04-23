/**
 * netlify/functions/gemini-proxy.js
 *
 * Gemini APIへのセキュアなプロキシ関数。
 * - APIキーはNetlify環境変数 GEMINI_API_KEY に保護
 * - モデル自動フォールバック（3.1 Flash-Lite → 2.0 Flash → 1.5 Flash）
 * - 429レート制限時はクライアントに retryAfter を通知
 */

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

// 無料枠レート制限（2026年4月時点）
// モデルを制限の緩いものから順に並べる
// RPM: 分間リクエスト数 / RPD: 日間リクエスト数
const MODELS = [
  { id: 'gemini-2.5-flash',      rpm: 10, rpd: 500  },  // メイン（高性能）
  { id: 'gemini-2.0-flash',      rpm: 15, rpd: 1500 },  // フォールバック1
  { id: 'gemini-1.5-flash',      rpm: 15, rpd: 1500 },  // フォールバック2
];

// Netlify無料枠タイムアウト10秒に対し、8秒でGemini側をAbort
const GEMINI_TIMEOUT_MS = 8000;

/**
 * 単一モデルでGemini APIを呼び出す（AbortControllerでタイムアウト制御）
 */
async function callGemini(modelId, prompt, apiKey) {
  const url = `${GEMINI_BASE_URL}/${modelId}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 3000,   // 504対策: 出力を抑えてレスポンスを高速化
      responseMimeType: 'application/json',
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  } catch (err) {
    if (err.name === 'AbortError') {
      // タイムアウト専用エラーを投げる
      const timeoutErr = new Error('timeout');
      timeoutErr.isTimeout = true;
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

exports.handler = async (event) => {
  // ==================== CORS ヘッダー ====================
  const allowedOrigins = [
    process.env.URL,
    process.env.DEPLOY_URL,
    'http://localhost:8888',
    'http://localhost:3000',
    'http://localhost',
  ].filter(Boolean);

  const origin = event.headers.origin || '';
  const corsOrigin = allowedOrigins.includes(origin) ? origin : (allowedOrigins[0] || '');

  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  // ==================== APIキー確認 ====================
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('[gemini-proxy] GEMINI_API_KEY が未設定');
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'サーバーの設定が完了していません。管理者にお問い合わせください。' }),
    };
  }

  // ==================== リクエスト検証 ====================
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'リクエストの形式が不正です。' }) };
  }

  const { prompt } = body;
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'prompt が指定されていません。' }) };
  }
  if (prompt.length > 8000) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'プロンプトが長すぎます。' }) };
  }

  // ==================== モデルフォールバックで呼び出し ====================
  let lastError = null;

  for (const model of MODELS) {
    let res, data;
    try {
      ({ res, data } = await callGemini(model.id, prompt, apiKey));
    } catch (err) {
      if (err.isTimeout) {
        console.warn(`[gemini-proxy] タイムアウト (${model.id}) → 次へフォールバック`);
        lastError = { statusCode: 504, error: '応答時間が上限を超えました。再試行してください。' };
        continue; // 次のモデルで再試行
      }
      console.error(`[gemini-proxy] ネットワークエラー (${model.id}):`, err.message);
      lastError = { statusCode: 502, error: 'AIサービスへの接続に失敗しました。時間をおいて再試行してください。' };
      continue;
    }

    // 成功
    if (res.ok) {
      console.log(`[gemini-proxy] 成功: ${model.id}`);
      return { statusCode: 200, headers, body: JSON.stringify(data) };
    }

    const status = res.status;
    const errMsg = data?.error?.message || `HTTP ${status}`;
    console.warn(`[gemini-proxy] ${model.id} → ${status}: ${errMsg}`);

    // レート制限（429）: クライアントに retryAfter を返してフォールバックしない
    if (status === 429) {
      const retryAfterSec = parseInt(res.headers.get('retry-after') || '60', 10);
      return {
        statusCode: 429,
        headers: { ...headers, 'Retry-After': String(retryAfterSec) },
        body: JSON.stringify({
          error: 'rate_limit',
          retryAfter: retryAfterSec,
          model: model.id,
          rpm: model.rpm,
          rpd: model.rpd,
        }),
      };
    }

    // モデルが存在しない（404）→ 次のモデルを試す
    if (status === 404) {
      console.warn(`[gemini-proxy] モデル未発見: ${model.id} → 次へフォールバック`);
      lastError = { statusCode: 404, error: `モデル ${model.id} が利用できません。` };
      continue;
    }

    // その他のエラー → リトライ不要
    lastError = {
      statusCode: status >= 500 ? 502 : status,
      error: `AIサービスエラー: ${errMsg}`,
    };
    break;
  }

  // 全モデルで失敗
  console.error('[gemini-proxy] 全モデルで失敗:', lastError);
  return {
    statusCode: lastError?.statusCode || 502,
    headers,
    body: JSON.stringify({ error: lastError?.error || '予期しないエラーが発生しました。' }),
  };
};
