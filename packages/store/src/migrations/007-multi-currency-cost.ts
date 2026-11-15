import type { Migration } from './shared.ts'

export const migration007: Migration = {
  id: 7,
  name: 'multi_currency_cost',
  /**
   * 账本与 run 改为多币种，**不做汇率换算**。
   *
   * 内置目录扩展到九家厂商后，阿里 / 月之暗面 / 智谱三家官网按人民币标价。
   * 可选方案有三种：
   *
   * 1. 换算为美元：需要汇率。汇率持续变动，写入磁盘的数值很快不再准确，
   *    但看起来仍是确切的金额。
   * 2. 将人民币金额写入 `cost_usd`：字段名与实际币种不符，数值相差约七倍且界面上无法分辨。
   * 3. 记录币种，各币种分开合计。**采用此方案。**
   *
   * 列名一并从 `cost_usd` 改为 `cost`。这不违反「已落盘的键名不改」：
   * 该规则防止的是无法读取旧数据，而 RENAME COLUMN 会原样保留数据；
   * 保留名称与内容不符的列反而会误导后续读表的人。
   *
   * 存量行一律记为 `'USD'`：迁移之前目录中只有 Anthropic 与 DeepSeek 两家，
   * 均以美元标价，因此该默认值是事实，不是推测。
   */
  sql: `
ALTER TABLE runs RENAME COLUMN cost_usd TO cost;
ALTER TABLE runs ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD';
ALTER TABLE usage_ledger RENAME COLUMN cost_usd TO cost;
ALTER TABLE usage_ledger ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD';
`,
}
