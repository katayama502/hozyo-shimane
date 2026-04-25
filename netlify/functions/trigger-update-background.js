/**
 * netlify/functions/trigger-update-background.js
 *
 * Netlify Background Function — タイムアウトなし（最大15分）
 *
 * データ取得フロー:
 *   1. jGrants API で島根県・益田市の補助金を取得
 *   2. Firestore に保存
 *
 * ファイル名の "-background" サフィックスが Netlify に Background Function
 * として認識させるシグナル（設定不要）。
 */

const {
  fetchFromJGrants,
  getGoogleAccessToken,
  readFirestore,
  writeFirestore,
} = require('./_shared');

exports.handler = async () => {
  console.log('[trigger-update] バックグラウンド更新開始:', new Date().toISOString());

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const saRaw     = process.env.FIREBASE_SERVICE_ACCOUNT;

  if (!projectId || !saRaw) {
    console.error('[trigger-update] 環境変数未設定 (FIREBASE_PROJECT_ID / FIREBASE_SERVICE_ACCOUNT)');
    return;
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(saRaw);
  } catch {
    console.error('[trigger-update] FIREBASE_SERVICE_ACCOUNT のJSON形式が不正');
    return;
  }

  // 1時間以内に更新済みならスキップ
  try {
    const current = await readFirestore(projectId);
    if (current?.subsidies?.length > 0) {
      const ageMs = Date.now() - new Date(current.lastUpdated || 0).getTime();
      if (ageMs < 60 * 60 * 1000) {
        console.log('[trigger-update] 1時間以内に更新済みのためスキップ');
        return;
      }
    }
  } catch (err) {
    console.warn('[trigger-update] Firestore確認失敗（続行）:', err.message);
  }

  // jGrants 取得 と OAuth を並列実行
  let jGrantsResult, accessToken;
  try {
    [jGrantsResult, accessToken] = await Promise.all([
      fetchFromJGrants(),
      getGoogleAccessToken(serviceAccount),
    ]);
  } catch (err) {
    console.error('[trigger-update] 取得失敗:', err.message);
    return;
  }

  if (jGrantsResult.subsidies.length === 0) {
    console.error('[trigger-update] jGrants 取得件数0件 → 保存をスキップ');
    return;
  }

  // Firestore 保存
  const fetchedAt = new Date().toISOString();
  try {
    await writeFirestore(projectId, accessToken, jGrantsResult.subsidies, fetchedAt);
    console.log(`[trigger-update] 完了: ${jGrantsResult.subsidies.length}件, ${fetchedAt}`);
  } catch (err) {
    console.error('[trigger-update] Firestore書き込み失敗:', err.message);
  }
};
