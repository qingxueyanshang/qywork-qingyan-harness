# 发布 Windows 安装包

Windows 安装包通过 `.github/workflows/release-windows.yml` 构建。工作流只能手动触发，
构建完成后先创建 GitHub 草稿 Release，不会自动公开。

## 发布前

版本号只改根目录的 `VERSION`：

```bash
bun run version:sync
bun run gate
git diff --check
```

确认代码、文档和版本号属于同一次发布后，将提交推送到 GitHub。

## 生成安装包

1. 打开仓库的 **Actions** 页面。
2. 选择 **Windows Release**。
3. 点击 **Run workflow**，确认分支为 `master` 后运行。工作流会拒绝其它分支。
4. 等待版本检查、全量门禁、Sidecar 构建和 NSIS 打包完成。

工作流会按 `VERSION` 创建 `v<version>` 标签对应的草稿 Release，并上传：

- Windows x64 NSIS 安装程序；
- `SHA256SUMS.txt` 完整性校验文件；
- GitHub 根据提交记录生成的版本说明。

工作流使用仓库自带的 `GITHUB_TOKEN` 写入 Release，不需要配置 SSH、个人访问令牌或额外密码。

## 公开发布

在 GitHub 的 **Releases** 页面打开草稿，完成以下检查：

1. 标签和标题中的版本与 `VERSION` 一致；
2. 安装程序可以在 Windows x64 上完成安装、启动和卸载；
3. 安装包的 SHA-256 与 `SHA256SUMS.txt` 一致；
4. 版本说明准确描述本次变化。

检查通过后再点击 **Publish release**。草稿不会出现在公开下载页，发布后 README 的下载入口
才会面向访客提供安装包。

当前安装包没有 Authenticode 签名，Windows 可能显示 SmartScreen 提示；这不阻塞草稿构建和
GitHub Release 上传。
