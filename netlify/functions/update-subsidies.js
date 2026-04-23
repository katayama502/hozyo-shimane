/**
 * netlify/functions/update-subsidies.js
 *
 * Firebase Firestore への補助金データ週次更新関数。
 *
 * フロー:
 *   1. Firestore から現在のデータを読み取る（公開エンドポイント）
 *   2. データが新鮮（7日以内）なら即座にクライアントへ返す
 *   3. データが古い（7日超）or 未作成なら：
 *      a. Gemini呼び出し と OAuth取得を【並列実行】（時間短縮の核心）
 *      b. Firestore にデータを書き込む
 *      c. 最新データをクライアントへ返す
 *
 * タイムライン（Netlify 10s制限内）:
 *   Firestore読取 (〜300ms)
 *   └→ [Gemini呼出 (〜4s)] 並列 [OAuth取得 (〜400ms)]
 *      └→ Firestore書込 (〜300ms)
 *   合計: 約5s ← 余裕あり
 *
 * 必要な環境変数（Netlify）:
 *   GEMINI_API_KEY           - Gemini API キー
 *   FIREBASE_PROJECT_ID      - Firebase プロジェクトID
 *   FIREBASE_SERVICE_ACCOUNT - サービスアカウントJSONの全文字列
 */

// crypto は動的importではなくモジュールレベルで読み込む（初回オーバーヘッド排除）
const { webcrypto } = require('node:crypto');

const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // 7日
const GEMINI_TIMEOUT_MS  = 20000;                     // 26s枠に対して20s（OAuth/書込分を確保）
const GEMINI_BASE_URL    = 'https://generativelanguage.googleapis.com/v1beta/models';

const GEMINI_MODELS = [
  { id: 'gemini-2.5-flash' },  // メイン
  { id: 'gemini-2.0-flash' },  // フォールバック
];

// ==================== Gemini呼び出し ====================

function buildSubsidyPrompt() {
  return `あなたは島根県の補助金・助成金制度に精通した専門家です。
2026年現在、島根県内で申請可能または近日中に申請受付が予定されている補助金・助成金・支援制度を25件リストアップしてください。

以下のカテゴリから各3〜5件を目安に選んでください：農業・林業・水産業、中小企業・創業支援、移住・定住支援、子育て・教育、住宅・リフォーム、ITデジタル化

国の補助金で島根県民も対象になるものも含めてください（例：ものづくり補助金、IT導入補助金等）。
松江市・出雲市・浜田市など市町村独自の補助金も含めてください。

以下のJSON形式のみで返してください（説明文・マークダウン等は一切不要）：

{"subsidies":[{"id":"shimane-001","title":"補助金の正式名称","simpleDescription":"わかりやすい説明60文字以内","description":"詳細説明200文字以内","category":"農業・林業・水産業","targetUsers":["農業従事者"],"maxAmount":1000000,"deadline":"2026-06-30","issuer":"島根県","region":"島根県全域","applicationUrl":"https://www.pref.shimane.lg.jp/","requirements":"申請条件100文字以内","status":"受付中"}]}

フィールド: id=shimane-連番3桁, category="農業・林業・水産業"/"中小企業・創業支援"/"移住・定住支援"/"子育て・教育"/"住宅・リフォーム"/"ITデジタル化"/"その他", maxAmount=数値(不明は0), deadline=YYYY-MM-DD or null, status="受付中"/"受付予定"/"終了"`;
}

