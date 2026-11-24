# 发布到 Morz 插件市场

## 发布状态：已上架（待扫描收录）

| 项 | 结果 |
|---|---|
| 仓库 | https://github.com/juestchaos/morz-folder-icons （public） |
| 分支 / Tag | `main` / `v1.0.0`（annotated，与 `manifest.version` 一致） |
| Release | https://github.com/juestchaos/morz-folder-icons/releases/tag/v1.0.0 |
| Topic | `morz-plugin`（另有 `morz`、`markdown`、`productivity`） |
| 字节校验 | tag 内 `main.js` 381358 B、`manifest.json` 388 B，与本地 sha256 一致 |
| 作者 / 本地目录 | `pkmer` / `morz-folder-icons` |
| 待完成 | 官方扫描器每日 03:00 UTC 收录，最长约 24h 后出现在插件市场 |

自测安装：Morz → 设置 → 第三方插件 → **从仓库安装…** → 输入 `juestchaos/morz-folder-icons`。

一键发布脚本见 `publish-remote.sh`（读取 `../.github-token`，push 用 `http.extraheader` 注入凭据，token 不进 remote URL）。

---

Morz 用 **DSH 自发布**模式：作者给 GitHub 仓库打 topic 标签即可上架，**无需 PR、无需排队审核**。
官方扫描器每天 03:00 UTC 扫一遍 GitHub，通过确定性校验的仓库自动进入社区索引。

## 一、发布前必改

| 项 | 当时的值 | 现在 |
|---|---|---|
| `manifest.json` 的 `author` | `"local"` | ✅ `"pkmer"` |
| GitHub 仓库名 | — | ✅ `morz-folder-icons`（本地目录已同名） |
| `manifest.id` | `folder-icons` | 保持不动——它是市场主键，改了等于换一个插件，已装用户的配置会失联 |

## 二、三步上架

```bash
cd morz-folder-icons

# 1) 推仓库：manifest.json + main.js 必须在仓库根目录
git init
git add manifest.json main.js icon-128.svg icon.svg icon-128.png README.md
git commit -m "morz-folder-icons v1.0.0"
git remote add origin https://github.com/<你的账号>/morz-folder-icons.git
git push -u origin main

# 2) 打 tag（必须 v 开头，且与 manifest.version 完全一致）+ 发 Release
git tag -a v1.0.0 -m "morz-folder-icons v1.0.0"
git push origin v1.0.0
gh release create v1.0.0 --title "v1.0.0" --notes "首个版本：文件树文件夹图标、图标搜索、名称规则"

# 3) 加 topic —— 这一步才是"提交"
gh repo edit --add-topic morz-plugin
```

完成后等下一次扫描（最长约 24 小时），在 **设置 → 插件市场** 搜索「文件夹图标」。

> 不等扫描立刻自测：对方在客户端用 **「从仓库安装…」** 直接输入 `你的账号/folder-icons`。

## 三、自动审核的硬规则

扫描器是确定性校验，不通过就进不了索引：

| 规则 | 本插件 |
|---|---|
| manifest 合法 JSON、有 id/name/version | ✅ |
| `version` 是 semver | ✅ `1.0.0` |
| 插件必须有 `sdk: 1` | ✅ |
| 入口文件存在且 ≤ 5MB | ✅ `main.js` 372 KB |
| 代码导出 `activate` | ✅ |
| 声明 `vault:read` 就不能出现 `vault.write/delete/create` | ✅ 只有 `vault.exists/list/on` |
| 不得出现 `eval(` / `new Function(` | ✅ 各 0 处 |
| 不得有未声明的外部域名请求 | ✅ 无网络请求 |

通过后条目自动带 `sha256`，客户端安装时逐字节校验——扫描时审到的内容就是用户下载到的内容。

## 四、版本更新

```bash
# 改 manifest.json 的 version，然后
git commit -am "v1.0.1"
git tag v1.0.1 && git push origin v1.0.1
gh release create v1.0.1 --title "v1.0.1" --notes "更新说明"
```

索引对比 `version` 判断是否可更新；安装永远钉在索引声明的 tag 上，作者后来改分支不会影响已发布版本。
插件数据（`data.json` / `ctx.storage`）升级时不清空，更新失败自动回滚。

## 五、进官方精选索引（可选，需 PR）

社区索引之外的「官方精选」是人工策展，只有这条路径需要 PR：

1. Fork `cumany/Morz`
2. 在 `registry/index.json` 的 `plugins` 数组加一条，`trust` 必须写 `community`
3. 本地跑 `node registry/validate.mjs`（无依赖）
4. 提 PR，CI 跑同一个校验器，维护者审代码后合并；`official` / `verified` 由维护者设置

索引条目字段：`id / name / description / author / repo / version / tag / trust`，可选
`minAppVersion / permissions / sha256 / homepage / changelog / icon`。
`id` 在全市场唯一，`repo` 必须是 `owner/repo`，数组按 `id` 排序。

## 六、已知取舍

| 项 | 说明 |
|---|---|
| `icon` 字段作用范围 | 官方文档定位是「市场卡片图标（128×128 推荐，列表显示 24px）」。已装插件列表是否也读它未经证实 |
| 仓库暴露源码 | 若把整个 `folder-icons/` 推上去，`src/`（含 337 KB Lucide 源数据）和测试脚本也会公开。想收敛就只推 `manifest.json`、`main.js`、图标、README |
| `minAppVersion` | 本插件用了 SDK v1.8 的 `decorateFileTree` / `fileTreeMenu`，老版本装了会报错。若确认 v1.8 对应的应用版本号，建议在索引条目补 `minAppVersion` |
