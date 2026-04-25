/**
 * netlify/functions/_shared.js
 * scheduled-update.js / trigger-update-background.js 共通ロジック
 *
 * データ取得フロー:
 *   1. カテゴリグループ3種（各10件）を並列で Gemini Search Grounding に問い合わせ
 *      - group-1: 農業・林業・水産業 / 中小企業・創業支援
 *      - group-2: 移住・定住支援 / 子育て・教育 / 住宅・リフォーム
 *      - group-3: ITデジタル化 / その他
 *   2. 3グループの結果をマージ・重複除去（最大30件）
 *   3. ID を masuda-001〜 で採番し直して Firestore に保存
 *
 * ※ スクレイピングは補助的な位置づけ。失敗しても Search Grounding で続行。
 * ※ 1グループ失敗しても他グループの結果で続行。
 */

const { webcrypto } = require('node:crypto');

const GEMINI_TIMEOUT_MS = 55000; // Search Grounding は応答に時間がかかる
const GEMINI_BASE_URL   = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_MODELS     = [
  { id: 'gemini-2.5-flash' },
  { id: 'gemini-2.0-flash' },
];

const FIRESTORE_DOC_PATH = 'hojosearch/masuda';

// ==================== スクレイピング対象URL ====================
// 益田市公式サイトの補助金ページを網羅
const SCRAPE_URLS = [
  // 産業支援センター - 創業・新事業
  'https://www.city.masuda.lg.jp/soshikikarasagasu/sangyokeizaibu/sangyoshiencenter/6/1/12035.html',
  'https://www.city.masuda.lg.jp/soshikikarasagasu/sangyokeizaibu/sangyoshiencenter/6/1/12036.html',
  'https://www.city.masuda.lg.jp/soshikikarasagasu/sangyokeizaibu/sangyoshiencenter/6/1/2142.html',
  // 産業支援センター - 中小企業
  'https://www.city.masuda.lg.jp/soshikikarasagasu/sangyokeizaibu/sangyoshiencenter/6/2/9513.html',
  // その他事業支援
  'https://www.city.masuda.lg.jp/soshikikarasagasu/sangyokeizaibu/sangyoshiencenter/6/7659.html',
  'https://www.city.masuda.lg.jp/soshikikarasagasu/sangyokeizaibu/sangyoshiencenter/6/6561.html',
  'https://www.city.masuda.lg.jp/soshikikarasagasu/sangyokeizaibu/sangyoshiencenter/6/12076.html',
  // 住宅・リフォーム
  'https://www.city.masuda.lg.jp/soshikikarasagasu/kensetsubu/kenchikuka/6714.html',
  'https://www.city.masuda.lg.jp/soshikikarasagasu/kensetsubu/kenchikuka/6/2953.html',
  // 移住・空き家
  'https://www.city.masuda.lg.jp/soshikikarasagasu/seisakukikakukyoku/chiikishinkouka/3/1241.html',
  'https://www.city.masuda.lg.jp/soshikikarasagasu/seisakukikakukyoku/chiikishinkouka/3/1242.html',
  // 環境・エネルギー
  'https://www.city.masuda.lg.jp/soshikikarasagasu/fukushikankyobu/kankyoeiseika/4/2574.html',
  'https://www.city.masuda.lg.jp/soshikikarasagasu/fukushikankyobu/kankyoeiseika/4/2561.html',
];

// ==================== スクレイピング ====================

/**
 * HTMLからメインテキストを抽出（スクリプト・スタイル・ナビ除去）
 */
function extractText(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&[a-z]+;/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2000); // 1ページあたり最大2000文字
}

/**
 * 複数ページを並列スクレイピング
 * @returns {string} 全ページのテキストを結合した文字列
 */
