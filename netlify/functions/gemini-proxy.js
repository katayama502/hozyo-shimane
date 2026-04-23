/**
 * netlify/functions/gemini-proxy.js
 *
 * Gemini APIへのセキュアなプロキシ関数。
 * APIキーはNetlify環境変数 GEMINI_API_KEY に保存し、
 * クライアント側に一切露出しない。
 */

const GEMINI_MODEL = 'gemini-2.0-flash';
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

exports.handler = async (event) => {
  // ==================== CORS ヘッダー ====================
  const allowedOrigins = [
    process.env.URL,          // Netlifyが自動設定するデプロイURL
    process.env.DEPLOY_URL,   // プレビューURL
    'http://localhost:8888',  // Netlify Dev
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

  // プリフライトリクエスト
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  // POST以外は拒否
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method Not Allowed' }),
    };
  }

  // ==================== APIキー確認 ====================
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('[gemini-proxy] GEMINI_API_KEY が設定されていません');
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'サーバーの設定が完了していません。管理者にお問い合わせください。',
      }),
    };
  }

  // ==================== リクエスト解析 ====================
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'リクエストの形式が不正です。' }),
    };
  }

  const { prompt } = body;
  if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'prompt が指定されていません。' }),
    };
  }

  // プロンプト長の制限（悪用防止）
  if (prompt.length > 8000) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'プロンプトが長すぎます。' }),
    };
  }

  // ==================== Gemini API呼び出し ====================
  const geminiUrl = `${GEMINI_BASE_URL}/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  const geminiBody = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 8192,
      responseMimeType: 'application/json',
    },
  };

  let geminiRes;
  try {
    geminiRes = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiBody),
    });
  } catch (networkErr) {
    console.error('[gemini-proxy] ネットワークエラー:', networkErr);
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ error: 'Gemini APIへの接続に失敗しました。時間をおいて再試行してください。' }),
    };
  }

  const geminiData = await geminiRes.json();

  if (!geminiRes.ok) {
    const errMsg = geminiData?.error?.message || `HTTP ${geminiRes.status}`;
    console.error('[gemini-proxy] Gemini APIエラー:', geminiRes.status, errMsg);
    return {
      statusCode: geminiRes.status >= 500 ? 502 : geminiRes.status,
      headers,
      body: JSON.stringify({ error: `AIサービスエラー: ${errMsg}` }),
    };
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify(geminiData),
  };
};
