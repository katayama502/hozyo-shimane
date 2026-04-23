/**
 * netlify/functions/update-subsidies.js
 *
 * 補助金データ取得エンドポイント（HTTP）。
 *
 * 通常運用: Firestoreにデータがあれば即返却（週次cronが常に最新を保つ）
 * 初回のみ: Firestoreが空の場合のみ Gemini を呼び出してデータを生成・保存
 *
 * データの鮮度管理は scheduled-update.js（週次cron）が担う。
 * このエンドポイントはデータの有無だけを判断する。
 */

const { fetchFromGemini, getGoogleAccessToken, readFirestore, writeFirestore } = require('./_shared');

exports.handler = async (event) => {
  // ==================== CORS ====================
  const allowedOrigins = [
    process.env.URL,
    process.env.DEPLOY_URL,
    'http://localhost:8888',
    'http://localhost:3000',
    'http://localhost',
  ].filter(Boolean);

  const origin     = event.headers.origin || '';
  const corsOrigin = allowedOrigins.includes(origin) ? origin : (allowedOrigins[0] || '');

  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Max-Age': '86400',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };

  // ==================== 環境変数チェック ====================
  const geminiKey = process.env.GEMINI_API_KEY;
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const saRaw     = process.env.FIREBASE_SERVICE_ACCOUNT;

  if (!geminiKey || !projectId || !saRaw) {
    const missing = [
      !geminiKey ? 'GEMINI_API_KEY' : null,
      !projectId ? 'FIREBASE_PROJECT_ID' : null,
      !saRaw     ? 'FIREBASE_SERVICE_ACCOUNT' : null,
    ].filter(Boolean).join(', ');
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: `サーバー設定エラー: ${missing} が未設定です。` }),
    };
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(saRaw);
  } catch {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'FIREBASE_SERVICE_ACCOUNT のJSON形式が不正です。' }),
    };
  }

  // ==================== Firestore 読み取り ====================
  // データがあれば鮮度に関わらず即返却（鮮度管理は週次cronに任せる）
  let current = null;
  try {
    current = await readFirestore(projectId);
  } catch (err) {
    console.warn('[update-subsidies] Firestore読み取り失敗:', err.message);
  }

  if (current?.subsidies?.length > 0) {
    console.log('[update-subsidies] Firestoreからデータ返却');
    return {
      statusCode: 200,
      headers: { ...headers, 'X-Cache': 'HIT' },
      body: JSON.stringify({
        subsidies:   current.subsidies,
        fetchedAt:   current.fetchedAt,
        lastUpdated: current.lastUpdated,
        source:      'firestore',
      }),
    };
  }

  // ==================== 初回のみ: Gemini + Firestore書き込み ====================
  console.log('[update-subsidies] Firestoreにデータなし → 初回Gemini取得');

  let geminiResult, accessToken;
  try {
    [geminiResult, accessToken] = await Promise.all([
      fetchFromGemini(geminiKey),
      getGoogleAccessToken(serviceAccount),
    ]);
  } catch (err) {
    console.error('[update-subsidies] 初回取得失敗:', err.message);
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ error: `補助金データの取得に失敗しました: ${err.message}` }),
    };
  }

  const fetchedAt = new Date().toISOString();

  try {
    await writeFirestore(projectId, accessToken, geminiResult.subsidies, fetchedAt);
  } catch (err) {
    console.error('[update-subsidies] Firestore書き込み失敗:', err.message);
    // 書き込み失敗でもデータはクライアントに返す
  }

  return {
    statusCode: 200,
    headers: { ...headers, 'X-Cache': 'MISS' },
    body: JSON.stringify({
      subsidies:   geminiResult.subsidies,
      fetchedAt,
      lastUpdated: fetchedAt,
      source:      'gemini',
    }),
  };
};
