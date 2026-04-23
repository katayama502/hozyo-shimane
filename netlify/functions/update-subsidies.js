/**
 * netlify/functions/update-subsidies.js
 *
 * Firebase Firestore への補助金データ週次更新関数。
 *
 * フロー:
 *   1. Firestore から現在のデータを読み取る（公開エンドポイント）
 *   2. データが新鮮（7日以内）なら即座にクライアントへ返す
 *   3. データが古い（7日超）or 未作成なら：
 *      a. Gemini API で15件の補助金データを生成
 *      b. サービスアカウント JWT（RS256）でGoogle OAuth トークンを取得
 *      c. Firestore にデータを書き込む
 *      d. 最新データをクライアントへ返す
 *
 * 必要な環境変数（Netlify）:
 *   GEMINI_API_KEY         - Gemini API キー
 *   FIREBASE_PROJECT_ID    - Firebase プロジェクトID
 *   FIREBASE_SERVICE_ACCOUNT - サービスアカウントJSONの全文字列
 */

const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // 7日
const GEMINI_TIMEOUT_MS  = 8000;                      // Netlify 10s枠に対して8s
const GEMINI_BASE_URL    = 'https://generativelanguage.googleapis.com/v1beta/models';

const GEMINI_MODELS = [
  { id: 'gemini-2.5-flash' },
  { id: 'gemini-2.0-flash' },
  { id: 'gemini-1.5-flash' },
];

// ==================== Gemini呼び出し ====================

function buildSubsidyPrompt() {
  return `
あなたは島根県の補助金・助成金制度に精通した専門家です。
2026年現在、島根県内で申請可能または近日中に申請受付が予定されている補助金・助成金・支援制度を15件リストアップしてください。

以下のカテゴリから各2〜3件を目安に選んでください：
- 農業・林業・水産業
- 中小企業・創業支援
- 移住・定住支援
- 子育て・教育
- 住宅・リフォーム
- ITデジタル化

国の補助金で島根県民も対象になるものも含めてください（例：ものづくり補助金、IT導入補助金等）。

以下のJSON形式のみで返してください（説明文・マークダウン等は一切不要）：

{
  "subsidies": [
    {
      "id": "shimane-001",
      "title": "補助金・助成金の正式名称",
      "simpleDescription": "一般の方にわかりやすい説明（60文字以内）",
      "description": "補助金の詳細説明（200文字以内）",
      "category": "農業・林業・水産業",
      "targetUsers": ["農業従事者", "新規就農者"],
      "maxAmount": 1000000,
      "deadline": "2026-06-30",
      "issuer": "島根県",
      "region": "島根県全域",
      "applicationUrl": "https://www.pref.shimane.lg.jp/",
      "requirements": "主な申請条件（100文字以内）",
      "status": "受付中"
    }
  ]
}

フィールド説明：
- id: "shimane-" + 連番3桁（例: shimane-001）
- category: "農業・林業・水産業" / "中小企業・創業支援" / "移住・定住支援" / "子育て・教育" / "住宅・リフォーム" / "ITデジタル化" / "その他" のいずれか
- targetUsers: 対象者の配列（例: ["中小企業", "個人事業主"]）
- maxAmount: 補助上限額（円・数値）。不明または上限なしの場合は 0
- deadline: ISO日付形式 "YYYY-MM-DD"。不明・常時受付の場合は null
- issuer: "島根県" / "松江市" / "出雲市" / "国" など発行元
- region: "島根県全域" または具体的な市町村名
- applicationUrl: 公式ページURL（不明の場合は発行元の公式サイト）
- status: "受付中" / "受付予定" / "終了" のいずれか

注意：
- maxAmountは必ず数値（文字列不可）
- 実在する・実在する可能性が高い制度のみを記載
- 終了済みの制度は除外するか status: "終了" を設定
`;
}

