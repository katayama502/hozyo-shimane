/**
 * ui.js
 * DOM操作・カード描画・モーダル開閉・スケルトンUI・エラー表示
 */

const UI = {
  /**
   * テキストをエスケープしてDOM安全な文字列にする
   */
  escape(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
  },

  // ==================== ローディング ====================

  /**
   * スケルトンUIを表示する
   * @param {number} count - スケルトンカードの枚数
   */
  showSkeleton(count = 6) {
    const grid = document.getElementById('cards-grid');
    const empty = document.getElementById('empty-state');
    const error = document.getElementById('error-state');

    if (empty) empty.classList.add('hidden');
    if (error) error.classList.add('hidden');

    if (!grid) return;
    grid.innerHTML = '';
    for (let i = 0; i < count; i++) {
      const el = document.createElement('div');
      el.className = 'card skeleton-card';
      el.innerHTML = `
        <div class="skeleton-line skeleton-title"></div>
        <div class="skeleton-line skeleton-text"></div>
        <div class="skeleton-line skeleton-text short"></div>
        <div class="skeleton-footer">
          <div class="skeleton-line skeleton-badge"></div>
          <div class="skeleton-line skeleton-amount"></div>
        </div>
      `;
      grid.appendChild(el);
    }
  },

  /**
   * ローディングオーバーレイをAIサーチに表示
   */
  showAILoading() {
    const el = document.getElementById('ai-loading');
    if (el) el.classList.remove('hidden');
    const results = document.getElementById('ai-results');
    if (results) results.classList.add('hidden');
  },

  hideAILoading() {
    const el = document.getElementById('ai-loading');
    if (el) el.classList.add('hidden');
  },

  // ==================== カード描画 ====================

  /**
   * 補助金カード一覧を描画する
   * @param {Array} subsidies - 表示する補助金
   */
  renderCards(subsidies) {
    const grid = document.getElementById('cards-grid');
    const empty = document.getElementById('empty-state');
    const error = document.getElementById('error-state');

    if (error) error.classList.add('hidden');
    if (!grid) return;

    grid.innerHTML = '';

    if (subsidies.length === 0) {
      if (empty) empty.classList.remove('hidden');
      return;
    }

    if (empty) empty.classList.add('hidden');

    const fragment = document.createDocumentFragment();
    subsidies.forEach(s => {
      fragment.appendChild(UI._createCard(s));
    });
    grid.appendChild(fragment);

    // カード数を更新
    UI.updateCount(subsidies.length);
  },

  /**
   * 補助金カード要素を生成する
   * @param {object} subsidy
   * @returns {HTMLElement}
   */
  _createCard(subsidy) {
    const card = document.createElement('article');
    card.className = 'card subsidy-card';
    card.setAttribute('data-id', UI.escape(subsidy.id));
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    card.setAttribute('aria-label', subsidy.title + ' の詳細を見る');

    const deadlineBadge = UI._createDeadlineBadge(subsidy.deadline, subsidy.status);
    const categoryBadge = UI._createCategoryBadge(subsidy.category);
    const amountText = FILTER_UTILS.formatAmount(subsidy.maxAmount);

    // 締切表示テキスト
    let deadlineText = '締切：常時受付';
    if (subsidy.deadline) {
      const d = new Date(subsidy.deadline);
      const y = d.getFullYear();
      const m = d.getMonth() + 1;
      const day = d.getDate();
      deadlineText = `締切：${y}年${m}月${day}日`;
    }

    // カード内容をDOM APIで構築
    const header = document.createElement('div');
    header.className = 'card-header';

    const badges = document.createElement('div');
    badges.className = 'card-badges';
    badges.appendChild(categoryBadge);
    if (deadlineBadge) badges.appendChild(deadlineBadge);
    header.appendChild(badges);

    const issuerEl = document.createElement('span');
    issuerEl.className = 'card-issuer';
    issuerEl.textContent = subsidy.issuer;
    header.appendChild(issuerEl);

    const title = document.createElement('h3');
    title.className = 'card-title';
    title.textContent = subsidy.title;

    const desc = document.createElement('p');
    desc.className = 'card-desc';
    desc.textContent = subsidy.simpleDescription || subsidy.description;

    const footer = document.createElement('div');
    footer.className = 'card-footer';

    const deadlineEl = document.createElement('span');
    deadlineEl.className = 'card-deadline';
    deadlineEl.textContent = deadlineText;

    const amountEl = document.createElement('span');
    amountEl.className = 'card-amount';
    amountEl.textContent = `最大 ${amountText}`;

    footer.appendChild(deadlineEl);
    footer.appendChild(amountEl);

    card.appendChild(header);
    card.appendChild(title);
    card.appendChild(desc);
    card.appendChild(footer);

    // クリックイベント
    const openModal = () => APP_STATE && APP.openModal(subsidy.id);
    card.addEventListener('click', openModal);
    card.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openModal();
      }
    });

    return card;
  },

  /**
   * 締切バッジ要素を生成する
   */
  _createDeadlineBadge(deadline, status) {
    if (status === '終了') {
      const badge = document.createElement('span');
      badge.className = 'badge badge-expired';
      badge.textContent = '終了';
      return badge;
    }

    const badgeType = FILTER_UTILS.getDeadlineBadgeType(deadline);
    if (!badgeType || badgeType === 'normal') return null;

    const badge = document.createElement('span');
    if (badgeType === 'expired') {
      badge.className = 'badge badge-expired';
      badge.textContent = '期限切れ';
    } else if (badgeType === 'urgent') {
      const days = FILTER_UTILS.getDaysUntilDeadline(deadline);
      badge.className = 'badge badge-urgent';
      badge.textContent = days === 0 ? '本日締切' : `残${days}日`;
    } else if (badgeType === 'soon') {
      const days = FILTER_UTILS.getDaysUntilDeadline(deadline);
      badge.className = 'badge badge-soon';
      badge.textContent = `残${days}日`;
    }
    return badge;
  },

  /**
   * カテゴリバッジ要素を生成する
   */
  _createCategoryBadge(category) {
    const badge = document.createElement('span');
    badge.className = `badge badge-category badge-cat-${UI._categorySlug(category)}`;
    badge.textContent = category;
    return badge;
  },

  _categorySlug(category) {
    const map = {
      '農業・林業・水産業': 'agri',
      '中小企業・創業支援': 'biz',
      '移住・定住支援': 'move',
      '子育て・教育': 'child',
      '住宅・リフォーム': 'house',
      'ITデジタル化': 'it',
      'その他': 'other',
    };
    return map[category] || 'other';
  },

  // ==================== カード数表示 ====================

  updateCount(count) {
    const el = document.getElementById('result-count');
    if (el) el.textContent = `${count}件`;
  },

  // ==================== フィルターオプション更新 ====================

  /**
   * フィルタードロップダウンのオプションを更新する
   * @param {Array} subsidies
   */
  updateFilterOptions(subsidies) {
    const categories = FILTER_UTILS.getCategories(subsidies);
    const issuers = FILTER_UTILS.getIssuers(subsidies);

    UI._updateSelect('filter-category', categories, 'カテゴリ（全て）');
    UI._updateSelect('filter-issuer', issuers, '発行元（全て）');
  },

  _updateSelect(id, options, placeholder) {
    const sel = document.getElementById(id);
    if (!sel) return;
    const current = sel.value;
    // allオプション以外を削除
    while (sel.options.length > 1) sel.remove(1);
    options.forEach(opt => {
      const o = document.createElement('option');
      o.value = opt;
      o.textContent = opt;
      sel.appendChild(o);
    });
    // 以前の選択を復元
    if (current && options.includes(current)) sel.value = current;
  },

  // ==================== 取得日時表示 ====================

  updateFetchTime(isoString) {
    const el = document.getElementById('fetch-time');
    if (!el) return;
    if (!isoString) {
      el.textContent = '';
      return;
    }
    const d = new Date(isoString);
    const pad = n => String(n).padStart(2, '0');
    const text = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())} 時点の情報`;
    el.textContent = text;
  },

  // ==================== エラー表示 ====================

  showError(message, onRetry) {
    const grid = document.getElementById('cards-grid');
    const empty = document.getElementById('empty-state');
    const errorEl = document.getElementById('error-state');
    const errorMsg = document.getElementById('error-message');

    if (grid) grid.innerHTML = '';
    if (empty) empty.classList.add('hidden');
    if (errorEl) errorEl.classList.remove('hidden');
    if (errorMsg) errorMsg.textContent = message;

    const retryBtn = document.getElementById('retry-btn');
    if (retryBtn && onRetry) {
      retryBtn.onclick = onRetry;
    }
  },

  hideError() {
    const errorEl = document.getElementById('error-state');
    if (errorEl) errorEl.classList.add('hidden');
  },

  // ==================== 詳細モーダル ====================

  openModal(subsidy) {
    const modal = document.getElementById('detail-modal');
    if (!modal) return;

    // タイトル
    UI._setText('modal-title', subsidy.title);
    UI._setText('modal-simple-desc', subsidy.simpleDescription);
    UI._setText('modal-description', subsidy.description);
    UI._setText('modal-category', subsidy.category);
    UI._setText('modal-issuer', subsidy.issuer);
    UI._setText('modal-region', subsidy.region);
    UI._setText('modal-requirements', subsidy.requirements);

    // 金額
    UI._setText('modal-amount', FILTER_UTILS.formatAmount(subsidy.maxAmount));

    // 締切
    const deadlineEl = document.getElementById('modal-deadline');
    if (deadlineEl) {
      if (subsidy.deadline) {
        const d = new Date(subsidy.deadline);
        const days = FILTER_UTILS.getDaysUntilDeadline(subsidy.deadline);
        const badgeType = FILTER_UTILS.getDeadlineBadgeType(subsidy.deadline);
        let daysStr = '';
        if (days !== null) {
          if (days < 0) daysStr = '（期限切れ）';
          else if (days === 0) daysStr = '（本日締切）';
          else daysStr = `（残${days}日）`;
        }
        deadlineEl.textContent = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${daysStr}`;
        deadlineEl.className = `modal-deadline-value deadline-${badgeType || 'normal'}`;
      } else {
        deadlineEl.textContent = '常時受付 / 随時';
        deadlineEl.className = 'modal-deadline-value';
      }
    }

    // 対象者
    const targetEl = document.getElementById('modal-target-users');
    if (targetEl) {
      targetEl.innerHTML = '';
      (subsidy.targetUsers || []).forEach(user => {
        const chip = document.createElement('span');
        chip.className = 'target-chip';
        chip.textContent = user;
        targetEl.appendChild(chip);
      });
    }

    // ステータスバッジ
    const statusEl = document.getElementById('modal-status');
    if (statusEl) {
      statusEl.textContent = subsidy.status;
      statusEl.className = `modal-status status-${subsidy.status === '受付中' ? 'active' : subsidy.status === '受付予定' ? 'upcoming' : 'closed'}`;
    }

    // 申請URLリンク
    const linkEl = document.getElementById('modal-link');
    if (linkEl) {
      linkEl.href = subsidy.applicationUrl;
      linkEl.textContent = '公式サイトで申請する →';
    }

    // カテゴリバッジ
    const catBadgeEl = document.getElementById('modal-category-badge');
    if (catBadgeEl) {
      catBadgeEl.textContent = subsidy.category;
      catBadgeEl.className = `badge badge-category badge-cat-${UI._categorySlug(subsidy.category)}`;
    }

    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('modal-open');

    // フォーカス管理
    const closeBtn = modal.querySelector('.modal-close');
    if (closeBtn) closeBtn.focus();
  },

  closeModal() {
    const modal = document.getElementById('detail-modal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('modal-open');
  },

  // ==================== APIキーモーダル ====================

  openApiKeyModal() {
    const modal = document.getElementById('apikey-modal');
    if (!modal) return;
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    const input = document.getElementById('apikey-input');
    if (input) {
      const saved = localStorage.getItem('gemini_api_key') || '';
      input.value = saved;
      input.focus();
    }
  },

  closeApiKeyModal() {
    const modal = document.getElementById('apikey-modal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
  },

  // ==================== APIキーバナー ====================

  showApiKeyBanner() {
    const banner = document.getElementById('apikey-banner');
    if (banner) banner.classList.remove('hidden');
  },

  hideApiKeyBanner() {
    const banner = document.getElementById('apikey-banner');
    if (banner) banner.classList.add('hidden');
  },

  // ==================== AI検索結果 ====================

  renderAIResults(data) {
    const container = document.getElementById('ai-results');
    if (!container) return;

    container.innerHTML = '';
    container.classList.remove('hidden');

    // アドバイス表示
    if (data.advice) {
      const adviceEl = document.createElement('div');
      adviceEl.className = 'ai-advice';
      const icon = document.createElement('span');
      icon.className = 'ai-advice-icon';
      icon.textContent = '💡';
      const text = document.createElement('p');
      text.textContent = data.advice;
      adviceEl.appendChild(icon);
      adviceEl.appendChild(text);
      container.appendChild(adviceEl);
    }

    if (!data.results || data.results.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'ai-no-results';
      empty.textContent = '条件に合う補助金が見つかりませんでした。キーワードを変えて試してみてください。';
      container.appendChild(empty);
      return;
    }

    // 結果ヘッダー
    const header = document.createElement('p');
    header.className = 'ai-results-header';
    header.textContent = `${data.results.length}件の補助金が見つかりました`;
    container.appendChild(header);

    // 結果カード
    data.results.forEach((r, i) => {
      const card = UI._createAIResultCard(r, i);
      container.appendChild(card);
    });
  },

  _createAIResultCard(result, index) {
    const card = document.createElement('div');
    card.className = 'ai-result-card';

    const num = document.createElement('div');
    num.className = 'ai-result-num';
    num.textContent = index + 1;

    const content = document.createElement('div');
    content.className = 'ai-result-content';

    const headerRow = document.createElement('div');
    headerRow.className = 'ai-result-header';

    const title = document.createElement('h3');
    title.className = 'ai-result-title';
    title.textContent = result.title;

    const catBadge = document.createElement('span');
    catBadge.className = `badge badge-category badge-cat-${UI._categorySlug(result.category)}`;
    catBadge.textContent = result.category;

    headerRow.appendChild(title);
    headerRow.appendChild(catBadge);

    const reason = document.createElement('div');
    reason.className = 'ai-result-reason';
    const reasonIcon = document.createElement('span');
    reasonIcon.textContent = '✓ ';
    reasonIcon.className = 'reason-icon';
    const reasonText = document.createElement('span');
    reasonText.textContent = result.reason;
    reason.appendChild(reasonIcon);
    reason.appendChild(reasonText);

    const desc = document.createElement('p');
    desc.className = 'ai-result-desc';
    desc.textContent = result.simpleDescription;

    const meta = document.createElement('div');
    meta.className = 'ai-result-meta';

    const amountEl = document.createElement('span');
    amountEl.textContent = `最大 ${FILTER_UTILS.formatAmount(result.maxAmount)}`;

    const issuerEl = document.createElement('span');
    issuerEl.textContent = result.issuer;

    meta.appendChild(amountEl);
    meta.appendChild(issuerEl);

    if (result.requirements) {
      const req = document.createElement('p');
      req.className = 'ai-result-req';
      req.textContent = `条件: ${result.requirements}`;
      content.appendChild(headerRow);
      content.appendChild(reason);
      content.appendChild(desc);
      content.appendChild(meta);
      content.appendChild(req);
    } else {
      content.appendChild(headerRow);
      content.appendChild(reason);
      content.appendChild(desc);
      content.appendChild(meta);
    }

    if (result.nextStep) {
      const next = document.createElement('div');
      next.className = 'ai-next-step';
      const nextIcon = document.createElement('span');
      nextIcon.textContent = '→ ';
      const nextText = document.createElement('span');
      nextText.textContent = result.nextStep;
      next.appendChild(nextIcon);
      next.appendChild(nextText);
      content.appendChild(next);
    }

    const actions = document.createElement('div');
    actions.className = 'ai-result-actions';
    const link = document.createElement('a');
    link.href = result.applicationUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.className = 'btn btn-primary btn-sm';
    link.textContent = '公式サイトを確認する';
    actions.appendChild(link);
    content.appendChild(actions);

    card.appendChild(num);
    card.appendChild(content);

    return card;
  },

  showAIError(message) {
    const container = document.getElementById('ai-results');
    if (!container) return;
    container.innerHTML = '';
    container.classList.remove('hidden');

    const errEl = document.createElement('div');
    errEl.className = 'ai-error';
    errEl.textContent = message;
    container.appendChild(errEl);
  },

  // ==================== レート制限UI ====================

  /**
   * カード一覧エリアにレート制限エラーを表示（再試行ボタン付き）
   */
  showRateLimitError(message, retryAfterMs, onRetry) {
    const grid = document.getElementById('cards-grid');
    const empty = document.getElementById('empty-state');
    const errorEl = document.getElementById('error-state');
    const errorMsg = document.getElementById('error-message');

    if (grid) grid.innerHTML = '';
    if (empty) empty.classList.add('hidden');
    if (errorEl) errorEl.classList.remove('hidden');
    if (errorMsg) errorMsg.textContent = message;

    const retryBtn = document.getElementById('retry-btn');
    if (!retryBtn) return;

    if (retryAfterMs && retryAfterMs > 0) {
      retryBtn.disabled = true;
      let remaining = Math.ceil(retryAfterMs / 1000);
      retryBtn.textContent = `${remaining}秒後に再試行可能`;

      const tick = setInterval(() => {
        remaining--;
        if (remaining <= 0) {
          clearInterval(tick);
          retryBtn.disabled = false;
          retryBtn.textContent = '再試行する';
          if (onRetry) retryBtn.onclick = onRetry;
        } else {
          retryBtn.textContent = `${remaining}秒後に再試行可能`;
        }
      }, 1000);
    } else {
      retryBtn.disabled = false;
      retryBtn.textContent = '再試行する';
      if (onRetry) retryBtn.onclick = onRetry;
    }
  },

  /**
   * 取得中にレート制限が発生してリトライ待機中であることをステータスバーに表示
   */
  showRateLimitCountdown(waitMs, attempt) {
    const statusBar = document.getElementById('status-bar');
    let banner = document.getElementById('rate-limit-banner');

    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'rate-limit-banner';
      banner.className = 'rate-limit-banner';
      banner.setAttribute('role', 'status');
      if (statusBar) statusBar.after(banner);
    }

    let remaining = Math.ceil(waitMs / 1000);
    const updateText = () => {
      const icon = document.createElement('span');
      icon.textContent = '⏳ ';
      const text = document.createElement('span');
      text.textContent = `レート制限のため ${remaining}秒 待機中… (自動リトライ ${attempt}回目)`;
      banner.innerHTML = '';
      banner.appendChild(icon);
      banner.appendChild(text);
    };
    updateText();
    banner.classList.remove('hidden');

    const tick = setInterval(() => {
      remaining--;
      if (remaining <= 0) { clearInterval(tick); return; }
      updateText();
    }, 1000);
    banner._tickId = tick;
  },

  hideRateLimitCountdown() {
    const banner = document.getElementById('rate-limit-banner');
    if (!banner) return;
    if (banner._tickId) clearInterval(banner._tickId);
    banner.classList.add('hidden');
  },

  /**
   * AI検索中のレート制限メッセージ
   */
  showAIRateLimitMessage(waitMs, attempt) {
    const loadingEl = document.getElementById('ai-loading');
    if (!loadingEl) return;
    let msgEl = loadingEl.querySelector('.ai-ratelimit-msg');
    if (!msgEl) {
      msgEl = document.createElement('p');
      msgEl.className = 'ai-ratelimit-msg';
      loadingEl.appendChild(msgEl);
    }
    let remaining = Math.ceil(waitMs / 1000);
    msgEl.textContent = `レート制限のため ${remaining}秒 待機中… (リトライ ${attempt}回目)`;
    const tick = setInterval(() => {
      remaining--;
      if (remaining <= 0) { clearInterval(tick); msgEl.textContent = '再試行中…'; return; }
      msgEl.textContent = `レート制限のため ${remaining}秒 待機中… (リトライ ${attempt}回目)`;
    }, 1000);
  },

  // ==================== ユーティリティ ====================

  _setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text == null ? '' : String(text);
  },

  showToast(message, type = 'info') {
    const existing = document.getElementById('toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'toast';
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    requestAnimationFrame(() => toast.classList.add('toast-visible'));
    setTimeout(() => {
      toast.classList.remove('toast-visible');
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  },
};
