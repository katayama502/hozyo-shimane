/**
 * app.js
 * メインロジック（状態管理・初期化・イベント連携）
 *
 * データ取得の優先順位:
 *   1. sessionStorage（30分）→ タブ内リロード対応・即時
 *   2. localStorage（6時間） → セッションをまたいで保持
 *   3. Firebase Firestore    → 週1回更新のサーバーキャッシュ（全ユーザー共有）
 *   4. Netlify Function      → Firestoreが古い場合のみGemini再取得 + Firestore更新
 */

// ==================== グローバル状態 ====================

const APP_STATE = {
  allSubsidies: [],
  fetchedAt: null,
  isLoading: false,
  currentTab: 'list',
  filters: { category: 'all', issuer: 'all', status: 'all', keyword: '' },
  sort: 'default',
  rateLimitTimer: null,   // レート制限タイマーID
};

// ==================== メインモジュール ====================

const APP = {
  // ---- キャッシュ設定 ----
  CACHE_KEY_SESSION: 'hojosearch_cache_session',
  CACHE_KEY_LOCAL:   'hojosearch_cache_local_v2',
  CACHE_TTL_SESSION: 30 * 60 * 1000,          // 30分
  CACHE_TTL_LOCAL:   6  * 60 * 60 * 1000,     // 6時間（RPD節約の要）

  // ---- リクエスト間隔制御 ----
  REFETCH_COOLDOWN_MS: 60 * 1000,             // 再取得ボタンの最短間隔 1分
  lastFetchTimestamp: 0,

  init() {
    APP._bindEvents();
    APP._renderExampleChips();
    APP.loadSubsidies();
  },

  // ==================== 多層キャッシュ読み書き ====================

  _readCache(storage, key, ttlMs) {
    try {
      const raw = storage.getItem(key);
      if (!raw) return null;
      const cached = JSON.parse(raw);
      if (Date.now() - (cached.cachedAt || 0) > ttlMs) return null;
      return cached;
    } catch { return null; }
  },

  _writeCache(storage, key, data) {
    try { storage.setItem(key, JSON.stringify({ ...data, cachedAt: Date.now() })); }
    catch { /* ストレージ容量不足等は無視 */ }
  },

  _clearCache() {
    try { sessionStorage.removeItem(APP.CACHE_KEY_SESSION); } catch { /* ignore */ }
    try { localStorage.removeItem(APP.CACHE_KEY_LOCAL); } catch { /* ignore */ }
  },

  /** キャッシュのタイムスタンプを人間が読める形式で返す */
  _cacheAgeLabel(cachedAt) {
    if (!cachedAt) return '';
    const ageSec = Math.floor((Date.now() - cachedAt) / 1000);
    if (ageSec < 60)  return `${ageSec}秒前のキャッシュ`;
    if (ageSec < 3600) return `${Math.floor(ageSec / 60)}分前のキャッシュ`;
    return `${Math.floor(ageSec / 3600)}時間前のキャッシュ`;
  },

  // ==================== データ取得 ====================

  /**
   * 補助金データを取得（多層キャッシュ対応）
   * @param {boolean} forceRefresh - キャッシュを無視して強制再取得
   */
  async loadSubsidies(forceRefresh = false) {
    if (APP_STATE.isLoading) return;

    // ---- クールダウンチェック（再取得ボタン連打防止）----
    if (forceRefresh) {
      const elapsed = Date.now() - APP.lastFetchTimestamp;
      if (elapsed < APP.REFETCH_COOLDOWN_MS && APP.lastFetchTimestamp > 0) {
        const waitSec = Math.ceil((APP.REFETCH_COOLDOWN_MS - elapsed) / 1000);
        UI.showToast(`再取得は${waitSec}秒後に可能です（無料枠のレート制限対策）`, 'info');
        return;
      }
    }

    // ---- L2: sessionStorage ----
    if (!forceRefresh) {
      const cached = APP._readCache(sessionStorage, APP.CACHE_KEY_SESSION, APP.CACHE_TTL_SESSION);
      if (cached?.subsidies) {
        APP._applyCache(cached, 'session');
        return;
      }
    }

    // ---- L3: localStorage（6時間）----
    if (!forceRefresh) {
      const cached = APP._readCache(localStorage, APP.CACHE_KEY_LOCAL, APP.CACHE_TTL_LOCAL);
      if (cached?.subsidies) {
        APP._applyCache(cached, 'local');
        // sessionStorageにも書いてL2を埋める
        APP._writeCache(sessionStorage, APP.CACHE_KEY_SESSION, cached);
        return;
      }
    }

    // ---- Firebase / Netlify Function 呼び出し ----
    APP_STATE.isLoading = true;
    APP.lastFetchTimestamp = Date.now();
    UI.showSkeleton(9);
    UI.hideError();
    APP._setFetchBtnState(true);

    try {
      const result = await APP._fetchFromServer();

      APP._writeCache(sessionStorage, APP.CACHE_KEY_SESSION, result);
      APP._writeCache(localStorage,   APP.CACHE_KEY_LOCAL,   result);

      APP_STATE.allSubsidies = result.subsidies;
      APP_STATE.fetchedAt    = result.fetchedAt;
      UI.updateFetchTime(result.fetchedAt);
      UI.updateFilterOptions(result.subsidies);
      UI.hideRateLimitCountdown();
      APP.applyFilters();

      const sourceLabel = result.source === 'firestore'
        ? 'Firestoreキャッシュ'
        : result.source === 'firestore-stale'
        ? 'Firestoreキャッシュ（古い可能性あり）'
        : 'Gemini AI（最新）';
      UI.showToast(`${result.subsidies.length}件の補助金情報を取得しました（${sourceLabel}）`, 'success');

    } catch (err) {
      console.error('[APP] loadSubsidies error:', err);
      UI.hideRateLimitCountdown();

      if (err instanceof GeminiError && err.code === 'RATE_LIMIT') {
        UI.showRateLimitError(err.message, err.retryAfterMs, () => APP.loadSubsidies(true));
      } else {
        UI.showError(
          err instanceof GeminiError ? err.message : `データ取得に失敗しました: ${err.message}`,
          () => APP.loadSubsidies(true)
        );
      }
    } finally {
      APP_STATE.isLoading = false;
      APP._setFetchBtnState(false);
    }
  },

  /**
   * サーバーからデータを取得する（Firebase優先 → Netlify Function）
   *
   * Firebase読み取りは公開エンドポイントで即時。
   * データが新鮮ならGemini呼び出しなし（トークン消費ゼロ）。
   * データが古い or 未作成の場合のみ update-subsidies Function 経由でGemini呼び出し。
   */
  async _fetchFromServer() {
    // ---- Firebase Firestore から直接読み取り（認証不要）----
    if (typeof FIREBASE !== 'undefined') {
      try {
        const firestoreData = await FIREBASE.getSubsidies();
        if (firestoreData?.subsidies?.length > 0 && !FIREBASE.isStale(firestoreData.lastUpdated)) {
          console.log('[APP] Firestore から新鮮なデータを取得（Gemini呼び出しなし）');
          return { ...firestoreData, source: 'firestore' };
        }
        console.log('[APP] Firestore データなし or 古い → update-subsidies を呼び出し');
      } catch (err) {
        console.warn('[APP] Firestore 読み取り失敗:', err.message);
      }
    }

    // ---- Netlify Function: update-subsidies（Gemini再取得 + Firestore更新）----
    const res = await fetch('/.netlify/functions/update-subsidies', {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new GeminiError(
        data.error || `サーバーエラーが発生しました（HTTP ${res.status}）`,
        res.status === 429 ? 'RATE_LIMIT' : 'API_ERROR',
        (data.retryAfter || 60) * 1000
      );
    }

    return await res.json();
  },

  /** キャッシュデータを画面に適用 */
  _applyCache(cached, source) {
    APP_STATE.allSubsidies = cached.subsidies;
    APP_STATE.fetchedAt    = cached.fetchedAt;
    UI.updateFetchTime(cached.fetchedAt);
    UI.updateFilterOptions(cached.subsidies);
    APP.applyFilters();
    const ageLabel = APP._cacheAgeLabel(cached.cachedAt);
    const icon = source === 'local' ? '💾' : '⚡';
    UI.showToast(`${cached.subsidies.length}件を表示中 ${icon} ${ageLabel}`, 'info');
  },

  _setFetchBtnState(loading) {
    const btn = document.getElementById('refetch-btn');
    if (!btn) return;
    btn.disabled = loading;
    btn.textContent = loading ? '取得中…' : '🔄 再取得';
  },

  // ==================== フィルター・モーダル ====================

  applyFilters() {
    let result = FILTER_UTILS.filter(APP_STATE.allSubsidies, APP_STATE.filters);
    result = FILTER_UTILS.sort(result, APP_STATE.sort);
    UI.renderCards(result);
  },

  openModal(id) {
    const subsidy = APP_STATE.allSubsidies.find(s => s.id === id);
    if (subsidy) UI.openModal(subsidy);
  },

  // ==================== AI逆引き検索 ====================

  async runAISearch() {
    const textarea = document.getElementById('ai-intent-input');
    if (!textarea) return;

    const intent = textarea.value.trim();
    if (!intent) {
      UI.showToast('やりたいこと・困っていることを入力してください', 'error');
      return;
    }

    const btn = document.getElementById('ai-search-btn');
    if (btn) { btn.disabled = true; btn.textContent = '検索中…'; }
    UI.showAILoading();

    try {
      const result = await GEMINI_API.searchByIntent(intent, APP_STATE.allSubsidies, {
        onRateLimit: (waitMs, attempt) => UI.showAIRateLimitMessage(waitMs, attempt),
      });
      UI.renderAIResults(result);
    } catch (err) {
      console.error('[APP] runAISearch error:', err);
      UI.showAIError(err instanceof GeminiError ? err.message : `検索に失敗しました: ${err.message}`);
    } finally {
      UI.hideAILoading();
      if (btn) { btn.disabled = false; btn.textContent = '🔍 検索する'; }
    }
  },

  // ==================== イベントバインド ====================

  _bindEvents() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => APP._switchTab(btn.getAttribute('data-tab')));
    });

    const refetchBtn = document.getElementById('refetch-btn');
    if (refetchBtn) refetchBtn.addEventListener('click', () => APP.loadSubsidies(true));

    const closeModal = document.getElementById('close-detail-modal');
    if (closeModal) closeModal.addEventListener('click', () => UI.closeModal());

    document.querySelectorAll('.modal-overlay').forEach(overlay => {
      overlay.addEventListener('click', e => { if (e.target === overlay) UI.closeModal(); });
    });

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') UI.closeModal();
    });

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

    const catFilter    = document.getElementById('filter-category');
    const issuerFilter = document.getElementById('filter-issuer');
    const statusFilter = document.getElementById('filter-status');
    const sortSelect   = document.getElementById('sort-select');

    if (catFilter)    catFilter.addEventListener('change',    () => { APP_STATE.filters.category = catFilter.value;    APP.applyFilters(); });
    if (issuerFilter) issuerFilter.addEventListener('change', () => { APP_STATE.filters.issuer   = issuerFilter.value; APP.applyFilters(); });
    if (statusFilter) statusFilter.addEventListener('change', () => { APP_STATE.filters.status   = statusFilter.value; APP.applyFilters(); });
    if (sortSelect)   sortSelect.addEventListener('change',   () => { APP_STATE.sort             = sortSelect.value;   APP.applyFilters(); });

    const doReset = () => {
      APP_STATE.filters = { category: 'all', issuer: 'all', status: 'all', keyword: '' };
      APP_STATE.sort = 'default';
      if (searchInput)  searchInput.value  = '';
      if (catFilter)    catFilter.value    = 'all';
      if (issuerFilter) issuerFilter.value = 'all';
      if (statusFilter) statusFilter.value = 'all';
      if (sortSelect)   sortSelect.value   = 'default';
      APP.applyFilters();
    };
    const resetBtn  = document.getElementById('reset-filters-btn');
    const resetBtn2 = document.getElementById('reset-filters-btn-2');
    if (resetBtn)  resetBtn.addEventListener('click', doReset);
    if (resetBtn2) resetBtn2.addEventListener('click', doReset);

    const aiBtn = document.getElementById('ai-search-btn');
    if (aiBtn) aiBtn.addEventListener('click', () => APP.runAISearch());

    const aiTextarea = document.getElementById('ai-intent-input');
    if (aiTextarea) {
      aiTextarea.addEventListener('keydown', e => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); APP.runAISearch(); }
      });
    }
  },

  _renderExampleChips() {
    const container = document.getElementById('example-chips');
    if (!container) return;
    const examples = [
      '益田市に移住して農業を始めたい',
      '益田市で中小企業のIT化を進めたい',
      '子育て中で家のリフォームをしたい',
      '益田市で飲食店を新規開業したい',
      '益田市で林業に就きたい',
    ];
    examples.forEach(text => {
      const btn = document.createElement('button');
      btn.className = 'example-chip';
      btn.setAttribute('role', 'listitem');
      btn.textContent = text;
      btn.addEventListener('click', () => {
        const ta = document.getElementById('ai-intent-input');
        if (ta) ta.value = text;
      });
      container.appendChild(btn);
    });
  },

  _switchTab(tab) {
    APP_STATE.currentTab = tab;
    document.querySelectorAll('.tab-btn').forEach(btn => {
      const active = btn.getAttribute('data-tab') === tab;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    document.querySelectorAll('.tab-panel').forEach(panel => {
      panel.classList.toggle('hidden', panel.getAttribute('data-panel') !== tab);
    });
  },
};

document.addEventListener('DOMContentLoaded', () => APP.init());
