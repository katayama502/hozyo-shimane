/**
 * netlify/functions/scheduled-update.js
 *
 * 週次cron（毎週月曜 6:00 JST）に自動実行。
 * この関数自体はバックグラウンド関数を起動するだけで即リターンする。
 * 実際の Gemini → Firestore 処理は trigger-update-background.js が担う。
 *
 * 理由: scheduled-update はタイムアウト26秒のため、Gemini+スクレイピングを
 * 直接実行すると必ず失敗する。バックグラウンド関数は最大15分動作可能。
 *
 * スケジュール設定: netlify.toml の [functions.scheduled-update] を参照
 *
 * 必要な環境変数:
 *   URL - Netlify サイトURL（自動設定）
 */

const { SCRAPE_URLS, scrapePages, fetchFromGemini, getGoogleAccessToken, writeFirestore } = require('./_shared');

exports.handler = async () => {
  console.log('[scheduled-update] 週次更新: バックグラウンド関数を起動', new Date().toISOString());

  const siteUrl = process.env.URL;
  if (!siteUrl) {
    console.error('[scheduled-update] URL環境変数が未設定（Netlifyでは自動設定されるはず）');
    return { statusCode: 500, body: 'URL環境変数が未設定' };
  }

  const bgUrl = `${siteUrl}/.netlify/functions/trigger-update-background`;

  // 益田市公式サイトをスクレイピング + OAuth取得を並列実行
  let scrapedContent, accessToken;
  try {
    [scrapedContent, accessToken] = await Promise.all([
      scrapePages(SCRAPE_URLS),
      getGoogleAccessToken(serviceAccount),
    ]);
    console.log(`[scheduled-update] スクレイピング完了 (${scrapedContent.length}文字)`);
  } catch (err) {
    console.warn('[scheduled-update] 前処理失敗（Geminiのみで続行）:', err.message);
    scrapedContent = '';
  }

  // スクレイピング結果をもとにGeminiで構造化
  let geminiResult;
  try {
    geminiResult = await fetchFromGemini(geminiKey, scrapedContent);
  } catch (err) {
    console.error('[scheduled-update] Gemini失敗:', err.message);
    return { statusCode: 502, body: `Gemini失敗: ${err.message}` };
  }
};
