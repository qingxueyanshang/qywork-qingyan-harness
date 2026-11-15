import type { Migration } from './shared.ts'

export const migration002: Migration = {
  id: 2,
  name: 'intermediate_resources',
  sql: /* sql */ `
-- 中间资源登记表。
--
-- 正文不在本表，而在另一个数据库（qywork_content.sqlite3）中，按 content_hash 寻址。
-- 本表只存定位信息：产生者、大小、类型与哈希。
--
-- 跨库没有外键，blob 的存在由写入顺序保证：
-- 先在正文库写定 blob，再向本表插入行。顺序颠倒会使本表指向不存在的正文，
-- 且该损坏要到模型读取时才会暴露。
--
-- content_hash 可空：status='failed' 的资源（获取中途中断）没有写定的正文，
-- 但登记必须保留：模型需要看到此处有一条未能取得的结果，
-- 否则读起来与工具未执行无法区分。
CREATE TABLE intermediate_resources (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_id       TEXT,
  tool_name     TEXT NOT NULL,
  -- 资源的语义来源（web_fetch / shell / download 等），决定预览方式。
  source_type   TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('complete','partial','failed')),
  content_hash  TEXT,
  size_bytes    INTEGER NOT NULL DEFAULT 0,
  mime_type     TEXT,
  -- 覆盖范围：截断量、原始行数与查询条件。模型据此判断所见内容是否完整。
  coverage      TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_ir_run ON intermediate_resources(run_id, created_at);
-- GC 按哈希反查引用，无索引即全表扫描。
CREATE INDEX idx_ir_hash ON intermediate_resources(content_hash);
`,
}
