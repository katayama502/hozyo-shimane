/**
 * filter.js
 * フィルタリング・ソート・キーワード検索ロジック
 */

const FILTER_UTILS = {
  /**
   * 補助金一覧をフィルタリングする
   * @param {Array} subsidies - 全補助金
   * @param {object} filters - フィルター条件
   * @returns {Array}
   */
  filter(subsidies, filters) {
    let result = [...subsidies];

    // カテゴリフィルター
    if (filters.category && filters.category !== 'all') {
      result = result.filter(s => s.category === filters.category);
    }

    // 発行元フィルター
    if (filters.issuer && filters.issuer !== 'all') {
      result = result.filter(s => s.issuer === filters.issuer);
    }

    // ステータスフィルター
    if (filters.status && filters.status !== 'all') {
      result = result.filter(s => s.status === filters.status);
    }

    // キーワード検索
    if (filters.keyword && filters.keyword.trim()) {
      result = FILTER_UTILS.search(result, filters.keyword);
    }

    return result;
  },

  /**
   * キーワード検索（タイトル・説明・対象者・カテゴリを対象）
   * @param {Array} subsidies
   * @param {string} keyword
   * @returns {Array}
   */
  search(subsidies, keyword) {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return subsidies;

    // 複数キーワード対応（スペース区切り）
    const keywords = kw.split(/\s+/).filter(Boolean);

    return subsidies.filter(s => {
      const searchText = [
        s.title,
        s.simpleDescription,
        s.description,
        s.category,
        s.issuer,
        s.region,
        s.requirements,
        ...(s.targetUsers || []),
      ]
        .join(' ')
        .toLowerCase();

      return keywords.every(k => searchText.includes(k));
    });
  },

  /**
   * 補助金一覧をソートする
   * @param {Array} subsidies
   * @param {string} sortType - 'deadline' | 'amount_desc' | 'amount_asc' | 'default'
   * @returns {Array}
   */
  sort(subsidies, sortType) {
    const arr = [...subsidies];

    switch (sortType) {
      case 'deadline':
        return arr.sort((a, b) => {
          if (!a.deadline && !b.deadline) return 0;
          if (!a.deadline) return 1;
          if (!b.deadline) return -1;
          return new Date(a.deadline) - new Date(b.deadline);
        });

      case 'amount_desc':
        return arr.sort((a, b) => b.maxAmount - a.maxAmount);

      case 'amount_asc':
        return arr.sort((a, b) => {
          if (a.maxAmount === 0 && b.maxAmount === 0) return 0;
          if (a.maxAmount === 0) return 1;
          if (b.maxAmount === 0) return -1;
          return a.maxAmount - b.maxAmount;
        });

      default:
        // ステータス優先（受付中 > 受付予定 > 終了）、その後締切順
        return arr.sort((a, b) => {
          const statusOrder = { 受付中: 0, 受付予定: 1, 終了: 2 };
          const sa = statusOrder[a.status] ?? 1;
          const sb = statusOrder[b.status] ?? 1;
          if (sa !== sb) return sa - sb;
          if (!a.deadline && !b.deadline) return 0;
          if (!a.deadline) return 1;
          if (!b.deadline) return -1;
          return new Date(a.deadline) - new Date(b.deadline);
        });
    }
  },

  /**
   * カテゴリ一覧を補助金データから抽出する
   * @param {Array} subsidies
   * @returns {Array<string>}
   */
  getCategories(subsidies) {
    const cats = new Set(subsidies.map(s => s.category).filter(Boolean));
    return Array.from(cats).sort();
  },

  /**
   * 発行元一覧を補助金データから抽出する
   * @param {Array} subsidies
   * @returns {Array<string>}
   */
  getIssuers(subsidies) {
    const issuers = new Set(subsidies.map(s => s.issuer).filter(Boolean));
    return Array.from(issuers).sort();
  },

  /**
   * 締切までの残日数を計算する
   * @param {string|null} deadline - ISO日付文字列
   * @returns {number|null} 残日数（nullは締切なし）
   */
  getDaysUntilDeadline(deadline) {
    if (!deadline) return null;
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const d = new Date(deadline);
    d.setHours(0, 0, 0, 0);
    const diff = Math.ceil((d - now) / (1000 * 60 * 60 * 24));
    return diff;
  },

  /**
   * 締切バッジの種別を返す
   * @param {string|null} deadline
   * @returns {'urgent'|'soon'|'normal'|null}
   */
  getDeadlineBadgeType(deadline) {
    const days = FILTER_UTILS.getDaysUntilDeadline(deadline);
    if (days === null) return null;
    if (days < 0) return 'expired';
    if (days <= 14) return 'urgent';
    if (days <= 30) return 'soon';
    return 'normal';
  },

  /**
   * 金額をフォーマットする
   * @param {number} amount
   * @returns {string}
   */
  formatAmount(amount) {
    if (!amount || amount === 0) return '金額要確認';
    if (amount >= 100000000) return `${(amount / 100000000).toFixed(0)}億円`;
    if (amount >= 10000) return `${(amount / 10000).toFixed(0)}万円`;
    return `${amount.toLocaleString()}円`;
  },
};
