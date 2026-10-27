# 贡献规则（CONTRIBUTING）

本仓库是青记（Qing Notepad）插件市场的**线上数据源**。`main` 分支上的
`index.json` 被客户端直接消费（24 小时缓存），**合并即上线**。所以这里的
review 标准比一般文档仓库严：一条坏条目等于所有用户的市场列表里多一个
永远装不上的按钮。

字段定义、`sha256` 算法、白名单权限见 [`README.md`](./README.md)。

## 一、能提什么

| PR 类型 | 说明 | 标题格式 |
| --- | --- | --- |
| 上架新插件 | 往 `plugins` 追加一条 | `feat(index): 上架 <id> <version>` |
| 发布新版本 | 改**你自己**条目的 `version` / `download` / `sha256` | `feat(index): <id> 升到 <version>` |
| 修元数据 | 改描述、作者、repo、权限（权限只能减不能随意加） | `fix(index): 更正 <id> 的 <字段>` |
| 下架 | 删除条目，必须说明理由 | `chore(index): 下架 <id>` |
| 改索引格式 / 校验器 | 影响所有贡献者，需要维护者预先同意 | `feat(schema): ...` |

不确定能不能提，先开 issue 问，别直接改别人的条目。

## 二、提 PR 的硬规则

合并前会逐条核对，任一条不满足就打回：

1. **一个 PR 只做一件事。** 上架一个插件就只加一条；不要顺手重排别人的条目、
   不要顺手改格式、不要顺手升 `schema`。格式重排会让整份 diff 不可读，
   也让维护者无法判断你到底改了什么。
2. **只动你自己的条目。** 修改或删除他人条目会被直接关闭（下架除外，
   且必须在描述里给出理由：恶意行为、无法安装、作者本人请求）。
3. **`id` 一经发布不可改名、不可复用。** 改 id 等于发布新插件：老用户收不到更新，
   两个包还会并存。需要换 id 就走"下架 + 作为新插件上架"。
4. **`version` 只能严格递增。** 已发布过的版本号不得重复使用，即使字节完全相同。
   客户端靠 `version` 判断是否有更新。
5. **`sha256` 必须与 `download` 的真实字节一致。** 发布前请在干净目录重新下载一次
   并重算哈希（`Get-FileHash` 的结果要转小写）。这是唯一防篡改/防损坏的凭据。
6. **`download` 必须指向你自己 GitHub Release 上的固定 tag。**
   - 不要用 `main`/`master` 的 raw 地址，也不要用 `cdn.jsdelivr.net/gh/...@main`
     这类 jsDelivr 可变引用（内容可变，哈希必然漂移）。
   - 不要用第三方网盘、短链、会过期的签名 URL。
   - 不要提交 `http://`。
7. **包里必须能装上。** 请在真机上实际装一次：`plugin.json` 或 `package.json`
   能被解析、`main` 指向包内路径、声明的权限都在白名单里。
   索引登记的信息必须与包内清单一致（`id` / `version` / `permissions` / `engines`）——
   不要凭文件名猜。
8. **权限要写全、且是最小集。** 只声明真正用到的。用户是按权限弹窗决定装不装的，
   多要一个 `notes:write` 就会掉一批安装量。
9. **`index.json` 存成无 BOM 的 UTF-8，末尾保留换行。** 客户端 `serde_json`
   不接受 BOM，会静默解析失败、整个市场变空。
10. **CI 必须绿。** 每个 PR 会跑 `npm run validate`（零依赖，不需要 `npm install`）。
    本地请先跑一遍再提。

## 三、Review 流程

1. CI 跑 `node scripts/validate-index.mjs` → 红则直接打回，不看内容。
2. 维护者核对：包能不能装、权限是否最小、`download` 是否固定 tag、
   描述是否说得清用途。
3. 至少一位维护者 approve 后合并。
4. **合并 `index.json` 后必须 purge jsDelivr 缓存**（见下面的必做步骤），
   否则合并等于没合并。
5. 客户端自己还有一层 24 小时缓存（`INDEX_TTL_SECS`）。所以用户看到新内容的时机是
   **purge 成功之后**，再叠加客户端缓存过期或用户在插件页手动强制刷新。
   要立刻见效，就让用户强制刷新一次。

### 合并后必做：purge jsDelivr 缓存

jsDelivr 会缓存 `index.json`。**推完不 purge 就等于没推**：

```
https://purge.jsdelivr.net/gh/PyTs1n9/Qing-Notepad-Plugins@main/index.json
```

浏览器打开即可（GET），期望返回：

```json
{"status": "finished", "providers": {"CF": true, "FY": true}}
```

**症状极其隐蔽**：不 purge 时 `cdn.jsdelivr.net` 返回的是 **HTTP 200、内容也是合法
JSON**，只是**旧**——旧的 `download` 地址、旧的 `version`、旧的 `sha256`。也就是说
"市场列表能显示、点安装却报错"或"升级后版本号不变"这类问题，**先 purge 再排查**，
别第一时间怀疑客户端。GitHub Raw 那条源没有这层 CDN 缓存，但因为部分地区不可达，
它本来就不是可靠信号（见 README）。

如果示例包本身换了字节（不只是 `index.json` 变），包的地址同样要 purge：

```
https://purge.jsdelivr.net/gh/PyTs1n9/Qing-Notepad-Plugins@main/examples/<file>
```

正常情况下包不该重打包（sha256 会变，`index.json` 也得跟着改），所以需要 purge 的
永远是 `index.json` 这一条。

## 四、版本与撤回

- **升版本**：改 `version` + `download` + `sha256` + `updatedAt`，四者同一次提交内改齐。
  漏改任一项都会被 `sha256.artifact` 或 `download.mutable` 拦下。
- **撤回**（包有安全问题，必须立刻下架）：开 PR 删除该条目，标题 `chore(index): 下架 <id>`，
  描述里写清"为什么必须立刻下架"。这类 PR 优先合并，不必等常规 review 周期。
- 撤回后**不要**把同一个 `version` 重新上架：用户本地那份不会被替换。请直接发新版本号。

## 五、加字段 / 改格式

想给索引加字段（比如 `categories`、`size`、`icon`）：

1. 先开 issue 讨论，因为客户端也要同步改 `IndexEntry`，属于跨仓库改动。
2. 索引侧先行是安全的：客户端的 `IndexEntry` 忽略未知字段，
   校验器对未知字段**只警告不失败**，所以加字段不会连带旧客户端翻车。
3. 不要改已有字段的名字或语义；也**不要**把必填字段改成可选（客户端可能已经依赖它）。

## 六、本地自检清单

提 PR 前跑一遍：

```bash
npm run validate
```

然后确认：

- [ ] `npm run validate` 无错误（警告可解释）
- [ ] 只改了自己那一条 + 顶层 `updatedAt`
- [ ] `id` 没变过，`version` 比上一版大
- [ ] `sha256` 是对最终字节算的、已转小写
- [ ] `download` 是固定 tag 的 Release 直链
- [ ] 权限是最小集，且与包内清单一致
- [ ] 文件是无 BOM 的 UTF-8
