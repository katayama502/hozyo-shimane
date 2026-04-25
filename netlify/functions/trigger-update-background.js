/**
 * netlify/functions/trigger-update-background.js
 *
 * Netlify Background Function — タイムアウトなし（最大15分）
 *
 * データ取得フロー:
 *   1. jGrants API     → 島根県・国の補助金（公式・構造化データ）
 *   2. Gemini Search   → 益田市独自の補助金（jGrantsにない分を補完）
 *   3. マージ・重複除去 → Firestore に保存
 *
 * ファイル名の "-background" サフィックスが Netlify に Background Function
 * として認識させるシグナル（設定不要）。
 */

const {
  SCRAPE_URLS,
  scrapePages,
  fetchFromJGrants,
  fetchFromGemini,
  mergeSubsidies,
  getGoogleAccessToken,
  readFirestore,
  writeFirestore,
} = require('./_shared');

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

  // ── フェーズ1: jGrants / スクレイピング / OAuth を並列実行 ──────────────
  let jGrantsResult = { subsidies: [] };
  let scrapedContent = '';
  let accessToken;

  try {
    [jGrantsResult, scrapedContent, accessToken] = await Promise.all([
      fetchFromJGrants(),
      scrapePages(SCRAPE_URLS),
      getGoogleAccessToken(serviceAccount),
    ]);
    console.log(
      `[trigger-update] jGrants: ${jGrantsResult.subsidies.length}件`,
      `/ スクレイピング: ${scrapedContent.length}文字`
    );
  } catch (err) {
    console.warn('[trigger-update] フェーズ1 一部失敗（続行）:', err.message);
    // accessToken だけは必須なので個別に再取得
    if (!accessToken) {
      try {
        accessToken = await getGoogleAccessToken(serviceAccount);
      } catch (e) {
        console.error('[trigger-update] OAuth取得失敗:', e.message);
        return;
      }
    }
  }

  // ── フェーズ2: Gemini で益田市独自補助金を取得 ───────────────────────────
  let geminiResult = { subsidies: [] };
  try {
    geminiResult = await fetchFromGemini(geminiKey, scrapedContent);
  } catch (err) {
    console.warn('[trigger-update] Gemini失敗（jGrantsのみで続行）:', err.message);
  }

  // ── フェーズ3: jGrants（優先）＋ Gemini をマージ・重複除去 ───────────────
  const allSubsidies = mergeSubsidies([
    jGrantsResult.subsidies,  // jGrantsを先に入れることで重複時に優先される
    geminiResult.subsidies,
  ]);

  if (allSubsidies.length === 0) {
    console.error('[trigger-update] 取得件数0件 → 保存をスキップ');
    return;
  }

  // ── フェーズ4: Firestore 保存 ─────────────────────────────────────────────
  const fetchedAt = new Date().toISOString();
  try {
    await writeFirestore(projectId, accessToken, allSubsidies, fetchedAt);
    console.log(
      `[trigger-update] 完了: ${allSubsidies.length}件`,
      `(jGrants: ${jGrantsResult.subsidies.length}件 + Gemini: ${geminiResult.subsidies.length}件)`,
      fetchedAt
    );
  } catch (err) {
    console.error('[trigger-update] Firestore書き込み失敗:', err.message);
  }
};
