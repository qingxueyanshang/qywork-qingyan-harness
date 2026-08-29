# 发布桌面安装包

Windows 安装包通过 `.github/workflows/release-windows.yml` 构建；macOS 和 Linux 安装包通过
`.github/workflows/release-macos-linux.yml` 构建。两个工作流都只能手动触发。

Windows 工作流会创建 GitHub 草稿 Release。macOS/Linux 工作流会在 Actions 运行中上传构建产物，
需要发布到同一个 Release 时，将下载的产物和各自的 `SHA256SUMS.txt` 一并上传。

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

## macOS 与 Linux

1. 打开仓库的 **Actions** 页面。
2. 选择 **macOS and Linux Build**。
3. 点击 **Run workflow**，选择要构建的分支后运行。
4. 等待 `macOS arm64`、`macOS x64` 和 `Linux x64` 三个矩阵任务完成。
5. 在工作流的 **Artifacts** 区域下载对应平台的压缩包；每个产物都带有 `SHA256SUMS.txt`。

macOS 产物包含 `.dmg` 和 `.app.zip`；Linux 产物包含 `.deb` 和 `.AppImage`。
macOS 构建不依赖 Finder AppleScript，适合 GitHub Actions 的非交互环境。
