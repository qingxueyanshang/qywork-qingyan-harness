# 发布 Windows 安装包

Windows 安装包通过 `.github/workflows/release-windows.yml` 构建。工作流只能手动触发，
构建完成后先创建 GitHub 草稿 Release，不会自动公开。

## 发布前

首次发布自动更新版本前，在仓库 Actions 中配置：

- Variable `QYWORK_UPDATER_PUBLIC_KEY`：Tauri updater 公钥全文；
- Secret `TAURI_SIGNING_PRIVATE_KEY`：对应的私钥全文；
- Secret `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：私钥密码（无密码时留空）。

使用 `bun run --cwd apps/desktop tauri signer generate` 生成密钥，私钥另行备份且不入库。
同一发布渠道必须持续使用同一对密钥。工作流把公钥编入客户端，同时校验发布构建的签名配置；
缺少密钥会停止发布。Updater 签名用于验证下载来源，与 Windows Authenticode 是两回事。

日常 `bun run tauri:build` 不生成更新签名产物，仍可在没有私钥时构建本地测试包。
正式工作流通过构建配置启用更新产物和签名；这份配置不改写仓库的本地打包设置。

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
- 安装包的 `.sig` 签名与 `latest.json` 更新清单；
- `SHA256SUMS-windows-x86_64.txt` 完整性校验文件；
- GitHub 根据提交记录生成的版本说明。

工作流使用仓库自带的 `GITHUB_TOKEN` 写入 Release，不需要配置 SSH 或个人访问令牌。

## 公开发布

在 GitHub 的 **Releases** 页面打开草稿，完成以下检查：

1. 标签和标题中的版本与 `VERSION` 一致；
2. 安装程序可以在 Windows x64 上完成安装、启动和卸载；
3. 安装包的 SHA-256 与 `SHA256SUMS-windows-x86_64.txt` 一致；
4. 版本说明准确描述本次变化。
5. `latest.json` 的版本、Windows x64 下载地址及签名指向同一安装包；
6. 用上一版带相同更新公钥的客户端完成下载、重启更新，并确认项目与配置保留。

检查通过后再点击 **Publish release**。草稿不会出现在公开下载页，发布后 README 的下载入口
才会面向访客提供安装包。

当前安装包没有 Authenticode 签名，Windows 可能显示 SmartScreen 提示；这不阻塞草稿构建和
GitHub Release 上传。

## 应用内更新

设置 → 通用 → 软件更新提供自动检查、自动下载和手动操作。应用运行时每 6 小时检查正式
Release，默认自动下载；下载完成后由用户点击更新，任务仍在运行时等待，等待可以取消。

Windows 安装版验证签名后运行完整安装包；下载缓存在当前进程内，退出后需要重新下载。
首次从没有更新功能的旧版升级，需要手动安装一次。未嵌入公钥的本地测试包只提供手动下载入口。

`start.bat` 的桌面与 Web 模式由同一个源码启动器负责：后台只获取 Release 标签的 Git 对象，
点击后检查 master 分支、干净工作区和快进关系，退出进程后合并、安装锁定依赖并完整重启。
本地改动、领先提交或分叉会阻止更新，不自动暂存或覆盖。失败记录位于 `.tmp/update/`，
下次启动会显示更新失败原因。源码更新不修改全局项目数据或配置。

远程连接的 Web 页面没有本机更新入口。当前自动应用更新范围为 Windows；未支持的平台提供
GitHub 下载入口。正式发布与实际跨版本安装验收必须在签名配置完成后执行。
