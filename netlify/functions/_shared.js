/**
 * netlify/functions/_shared.js
 * scheduled-update.js / trigger-update-background.js 共通ロジック
 *
 * データ取得フロー:
 *   1. jGrants API（国の公式補助金DB）から島根・益田キーワードで取得
 *   2. 締切済みを除外してアプリスキーマに変換
 *   3. Firestore (hojosearch/masuda) に保存
 *
 * 週次スケジュール: netlify.toml の schedule = "0 21 * * 0" を参照
 */

const { webcrypto } = require('node:crypto');

const FIRESTORE_DOC_PATH = 'hojosearch/masuda';

// ==================== jGrants API ====================

const JGRANTS_BASE = 'https://api.jgrants-portal.go.jp/exp/v1/public/subsidies';

// 検索クエリ定義（島根県・益田市関連を幅広く取得）
const JGRANTS_QUERIES = [
  { keyword: '島根', sort: 'acceptance_end_datetime', order: 'ASC', acceptance: '0', limit: '50' },
  { keyword: '益田', sort: 'acceptance_end_datetime', order: 'ASC', acceptance: '0', limit: '20' },
];

/**
 * jGrants API から補助金一覧を取得する
 * @returns {{ subsidies: Array }}
 */
async function fetchFromJGrants() {
  console.log('[jGrants] 取得開始');
  const allItems = [];
  const seenIds  = new Set();

  for (const query of JGRANTS_QUERIES) {
    const params = new URLSearchParams(query);
    try {
      const res = await fetch(`${JGRANTS_BASE}?${params}`, {
        signal: AbortSignal.timeout(15000),
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) {
        console.warn(`[jGrants] HTTP ${res.status} (keyword=${query.keyword})`);
        continue;
      }
      const data  = await res.json();
      const items = data.result || [];
      for (const item of items) {
        if (!seenIds.has(item.id)) {
          seenIds.add(item.id);
          allItems.push(item);
        }
      }
      console.log(`[jGrants] keyword=${query.keyword}: ${items.length}件`);
    } catch (err) {
      console.warn(`[jGrants] 取得失敗 (keyword=${query.keyword}):`, err.message);
    }
  }

  // 締切済みを除外してスキーマ変換
  const now       = new Date();
  const subsidies = allItems
    .filter(item => {
      if (!item.acceptance_end_datetime) return true;
      return new Date(item.acceptance_end_datetime) >= now;
    })
    .map(mapJGrantsToSubsidy);

  console.log(`[jGrants] 完了: ${subsidies.length}件（期限切れ除外済み）`);
  return { subsidies };
}

/** jGrants アイテムをアプリスキーマに変換 */
function mapJGrantsToSubsidy(item) {
  const now     = new Date();
  const startDt = item.acceptance_start_datetime ? new Date(item.acceptance_start_datetime) : null;
  const endDt   = item.acceptance_end_datetime   ? new Date(item.acceptance_end_datetime)   : null;

  let status = '受付中';
  if (endDt && endDt < now)         status = '終了';
  else if (startDt && startDt > now) status = '受付予定';

  return {
    id:                `jg-${item.id}`,
    title:             item.title || item.name || '',
    simpleDescription: (item.title || '').slice(0, 60),
    description:       _buildJGrantsDesc(item),
    category:          _guessCategoryFromTitle(item.title || ''),
    targetUsers:       _parseTargetUsers(item.target_number_of_employees),
    maxAmount:         Number(item.subsidy_max_limit) || 0,
    deadline:          endDt ? endDt.toISOString().slice(0, 10) : null,
    issuer:            _guessIssuer(item.target_area_search),
    region:            item.target_area_search || '全国',
    applicationUrl:    `https://jgrants-portal.go.jp/subsidy/${item.id}`,
    requirements:      item.target_number_of_employees || '',
    status,
  };
}

function _buildJGrantsDesc(item) {
  const parts = [];
  if (item.title)                       parts.push(item.title);
  if (item.target_area_search)          parts.push(`対象地域: ${item.target_area_search}`);
  if (item.target_number_of_employees)  parts.push(`対象: ${item.target_number_of_employees}`);
  return parts.join('。').slice(0, 200);
}

function _guessCategoryFromTitle(title) {
  if (/農業|林業|水産|漁業|畜産|農林|木材|森林/.test(title))         return '農業・林業・水産業';
  if (/移住|定住|空き家|UIターン/.test(title))                        return '移住・定住支援';
  if (/子育て|育児|保育|教育|学校|奨学/.test(title))                  return '子育て・教育';
  if (/住宅|リフォーム|改修|耐震|建築|建設/.test(title))              return '住宅・リフォーム';
  if (/IT|DX|デジタル|ICT|システム|ソフトウェア|クラウド/.test(title)) return 'ITデジタル化';
  if (/創業|起業|スタートアップ|新事業/.test(title))                   return '中小企業・創業支援';
  if (/中小企業|小規模事業|事業継続|経営/.test(title))                 return '中小企業・創業支援';
  return 'その他';
}

function _guessIssuer(targetArea) {
  if (!targetArea || targetArea === '全国') return '国';
  if (targetArea.includes('益田'))          return '益田市';
  if (targetArea.includes('島根'))          return '島根県';
  return '国';
}

function _parseTargetUsers(targetEmployees) {
  if (!targetEmployees || targetEmployees.includes('制約なし'))
    return ['すべての企業', '個人事業主'];
  return ['中小企業', '個人事業主'];
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
  fetchFromJGrants,
  getGoogleAccessToken,
  readFirestore,
  writeFirestore,
};
