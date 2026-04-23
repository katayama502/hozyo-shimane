/**
 * netlify/functions/scheduled-update.js
 *
 * 週次cron（毎週月曜 6:00 JST）で Gemini → Firestore を自動更新。
 * ユーザーは常に Firestore から瞬時に取得できる。
 *
 * スケジュール設定: netlify.toml の [functions.scheduled-update] を参照
 *
 * 必要な環境変数:
 *   GEMINI_API_KEY           - Gemini API キー
 *   FIREBASE_PROJECT_ID      - Firebase プロジェクトID
 *   FIREBASE_SERVICE_ACCOUNT - サービスアカウントJSONの全文字列
 */

const { fetchFromGemini, getGoogleAccessToken, writeFirestore } = require('./_shared');

exports.handler = async () => {
  console.log('[scheduled-update] 週次更新開始:', new Date().toISOString());

  const geminiKey = process.env.GEMINI_API_KEY;
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const saRaw     = process.env.FIREBASE_SERVICE_ACCOUNT;

  if (!geminiKey || !projectId || !saRaw) {
    const missing = [
      !geminiKey ? 'GEMINI_API_KEY' : null,
      !projectId ? 'FIREBASE_PROJECT_ID' : null,
      !saRaw     ? 'FIREBASE_SERVICE_ACCOUNT' : null,
    ].filter(Boolean).join(', ');
    console.error('[scheduled-update] 環境変数未設定:', missing);
    return { statusCode: 500, body: `環境変数未設定: ${missing}` };
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(saRaw);
  } catch {
    console.error('[scheduled-update] FIREBASE_SERVICE_ACCOUNT のJSON形式が不正');
    return { statusCode: 500, body: 'FIREBASE_SERVICE_ACCOUNT のJSON形式が不正です' };
  }

  // Gemini呼び出しとOAuthトークン取得を並列実行
  let geminiResult, accessToken;
  try {
    [geminiResult, accessToken] = await Promise.all([
      fetchFromGemini(geminiKey),
      getGoogleAccessToken(serviceAccount),
    ]);
  } catch (err) {
    console.error('[scheduled-update] 並列取得失敗:', err.message);
    return { statusCode: 502, body: `取得失敗: ${err.message}` };
  }

  const fetchedAt = new Date().toISOString();

  try {
    await writeFirestore(projectId, accessToken, geminiResult.subsidies, fetchedAt);
  } catch (err) {
    console.error('[scheduled-update] Firestore書き込み失敗:', err.message);
    return { statusCode: 502, body: `Firestore書き込み失敗: ${err.message}` };
  }

  console.log(`[scheduled-update] 週次更新完了: ${geminiResult.subsidies.length}件`);
  return { statusCode: 200, body: `更新完了: ${geminiResult.subsidies.length}件` };
};
