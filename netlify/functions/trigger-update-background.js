/**
 * netlify/functions/trigger-update-background.js
 *
 * Netlify Background Function — タイムアウトなし（最大15分）
 *
 * クライアントはこの関数を呼び出すと即座に 202 を受け取る。
 * 関数はバックグラウンドで Gemini → Firestore 書き込みを実行する。
 * クライアントは Firestore をポーリングして結果を待つ。
 *
 * ファイル名の "-background" サフィックスが Netlify に Background Function
 * として認識させるシグナル（設定不要）。
 */

const { SCRAPE_URLS, scrapePages, fetchFromGemini, getGoogleAccessToken, readFirestore, writeFirestore } = require('./_shared');

exports.handler = async () => {
  console.log('[trigger-update] バックグラウンド更新開始:', new Date().toISOString());

  const geminiKey = process.env.GEMINI_API_KEY;
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const saRaw     = process.env.FIREBASE_SERVICE_ACCOUNT;

  if (!geminiKey || !projectId || !saRaw) {
    console.error('[trigger-update] 環境変数未設定');
    return;
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(saRaw);
  } catch {
    console.error('[trigger-update] FIREBASE_SERVICE_ACCOUNT のJSON形式が不正');
    return;
  }

  // 既にデータが存在する場合はスキップ（二重更新防止）
  try {
    const current = await readFirestore(projectId);
    if (current?.subsidies?.length > 0) {
      const updatedAt = current.lastUpdated ? new Date(current.lastUpdated).getTime() : 0;
      const ageMs     = Date.now() - updatedAt;
      // 1時間以内に更新済みなら何もしない
      if (ageMs < 60 * 60 * 1000) {
        console.log('[trigger-update] 1時間以内に更新済みのためスキップ');
        return;
      }
    }
  } catch (err) {
    console.warn('[trigger-update] Firestore確認失敗（続行）:', err.message);
  }

  // 益田市公式サイトをスクレイピング + OAuth取得を並列実行
  let scrapedContent, accessToken;
  try {
    [scrapedContent, accessToken] = await Promise.all([
      scrapePages(SCRAPE_URLS),
      getGoogleAccessToken(serviceAccount),
    ]);
    console.log(`[trigger-update] スクレイピング完了 (${scrapedContent.length}文字)`);
  } catch (err) {
    console.error('[trigger-update] 前処理失敗:', err.message);
    scrapedContent = '';
  }

  // スクレイピング結果をもとにGeminiで構造化
  let geminiResult;
  try {
    geminiResult = await fetchFromGemini(geminiKey, scrapedContent);
  } catch (err) {
    console.error('[trigger-update] Gemini失敗:', err.message);
    return;
  }

  const fetchedAt = new Date().toISOString();

  try {
    await writeFirestore(projectId, accessToken, geminiResult.subsidies, fetchedAt);
    console.log(`[trigger-update] 完了: ${geminiResult.subsidies.length}件, ${fetchedAt}`);
  } catch (err) {
    console.error('[trigger-update] Firestore書き込み失敗:', err.message);
  }
};
