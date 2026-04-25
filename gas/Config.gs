/**
 * Config.gs
 * 定数・スクレイピング対象URL
 *
 * 【セットアップ手順】
 * GASエディタ上部メニュー > プロジェクトの設定 > スクリプトプロパティ に
 * 以下の3つを登録してください：
 *
 *   GEMINI_API_KEY           : Gemini API キー
 *   FIREBASE_PROJECT_ID      : Firebase プロジェクトID（例: shimane-hojosearch）
 *   FIREBASE_SERVICE_ACCOUNT : サービスアカウントJSONの全文字列
 */

// Firestore ドキュメントパス
var FIRESTORE_DOC_PATH = 'hojosearch/masuda';

// Gemini モデル（フォールバック順）
var GEMINI_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.0-flash',
];

// スクレイピング対象ページ（益田市公式サイト）
var SCRAPE_URLS = [
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
