---
name: rust-sources-not-rustfmt-formatted
description: 本仓库的 Rust 源码不按 rustfmt 排版，不要运行 cargo fmt；它会改写整个包并混入其他会话未提交的改动
metadata:
  type: project
---

`apps/desktop/src-tauri` 与 `apps/desktop/native/computer-host` 的 Rust 源码不按 rustfmt 的默认规则排版，门禁中只有
`cargo check` 与 `cargo test`，没有格式检查。

2026-11-13 执行 `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- <两个文件>`，`--` 之后的文件参数没有限定范围：
该包与它引用的模块共 26 个文件被改写，其中 `lib.rs` 与 `build.rs` 含另一个会话未提交的改动。

**Why:** 改写产生的差异与本次改动无关（CLAUDE.md B2），并且与共用工作区中其他会话的改动混在同一个文件中，无法用 `git checkout` 直接还原。

**How to apply:** 修改 Rust 文件后不运行 `cargo fmt`，沿用所在文件的排版。已经误改写时的还原方法：
逐个文件比较「`rustfmt` 处理 HEAD 版本的结果」与工作区文件，相同的用 `git checkout` 还原；不同的文件含其他改动，
以 HEAD 版本为 ours、`rustfmt` 处理的 HEAD 版本为 base、工作区文件为 theirs 执行 `git merge-file --theirs`。
共用工作区的其他注意事项见 [[scratch-dir-shared-between-sessions]]。
