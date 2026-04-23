/**
 * gemini.js
 * Gemini API呼び出し専用モジュール
 */

const GEMINI_API = {
  BASE_URL: 'https://generativelanguage.googleapis.com/v1beta/models',
  MODEL: 'gemini-1.5-flash',

  /**
   * Gemini APIにリクエストを送信する基本メソッド
   * @param {string} apiKey
   * @param {string} prompt
   * @returns {Promise<object>} パース済みJSONオブジェクト
   */
  async request(apiKey, prompt) {
    const url = `${this.BASE_URL}/${this.MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const body = {
      contents: [
        {
          parts: [{ text: prompt }],
        },
      ],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 8192,
        responseMimeType: 'application/json',
      },
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({}));
      const message = errBody?.error?.message || `HTTP ${response.status}`;

      if (response.status === 400) {
        throw new GeminiError('APIキーが無効です。正しいGemini APIキーを入力してください。', 'INVALID_API_KEY');
      }
      if (response.status === 403) {
        throw new GeminiError('APIキーの権限がありません。Gemini APIが有効化されているか確認してください。', 'FORBIDDEN');
      }
      if (response.status === 429) {
        throw new GeminiError('APIの利用制限に達しました。しばらく待ってから再試行してください。', 'RATE_LIMIT');
      }
      throw new GeminiError(`APIエラー: ${message}`, 'API_ERROR');
    }

    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!text) {
      throw new GeminiError('APIからの応答が空です。再試行してください。', 'EMPTY_RESPONSE');
    }

    try {
      return JSON.parse(text);
    } catch {
      // JSON parse失敗時: JSONブロックを抽出して再試行
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          return JSON.parse(jsonMatch[0]);
        } catch {
          throw new GeminiError('APIの応答形式が不正です。再試行してください。', 'PARSE_ERROR');
        }
      }
      throw new GeminiError('APIの応答形式が不正です。再試行してください。', 'PARSE_ERROR');
    }
  },

  /**
   * 島根県の補助金一覧を取得する
   * @param {string} apiKey
   * @returns {Promise<{subsidies: Array, fetchedAt: string}>}
   */
  async fetchSubsidies(apiKey) {
    const prompt = PROMPTS.fetchSubsidies();
    const result = await this.request(apiKey, prompt);

    if (!result.subsidies || !Array.isArray(result.subsidies)) {
      throw new GeminiError('補助金データの形式が不正です。再試行してください。', 'INVALID_DATA');
    }

    // データバリデーション・正規化
    const subsidies = result.subsidies.map((s, i) => ({
      id: s.id || `shimane-${String(i + 1).padStart(3, '0')}`,
      title: String(s.title || '名称不明'),
      simpleDescription: String(s.simpleDescription || ''),
      description: String(s.description || ''),
      category: GEMINI_API._normalizeCategory(s.category),
      targetUsers: Array.isArray(s.targetUsers) ? s.targetUsers.map(String) : [],
      maxAmount: typeof s.maxAmount === 'number' ? s.maxAmount : 0,
      deadline: s.deadline && s.deadline !== 'null' ? String(s.deadline) : null,
      issuer: String(s.issuer || '不明'),
      region: String(s.region || '島根県'),
      applicationUrl: GEMINI_API._normalizeUrl(s.applicationUrl),
      requirements: String(s.requirements || ''),
      status: GEMINI_API._normalizeStatus(s.status),
    }));

    return {
      subsidies,
      fetchedAt: new Date().toISOString(),
    };
  },

  /**
   * AI逆引き検索
   * @param {string} apiKey
   * @param {string} intent - ユーザーの入力
   * @param {Array} existingSubsidies - 既取得の補助金
   * @returns {Promise<{results: Array, advice: string}>}
   */
  async searchByIntent(apiKey, intent, existingSubsidies = []) {
    const prompt = PROMPTS.reverseSearch(intent, existingSubsidies);
    const result = await this.request(apiKey, prompt);

    if (!result.results || !Array.isArray(result.results)) {
      throw new GeminiError('検索結果の形式が不正です。再試行してください。', 'INVALID_DATA');
    }

    return {
      results: result.results.map(r => ({
        title: String(r.title || '名称不明'),
        reason: String(r.reason || ''),
        simpleDescription: String(r.simpleDescription || ''),
        maxAmount: typeof r.maxAmount === 'number' ? r.maxAmount : 0,
        deadline: r.deadline && r.deadline !== 'null' ? String(r.deadline) : null,
        issuer: String(r.issuer || '不明'),
        applicationUrl: GEMINI_API._normalizeUrl(r.applicationUrl),
        category: GEMINI_API._normalizeCategory(r.category),
        requirements: String(r.requirements || ''),
        nextStep: String(r.nextStep || ''),
      })),
      advice: String(result.advice || ''),
    };
  },

  _normalizeCategory(cat) {
    const valid = [
      '農業・林業・水産業',
      '中小企業・創業支援',
      '移住・定住支援',
      '子育て・教育',
      '住宅・リフォーム',
      'ITデジタル化',
      'その他',
    ];
    return valid.includes(cat) ? cat : 'その他';
  },

  _normalizeStatus(status) {
    const valid = ['受付中', '受付予定', '終了'];
    return valid.includes(status) ? status : '受付中';
  },

  _normalizeUrl(url) {
    if (!url || typeof url !== 'string') return 'https://www.pref.shimane.lg.jp/';
    if (url.startsWith('http://') || url.startsWith('https://')) return url;
    return 'https://www.pref.shimane.lg.jp/';
  },
};

/**
 * Gemini API 専用エラークラス
 */
class GeminiError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'GeminiError';
    this.code = code;
  }
}
