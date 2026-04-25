/**
 * Scraper.gs
 * 益田市公式サイトのスクレイピング
 *
 * UrlFetchApp.fetchAll() で全ページを並列取得し、
 * HTMLからメインテキストを抽出して返す。
 */

/**
 * 複数ページを並列スクレイピングして結合テキストを返す
 * @param {string[]} urls
 * @returns {string}
 */
function scrapePages(urls) {
  console.log('スクレイピング開始: ' + urls.length + '件');

  var requests = urls.map(function(url) {
    return {
      url: url,
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HojoSearch-Bot/1.0)' },
      muteHttpExceptions: true,
    };
  });

  var responses = UrlFetchApp.fetchAll(requests);

  var texts = [];
  responses.forEach(function(res, i) {
    var url = urls[i];
    var code = res.getResponseCode();
    if (code !== 200) {
      console.warn('スクレイピング失敗: ' + url + ' (HTTP ' + code + ')');
      return;
    }
    var text = extractText(res.getContentText());
    if (text.length > 50) {
      texts.push('【ページ: ' + url + '】\n' + text);
      console.log('取得成功: ' + url.split('/').slice(-2).join('/') + ' (' + text.length + '文字)');
    }
  });

  console.log('スクレイピング完了: ' + texts.length + '/' + urls.length + '件成功');
  return texts.join('\n\n');
}

/**
 * HTMLからスクリプト・スタイル・ナビゲーションを除去してテキスト抽出
 * @param {string} html
 * @returns {string}
 */
function extractText(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&[a-z]+;/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 2000); // 1ページあたり最大2000文字
}
