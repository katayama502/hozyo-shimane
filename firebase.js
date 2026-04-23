/**
 * firebase.js
 * Firebase Firestore クライアントモジュール（読み取り専用）
 *
 * - Firestore REST API を直接呼び出し（Firebase SDK不要）
 * - 書き込みはサーバーサイド（Netlify Function）のみ
 * - プロジェクトIDは公開情報のためクライアントコードに記載OK
 *
 * ★ FIREBASE_PROJECT_ID を自分のプロジェクトIDに変更してください ★
 */


const FIREBASE_PROJECT_ID = 'shimane-hojosearch'; // ← 変更必要

const FIREBASE = {
  STALE_THRESHOLD_MS: 7 * 24 * 60 * 60 * 1000, // 7日（週次更新）
  DOC_URL: `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/hojosearch/masuda`,

  /**
   * Firestore から補助金データを取得する
   * @returns {Promise<{subsidies: Array, fetchedAt: string, lastUpdated: string}|null>}
   */
  async getSubsidies() {
    if (FIREBASE_PROJECT_ID === 'YOUR_FIREBASE_PROJECT_ID') {
      console.warn('[Firebase] FIREBASE_PROJECT_ID が未設定です。firebase.js を編集してください。');
      return null;
    }

    try {
      const res = await fetch(FIREBASE.DOC_URL, {
        headers: { 'Content-Type': 'application/json' },
      });

      if (res.status === 404) return null; // ドキュメント未作成（初回）
      if (!res.ok) {
        console.warn('[Firebase] Firestore 読み取りエラー:', res.status);
        return null;
      }

      const doc = await res.json();
      const dataStr     = doc?.fields?.data?.stringValue;
      const lastUpdated = doc?.fields?.lastUpdated?.timestampValue;

      if (!dataStr) return null;

      const data = JSON.parse(dataStr);
      return { ...data, lastUpdated };
    } catch (err) {
      console.warn('[Firebase] 接続エラー:', err.message);
      return null;
    }
  },

  /**
   * データが古い（7日超）かどうか判定する
   * @param {string} lastUpdated - ISO8601タイムスタンプ
   * @returns {boolean}
   */
  isStale(lastUpdated) {
    if (!lastUpdated) return true;
    const updated = new Date(lastUpdated).getTime();
    if (isNaN(updated)) return true;
    return Date.now() - updated > FIREBASE.STALE_THRESHOLD_MS;
  },

  /**
   * 最終更新日時を人間が読める形式で返す
   * @param {string} lastUpdated
   * @returns {string}
   */
  formatLastUpdated(lastUpdated) {
    if (!lastUpdated) return '不明';
    const d = new Date(lastUpdated);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  },

  /**
   * 次回更新予定日時を返す
   * @param {string} lastUpdated
   * @returns {string}
   */
  formatNextUpdate(lastUpdated) {
    if (!lastUpdated) return '—';
    const next = new Date(new Date(lastUpdated).getTime() + FIREBASE.STALE_THRESHOLD_MS);
    const pad = n => String(n).padStart(2, '0');
    return `${next.getMonth() + 1}月${next.getDate()}日 ${pad(next.getHours())}:${pad(next.getMinutes())}`;
  },
};
