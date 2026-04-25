/**
 * Main.gs
 * エントリーポイント・トリガー管理
 *
 * 【実行フロー】
 *   1. 益田市公式サイトをスクレイピング（並列）
 *   2. 取得テキスト + Gemini で補助金データを構造化
 *   3. Firebase Firestore に保存
 *
 * 【スケジュール】
 *   3日に1回（毎日チェックし、最終更新から72時間超なら更新）
 *   GAS トリガー: 毎日 6:00 JST に dailyCheck() を実行
 *
 * 【セットアップ手順】
 *   1. GASエディタで新規プロジェクトを作成
 *   2. このフォルダ内の全 .gs ファイルをコピー
 *   3. appsscript.json を「マニフェストファイルを表示」で上書き
 *   4. スクリプトプロパティに以下を設定:
 *        GEMINI_API_KEY           : GeminiのAPIキー
 *        FIREBASE_PROJECT_ID      : FirebaseプロジェクトID
 *        FIREBASE_SERVICE_ACCOUNT : サービスアカウントJSONの全文
 *   5. setupTrigger() を一度手動で実行してトリガーを登録
 *   6. 動作確認: runUpdate() を手動実行
 */

// 更新間隔: 3日（72時間）
var UPDATE_INTERVAL_HOURS = 72;

// ==================== メイン更新処理 ====================

/**
 * 補助金データの更新メイン処理
 * 手動実行・トリガーから呼ばれる
 */
function runUpdate() {
  console.log('=== 補助金データ更新開始 ===');
  console.log('実行時刻: ' + new Date().toISOString());

  // スクレイピングとOAuthトークン取得を逐次実行（GASは同期処理）
  var scrapedContent = '';
  try {
    scrapedContent = scrapePages(SCRAPE_URLS);
    console.log('スクレイピング完了: ' + scrapedContent.length + '文字');
  } catch (e) {
    console.warn('スクレイピング失敗（Geminiのみで続行）: ' + e.message);
  }

  // Gemini で構造化
  var geminiResult;
  try {
    geminiResult = fetchFromGemini(scrapedContent);
  } catch (e) {
    console.error('Gemini失敗: ' + e.message);
    throw e;
  }

  var fetchedAt = new Date().toISOString();

  // OAuthトークン取得 → Firestore 書き込み
  try {
    var accessToken = getGoogleAccessToken();
    writeFirestore(accessToken, geminiResult.subsidies, fetchedAt);
  } catch (e) {
    console.error('Firestore書き込み失敗: ' + e.message);
    throw e;
  }

  console.log('=== 更新完了: ' + geminiResult.subsidies.length + '件 ===');
}

// ==================== 3日に1回チェック ====================

/**
 * 毎日実行されるチェック関数
 * Firestoreのデータが72時間以上古い場合のみ更新する
 */
function dailyCheck() {
  console.log('定期チェック開始: ' + new Date().toISOString());

  try {
    var current = readFirestore();

    if (current && current.lastUpdated) {
      var lastUpdatedMs = new Date(current.lastUpdated).getTime();
      var elapsedHours  = (Date.now() - lastUpdatedMs) / (1000 * 60 * 60);

      console.log('最終更新から ' + Math.floor(elapsedHours) + ' 時間経過');

      if (elapsedHours < UPDATE_INTERVAL_HOURS) {
        console.log('更新不要（次回更新まで ' +
          Math.ceil(UPDATE_INTERVAL_HOURS - elapsedHours) + ' 時間）');
        return;
      }
    } else {
      console.log('Firestoreにデータなし → 初回取得');
    }
  } catch (e) {
    console.warn('Firestore確認失敗（更新を実行）: ' + e.message);
  }

  runUpdate();
}

// ==================== トリガー管理 ====================

/**
 * 毎日 6:00 JST に dailyCheck を実行するトリガーを登録
 * 初回セットアップ時に一度だけ手動実行してください
 */
function setupTrigger() {
  // 既存のトリガーを削除（重複防止）
  deleteTriggers_();

  ScriptApp.newTrigger('dailyCheck')
    .timeBased()
    .everyDays(1)
    .atHour(6)
    .inTimezone('Asia/Tokyo')
    .create();

  console.log('トリガー登録完了: 毎日 6:00 JST に dailyCheck() を実行');
  console.log('3日に1回（72時間超のとき）のみ Gemini API が呼ばれます');
}

/**
 * 全トリガーを削除
 */
function deleteTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    ScriptApp.deleteTrigger(trigger);
  });
  console.log('既存トリガーを削除しました');
}

/**
 * トリガー一覧を確認（デバッグ用）
 */
function listTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  if (triggers.length === 0) {
    console.log('登録中のトリガーはありません');
    return;
  }
  triggers.forEach(function(t) {
    console.log('トリガー: ' + t.getHandlerFunction() +
      ' / 種別: ' + t.getTriggerSource());
  });
}

// ==================== 動作確認用 ====================

/**
 * スクレイピングのみをテスト（Gemini・Firestoreへの書き込みなし）
 */
function testScraping() {
  var result = scrapePages(SCRAPE_URLS);
  console.log('取得文字数: ' + result.length);
  console.log('先頭500文字:\n' + result.substring(0, 500));
}

/**
 * Firestore の現在データを確認
 */
function checkFirestore() {
  var data = readFirestore();
  if (!data) {
    console.log('Firestoreにデータなし');
    return;
  }
  console.log('件数: ' + (data.subsidies ? data.subsidies.length : 0));
  console.log('最終更新: ' + data.lastUpdated);
  if (data.subsidies && data.subsidies.length > 0) {
    console.log('先頭1件: ' + JSON.stringify(data.subsidies[0]));
  }
}
