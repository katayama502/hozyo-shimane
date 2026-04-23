/**
 * app.js
 * メインロジック（状態管理・初期化・イベント連携）
 */

// ==================== グローバル状態 ====================

const APP_STATE = {
  allSubsidies: [],    // 全補助金データ
  fetchedAt: null,     // 取得日時
  isLoading: false,    // ローディング中フラグ
  currentTab: 'list',  // 'list' | 'search'
  filters: {
    category: 'all',
    issuer: 'all',
    status: 'all',
    keyword: '',
  },
  sort: 'default',
  apiKey: '',
};

// ==================== メインモジュール ====================

const APP = {
  /**
   * アプリ初期化
   */
  // sessionStorageキャッシュキー
  CACHE_KEY: 'hojosearch_subsidies_cache',
  CACHE_TTL_MS: 30 * 60 * 1000, // 30分

  init() {
    APP_STATE.apiKey = localStorage.getItem('gemini_api_key') || '';

    APP._bindEvents();
    APP._renderExampleChips();

    if (!APP_STATE.apiKey) {
      UI.showApiKeyBanner();
    } else {
      APP.loadSubsidies();
    }
  },

  /**
   * sessionStorageからキャッシュを読み込む
   * @returns {object|null} キャッシュされたデータ（有効期限内）またはnull
   */
  _loadCache() {
    try {
      const raw = sessionStorage.getItem(APP.CACHE_KEY);
      if (!raw) return null;
      const cached = JSON.parse(raw);
      const age = Date.now() - (cached.cachedAt || 0);
      if (age > APP.CACHE_TTL_MS) return null;
      return cached;
    } catch {
      return null;
    }
  },

  /**
   * sessionStorageにデータをキャッシュする
   */
  _saveCache(data) {
    try {
      sessionStorage.setItem(APP.CACHE_KEY, JSON.stringify({
        ...data,
        cachedAt: Date.now(),
      }));
    } catch {
      // sessionStorage が使えない環境（プライベートブラウジング等）は無視
    }
  },

  /**
   * 補助金データをGemini APIから取得・表示する（sessionStorageキャッシュ対応）
   */
  async loadSubsidies(forceRefresh = false) {
    if (APP_STATE.isLoading) return;

    const apiKey = localStorage.getItem('gemini_api_key') || '';
    if (!apiKey) {
      UI.showApiKeyBanner();
      return;
    }

    // キャッシュ確認（強制再取得でない場合）
    if (!forceRefresh) {
      const cached = APP._loadCache();
      if (cached && cached.subsidies) {
        APP_STATE.allSubsidies = cached.subsidies;
        APP_STATE.fetchedAt = cached.fetchedAt;
        UI.updateFetchTime(cached.fetchedAt);
        UI.updateFilterOptions(cached.subsidies);
        APP.applyFilters();
        UI.hideApiKeyBanner();
        UI.showToast(`${cached.subsidies.length}件の補助金情報を表示中（キャッシュ）`, 'info');
        return;
      }
    }

    APP_STATE.isLoading = true;
    APP_STATE.apiKey = apiKey;

    UI.showSkeleton(9);
    UI.hideError();

    // ステータスバー
    const statusBar = document.getElementById('status-bar');
    if (statusBar) statusBar.classList.add('loading');

    const fetchBtn = document.getElementById('refetch-btn');
    if (fetchBtn) {
      fetchBtn.disabled = true;
      fetchBtn.textContent = '取得中…';
    }

    try {
      const result = await GEMINI_API.fetchSubsidies(apiKey);
      APP_STATE.allSubsidies = result.subsidies;
      APP_STATE.fetchedAt = result.fetchedAt;

      // キャッシュに保存
      APP._saveCache(result);

      UI.updateFetchTime(result.fetchedAt);
      UI.updateFilterOptions(result.subsidies);
      APP.applyFilters();

      if (statusBar) statusBar.classList.remove('loading');
      UI.hideApiKeyBanner();
      UI.showToast(`${result.subsidies.length}件の補助金情報を取得しました`, 'success');
    } catch (err) {
      console.error('[APP] loadSubsidies error:', err);
      UI.showError(
        err instanceof GeminiError ? err.message : `データの取得に失敗しました: ${err.message}`,
        () => APP.loadSubsidies(true)
      );
      if (statusBar) statusBar.classList.remove('loading');
    } finally {
      APP_STATE.isLoading = false;
      if (fetchBtn) {
        fetchBtn.disabled = false;
        fetchBtn.textContent = '再取得';
      }
    }
  },

  /**
   * フィルター・ソートを適用してカードを再描画する
   */
  applyFilters() {
    let result = FILTER_UTILS.filter(APP_STATE.allSubsidies, APP_STATE.filters);
    result = FILTER_UTILS.sort(result, APP_STATE.sort);
    UI.renderCards(result);
  },

  /**
   * 詳細モーダルを開く
   * @param {string} id
   */
  openModal(id) {
    const subsidy = APP_STATE.allSubsidies.find(s => s.id === id);
    if (subsidy) UI.openModal(subsidy);
  },

  /**
   * AIキーを保存してデータを取得する
   */
  saveApiKeyAndLoad() {
    const input = document.getElementById('apikey-input');
    if (!input) return;

    const key = input.value.trim();
    if (!key) {
      UI.showToast('APIキーを入力してください', 'error');
      return;
    }
    if (!key.startsWith('AIza')) {
      UI.showToast('Gemini APIキーは "AIza" で始まる形式です。正しいキーを入力してください。', 'error');
      return;
    }

    localStorage.setItem('gemini_api_key', key);
    APP_STATE.apiKey = key;
    // APIキー変更時はキャッシュをクリアして再取得
    try { sessionStorage.removeItem(APP.CACHE_KEY); } catch { /* ignore */ }
    UI.closeApiKeyModal();
    APP.loadSubsidies(true);
  },

  /**
   * AI逆引き検索を実行する
   */
  async runAISearch() {
    const textarea = document.getElementById('ai-intent-input');
    if (!textarea) return;

    const intent = textarea.value.trim();
    if (!intent) {
      UI.showToast('やりたいこと・困っていることを入力してください', 'error');
      return;
    }

    const apiKey = localStorage.getItem('gemini_api_key') || '';
    if (!apiKey) {
      UI.showApiKeyBanner();
      UI.showToast('Gemini APIキーを設定してください', 'error');
      return;
    }

    const btn = document.getElementById('ai-search-btn');
    if (btn) {
      btn.disabled = true;
      btn.textContent = '検索中…';
    }

    UI.showAILoading();

    try {
      const result = await GEMINI_API.searchByIntent(apiKey, intent, APP_STATE.allSubsidies);
      UI.renderAIResults(result);
    } catch (err) {
      console.error('[APP] runAISearch error:', err);
      UI.showAIError(
        err instanceof GeminiError ? err.message : `検索に失敗しました: ${err.message}`
      );
    } finally {
      UI.hideAILoading();
      if (btn) {
        btn.disabled = false;
        btn.textContent = '検索する';
      }
    }
  },

  // ==================== イベントバインド ====================

  _bindEvents() {
    // タブ切り替え
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.getAttribute('data-tab');
        APP._switchTab(tab);
      });
    });

    // 再取得ボタン（強制再取得）
    const refetchBtn = document.getElementById('refetch-btn');
    if (refetchBtn) refetchBtn.addEventListener('click', () => APP.loadSubsidies(true));

    // APIキー設定ボタン（ヘッダー）
    const settingsBtn = document.getElementById('settings-btn');
    if (settingsBtn) settingsBtn.addEventListener('click', () => UI.openApiKeyModal());

    // APIキーバナーのボタン
    const bannerBtn = document.getElementById('apikey-banner-btn');
    if (bannerBtn) bannerBtn.addEventListener('click', () => UI.openApiKeyModal());

    // APIキーモーダル保存
    const saveKeyBtn = document.getElementById('save-apikey-btn');
    if (saveKeyBtn) saveKeyBtn.addEventListener('click', () => APP.saveApiKeyAndLoad());

    // APIキーモーダルのEnterキー
    const keyInput = document.getElementById('apikey-input');
    if (keyInput) {
      keyInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') APP.saveApiKeyAndLoad();
      });
    }

    // APIキーモーダル閉じる
    const closeKeyModal = document.getElementById('close-apikey-modal');
    if (closeKeyModal) closeKeyModal.addEventListener('click', () => UI.closeApiKeyModal());

    // APIキーモーダル キャンセルボタン（2つ目）
    const closeKeyModal2 = document.getElementById('close-apikey-modal-2');
    if (closeKeyModal2) closeKeyModal2.addEventListener('click', () => UI.closeApiKeyModal());

    // 詳細モーダル閉じる
    const closeModal = document.getElementById('close-detail-modal');
    if (closeModal) closeModal.addEventListener('click', () => UI.closeModal());

    // モーダル背景クリックで閉じる
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
      overlay.addEventListener('click', e => {
        if (e.target === overlay) {
          UI.closeModal();
          UI.closeApiKeyModal();
        }
      });
    });

    // ESCキーでモーダルを閉じる
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        UI.closeModal();
        UI.closeApiKeyModal();
      }
    });

    // キーワード検索
    const searchInput = document.getElementById('search-input');
    if (searchInput) {
      let searchTimer;
      searchInput.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
          APP_STATE.filters.keyword = searchInput.value;
          APP.applyFilters();
        }, 300);
      });
    }

    // フィルター：カテゴリ
    const catFilter = document.getElementById('filter-category');
    if (catFilter) {
      catFilter.addEventListener('change', () => {
        APP_STATE.filters.category = catFilter.value;
        APP.applyFilters();
      });
    }

    // フィルター：発行元
    const issuerFilter = document.getElementById('filter-issuer');
    if (issuerFilter) {
      issuerFilter.addEventListener('change', () => {
        APP_STATE.filters.issuer = issuerFilter.value;
        APP.applyFilters();
      });
    }

    // フィルター：ステータス
    const statusFilter = document.getElementById('filter-status');
    if (statusFilter) {
      statusFilter.addEventListener('change', () => {
        APP_STATE.filters.status = statusFilter.value;
        APP.applyFilters();
      });
    }

    // ソート
    const sortSelect = document.getElementById('sort-select');
    if (sortSelect) {
      sortSelect.addEventListener('change', () => {
        APP_STATE.sort = sortSelect.value;
        APP.applyFilters();
      });
    }

    // フィルターリセット
    const doReset = () => {
      APP_STATE.filters = { category: 'all', issuer: 'all', status: 'all', keyword: '' };
      APP_STATE.sort = 'default';
      const searchInput = document.getElementById('search-input');
      if (searchInput) searchInput.value = '';
      if (catFilter) catFilter.value = 'all';
      if (issuerFilter) issuerFilter.value = 'all';
      if (statusFilter) statusFilter.value = 'all';
      if (sortSelect) sortSelect.value = 'default';
      APP.applyFilters();
    };
    const resetBtn = document.getElementById('reset-filters-btn');
    if (resetBtn) resetBtn.addEventListener('click', doReset);
    // 空状態のリセットボタン
    const resetBtn2 = document.getElementById('reset-filters-btn-2');
    if (resetBtn2) resetBtn2.addEventListener('click', doReset);

    // AI検索実行
    const aiBtn = document.getElementById('ai-search-btn');
    if (aiBtn) aiBtn.addEventListener('click', () => APP.runAISearch());

    // AI検索：Ctrl+Enter
    const aiTextarea = document.getElementById('ai-intent-input');
    if (aiTextarea) {
      aiTextarea.addEventListener('keydown', e => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          e.preventDefault();
          APP.runAISearch();
        }
      });
    }

    // APIキーの表示/非表示切り替え
    const toggleKeyBtn = document.getElementById('toggle-apikey-visibility');
    if (toggleKeyBtn) {
      toggleKeyBtn.addEventListener('click', () => {
        const input = document.getElementById('apikey-input');
        if (!input) return;
        if (input.type === 'password') {
          input.type = 'text';
          toggleKeyBtn.textContent = '隠す';
        } else {
          input.type = 'password';
          toggleKeyBtn.textContent = '表示';
        }
      });
    }
  },

  /**
   * AI逆引き検索の入力例チップをDOMで生成する
   */
  _renderExampleChips() {
    const container = document.getElementById('example-chips');
    if (!container) return;

    const examples = [
      '島根に移住して農業を始めたい',
      '中小企業のIT化を進めたい',
      '子育て中で家のリフォームをしたい',
      '飲食店を新規開業したい',
      '林業に就きたい',
    ];

    examples.forEach(text => {
      const btn = document.createElement('button');
      btn.className = 'example-chip';
      btn.setAttribute('role', 'listitem');
      btn.textContent = text;
      btn.addEventListener('click', () => {
        const textarea = document.getElementById('ai-intent-input');
        if (textarea) textarea.value = text;
      });
      container.appendChild(btn);
    });
  },

  _switchTab(tab) {
    APP_STATE.currentTab = tab;
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-tab') === tab);
      btn.setAttribute('aria-selected', btn.getAttribute('data-tab') === tab ? 'true' : 'false');
    });
    document.querySelectorAll('.tab-panel').forEach(panel => {
      panel.classList.toggle('hidden', panel.getAttribute('data-panel') !== tab);
    });
  },
};

// ==================== 起動 ====================

document.addEventListener('DOMContentLoaded', () => APP.init());
