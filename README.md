# 青记插件索引（Qing Notepad Plugins）

青记（Qing Notepad）的插件市场**只读这一个文件**：[`index.json`](./index.json)。
这个仓库是它的唯一登记处——包含一份索引、一个零依赖校验器，和 4 个自举示例包。

> 插件作者请读：[字段表](#字段表) → [sha256 怎么算](#sha256-怎么算) → [提交步骤](#提交步骤) → [被拒的常见原因](#被拒的常见原因)。
> 提 PR 之前请先读 [`CONTRIBUTING.md`](./CONTRIBUTING.md)。

---

## 客户端怎么用它

客户端（`src-tauri/src/plugin.rs` 的 `INDEX_URLS`）按顺序尝试两个地址，先成功者胜：

| 顺序 | 来源 | 地址 |
| --- | --- | --- |
| 1 | GitHub Raw | `https://raw.githubusercontent.com/PyTs1n9/Qing-Notepad-Plugins/main/index.json` |
| 2 | jsDelivr（兜底） | `https://cdn.jsdelivr.net/gh/PyTs1n9/Qing-Notepad-Plugins@main/index.json` |

行为要点：

- **缓存 24 小时**（`INDEX_TTL_SECS`），之后才重新拉；用户可以在插件页手动强制刷新。
- 两个地址都拉不到时**不报错**，降级为"仅本地安装"（.qnp / .zip 仍可直接装）。
  所以本仓库挂掉不会影响已装插件，只会让市场列表变空。
- 索引里的 `download` 是客户端**自己下载**的（走 Rust，不受 CSP 限制），下载后必须
  校验 `sha256`——这是"索引说它是 X"和"字节确实是 X"之间唯一的一致性证据。
- 因此 `main` 分支上的 `index.json` 是**线上数据**。合并即上线，没有灰度。

## 字段表

顶层结构：

```json
{ "schema": 1, "updatedAt": "2026-10-27T06:45:52Z", "plugins": [] }
```

| 字段 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- |
| `schema` | ✅ | 整数 | 目前只有 `1` |
| `updatedAt` | ✅ | 字符串 | ISO-8601 UTC，建议以 `Z` 结尾；每次改索引都要更新 |
| `plugins` | ✅ | 数组 | 每个元素见下表 |

单个插件条目：

| 字段 | 必填 | 类型 | 约束 / 被拒时的表现 |
| --- | --- | --- | --- |
| `id` | ✅ | string | 至少两段点分（`publisher.name`）；每段以 `[a-z0-9]` 开头、**不以 `-` 结尾**、中间只允许 `[a-z0-9-]`；整串 ≤ 64 字节。全小写，不允许 `_`、空格、大写。`ms-python.python` 合法（连字符在任意段都合法） |
| `name` | ✅ | string | 非空，≤ 96 字节。展示名，可以中文 |
| `description` | ✅ | string | 非空。一句话说清"这个插件解决什么问题" |
| `author` | ✅ | string | 非空。写成**字符串**（对象写法客户端也收，但本索引统一要求字符串） |
| `repo` | 建议 | string | `https://` 源码地址，指向 GitHub 仓库页面而不是 raw 文件 |
| `version` | ✅ | string | **严格 semver** `x.y.z`，可带 `-prerelease` / `+build`。不接受 `v` 前缀、不接受前导零（`1.00.0` 非法）、必须三段 |
| `apiVersion` | 可省 | 整数 | 省略视为 `1`；写了就必须是 `1` |
| `engines.host` | ✅ | string | 宿主版本区间，必须能被解析（见下）。建议统一写 `">=0.7.3 <1.0.0"` |
| `download` | ✅ | string | **必须是 `https://`**，指向 zip 字节，路径以 `.zip` 或 `.qnp` 结尾（两者本质同构） |
| `sha256` | ✅ | string | **必填**，64 位**小写**十六进制。缺失时客户端直接拒装（`E_SHA256_MISSING`） |
| `permissions` | ✅ | string[] | 只能是下面 8 个之一，不要重复声明 |
| `updatedAt` | 可省 | string | ISO-8601；建议填本次发布的时间 |

`permissions` 白名单（与客户端的 `KNOWN_PERMISSIONS` 逐字一致，写错会 `E_PERMISSION_UNKNOWN`）：

```
storage   notes:read   notes:write   todo:read
todo:write   clipboard:read   clipboard:write   notify
```

`engines.host` 支持的区间写法：空格分隔表示"且"（`>=0.7.3 <1.0.0`），`||` 表示"或"，
运算符接受 `>=` `>` `<=` `<` `=` `^` `~`，版本可以是部分版本或通配符（`1.2.x` / `1.x` / `*`）。
**不支持** hyphen range（`1.2.3 - 2.0.0`），请写成 `>=1.2.3 <=2.0.0`。

## sha256 怎么算

`sha256` 必须对**你上传的那个 zip/qnp 文件的字节**做哈希——不是源码目录、不是 tar 包。
任何一次重新打包都会改变它。

```powershell
# Windows PowerShell —— 结果是大写，必须转小写
(Get-FileHash .\qing.my-plugin-1.0.0.qnp -Algorithm SHA256).Hash.ToLower()
```

```bash
# macOS / Linux / Git Bash —— 本身就是小写
shasum -a 256 qing.my-plugin-1.0.0.qnp
# 或
sha256sum qing.my-plugin-1.0.0.qnp
```

拿到 64 位小写十六进制后填进 `sha256`。校验器会**直接对仓库里的文件重算一遍**：
如果 `download` 指向本仓库 `examples/` 下的同名包，哈希对不上会直接失败。

## 提交步骤

1. Fork 本仓库，clone 到本地（`main` 分支）。
2. 把包传到**你自己的** GitHub Release（打 tag，不要用 `main` 分支的 raw / jsDelivr 地址），
   拿到形如 `https://github.com/<you>/<repo>/releases/download/v1.0.0/qing.my-plugin-1.0.0.qnp` 的地址。
3. 算好 `sha256`（见上）。
4. 在 `index.json` 的 `plugins` 数组里**追加**一条（不要动别人的条目），并更新顶层 `updatedAt`。
5. 本地跑一遍校验（零依赖，不需要 `npm install`）：

   ```bash
   npm run validate
   ```

   全绿再提 PR。
6. 提交 PR，标题格式：`feat(index): 上架 <id> <version>`。
   在 PR 描述里贴上 Release 链接，并说明这个插件要哪些权限、为什么需要。

CI 会对每个 PR 跑同一个校验器（`.github/workflows/validate.yml`），
红的不予 review。

## 规则（硬性）

1. **`id` 一经发布不可改名、不可复用。** 改 id 等于换一个插件：老用户装的那份不会
   收到你的更新，两个包还会同时存在。想换 id 就先走"下架 + 当成新插件上架"。
2. **同一 `id` 在索引里只能出现一次。** 一个 id 对应一个包的一个版本，不做多版本并存。
3. **`version` 只能单调递增。** 已发布过的版本号不要重复使用——即使内容完全一样。
   客户端靠它判断"有没有更新"。
4. **`sha256` 必须与 `download` 的字节一致。** 这是唯一防篡改、防传输损坏的手段。
5. **不要删除别人的条目。** 需要下架请用 PR 说明理由（恶意、无法安装、作者请求），
   由维护者处理。
6. 索引里**只放元数据**，不放包本体（`examples/` 是唯一的例外，见下）。

## 关于 `examples/` 里的 4 个包

`examples/` 下这 4 个包是**自举示例**，用来证明整条链路（拉索引 → 下载 → 校验
sha256 → 装 → 授权 → 跑命令）在真机上通得了：

| 文件 | id |
| --- | --- |
| `qing.hello-headless-1.0.0.qnp` | `qing.hello-headless` |
| `qing.note-wordcount-1.0.0.qnp` | `qing.note-wordcount` |
| `qing.isolation-probe-1.0.0.qnp` | `qing.isolation-probe` |
| `qing.wordcount-ts-1.0.0.qnp` | `qing.wordcount-ts` |

它们的 `download` 指向本仓库 `main` 分支的 **jsDelivr** 地址
（`https://cdn.jsdelivr.net/gh/PyTs1n9/Qing-Notepad-Plugins@main/examples/<file>`），
是**故意的例外**：

- 为什么用 jsDelivr 而不是 `raw.githubusercontent.com`：**raw 在部分地区不可达**，
  应用内的 `reqwest` 会报 `error sending request for url (...)`，结果是"列表能看、
  点安装却装不上"——比不显示更糟。jsDelivr 有 CDN 兜底，索引本身也正是靠它加载出来的。
- jsDelivr 的 `@main` **不仅是可变引用，还是"粘滞引用"**，两件事都要记住：
  1. **可变**——重新打包示例包会让 `sha256` 失配。所以校验器对这 4 条给出
     `download.mutable` 警告（警告不阻断 CI），同时覆盖
     `raw.githubusercontent.com/.../main` 与 `cdn.jsdelivr.net/gh/...@main` 两种形态，
     提醒维护者改包时同步改哈希。
  2. **粘滞**——推了新内容不会立刻可见，要等 purge 或 CDN TTL 才生效。
     所以**每次合并 `index.json` 后都要 purge jsDelivr 缓存**；这一步由 CI 自动做
     （`.github/workflows/purge-jsdelivr.yml`），失败才人工补，见
     [CONTRIBUTING 的说明](./CONTRIBUTING.md#三review-流程)。
- 这两点合起来，正是正式插件**必须**把包挂在自己 Release 固定 tag 上的原因：
  **tag 不变、字节不变，就不存在缓存漂移**，客户端校验的 `sha256` 永远对得上。
  索引仓库只存 `index.json`，`@main` 的 jsDelivr 地址只适合自举示例。

源码在 [Qing-Notepad/examples](https://github.com/PyTs1n9/Qing-Notepad/tree/main/examples)。

## 本地开发

```bash
npm run validate          # 校验 index.json
npm run validate:json     # 机器可读输出（CI / 编辑器集成用）
node scripts/validate-index.mjs path/to/other-index.json   # 校验别处的索引
```

校验器**零依赖**，只用 Node 内置模块，所以 CI 里不跑 `npm install`。要求 Node ≥ 18。

输出示例：

```
统计
  条目数        4
  规则检查次数   195
  id            qing.hello-headless, qing.note-wordcount, ...
  结果          0 个错误 / 4 个警告
```

退出码：有错误 → `1`，只有警告或全通过 → `0`。未知的多余字段只产生警告，
方便以后给索引加字段而不必同步改校验器。

## 被拒的常见原因

| 现象 | 原因 | 怎么改 |
| --- | --- | --- |
| `id.pattern` | id 只有一段、含大写/下划线、某段以 `-` 结尾 | 改成 `publisher.name`，全小写 |
| `id.length` | id 超过 64 字节 | 缩短 publisher 或 name |
| `id.duplicate` | 同一 id 出现两次 | 只保留一条 |
| `version.semver` | 写了 `v1.0.0` / `1.0` / `1.00.0` | 改成 `1.0.0` |
| `sha256.required` | 忘了填 sha256 | 算一遍填上（客户端会 `E_SHA256_MISSING`） |
| `sha256.format` | 大写、或不是 64 位 | 转小写，确认是 SHA-256 而不是 MD5/SHA-1 |
| `sha256.artifact` | 重新打包了但没改哈希 | 重新算，或把包改回原样 |
| `download.https` | 用了 `http://` 或相对路径 | 换成 `https://` 的 Release 地址 |
| `download.suffix` | 地址不以 `.zip` / `.qnp` 结尾 | 上传 zip 产物；不要指向 `.tar.gz` |
| `download.mutable` | 指向可变引用：`raw.githubusercontent.com/.../main`、`cdn.jsdelivr.net/gh/...@main`，或未固定版本的 jsDelivr 地址（**警告**） | 换成自己 Release 固定 tag 的直链；自举示例可忽略 |
| `permissions.known` | 权限名写错（如 `note:read`、`telnet`） | 从白名单里选，注意 `notes:` 是复数 |
| `engines.host.range` | 区间写法不对（`latest`、`>=v0.7.3`） | 用 `>=0.7.3 <1.0.0` |
| `engines.host.overlap` | 要求 `>=2.0.0` 之类，现有客户端都装不上（警告） | 放宽下界，或等宿主发版 |
| `file.bom` | 用记事本存成了带 BOM 的 UTF-8 | 存成"UTF-8（无 BOM）"；`serde_json` 会拒 |
| `file.json` | JSON 语法错误、尾逗号 | 用编辑器校验，或 `node -e "JSON.parse(...)"` |
| `entry.unknownKey` | 写了索引不认识的字段（**只警告**） | 不影响合并，但客户端会忽略 |
