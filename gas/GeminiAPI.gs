/**
 * GeminiAPI.gs
 * Gemini API 呼び出し（スクレイピング結果を渡して補助金データを構造化）
 */

/**
 * スクレイピング済みコンテンツをもとに補助金データをGeminiで生成
 * @param {string} scrapedContent - 益田市サイトから取得したテキスト
 * @returns {Object} { subsidies: Array }
 */
function fetchFromGemini(scrapedContent) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) throw new Error('GEMINI_API_KEY が未設定です');

  var prompt = buildSubsidyPrompt(scrapedContent);

  for (var i = 0; i < GEMINI_MODELS.length; i++) {
    var modelId = GEMINI_MODELS[i];
    try {
      var result = callGeminiModel(modelId, prompt, apiKey);
      if (result) return result;
    } catch (e) {
      console.warn(modelId + ' 失敗: ' + e.message);
    }
  }

  throw new Error('全Geminiモデルで失敗しました');
}

/**
 * 単一モデルでGemini APIを呼び出す
 */
function callGeminiModel(modelId, prompt, apiKey) {
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + modelId + ':generateContent?key=' + apiKey;

  var response = UrlFetchApp.fetch(url, {
    method: 'POST',
    contentType: 'application/json',
    payload: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 4096,
        responseMimeType: 'application/json',
      },
    }),
    muteHttpExceptions: true,
  });

  var code = response.getResponseCode();
  if (code === 404) return null; // モデル未発見 → 次へ
  if (code !== 200) throw new Error('HTTP ' + code + ': ' + response.getContentText().substring(0, 200));

  var data = JSON.parse(response.getContentText());
  var text = data && data.candidates && data.candidates[0] &&
             data.candidates[0].content && data.candidates[0].content.parts &&
             data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text || '';

  if (!text) throw new Error('Geminiのレスポンスが空です');

  var parsed = JSON.parse(text);
  if (!Array.isArray(parsed && parsed.subsidies)) throw new Error('subsidies配列がありません');

  console.log('Gemini成功: ' + modelId + ', ' + parsed.subsidies.length + '件');
  return parsed;
}

/**
 * スクレイピング内容を含むプロンプトを組み立てる
 */
function buildSubsidyPrompt(scrapedContent) {
  var realDataSection = scrapedContent && scrapedContent.length > 100
    ? '以下は益田市公式サイトから取得した実際の補助金・支援制度の情報です：\n\n' +
      scrapedContent +
      '\n\n---\n上記の実際のページ内容をもとに補助金情報を構造化してください。\n' +
      'ページに記載のない制度（農業支援、移住支援、子育て支援、島根県・国の補助金など）も加え、合計25件になるよう補完してください。'
    : '益田市・島根県・国の補助金を25件リストアップしてください。';

  return 'あなたは島根県益田市の補助金・助成金の専門家です。\n\n' +
    realDataSection +
    '\n\n以下のJSON形式のみで返してください（説明文・マークダウン等は一切不要）：\n\n' +
    '{"subsidies":[{"id":"masuda-001","title":"補助金の正式名称","simpleDescription":"わかりやすい説明60文字以内","description":"詳細説明200文字以内","category":"中小企業・創業支援","targetUsers":["中小企業","個人事業主"],"maxAmount":1000000,"deadline":"2026-06-30","issuer":"益田市","region":"益田市","applicationUrl":"https://www.city.masuda.lg.jp/","requirements":"申請条件100文字以内","status":"受付中"}]}\n\n' +
    'フィールド:\n' +
    '- id: masuda-連番3桁\n' +
    '- category: "農業・林業・水産業"/"中小企業・創業支援"/"移住・定住支援"/"子育て・教育"/"住宅・リフォーム"/"ITデジタル化"/"その他"\n' +
    '- issuer: "益田市"/"島根県"/"国"\n' +
    '- maxAmount: 数値（不明は0）\n' +
    '- deadline: "YYYY-MM-DD" または null\n' +
    '- status: "受付中"/"受付予定"/"終了"';
}