async function callGemini(modelId, prompt, apiKey) {
  const url = `${GEMINI_BASE_URL}/${modelId}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 3000,
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
      const e = new Error('timeout');
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
      console.warn(`[update-subsidies] ${model.id} エラー:`, err.message);
      continue;
    }

    if (!res.ok) {
      console.warn(`[update-subsidies] ${model.id} HTTP ${res.status}`);
      if (res.status === 404) continue; // モデル未発見 → 次へ
      throw new Error(`Gemini API エラー: HTTP ${res.status}`);
    }

    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('Gemini のレスポンスが不正なJSONです');
    }

    if (!Array.isArray(parsed?.subsidies)) {
      throw new Error('Gemini レスポンスに subsidies 配列がありません');
    }

    console.log(`[update-subsidies] Gemini 成功: ${model.id}, ${parsed.subsidies.length}件`);
    return parsed;
  }

  throw new Error('全Geminiモデルで失敗しました');
}

// ==================== Google JWT / OAuth ====================

/**
 * Base64URL エンコード（Node.js Buffer）
 */
function base64url(data) {
  const b = Buffer.isBuffer(data) ? data : Buffer.from(JSON.stringify(data));
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * サービスアカウントの秘密鍵（PEM）を CryptoKey にインポートする
 * Node.js 18+ の crypto.subtle（WebCrypto）を使用
 */
async function importPrivateKey(pemKey) {
  // PEM ヘッダー・フッターと改行を除去して DER バイナリに変換
  const pemBody = pemKey
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const der = Buffer.from(pemBody, 'base64');

  const { webcrypto } = await import('node:crypto');
  return webcrypto.subtle.importKey(
    'pkcs8',
    der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

/**
 * RS256 JWT を署名して Google OAuth2 アクセストークンを取得
 */
async function getGoogleAccessToken(serviceAccount) {
  const { client_email, private_key, token_uri } = serviceAccount;
  const tokenUrl = token_uri || 'https://oauth2.googleapis.com/token';

  const now    = Math.floor(Date.now() / 1000);
  const header  = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: client_email,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: tokenUrl,
    iat: now,
    exp: now + 3600,
  };

  const signingInput = `${base64url(header)}.${base64url(payload)}`;

  const cryptoKey = await importPrivateKey(private_key);
  const { webcrypto } = await import('node:crypto');
  const signature = await webcrypto.subtle.sign(
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
    throw new Error(`Google OAuth トークン取得失敗: ${tokenRes.status} ${err}`);
  }

  const tokenData = await tokenRes.json();
  return tokenData.access_token;
}

// ==================== Firestore 読み書き ====================

function firestoreUrl(projectId) {
  return `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/hojosearch/shimane`;
}

/**
 * Firestore からデータを読み取る（認証不要・公開ルール前提）
 */
async function readFirestore(projectId) {
  const res = await fetch(firestoreUrl(projectId), {
    headers: { 'Content-Type': 'application/json' },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    console.warn('[update-subsidies] Firestore 読み取りエラー:', res.status);
    return null;
  }

  const doc = await res.json();
  const dataStr     = doc?.fields?.data?.stringValue;
  const lastUpdated = doc?.fields?.lastUpdated?.timestampValue;
  if (!dataStr) return null;

  try {
    const parsed = JSON.parse(dataStr);
    return { ...parsed, lastUpdated };
  } catch {
    return null;
  }
}

/**
 * Firestore にデータを書き込む（サービスアカウント認証必須）
 */
async function writeFirestore(projectId, accessToken, subsidies, fetchedAt) {
  const payload = { subsidies, fetchedAt };
  const now     = new Date().toISOString();

  const body = {
    fields: {
      data:        { stringValue: JSON.stringify(payload) },
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
    throw new Error(`Firestore 書き込みエラー: ${res.status} ${errText}`);
  }

  console.log(`[update-subsidies] Firestore 書き込み完了: ${subsidies.length}件`);
}

// ==================== メインハンドラー ====================

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
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };

  // ==================== 環境変数チェック ====================
  const geminiKey    = process.env.GEMINI_API_KEY;
  const projectId    = process.env.FIREBASE_PROJECT_ID;
  const saRaw        = process.env.FIREBASE_SERVICE_ACCOUNT;

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
  let current;
  try {
    current = await readFirestore(projectId);
  } catch (err) {
    console.warn('[update-subsidies] Firestore 読み取り失敗（スキップ）:', err.message);
    current = null;
  }

  if (current) {
    const lastUpdated = current.lastUpdated;
    const updatedAt   = lastUpdated ? new Date(lastUpdated).getTime() : 0;
    const isStale     = !updatedAt || isNaN(updatedAt) || (Date.now() - updatedAt > STALE_THRESHOLD_MS);

    if (!isStale) {
      console.log('[update-subsidies] Firestore キャッシュヒット（7日以内）');
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
    console.log('[update-subsidies] Firestore データが古い → Gemini 再取得');
  } else {
    console.log('[update-subsidies] Firestore データなし → 新規取得');
  }

  // ==================== Gemini でデータ取得 ====================
  let geminiResult;
  try {
    geminiResult = await fetchFromGemini(geminiKey);
  } catch (err) {
    console.error('[update-subsidies] Gemini 取得失敗:', err.message);

    // Gemini 失敗時: 古いFirestoreデータがあれば返す（graceful degradation）
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
    const accessToken = await getGoogleAccessToken(serviceAccount);
    await writeFirestore(projectId, accessToken, geminiResult.subsidies, fetchedAt);
  } catch (err) {
    console.error('[update-subsidies] Firestore 書き込み失敗:', err.message);
    // 書き込み失敗でも取得したデータは返す（クライアントにはlocalStorageキャッシュで対応）
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