async function scrapePages(urls) {
  console.log(`[shared] スクレイピング開始: ${urls.length}件`);

  const results = await Promise.allSettled(
    urls.map(async (url) => {
      try {
        const res = await fetch(url, {
          signal: AbortSignal.timeout(8000),
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; HojoSearch-Bot/1.0)',
            'Accept-Language': 'ja,en;q=0.9',
          },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const html = await res.text();
        const text = extractText(html);
        console.log(`[shared] 取得成功: ${url.split('/').slice(-2).join('/')} (${text.length}文字)`);
        return `【ページ: ${url}】\n${text}`;
      } catch (err) {
        console.warn(`[shared] スクレイピング失敗: ${url} - ${err.message}`);
        return null;
      }
    })
  );

  const succeeded = results
    .filter(r => r.status === 'fulfilled' && r.value)
    .map(r => r.value);

  console.log(`[shared] スクレイピング完了: ${succeeded.length}/${urls.length}件成功`);
  return succeeded.join('\n\n');
}

// ==================== カテゴリグループ（分割取得用） ====================

/**
 * 10件ずつ取得するカテゴリグループ定義
 * 各グループが独立した Gemini 呼び出しになるため、
 * 1回あたりの応答が小さくなりタイムアウトしにくい。
 */
const CHUNK_GROUPS = [
  {
    name:       'group-1',
    categories: ['農業・林業・水産業', '中小企業・創業支援'],
    keywords:   '農業 林業 水産業 中小企業 創業 新事業 事業継続',
  },
  {
    name:       'group-2',
    categories: ['移住・定住支援', '子育て・教育', '住宅・リフォーム'],
    keywords:   '移住 定住 空き家 子育て 教育 住宅 リフォーム 改修',
  },
  {
    name:       'group-3',
    categories: ['ITデジタル化', 'その他'],
    keywords:   'ITデジタル化 DX 省エネ 環境 エネルギー 太陽光 その他支援',
  },
];

// ==================== Gemini プロンプト ====================

/**
 * カテゴリグループに特化したプロンプトを生成（10件取得用）
 */
function buildChunkPrompt(group, scrapedContent) {
  const cats = group.categories.join('・');
  const supplement = scrapedContent && scrapedContent.length > 100
    ? `\n\n【補足情報（公式サイトから取得済み）】\n${scrapedContent.slice(0, 4000)}`
    : '';

  return `あなたは島根県益田市の補助金・助成金の専門家です。

【今回の対象カテゴリ】${cats}

以下を検索して「${cats}」に関する補助金情報を収集してください：
- site:city.masuda.lg.jp ${group.keywords}
- 島根県 益田市 ${cats} 補助金 2025 2026
- 国 ${group.keywords} 補助金 助成金${supplement}

収集した情報をもとに、上記カテゴリの補助金・助成金を正確に10件リストアップし、
以下のJSON形式のみで返してください（説明文・マークダウン・コードブロック等は一切不要）：

{"subsidies":[{"id":"masuda-001","title":"補助金の正式名称","simpleDescription":"わかりやすい説明60文字以内","description":"詳細説明200文字以内","category":"${group.categories[0]}","targetUsers":["中小企業","個人事業主"],"maxAmount":1000000,"deadline":"2026-06-30","issuer":"益田市","region":"益田市","applicationUrl":"https://www.city.masuda.lg.jp/","requirements":"申請条件100文字以内","status":"受付中"}]}

フィールド:
- id: masuda-連番3桁（後で採番し直すため仮番号でOK）
- category: 必ず "${group.categories.join('" か "')}" のいずれか
- issuer: "益田市"/"島根県"/"国"
- maxAmount: 数値（不明は0）
- deadline: "YYYY-MM-DD" または null
- status: "受付中"/"受付予定"/"終了"`;
}

/**
 * レスポンステキストからJSONを抽出する
 * Geminiがマークダウンのコードブロックで囲んで返す場合に対応
 */
function extractJson(text) {
  const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) return JSON.parse(codeBlock[1].trim());

  const start = text.indexOf('{');
  const end   = text.lastIndexOf('}');
  if (start !== -1 && end !== -1) return JSON.parse(text.slice(start, end + 1));

  return JSON.parse(text);
}

/**
 * タイトルを正規化して重複判定キーを生成する
 */
function normalizeTitle(title) {
  return String(title)
    .replace(/[\s　・\-－]/g, '')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0))
    .toLowerCase();
}

/**
 * 複数チャンクの結果をマージ・重複除去・ID採番する
 */