async function callGemini(modelId, prompt, apiKey) {
  const url = `${GEMINI_BASE_URL}/${modelId}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 4096,
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
      const e = new Error(`タイムアウト (${modelId})`);
      e.isTimeout = true;
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFromGemini(apiKey) {
  const prompt = buildSubsidyPrompt();

  for (const model of GEMINI_MODELS) {
    let res, data;
    try {
      ({ res, data } = await callGemini(model.id, prompt, apiKey));
    } catch (err) {
      console.warn(`[update-subsidies] ${model.id} 失敗:`, err.message);
      continue;
    }

    if (!res.ok) {
      console.warn(`[update-subsidies] ${model.id} HTTP ${res.status}`);
      if (res.status === 404) continue;
      throw new Error(`Gemini APIエラー: HTTP ${res.status} (${data?.error?.message || ''})`);
    }

    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('Geminiのレスポンスが不正なJSONです');
    }

    if (!Array.isArray(parsed?.subsidies)) {
      throw new Error('Geminiレスポンスにsubsidies配列がありません');
    }

    console.log(`[update-subsidies] Gemini成功: ${model.id}, ${parsed.subsidies.length}件`);
    return parsed;
  }

  throw new Error('全Geminiモデルで失敗しました');
}

// ==================== Google JWT / OAuth ====================

function base64url(data) {
  const b = Buffer.isBuffer(data) ? data : Buffer.from(JSON.stringify(data));
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function importPrivateKey(pemKey) {
  const pemBody = pemKey
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const der = Buffer.from(pemBody, 'base64');

  return webcrypto.subtle.importKey(
    'pkcs8',
    der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

async function getGoogleAccessToken(serviceAccount) {
  const { client_email, private_key, token_uri } = serviceAccount;
  const tokenUrl = token_uri || 'https://oauth2.googleapis.com/token';

  const now     = Math.floor(Date.now() / 1000);
  const header  = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: client_email,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: tokenUrl,
    iat: now,
    exp: now + 3600,
  };

  const signingInput = `${base64url(header)}.${base64url(payload)}`;
  const cryptoKey    = await importPrivateKey(private_key);
  const signature    = await webcrypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    Buffer.from(signingInput)
  );
  const jwt = `${signingInput}.${base64url(Buffer.from(signature))}`;

  const tokenRes = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text().catch(() => '');
    throw new Error(`Google OAuthトークン取得失敗: ${tokenRes.status} ${err}`);
  }

  const tokenData = await tokenRes.json();
  return tokenData.access_token;
}

// ==================== Firestore 読み書き ====================

function firestoreUrl(projectId) {
  return `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/hojosearch/shimane`;
}

async function readFirestore(projectId) {
  const res = await fetch(firestoreUrl(projectId), {
    headers: { 'Content-Type': 'application/json' },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    console.warn('[update-subsidies] Firestore読み取りエラー:', res.status);
    return null;
  }

  const doc         = await res.json();
  const dataStr     = doc?.fields?.data?.stringValue;
  const lastUpdated = doc?.fields?.lastUpdated?.timestampValue;
  if (!dataStr) return null;

  try {
    return { ...JSON.parse(dataStr), lastUpdated };
  } catch {
    return null;
  }
}

async function writeFirestore(projectId, accessToken, subsidies, fetchedAt) {
  const now  = new Date().toISOString();
  const body = {
    fields: {
      data:        { stringValue: JSON.stringify({ subsidies, fetchedAt }) },
      lastUpdated: { timestampValue: now },
      count:       { integerValue: String(subsidies.length) },
    },
  };

  const url = `${firestoreUrl(projectId)}?updateMask.fieldPaths=data&updateMask.fieldPaths=lastUpdated&updateMask.fieldPaths=count`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Firestore書き込みエラー: ${res.status} ${errText}`);
  }

  console.log(`[update-subsidies] Firestore書き込み完了: ${subsidies.length}件`);
}

// ==================== メインハンドラー ====================

exports.handler = async (event) => {
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
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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
    console.error('[update-subsidies] 環境変数未設定:', missing);
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

  // ==================== Firestore 読み取り（新鮮なら即返却）====================
  let current = null;
  try {
    current = await readFirestore(projectId);
  } catch (err) {
    console.warn('[update-subsidies] Firestore読み取り失敗（スキップ）:', err.message);
  }

  if (current) {
    const updatedAt = current.lastUpdated ? new Date(current.lastUpdated).getTime() : 0;
    const isStale   = !updatedAt || isNaN(updatedAt) || (Date.now() - updatedAt > STALE_THRESHOLD_MS);

    if (!isStale) {
      console.log('[update-subsidies] Firestoreキャッシュヒット（7日以内）');
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
    console.log('[update-subsidies] Firestoreデータが古い → Gemini再取得');
  } else {
    console.log('[update-subsidies] Firestoreデータなし → 新規取得');
  }

  // ==================== Gemini と OAuth を並列実行（時間短縮の核心）====================
  let geminiResult, accessToken;
  try {
    [geminiResult, accessToken] = await Promise.all([
      fetchFromGemini(geminiKey),
      getGoogleAccessToken(serviceAccount),
    ]);
  } catch (err) {
    console.error('[update-subsidies] 並列取得失敗:', err.message);

    // Geminiは失敗したがOAuthは成功している場合もある。
    // いずれにせよ古いFirestoreデータがあれば返す（graceful degradation）
    if (current?.subsidies) {
      return {
        statusCode: 200,
        headers: { ...headers, 'X-Cache': 'STALE' },
        body: JSON.stringify({
          subsidies:   current.subsidies,
          fetchedAt:   current.fetchedAt,
          lastUpdated: current.lastUpdated,
          source:      'firestore-stale',
          warning:     'データが古い可能性があります（更新に失敗しました）',
        }),
      };
    }

    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ error: `補助金データの取得に失敗しました: ${err.message}` }),
    };
  }

  const fetchedAt = new Date().toISOString();

  // ==================== Firestore 書き込み ====================
  try {
    await writeFirestore(projectId, accessToken, geminiResult.subsidies, fetchedAt);
  } catch (err) {
    console.error('[update-subsidies] Firestore書き込み失敗:', err.message);
    // 書き込み失敗でも取得したデータはクライアントに返す
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
