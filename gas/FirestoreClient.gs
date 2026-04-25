/**
 * FirestoreClient.gs
 * Firebase Firestore 読み書き（サービスアカウント JWT 認証）
 *
 * GAS の Utilities.computeRsaSha256Signature() を使って
 * RS256 JWT を生成し、Google OAuth アクセストークンを取得する。
 */

// ==================== OAuth アクセストークン ====================

/**
 * サービスアカウントJWTでGoogle OAuthトークンを取得
 * @returns {string} アクセストークン
 */
function getGoogleAccessToken() {
  var sa = getServiceAccount();
  var tokenUrl = sa.token_uri || 'https://oauth2.googleapis.com/token';
  var now = Math.floor(Date.now() / 1000);

  var header  = { alg: 'RS256', typ: 'JWT' };
  var payload = {
    iss:   sa.client_email,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud:   tokenUrl,
    iat:   now,
    exp:   now + 3600,
  };

  var signingInput = base64url(JSON.stringify(header)) + '.' + base64url(JSON.stringify(payload));

  // GAS 組み込み関数で RSA-SHA256 署名
  var signatureBytes = Utilities.computeRsaSha256Signature(signingInput, sa.private_key);
  var jwt = signingInput + '.' + base64urlFromBytes(signatureBytes);

  var response = UrlFetchApp.fetch(tokenUrl, {
    method: 'POST',
    payload: {
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    },
    muteHttpExceptions: true,
  });

  if (response.getResponseCode() !== 200) {
    throw new Error('OAuthトークン取得失敗: ' + response.getContentText().substring(0, 200));
  }

  return JSON.parse(response.getContentText()).access_token;
}

// ==================== Firestore 読み書き ====================

/**
 * Firestore からデータを読み取る（公開ルール・認証不要）
 * @returns {Object|null}
 */
function readFirestore() {
  var projectId = getProjectId();
  var url = buildFirestoreUrl(projectId);

  var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  var code = response.getResponseCode();

  if (code === 404) return null;
  if (code !== 200) {
    console.warn('Firestore読み取りエラー: HTTP ' + code);
    return null;
  }

  var doc = JSON.parse(response.getContentText());
  var dataStr     = doc && doc.fields && doc.fields.data && doc.fields.data.stringValue;
  var lastUpdated = doc && doc.fields && doc.fields.lastUpdated && doc.fields.lastUpdated.timestampValue;
  if (!dataStr) return null;

  try {
    var parsed = JSON.parse(dataStr);
    parsed.lastUpdated = lastUpdated;
    return parsed;
  } catch (e) {
    return null;
  }
}

/**
 * Firestore にデータを書き込む（サービスアカウント認証必須）
 * @param {string} accessToken
 * @param {Array}  subsidies
 * @param {string} fetchedAt
 */
function writeFirestore(accessToken, subsidies, fetchedAt) {
  var projectId = getProjectId();
  var now = new Date().toISOString();
  var url = buildFirestoreUrl(projectId) +
    '?updateMask.fieldPaths=data&updateMask.fieldPaths=lastUpdated&updateMask.fieldPaths=count';

  var body = {
    fields: {
      data:        { stringValue: JSON.stringify({ subsidies: subsidies, fetchedAt: fetchedAt }) },
      lastUpdated: { timestampValue: now },
      count:       { integerValue: String(subsidies.length) },
    },
  };

  var response = UrlFetchApp.fetch(url, {
    method: 'PATCH',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + accessToken },
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });

  if (response.getResponseCode() !== 200) {
    throw new Error('Firestore書き込みエラー: ' + response.getContentText().substring(0, 200));
  }

  console.log('Firestore書き込み完了: ' + subsidies.length + '件');
}

// ==================== ユーティリティ ====================

function buildFirestoreUrl(projectId) {
  return 'https://firestore.googleapis.com/v1/projects/' + projectId +
    '/databases/(default)/documents/' + FIRESTORE_DOC_PATH;
}

function getServiceAccount() {
  var raw = PropertiesService.getScriptProperties().getProperty('FIREBASE_SERVICE_ACCOUNT');
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT が未設定です');
  return JSON.parse(raw);
}

function getProjectId() {
  var id = PropertiesService.getScriptProperties().getProperty('FIREBASE_PROJECT_ID');
  if (!id) throw new Error('FIREBASE_PROJECT_ID が未設定です');
  return id;
}

function base64url(str) {
  return Utilities.base64EncodeWebSafe(str).replace(/=+$/, '');
}

function base64urlFromBytes(bytes) {
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
}
