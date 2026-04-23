/**
 * prompts.js
 * Gemini APIへのプロンプト定義
 */

const PROMPTS = {
  /**
   * 島根県の補助金一覧を取得するメインプロンプト
   */
  fetchSubsidies: () => `
あなたは島根県の補助金・助成金制度に精通した専門家です。
2026年現在、島根県内で申請可能または近日中に申請受付が予定されている補助金・助成金・支援制度を、できる限り多く（目標30件以上）リストアップしてください。

以下のカテゴリを網羅してください：
- 農業・林業・水産業
- 中小企業・創業支援
- 移住・定住支援
- 子育て・教育
- 住宅・リフォーム
- ITデジタル化
- その他（福祉・環境・観光等）

国の補助金で島根県民も対象になるものも含めてください（例：ものづくり補助金、IT導入補助金、事業再構築補助金等）。

以下のJSON形式のみで返してください（説明文・マークダウン等は一切不要）：

{
  "subsidies": [
    {
      "id": "shimane-001",
      "title": "補助金・助成金の正式名称",
      "simpleDescription": "一般の方にわかりやすい説明（60文字以内）",
      "description": "補助金の詳細説明（200文字以内）",
      "category": "農業・林業・水産業",
      "targetUsers": ["農業従事者", "新規就農者"],
      "maxAmount": 1000000,
      "deadline": "2026-06-30",
      "issuer": "島根県",
      "region": "島根県全域",
      "applicationUrl": "https://www.pref.shimane.lg.jp/",
      "requirements": "主な申請条件（100文字以内）",
      "status": "受付中"
    }
  ]
}

フィールド説明：
- id: "shimane-" + 連番3桁（例: shimane-001）
- category: "農業・林業・水産業" / "中小企業・創業支援" / "移住・定住支援" / "子育て・教育" / "住宅・リフォーム" / "ITデジタル化" / "その他" のいずれか
- targetUsers: 対象者の配列（例: ["中小企業", "個人事業主"]）
- maxAmount: 補助上限額（円・数値）。不明または上限なしの場合は 0
- deadline: ISO日付形式 "YYYY-MM-DD"。不明・常時受付の場合は null
- issuer: "島根県" / "松江市" / "出雲市" / "国" など発行元
- region: "島根県全域" または具体的な市町村名
- applicationUrl: 公式ページURL（不明の場合は発行元の公式サイト）
- status: "受付中" / "受付予定" / "終了" のいずれか

注意：
- maxAmountは必ず数値（文字列不可）
- 実在する・実在する可能性が高い制度のみを記載
- 終了済みの制度は除外するか status: "終了" を設定
`,

  /**
   * AI逆引き検索プロンプト
   * @param {string} intent - ユーザーが入力した「やりたいこと・困っていること」
   * @param {Array} existingSubsidies - 既に取得済みの補助金リスト
   */
  reverseSearch: (intent, existingSubsidies = []) => {
    const existingTitles = existingSubsidies
      .map(s => `- ${s.title}（${s.category}）`)
      .slice(0, 20)
      .join('\n');

    return `
あなたは島根県の補助金・助成金のアドバイザーです。
ユーザーの状況・やりたいことに最も適した補助金・助成金を島根県内で提案してください。

【ユーザーの状況・やりたいこと】
${intent}

${existingTitles ? `【既にリストアップ済みの補助金（参考）】\n${existingTitles}\n` : ''}

上記の状況に合った島根県・国の補助金・助成金を5件以内で提案してください。
既存リストにないものも含めて構いません。

以下のJSON形式のみで返してください：

{
  "results": [
    {
      "title": "補助金名",
      "reason": "この補助金をおすすめする理由（ユーザーの状況に紐付けて100文字以内）",
      "simpleDescription": "補助金の概要（80文字以内）",
      "maxAmount": 500000,
      "deadline": "2026-06-30",
      "issuer": "島根県",
      "applicationUrl": "https://www.pref.shimane.lg.jp/",
      "category": "中小企業・創業支援",
      "requirements": "主な申請条件（100文字以内）",
      "nextStep": "今すぐできる次のアクション（60文字以内）"
    }
  ],
  "advice": "全体的なアドバイスや注意点（200文字以内）"
}
`;
  },
};
