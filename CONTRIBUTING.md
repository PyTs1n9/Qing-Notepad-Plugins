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
6. **`download` 必须指向不可变的地址。**
   - 正式插件：你自己 GitHub Release 的固定 tag。
   - 本仓库 `examples/` 下的自举示例：`cdn.jsdelivr.net/gh/...@<commit-sha>/...`，
     SHA 写全 40 位，且必须是**包含该包字节的那个提交**（`git rev-parse <提交>`）。
   - 不要用 `main`/`master` 的 raw 地址，也不要用 `cdn.jsdelivr.net/gh/...@main`
     这类 jsDelivr 可变引用（内容可变，哈希必然漂移）。
   - 不要用第三方网盘、短链、会过期的签名 URL。不要提交 `http://`。
   - **重打包 = 两处一起改**：`sha256` 与 URL 里的 commit SHA。漏改任意一处，
     客户端会用 `E_SHA256_MISMATCH` 把包拒装——这是故意的 fail closed，不是 bug。
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
4. **合并 `index.json` 后由 CI 自动 purge jsDelivr 缓存**（见下一节）。CI 红了才需要
   人工补做——不 purge 的话，合并等于没合并。
5. 客户端自己还有一层 24 小时缓存（`INDEX_TTL_SECS`）。所以用户看到新内容的时机是
   **purge 成功之后**，再叠加客户端缓存过期或用户在插件页手动强制刷新。
   要立刻见效，就让用户强制刷新一次。

### 合并后：purge jsDelivr 缓存（CI 自动，失败才人工介入）

jsDelivr 会缓存 `index.json`。**推完不 purge 就等于没推**：客户端拿到的还是旧索引。

这一步由 CI 自动做（`.github/workflows/purge-jsdelivr.yml`），只在 `push: main`
且 `index.json` **实际变更**时触发——改 README / 改校验器不会去 purge。

```yaml
# CI 的成功判据（两条都满足才算成功）：
#   1. 返回体里 status == "finished"
#   2. 没有 throttled: true
# 拿不到 finished 或被限流 → job 红掉（不加 continue-on-error），最多重试 2 次。
```

**人工补救（只有 CI 红了才需要做）**：Actions 里跑一次 `purge-jsdelivr`
（workflow_dispatch），或直接浏览器 GET：

```
https://purge.jsdelivr.net/gh/PyTs1n9/Qing-Notepad-Plugins@main/index.json
```

期望返回：

```json
{"status": "finished", "providers": {"CF": true, "FY": true}}
```

**症状极其隐蔽**：不 purge 时 `cdn.jsdelivr.net` 返回的是 **HTTP 200、内容也是合法
JSON**，只是**旧**——旧的 `download` 地址、旧的 `version`、旧的 `sha256`。也就是说
"市场列表能显示、点安装却报错"或"升级后版本号不变"这类问题，**先看 purge 有没有跑成
再排查**，别第一时间怀疑客户端。GitHub Raw 那条源没有这层 CDN 缓存，但因为部分地区
不可达，它本来就不是可靠信号（见 README）。

如果示例包本身换了字节（不只是 `index.json` 变），包的地址同样要 purge：

```
https://purge.jsdelivr.net/gh/PyTs1n9/Qing-Notepad-Plugins@main/examples/<file>
```

正常情况下包不该重打包（sha256 会变，`index.json` 也得跟着改），所以需要 purge 的
永远是 `index.json` 这一条。

**purge 有配额，别拿脚本连打。** jsDelivr 的 purge 接口会限流，而且**限流期间它照样
返回 `status: "finished"`**，只是多带一个 `"throttled": true`：

1. **测试脚本不要连打 purge。** 真出过事故：连续调用十几次之后，第一次（未限流的那次）
   把好的缓存副本删掉、回源拿到的是更旧的副本，后面全被限流刷不动，线上反而变成旧索引。
2. **判断成功要两个字段一起看**：`status == "finished"` **且** 没有 `throttled: true`。
   只看 `finished` 会把"被限流"当成"刷好了"，这正是最坑的一类假象。
3. 被限流时返回体里有 `throttlingReset`（秒数），等窗口过了再试；连续失败不要无限重试，
   网络或配额问题需要人判断。CI 里也是这个判据，最多重试 2 次就红给人看。

## 四、版本与撤回

- **升版本**：改 `version` + `download` + `sha256` + `updatedAt`，同一次提交内改齐。
  漏改任一项都会被 `sha256.artifact` 或 `download.mutable` 拦下。
- **重打包自举示例**（`examples/` 下那几个包）：`download` 里的 commit SHA 指向的是
  "包含该包字节的那个提交"，所以只能分两步做，顺序不能反：
  1. 换包 → 提交（此时新 commit SHA 才存在）
  2. 用**新提交的 40 位 SHA** 改 `download`，同时重算 `sha256`，再提交
  只改哈希不改 URL 里的 SHA、或反过来，都会被 `E_SHA256_MISMATCH` 拒装（fail closed）。
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
