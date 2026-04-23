/**
 * netlify/functions/_shared.js
 * scheduled-update.js / update-subsidies.js 共通ロジック
 */

const { webcrypto } = require('node:crypto');

const GEMINI_TIMEOUT_MS = 20000;
const GEMINI_BASE_URL   = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_MODELS     = [
  { id: 'gemini-2.5-flash' },
  { id: 'gemini-2.0-flash' },
];

const FIRESTORE_DOC_PATH = 'hojosearch/masuda';

// ==================== プロンプト ====================

function buildSubsidyPrompt() {
  return `あなたは島根県益田市の補助金・助成金制度に精通した専門家です。
2026年現在、島根県益田市の市民・事業者が申請可能または近日中に申請受付が予定されている補助金・助成金・支援制度を25件リストアップしてください。

優先順位：1)益田市独自の制度 2)島根県の制度（益田市民対象） 3)国の制度（益田市民も対象：ものづくり補助金・IT導入補助金等）
カテゴリから各3〜5件：農業・林業・水産業、中小企業・創業支援、移住・定住支援、子育て・教育、住宅・リフォーム、ITデジタル化

以下のJSON形式のみで返してください（説明文・マークダウン等は一切不要）：

{"subsidies":[{"id":"masuda-001","title":"補助金の正式名称","simpleDescription":"わかりやすい説明60文字以内","description":"詳細説明200文字以内","category":"農業・林業・水産業","targetUsers":["農業従事者"],"maxAmount":1000000,"deadline":"2026-06-30","issuer":"益田市","region":"益田市","applicationUrl":"https://www.city.masuda.lg.jp/","requirements":"申請条件100文字以内","status":"受付中"}]}

フィールド: id=masuda-連番3桁, category="農業・林業・水産業"/"中小企業・創業支援"/"移住・定住支援"/"子育て・教育"/"住宅・リフォーム"/"ITデジタル化"/"その他", issuer="益田市"/"島根県"/"国", maxAmount=数値(不明は0), deadline=YYYY-MM-DD or null, status="受付中"/"受付予定"/"終了"`;
}

// ==================== Gemini ====================

async function callGemini(modelId, prompt, apiKey) {
  const url = `${GEMINI_BASE_URL}/${modelId}:generateContent?key=${apiKey}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 4096,
          responseMimeType: 'application/json',
        },
      }),
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
      console.warn(`[shared] ${model.id} 失敗:`, err.message);
      continue;
    }

    if (!res.ok) {
      console.warn(`[shared] ${model.id} HTTP ${res.status}`);
      if (res.status === 404) continue;
      throw new Error(`Gemini APIエラー: HTTP ${res.status}`);
    }

    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    let parsed;
    try { parsed = JSON.parse(text); }
    catch { throw new Error('GeminiのレスポンスがJSONではありません'); }

    if (!Array.isArray(parsed?.subsidies)) {
      throw new Error('Geminiレスポンスにsubsidies配列がありません');
    }

    console.log(`[shared] Gemini成功: ${model.id}, ${parsed.subsidies.length}件`);
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
  return webcrypto.subtle.importKey(
    'pkcs8',
    Buffer.from(pemBody, 'base64'),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

async function getGoogleAccessToken(serviceAccount) {
  const { client_email, private_key, token_uri } = serviceAccount;
  const tokenUrl = token_uri || 'https://oauth2.googleapis.com/token';
  const now      = Math.floor(Date.now() / 1000);

  const signingInput = `${base64url({ alg: 'RS256', typ: 'JWT' })}.${base64url({
    iss: client_email,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: tokenUrl,
    iat: now,
    exp: now + 3600,
  })}`;

  const cryptoKey = await importPrivateKey(private_key);
  const signature = await webcrypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    Buffer.from(signingInput)
  );
  const jwt = `${signingInput}.${base64url(Buffer.from(signature))}`;

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  if (!res.ok) {
    throw new Error(`Google OAuthトークン取得失敗: ${res.status} ${await res.text().catch(() => '')}`);
  }

  return (await res.json()).access_token;
}

// ==================== Firestore ====================

function firestoreUrl(projectId) {
  return `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${FIRESTORE_DOC_PATH}`;
}

async function readFirestore(projectId) {
  const res = await fetch(firestoreUrl(projectId));
  if (res.status === 404) return null;
  if (!res.ok) {
    console.warn('[shared] Firestore読み取りエラー:', res.status);
    return null;
  }
  const doc         = await res.json();
  const dataStr     = doc?.fields?.data?.stringValue;
  const lastUpdated = doc?.fields?.lastUpdated?.timestampValue;
  if (!dataStr) return null;

  try { return { ...JSON.parse(dataStr), lastUpdated }; }
  catch { return null; }
}

async function writeFirestore(projectId, accessToken, subsidies, fetchedAt) {
  const now = new Date().toISOString();
  const url = `${firestoreUrl(projectId)}?updateMask.fieldPaths=data&updateMask.fieldPaths=lastUpdated&updateMask.fieldPaths=count`;

  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      fields: {
        data:        { stringValue: JSON.stringify({ subsidies, fetchedAt }) },
        lastUpdated: { timestampValue: now },
        count:       { integerValue: String(subsidies.length) },
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`Firestore書き込みエラー: ${res.status} ${await res.text().catch(() => '')}`);
  }
  console.log(`[shared] Firestore書き込み完了: ${subsidies.length}件`);
}

module.exports = { fetchFromGemini, getGoogleAccessToken, readFirestore, writeFirestore };