function mergeSubsidies(chunks) {
  const seen = new Set();
  const merged = [];

  for (const subsidies of chunks) {
    for (const s of subsidies) {
      const key = normalizeTitle(s.title);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(s);
    }
  }

  // ID を masuda-001, 002 … と採番し直す
  return merged.map((s, i) => ({
    ...s,
    id: `masuda-${String(i + 1).padStart(3, '0')}`,
  }));
}

// ==================== Gemini API ====================

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
        // Google Search Grounding: Gemini自身がGoogleを検索してリアルデータを取得
        // ※ tools使用時は responseMimeType: 'application/json' は指定不可
        tools: [{ google_search: {} }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 2048, // 10件なので 4096 より小さくて十分
        },
      }),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  } catch (err) {
    if (err.name === 'AbortError') {
      const e = new Error(`Geminiタイムアウト (${modelId})`);
      e.isTimeout = true;
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 単一グループ・単一モデルで Gemini を呼び出し、subsidies 配列を返す
 */
async function fetchGroupSubsidies(group, scrapedContent, apiKey) {
  const prompt = buildChunkPrompt(group, scrapedContent);

  for (const model of GEMINI_MODELS) {
    let res, data;
    try {
      ({ res, data } = await callGemini(model.id, prompt, apiKey));
    } catch (err) {
      console.warn(`[shared] ${group.name} ${model.id} 失敗:`, err.message);
      continue;
    }

    if (!res.ok) {
      console.warn(`[shared] ${group.name} ${model.id} HTTP ${res.status}`);
      if (res.status === 404) continue;
      // レート制限の場合は少し待ってリトライ
      if (res.status === 429) {
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }
      throw new Error(`Gemini APIエラー: HTTP ${res.status} (${group.name})`);
    }

    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    let parsed;
    try { parsed = extractJson(text); }
    catch {
      console.warn(`[shared] ${group.name} JSON解析失敗:`, text.slice(0, 200));
      continue;
    }

    if (!Array.isArray(parsed?.subsidies)) {
      console.warn(`[shared] ${group.name} subsidies配列なし`);
      continue;
    }

    console.log(`[shared] ${group.name} 取得成功: ${model.id}, ${parsed.subsidies.length}件`);
    return parsed.subsidies;
  }

  console.warn(`[shared] ${group.name} 全モデル失敗 → このグループはスキップ`);
  return [];
}

/**
 * 全グループを並列で取得し、マージして返す
 * 3グループ × 10件 = 最大30件（重複除去後）
 */
async function fetchFromGemini(apiKey, scrapedContent = '') {
  console.log(`[shared] 分割取得開始: ${CHUNK_GROUPS.length}グループ並列`);

  // 全グループを並列実行（失敗しても他グループで続行）
  const results = await Promise.allSettled(
    CHUNK_GROUPS.map(group => fetchGroupSubsidies(group, scrapedContent, apiKey))
  );

  const chunks = results.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    console.warn(`[shared] ${CHUNK_GROUPS[i].name} Promise失敗:`, r.reason?.message);
    return [];
  });

  const totalRaw = chunks.reduce((n, c) => n + c.length, 0);
  console.log(`[shared] 分割取得完了: 合計 ${totalRaw} 件（重複除去前）`);

  if (totalRaw === 0) {
    throw new Error('全グループで取得件数が0件でした');
  }

  const subsidies = mergeSubsidies(chunks);
  console.log(`[shared] マージ後: ${subsidies.length} 件（重複除去済み）`);

  return { subsidies };
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
  const signature = await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, Buffer.from(signingInput));
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
  if (!res.ok) { console.warn('[shared] Firestore読み取りエラー:', res.status); return null; }

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
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      fields: {
        data:        { stringValue: JSON.stringify({ subsidies, fetchedAt }) },
        lastUpdated: { timestampValue: now },
        count:       { integerValue: String(subsidies.length) },
      },
    }),
  });

  if (!res.ok) throw new Error(`Firestore書き込みエラー: ${res.status} ${await res.text().catch(() => '')}`);
  console.log(`[shared] Firestore書き込み完了: ${subsidies.length}件`);
}

module.exports = {
  SCRAPE_URLS,
  scrapePages,
  fetchFromGemini,
  getGoogleAccessToken,
  readFirestore,
  writeFirestore,
};
