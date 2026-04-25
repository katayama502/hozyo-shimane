/**
 * netlify/functions/scheduled-update.js
 *
 * 週次cron（毎週月曜 6:00 JST）に自動実行。
 * この関数自体はバックグラウンド関数を起動するだけで即リターンする。
 * 実際の jGrants → Firestore 処理は trigger-update-background.js が担う。
 *
 * 理由: scheduled-update はタイムアウト10秒のため処理を直接実行できない。
 *       バックグラウンド関数は最大15分動作可能。
 *
 * スケジュール設定: netlify.toml の [functions.scheduled-update] を参照
 *
 * 必要な環境変数:
 *   URL - Netlify サイトURL（自動設定）
 */

exports.handler = async () => {
  console.log('[scheduled-update] 週次更新: バックグラウンド関数を起動', new Date().toISOString());

  const siteUrl = process.env.URL;
  if (!siteUrl) {
    console.error('[scheduled-update] URL環境変数が未設定（Netlifyでは自動設定されるはず）');
    return { statusCode: 500, body: 'URL環境変数が未設定' };
  }

  const bgUrl = `${siteUrl}/.netlify/functions/trigger-update-background`;

  try {
    const res = await fetch(bgUrl, {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
    });
    console.log(`[scheduled-update] バックグラウンド関数起動: HTTP ${res.status}`);
    return { statusCode: 200, body: `バックグラウンド更新を起動しました (${res.status})` };
  } catch (err) {
    console.error('[scheduled-update] バックグラウンド関数の起動失敗:', err.message);
    return { statusCode: 502, body: `起動失敗: ${err.message}` };
  }
};
