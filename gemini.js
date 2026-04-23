/**
 * gemini.js
 * Gemini API呼び出し専用モジュール（クライアント側）
 *
 * - APIキーはNetlify Function内に保護済み
 * - エラー時は1回リトライ（有料プラン向け軽量設定）
 */

const GEMINI_API = {
  PROXY_URL: '/.netlify/functions/gemini-proxy',

  RETRY_CONFIG: {
    maxRetries: 1,
    baseDelayMs: 2000,   // 待機 2秒
    maxDelayMs: 10000,   // 最大待機 10秒
  },

  /**
   * 指数バックオフ付きでプロキシ経由リクエストを送信する
   * @param {string} prompt
   * @param {object} [options]
   * @param {function} [options.onRateLimit] - レート制限通知コールバック(retryAfterMs, attempt)
   * @returns {Promise<object>}
   */
  async request(prompt, options = {}) {
    const { maxRetries, baseDelayMs, maxDelayMs } = GEMINI_API.RETRY_CONFIG;
    const { onRateLimit } = options;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let response;
      try {
        response = await fetch(GEMINI_API.PROXY_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt }),
        });
      } catch (networkErr) {
        if (attempt === maxRetries) {
          throw new GeminiError('ネットワークエラーが発生しました。接続を確認して再試行してください。', 'NETWORK_ERROR');
        }
        const delay = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
        await GEMINI_API._sleep(delay);
        continue;
      }

      const data = await response.json().catch(() => ({}));

      // ==================== 成功 ====================
      if (response.ok) {
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) throw new GeminiError('AIからの応答が空です。再試行してください。', 'EMPTY_RESPONSE');
        try {
          return JSON.parse(text);
        } catch {
          const match = text.match(/\{[\s\S]*\}/);
          if (match) {
            try { return JSON.parse(match[0]); } catch { /* fall through */ }
          }
          throw new GeminiError('AIの応答形式が不正です。再試行してください。', 'PARSE_ERROR');
        }
      }

      // ==================== レート制限 (429) ====================
      if (response.status === 429) {
        // サーバーが返した retryAfter を優先、なければ指数バックオフ
        const serverRetryAfter = data?.retryAfter ? data.retryAfter * 1000 : 0;
        const backoffDelay = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
        const waitMs = Math.max(serverRetryAfter, backoffDelay);

        if (attempt < maxRetries) {
          if (typeof onRateLimit === 'function') onRateLimit(waitMs, attempt + 1);
          await GEMINI_API._sleep(waitMs);
          continue;
        }

        // リトライ上限超過
        const waitSec = Math.ceil(waitMs / 1000);
        throw new GeminiError(
          `リクエスト制限に達しました。${waitSec}秒後に再試行してください。`,
          'RATE_LIMIT',
          { retryAfterMs: waitMs }
        );
      }

      // ==================== その他のエラー ====================
      const errMsg = data?.error || `HTTP ${response.status}`;
      if (response.status >= 500) {
        throw new GeminiError(`サーバーエラーが発生しました。再試行してください。（${errMsg}）`, 'SERVER_ERROR');
      }
      throw new GeminiError(`エラーが発生しました: ${errMsg}`, 'API_ERROR');
    }
  },

  /**
   * 島根県の補助金一覧を取得する
   */
  async fetchSubsidies(options = {}) {
    const prompt = PROMPTS.fetchSubsidies();
    const result = await GEMINI_API.request(prompt, options);

    if (!result.subsidies || !Array.isArray(result.subsidies)) {
      throw new GeminiError('補助金データの形式が不正です。再試行してください。', 'INVALID_DATA');
    }

    return {
      subsidies: result.subsidies.map((s, i) => ({
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
      })),
      fetchedAt: new Date().toISOString(),
    };
  },

  /**
   * AI逆引き検索
   */
  async searchByIntent(intent, existingSubsidies = [], options = {}) {
    const prompt = PROMPTS.reverseSearch(intent, existingSubsidies);
    const result = await GEMINI_API.request(prompt, options);

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

  _sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),

  _normalizeCategory(cat) {
    const valid = ['農業・林業・水産業','中小企業・創業支援','移住・定住支援','子育て・教育','住宅・リフォーム','ITデジタル化','その他'];
    return valid.includes(cat) ? cat : 'その他';
  },
  _normalizeStatus(status) {
    return ['受付中','受付予定','終了'].includes(status) ? status : '受付中';
  },
  _normalizeUrl(url) {
    if (!url || typeof url !== 'string') return 'https://www.pref.shimane.lg.jp/';
    return (url.startsWith('http://') || url.startsWith('https://')) ? url : 'https://www.pref.shimane.lg.jp/';
  },
};

/**
 * Gemini API 専用エラークラス
 */
class GeminiError extends Error {
  constructor(message, code, meta = {}) {
    super(message);
    this.name = 'GeminiError';
    this.code = code;
    this.retryAfterMs = meta.retryAfterMs || null;
  }
}
