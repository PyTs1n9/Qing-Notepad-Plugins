#!/usr/bin/env node
/**
 * 青记（Qing Notepad）插件索引校验器。
 *
 * 目标：把客户端 `src-tauri/src/plugin.rs` / `src-tauri/src/plugin_manifest.rs`
 * 里**运行时**才会做的校验，提前搬到提交时。索引里出现一条装不上的条目，
 * 用户的观感是“插件市场坏了”，而作者看到的只是一个装不上的按钮——所以宁可
 * 在这里挡住。
 *
 * 设计约束：
 *   1. 零依赖。CI 上不跑 `npm install`，只用 Node 内置模块（node:fs / node:crypto ...）。
 *   2. 本地与 CI 共用同一个入口（`npm run validate`）。
 *   3. 逐条报错：指出 `plugins[i].字段`、规则名、以及为什么不合格。
 *   4. 未知的多余字段只**警告**不失败，这样以后给索引加字段不需要同步改校验器。
 *
 * 退出码：有错误 → 1；只有警告或无问题 → 0。
 *
 * 用法：
 *   node scripts/validate-index.mjs [index.json 路径] [--json] [--quiet]
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// 常量：与客户端代码保持一致（改客户端必须同步改这里）
// ---------------------------------------------------------------------------

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const DEFAULT_INDEX_PATH = join(REPO_ROOT, "index.json");
const EXAMPLES_DIR = join(REPO_ROOT, "examples");

/** `IndexDocument.schema` 目前唯一支持的取值。 */
const SUPPORTED_SCHEMA = 1;
/** `IndexEntry.apiVersion` 省略时为 1；写了就必须是 1。 */
const SUPPORTED_API_VERSION = 1;

/** `plugin_manifest.rs` 的 MAX_ID_LEN / MAX_NAME_LEN / MAX_VERSION_LEN / MAX_RANGE_LEN。 */
const MAX_ID_BYTES = 64;
const MAX_NAME_BYTES = 96;
const MAX_VERSION_BYTES = 64;
const MAX_RANGE_BYTES = 96;
/** `is_strict_semver` 里单个数值位最多 10 位数字。 */
const MAX_NUMERIC_PART_DIGITS = 10;

/** 当前宿主版本线；用于判断“这个包在现有客户端上能不能装”。 */
const HOST_BASELINE_RANGE = ">=0.7.3 <1.0.0";

/**
 * `plugin_manifest.rs::KNOWN_PERMISSIONS` 的完整白名单（13 项，与客户端逐字一致）。
 *
 * P1a / P1a-2 加入编辑器面板后，客户端从 8 个码扩到 13 个，这里曾落后于客户端：
 * 结果是任何用 `editor:*` 或 `views` 的插件都能装上、却过不了本校验器，
 * 于是永远上不了架（`qing.outline` 就是卡在这一步）。改客户端必须同步改这里。
 */
const KNOWN_PERMISSIONS = [
  "storage",
  "notes:read",
  "notes:write",
  "todo:read",
  "todo:write",
  "clipboard:read",
  "clipboard:write",
  "notify",
  "editor:read",
  "editor:write",
  "editor:decorate",
  "views",
  "editor:selection",
];

/**
 * `is_valid_plugin_id` 的正则形式：至少两段点分；每段以 `[a-z0-9]` 开头、
 * 不以 `-` 结尾、中间只允许 `[a-z0-9-]`。P0 之后连字符在**任意**段都合法，
 * 所以 `ms-python.python` 是通过的。
 */
const ID_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

const KNOWN_DOCUMENT_KEYS = new Set(["schema", "updatedAt", "plugins"]);

const KNOWN_ENTRY_KEYS = new Set([
  "id",
  "name",
  "description",
  "author",
  "repo",
  "repoGitee",
  "version",
  "apiVersion",
  "engines",
  "download",
  "sha256",
  "permissions",
  "updatedAt",
]);

/** `.zip` 与 `.qnp` 本质是同构的（都是 zip 字节），两者都收。 */
const ALLOWED_ARCHIVE_SUFFIXES = [".zip", ".qnp"];

// ---------------------------------------------------------------------------
// 报告器
// ---------------------------------------------------------------------------

class Report {
  constructor() {
    /** @type {{at: string, rule: string, message: string}[]} */
    this.errors = [];
    /** @type {{at: string, rule: string, message: string}[]} */
    this.warnings = [];
    /** 实际执行过的规则次数，用于最后打印“检查条数”。 */
    this.checks = 0;
  }

  /**
   * 一条硬性规则。不满足即记错误。
   *
   * @param {boolean} ok 规则是否通过。
   * @param {string} at 出错位置，例如 `plugins[0].sha256`。
   * @param {string} rule 规则名，例如 `sha256.format`。
   * @param {string} message 为什么不合格。
   * @returns {boolean} 与 `ok` 相同。
   */
  expect(ok, at, rule, message) {
    this.checks += 1;
    if (!ok) this.errors.push({ at, rule, message });
    return ok;
  }

  /** 一条软性规则（建议）。不满足只记警告。 */
  expectSoft(ok, at, rule, message) {
    this.checks += 1;
    if (!ok) this.warnings.push({ at, rule, message });
    return ok;
  }
}

// ---------------------------------------------------------------------------
// semver：严格版本
// ---------------------------------------------------------------------------

/** semver 的标识符：非空，只含 `[0-9A-Za-z-]`。 */
function isSemverIdentifier(text) {
  return typeof text === "string" && text.length > 0 && /^[0-9A-Za-z-]+$/.test(text);
}

/**
 * 严格 semver 解析，逐条对齐客户端 `plugin_manifest.rs::is_strict_semver`：
 * 必须是 `x.y.z`，可选 `-prerelease`、可选 `+build`；数值位不允许前导零、
 * 不允许超过 10 位；**不接受 `v` 前缀**。
 *
 * @param {unknown} value
 * @returns {{major: number, minor: number, patch: number, prerelease: string[], build: string[]} | null}
 */
function parseStrictSemver(value) {
  if (typeof value !== "string") return null;
  if (value.length === 0 || Buffer.byteLength(value, "utf8") > MAX_VERSION_BYTES) return null;

  let rest = value;
  /** @type {string[]} */
  let build = [];
  const plusIndex = rest.indexOf("+");
  if (plusIndex !== -1) {
    const buildText = rest.slice(plusIndex + 1);
    rest = rest.slice(0, plusIndex);
    if (buildText.length === 0) return null;
    build = buildText.split(".");
    if (!build.every(isSemverIdentifier)) return null;
  }

  /** @type {string[]} */
  let prerelease = [];
  const dashIndex = rest.indexOf("-");
  if (dashIndex !== -1) {
    const preText = rest.slice(dashIndex + 1);
    rest = rest.slice(0, dashIndex);
    // `split_once('-')` 之后 prerelease 若为空字符串，判定为非法。
    if (preText.length === 0) return null;
    prerelease = preText.split(".");
    for (const part of prerelease) {
      if (!isSemverIdentifier(part)) return null;
      // 纯数字标识符不允许前导零（`-01` 非法，`-0` 合法）。
      const numeric = /^[0-9]+$/.test(part);
      if (numeric && part.length > 1 && part.startsWith("0")) return null;
    }
  }

  const coreParts = rest.split(".");
  if (coreParts.length !== 3) return null;
  const numbers = [];
  for (const part of coreParts) {
    if (!/^[0-9]+$/.test(part)) return null;
    if (part.length > 1 && part.startsWith("0")) return null;
    if (part.length > MAX_NUMERIC_PART_DIGITS) return null;
    numbers.push(Number(part));
  }

  return {
    major: numbers[0],
    minor: numbers[1],
    patch: numbers[2],
    prerelease,
    build,
  };
}

/**
 * semver 优先级比较（`+build` 不参与比较）。
 *
 * @param {{major: number, minor: number, patch: number, prerelease: string[]}} a
 * @param {{major: number, minor: number, patch: number, prerelease: string[]}} b
 * @returns {number} 负数表示 a < b，0 表示等价，正数表示 a > b。
 */
function compareSemver(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;

  const aPre = a.prerelease;
  const bPre = b.prerelease;
  // 有 prerelease 的版本低于同版本的正式版。
  if (aPre.length === 0 && bPre.length === 0) return 0;
  if (aPre.length === 0) return 1;
  if (bPre.length === 0) return -1;

  const length = Math.max(aPre.length, bPre.length);
  for (let index = 0; index < length; index += 1) {
    const left = aPre[index];
    const right = bPre[index];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;
    const leftNumeric = /^[0-9]+$/.test(left);
    const rightNumeric = /^[0-9]+$/.test(right);
    if (leftNumeric && rightNumeric) return Number(left) - Number(right);
    // 数字标识符低于字母标识符。
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    return left < right ? -1 : 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// semver：区间（用于 engines.host）
// ---------------------------------------------------------------------------

const RANGE_OPERATORS = [">=", "<=", ">", "<", "=", "^", "~"];

/**
 * 解析区间里的单个版本片段，支持部分版本与通配符（`1.2.x` / `1.x` / `*`）。
 *
 * @param {string} text
 * @returns {{major: number, minor: number, patch: number, prerelease: string[], wildcardFrom: number} | null}
 *   `wildcardFrom` 是第一个未显式指定的位（0/1/2），3 表示三位都写全了。
 */
function parseRangeVersion(text) {
  if (typeof text !== "string" || text.length === 0) return null;
  if (text.startsWith("v") || text.startsWith("V")) return null; // 不接受 v 前缀

  let rest = text;
  const plusIndex = rest.indexOf("+");
  if (plusIndex !== -1) {
    const buildText = rest.slice(plusIndex + 1);
    rest = rest.slice(0, plusIndex);
    if (buildText.length === 0 || !buildText.split(".").every(isSemverIdentifier)) return null;
  }

  /** @type {string[]} */
  let prerelease = [];
  const dashIndex = rest.indexOf("-");
  if (dashIndex !== -1) {
    const preText = rest.slice(dashIndex + 1);
    rest = rest.slice(0, dashIndex);
    if (preText.length === 0) return null;
    prerelease = preText.split(".");
    if (!prerelease.every(isSemverIdentifier)) return null;
  }

  const parts = rest.split(".");
  if (parts.length < 1 || parts.length > 3) return null;

  const numbers = [];
  let wildcardFrom = 3;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const isWildcard = part === "x" || part === "X" || part === "*";
    if (isWildcard) {
      if (wildcardFrom === 3) wildcardFrom = index;
      numbers.push(0);
      continue;
    }
    // `1.x.3` 这种“通配符后面还有具体数字”的写法没有意义。
    if (wildcardFrom !== 3) return null;
    if (!/^[0-9]+$/.test(part)) return null;
    if (part.length > 1 && part.startsWith("0")) return null;
    if (part.length > MAX_NUMERIC_PART_DIGITS) return null;
    numbers.push(Number(part));
  }

  if (wildcardFrom === 3) wildcardFrom = parts.length;
  while (numbers.length < 3) numbers.push(0);

  return {
    major: numbers[0],
    minor: numbers[1],
    patch: numbers[2],
    prerelease,
    wildcardFrom,
  };
}

/** 造一个用于比较的版本对象。 */
function version(major, minor, patch, prerelease = []) {
  return { major, minor, patch, prerelease, build: [] };
}

/**
 * 把「一个比较子」编译成谓词。
 *
 * @param {string} op 运算符，`""` 表示裸版本（等价于 `=`）。
 * @param {NonNullable<ReturnType<typeof parseRangeVersion>>} spec
 * @returns {((v: {major: number, minor: number, patch: number, prerelease: string[]}) => boolean) | null}
 */
function compileComparator(op, spec) {
  const base = version(spec.major, spec.minor, spec.patch, spec.prerelease);
  const isPartial = spec.wildcardFrom < 3;

  switch (op) {
    case ">=":
      return (candidate) => compareSemver(candidate, base) >= 0;
    case ">":
      return (candidate) => compareSemver(candidate, base) > 0;
    case "<=":
      return (candidate) => compareSemver(candidate, base) <= 0;
    case "<":
      return (candidate) => compareSemver(candidate, base) < 0;
    case "":
    case "=": {
      if (!isPartial) return (candidate) => compareSemver(candidate, base) === 0;
      // `1.2` / `1.2.x` → `>=1.2.0 <1.3.0`；`1` / `1.x` → `>=1.0.0 <2.0.0`。
      const upper =
        spec.wildcardFrom === 2
          ? version(spec.major, spec.minor + 1, 0)
          : version(spec.major + 1, 0, 0);
      if (spec.wildcardFrom === 0) return () => true;
      return (candidate) => compareSemver(candidate, base) >= 0 && compareSemver(candidate, upper) < 0;
    }
    case "^": {
      if (spec.wildcardFrom === 0) return () => true;
      let upper;
      if (spec.major > 0 || spec.wildcardFrom === 1) {
        upper = version(spec.major + 1, 0, 0);
      } else if (spec.minor > 0 || spec.wildcardFrom === 2) {
        upper = version(0, spec.minor + 1, 0);
      } else {
        upper = version(0, 0, spec.patch + 1);
      }
      return (candidate) => compareSemver(candidate, base) >= 0 && compareSemver(candidate, upper) < 0;
    }
    case "~": {
      if (spec.wildcardFrom === 0) return () => true;
      const upper =
        spec.wildcardFrom === 1
          ? version(spec.major + 1, 0, 0)
          : version(spec.major, spec.minor + 1, 0);
      return (candidate) => compareSemver(candidate, base) >= 0 && compareSemver(candidate, upper) < 0;
    }
    default:
      return null;
  }
}

/**
 * 解析区间字符串。支持：空格分隔的 AND、`||` 分隔的 OR、`>=`/`>`/`<=`/`<`/
 * `=`/`^`/`~` 与裸版本、部分版本、`x` 通配符。**不支持** hyphen range
 * （`1.2.3 - 2.0.0`）——那种写法在 Rust 侧也不支持，报错比默默误判好。
 *
 * @param {string} range
 * @returns {{ok: true, groups: {predicates: Function[], specs: object[]}[]} | {ok: false, reason: string}}
 */
function parseRange(range) {
  if (typeof range !== "string" || range.trim().length === 0) {
    return { ok: false, reason: "区间为空" };
  }
  if (Buffer.byteLength(range, "utf8") > MAX_RANGE_BYTES) {
    return { ok: false, reason: `区间超过 ${MAX_RANGE_BYTES} 字节` };
  }

  const groups = [];
  for (const rawGroup of range.split("||")) {
    const groupText = rawGroup.trim();
    if (groupText.length === 0) return { ok: false, reason: "`||` 两侧都有区间" };

    // 先把 `>= 0.7.3` 这种“运算符与版本之间带空格”的写法合并成一个 token。
    const rawTokens = groupText.split(/\s+/);
    const tokens = [];
    for (let index = 0; index < rawTokens.length; index += 1) {
      const token = rawTokens[index];
      if (RANGE_OPERATORS.includes(token)) {
        const next = rawTokens[index + 1];
        if (next === undefined) {
          return { ok: false, reason: `运算符 \`${token}\` 后面缺少版本号` };
        }
        tokens.push(token + next);
        index += 1;
        continue;
      }
      tokens.push(token);
    }

    const predicates = [];
    const specs = [];
    for (const token of tokens) {
      if (token === "-") {
        return { ok: false, reason: "不支持 hyphen range（`1.2.3 - 2.0.0`），请写成 `>=1.2.3 <=2.0.0`" };
      }
      let op = "";
      let versionText = token;
      for (const candidateOp of RANGE_OPERATORS) {
        if (token.startsWith(candidateOp)) {
          op = candidateOp;
          versionText = token.slice(candidateOp.length);
          break;
        }
      }
      if (versionText.length === 0) {
        return { ok: false, reason: `\`${token}\` 缺少版本号` };
      }
      const spec = parseRangeVersion(versionText);
      if (spec === null) {
        return { ok: false, reason: `\`${token}\` 不是合法的版本号或通配符（不允许 v 前缀、前导零）` };
      }
      const predicate = compileComparator(op, spec);
      if (predicate === null) {
        return { ok: false, reason: `\`${token}\` 的运算符不受支持` };
      }
      predicates.push(predicate);
      specs.push(spec);
    }
    if (predicates.length === 0) return { ok: false, reason: "区间为空" };
    groups.push({ predicates, specs });
  }

  if (groups.length === 0) return { ok: false, reason: "区间为空" };
  return { ok: true, groups };
}

/** 判断某个具体版本是否落在解析好的区间里。 */
function rangeMatches(parsedRange, candidate) {
  return parsedRange.groups.some((group) =>
    group.predicates.every((predicate) => predicate(candidate)),
  );
}

/**
 * 用边界候选值判断区间是否有解。
 *
 * 这不是定理证明，只是一次成本极低的“反例搜索”：把每个比较子的边界版本及
 * 其相邻值都试一遍。对于写错的区间（`>=1.0.0 <0.5.0`）足够用；找不到候选值
 * 时只给警告，避免把合法但刁钻的区间判死。
 *
 * @param {ReturnType<typeof parseRange>} parsedRange
 * @param {((v: object) => boolean) | null} extra 额外约束（例如“落在宿主基线内”）
 * @returns {boolean}
 */
function rangeHasSolution(parsedRange, extra) {
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {object[]} */
  const candidates = [];

  const push = (candidate) => {
    const key = `${candidate.major}.${candidate.minor}.${candidate.patch}-${candidate.prerelease.join(".")}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(candidate);
  };

  for (const group of parsedRange.groups) {
    for (const spec of group.specs) {
      const { major, minor, patch } = spec;
      push(version(major, minor, patch, spec.prerelease));
      push(version(major, minor, patch + 1));
      push(version(major, minor, patch, ["0"]));
      if (patch > 0) push(version(major, minor, patch - 1));
      push(version(major, minor + 1, 0));
      if (minor > 0) push(version(major, minor - 1, 0));
      push(version(major + 1, 0, 0));
      if (major > 0) push(version(major - 1, 0, 0));
    }
  }
  push(version(0, 0, 0));
  push(version(0, 7, 3));
  push(version(0, 8, 0));
  push(version(1, 0, 0));

  return candidates.some(
    (candidate) => rangeMatches(parsedRange, candidate) && (extra === null || extra(candidate)),
  );
}

// ---------------------------------------------------------------------------
// 字段级辅助
// ---------------------------------------------------------------------------

/**
 * `https://` 绝对 URL 检查。客户端会用 reqwest 去拉这个地址，所以只收 https，
 * 且必须能解析成绝对 URL（避免 `https:/foo` 这种笔误混过去）。
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isHttpsUrl(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  if (/\s/.test(value)) return false;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === "https:" && parsed.hostname.length > 0;
}

/** ISO-8601 UTC 时间戳，例如 `2026-10-27T06:00:00Z`。 */
function isIsoTimestamp(value) {
  if (typeof value !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return false;
  }
  return Number.isNaN(Date.parse(value)) === false;
}

/** 字段存在性：`undefined` / `null` 都算缺失。 */
function isPresent(value) {
  return value !== undefined && value !== null;
}

/**
 * 判断 `download` 是否指向**可变引用**。
 *
 * 同一条 `download.mutable` 警告覆盖两种形态，因为后果一样（包一重新打包
 * sha256 就会失配）：
 *   1. `raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>` —— `<ref>` 是分支名
 *   2. `cdn.jsdelivr.net/gh/<owner>/<repo>[@<ref>]/<path>` —— `@main` / `@master` /
 *      `@latest`，或者干脆没写 `@<ref>`（jsDelivr 会解析成"最新版本"，同样会随新
 *      tag 漂移）
 * 固定 tag（`@v1.2.3`）或 commit SHA 不算可变，不会触发警告。
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isMutableDownloadRef(value) {
  if (typeof value !== "string") return false;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  const segments = parsed.pathname.split("/").filter((part) => part.length > 0);

  if (parsed.hostname === "raw.githubusercontent.com") {
    // /<owner>/<repo>/<ref>/<path...>
    const ref = segments[2];
    return ref === undefined || ref === "main" || ref === "master";
  }

  if (parsed.hostname === "cdn.jsdelivr.net") {
    if (segments[0] !== "gh") return false;
    const repoSegment = segments[2]; // `<repo>@<ref>`
    if (repoSegment === undefined) return true;
    const at = repoSegment.indexOf("@");
    // 没有 @<ref>：jsDelivr 解析成最新版本，会随新 tag 漂移。
    if (at === -1) return true;
    const ref = repoSegment.slice(at + 1).toLowerCase();
    return ref.length === 0 || ref === "main" || ref === "master" || ref === "latest";
  }

  return false;
}

/**
 * 计算文件 sha256（小写十六进制）。
 *
 * @param {string} filePath
 * @returns {string}
 */
function sha256OfFile(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

// ---------------------------------------------------------------------------
// 校验主体
// ---------------------------------------------------------------------------

/**
 * 校验索引文档。
 *
 * @param {string} indexPath
 * @returns {{report: Report, entryCount: number, ids: string[]}}
 */
function validateIndex(indexPath) {
  const report = new Report();
  const ids = [];
  const referencedArtifacts = new Set();

  // -- 0. 文件本身 ----------------------------------------------------------
  if (!report.expect(existsSync(indexPath), "index.json", "file.exists", "找不到索引文件")) {
    return { report, entryCount: 0, ids };
  }

  const raw = readFileSync(indexPath);

  // BOM 会让客户端 `serde_json::from_str` 直接报错，是纯静默事故，必须挡。
  const hasBom = raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
  report.expect(
    !hasBom,
    "index.json",
    "file.bom",
    "文件以 UTF-8 BOM 开头，客户端 serde_json 会直接解析失败；请存成无 BOM 的 UTF-8",
  );

  const body = raw.toString("utf8");
  // 能无损往返 = 确实是合法 UTF-8；否则 Buffer 会用替换字符顶掉坏字节。
  report.expect(
    Buffer.from(body, "utf8").equals(raw.subarray(hasBom ? 3 : 0)),
    "index.json",
    "file.utf8",
    "文件不是合法的 UTF-8（存在无法解码的字节）",
  );

  report.expectSoft(
    body.endsWith("\n"),
    "index.json",
    "file.trailing-newline",
    "文件末尾建议保留一个换行，减少 diff 噪声",
  );

  let document;
  try {
    document = JSON.parse(hasBom ? body.slice(1) : body);
  } catch (error) {
    report.expect(false, "index.json", "file.json", `JSON 解析失败：${error.message}`);
    return { report, entryCount: 0, ids };
  }

  if (
    !report.expect(
      typeof document === "object" && document !== null && Array.isArray(document) === false,
      "index.json",
      "document.object",
      "索引顶层必须是一个 JSON 对象",
    )
  ) {
    return { report, entryCount: 0, ids };
  }

  // -- 1. 文档级字段 --------------------------------------------------------
  for (const key of Object.keys(document)) {
    report.expectSoft(
      KNOWN_DOCUMENT_KEYS.has(key),
      `index.json.${key}`,
      "document.unknownKey",
      `未知的顶层字段 \`${key}\`（只警告，不影响客户端解析）`,
    );
  }

  report.expect(
    isPresent(document.schema),
    "index.json.schema",
    "document.schema.required",
    "缺少 schema 字段",
  );
  report.expect(
    Number.isInteger(document.schema) && document.schema === SUPPORTED_SCHEMA,
    "index.json.schema",
    "document.schema.value",
    `schema 必须是整数 ${SUPPORTED_SCHEMA}，当前是 ${JSON.stringify(document.schema)}`,
  );

  report.expect(
    isIsoTimestamp(document.updatedAt),
    "index.json.updatedAt",
    "document.updatedAt.format",
    `updatedAt 必须是 ISO-8601 时间戳（如 ${new Date().toISOString().replace(/\.\d+Z$/, "Z")}），当前是 ${JSON.stringify(document.updatedAt)}`,
  );
  report.expectSoft(
    typeof document.updatedAt !== "string" || document.updatedAt.endsWith("Z"),
    "index.json.updatedAt",
    "document.updatedAt.utc",
    "建议统一使用 UTC（以 `Z` 结尾），避免跨时区排序出错",
  );

  if (
    !report.expect(
      Array.isArray(document.plugins),
      "index.json.plugins",
      "document.plugins.type",
      "plugins 必须是数组",
    )
  ) {
    return { report, entryCount: 0, ids };
  }

  report.expectSoft(
    document.plugins.length > 0,
    "index.json.plugins",
    "document.plugins.empty",
    "索引里没有任何条目，插件页会显示“暂无插件”",
  );

  // -- 2. 逐条校验 ----------------------------------------------------------
  const seenIds = new Map();

  document.plugins.forEach((entry, index) => {
    const at = `plugins[${index}]`;

    if (
      !report.expect(
        typeof entry === "object" && entry !== null && !Array.isArray(entry),
        at,
        "entry.object",
        "条目必须是 JSON 对象",
      )
    ) {
      return;
    }

    for (const key of Object.keys(entry)) {
      report.expectSoft(
        KNOWN_ENTRY_KEYS.has(key),
        `${at}.${key}`,
        "entry.unknownKey",
        `未知字段 \`${key}\`（只警告，客户端会忽略）`,
      );
    }

    // id ------------------------------------------------------------------
    const idOk = report.expect(
      typeof entry.id === "string" && entry.id.length > 0,
      `${at}.id`,
      "id.required",
      "id 必须是非空字符串",
    );
    if (idOk) {
      const id = entry.id;
      report.expect(
        Buffer.byteLength(id, "utf8") <= MAX_ID_BYTES,
        `${at}.id`,
        "id.length",
        `id 不能超过 ${MAX_ID_BYTES} 字节，当前 ${Buffer.byteLength(id, "utf8")} 字节：\`${id}\``,
      );
      report.expect(
        ID_PATTERN.test(id),
        `${at}.id`,
        "id.pattern",
        `id \`${id}\` 不合法：需要至少两段点分（\`publisher.name\`），每段以 [a-z0-9] 开头、不以 - 结尾、中间只含 [a-z0-9-]`,
      );
      if (seenIds.has(id)) {
        report.expect(
          false,
          `${at}.id`,
          "id.duplicate",
          `id \`${id}\` 与 plugins[${seenIds.get(id)}] 重复；同一 id 在索引里只能出现一次`,
        );
      } else {
        seenIds.set(id, index);
        ids.push(id);
      }
    }

    // name ----------------------------------------------------------------
    report.expect(
      typeof entry.name === "string" && entry.name.trim().length > 0,
      `${at}.name`,
      "name.required",
      "name 必须是非空字符串",
    );
    if (typeof entry.name === "string") {
      report.expect(
        Buffer.byteLength(entry.name, "utf8") <= MAX_NAME_BYTES,
        `${at}.name`,
        "name.length",
        `name 不能超过 ${MAX_NAME_BYTES} 字节，当前 ${Buffer.byteLength(entry.name, "utf8")} 字节`,
      );
    }

    // description ---------------------------------------------------------
    report.expect(
      typeof entry.description === "string" && entry.description.trim().length > 0,
      `${at}.description`,
      "description.required",
      "description 必须是非空字符串（列表页靠它给用户做判断）",
    );

    // author --------------------------------------------------------------
    if (typeof entry.author === "string") {
      report.expect(
        entry.author.trim().length > 0,
        `${at}.author`,
        "author.empty",
        "author 不能是空字符串",
      );
    } else if (typeof entry.author === "object" && entry.author !== null) {
      // 客户端两种都收，但索引侧统一成字符串，避免同一个仓库两种写法。
      report.expect(
        typeof entry.author.name === "string" && entry.author.name.trim().length > 0,
        `${at}.author`,
        "author.object",
        "author 写成对象时必须带非空 name",
      );
      report.expectSoft(
        false,
        `${at}.author`,
        "author.string",
        "author 建议写成字符串（对象写法客户端也收，但索引内应统一）",
      );
    } else {
      report.expect(false, `${at}.author`, "author.required", "author 必须是字符串");
    }

    // repo ----------------------------------------------------------------
    if (isPresent(entry.repo)) {
      report.expect(
        isHttpsUrl(entry.repo),
        `${at}.repo`,
        "repo.https",
        `repo 必须是 https:// 绝对地址，当前是 ${JSON.stringify(entry.repo)}`,
      );
      report.expectSoft(
        typeof entry.repo === "string" && !/^https:\/\/raw\.githubusercontent\.com\//.test(entry.repo),
        `${at}.repo`,
        "repo.human",
        "repo 建议指向 GitHub 仓库页面（用户要点开看源码），不是 raw 文件地址",
      );
    } else {
      report.expectSoft(false, `${at}.repo`, "repo.recommended", "建议填 repo，方便用户查看源码");
    }

    // version -------------------------------------------------------------
    const parsedVersion = parseStrictSemver(entry.version);
    report.expect(
      parsedVersion !== null,
      `${at}.version`,
      "version.semver",
      `version 必须是严格 semver（x.y.z，可带 -prerelease/+build），不接受 v 前缀与前导零；当前是 ${JSON.stringify(entry.version)}`,
    );

    // apiVersion ----------------------------------------------------------
    if (isPresent(entry.apiVersion)) {
      report.expect(
        Number.isInteger(entry.apiVersion) && entry.apiVersion === SUPPORTED_API_VERSION,
        `${at}.apiVersion`,
        "apiVersion.value",
        `apiVersion 省略时视为 ${SUPPORTED_API_VERSION}；写了就必须是 ${SUPPORTED_API_VERSION}，当前是 ${JSON.stringify(entry.apiVersion)}`,
      );
    }

    // engines.host --------------------------------------------------------
    const enginesOk = report.expect(
      typeof entry.engines === "object" && entry.engines !== null && !Array.isArray(entry.engines),
      `${at}.engines`,
      "engines.required",
      "engines 必须是对象，且包含 host 字段",
    );
    if (enginesOk) {
      const host = entry.engines.host;
      const hostOk = report.expect(
        typeof host === "string" && host.trim().length > 0,
        `${at}.engines.host`,
        "engines.host.required",
        "engines.host 必须是非空字符串",
      );
      if (hostOk) {
        const parsedRange = parseRange(host);
        report.expect(
          parsedRange.ok === true,
          `${at}.engines.host`,
          "engines.host.range",
          `engines.host \`${host}\` 不是可解析的版本区间${parsedRange.ok ? "" : "：" + parsedRange.reason}`,
        );
        if (parsedRange.ok) {
          const baseline = parseRange(HOST_BASELINE_RANGE);
          report.expectSoft(
            rangeHasSolution(parsedRange, (candidate) =>
              baseline.ok ? rangeMatches(baseline, candidate) : true,
            ),
            `${at}.engines.host`,
            "engines.host.overlap",
            `engines.host \`${host}\` 与当前宿主线 \`${HOST_BASELINE_RANGE}\` 没有交集，现有客户端装不上`,
          );
          report.expectSoft(
            rangeHasSolution(parsedRange, null),
            `${at}.engines.host`,
            "engines.host.satisfiable",
            `engines.host \`${host}\` 看起来无解（区间为空），请检查上下界是否写反`,
          );
        }
      }
      for (const key of Object.keys(entry.engines)) {
        report.expectSoft(
          key === "host",
          `${at}.engines.${key}`,
          "engines.unknownKey",
          `engines 里只有 host 会被客户端读取，\`${key}\` 会被忽略`,
        );
      }
    }

    // download ------------------------------------------------------------
    const downloadOk = report.expect(
      isHttpsUrl(entry.download),
      `${at}.download`,
      "download.https",
      `download 必须是 https:// 绝对地址，当前是 ${JSON.stringify(entry.download)}`,
    );
    if (downloadOk) {
      const suffixOk = ALLOWED_ARCHIVE_SUFFIXES.some((suffix) =>
        new URL(entry.download).pathname.toLowerCase().endsWith(suffix),
      );
      report.expect(
        suffixOk,
        `${at}.download`,
        "download.suffix",
        `download 必须指向 zip 字节（以 ${ALLOWED_ARCHIVE_SUFFIXES.join(" 或 ")} 结尾），当前是 ${new URL(entry.download).pathname}`,
      );

      report.expectSoft(
        !isMutableDownloadRef(entry.download),
        `${at}.download`,
        "download.mutable",
        "download 指向可变引用（raw.githubusercontent.com/.../main、cdn.jsdelivr.net/gh/...@main，或未固定版本的 jsDelivr 地址）：包一重新打包 sha256 就会失配，正式插件请挂在 Release 的固定 tag 上",
      );

      const artifactName = basename(new URL(entry.download).pathname);
      referencedArtifacts.add(artifactName);
      // 本仓库自举示例：本地有同名包就顺手核对 sha256，挡住“改了包忘了改哈希”。
      // 只在条目确实写了 sha256 时比对，避免和 sha256.required 报重复错误。
      const localArtifact = join(EXAMPLES_DIR, artifactName);
      if (typeof entry.sha256 === "string" && existsSync(localArtifact)) {
        const actual = sha256OfFile(localArtifact);
        report.expect(
          actual === entry.sha256,
          `${at}.sha256`,
          "sha256.artifact",
          `examples/${artifactName} 的实际 sha256 是 ${actual}，与条目登记的 ${JSON.stringify(entry.sha256)} 不一致`,
        );
      }
    }

    // sha256 --------------------------------------------------------------
    const shaOk = report.expect(
      isPresent(entry.sha256),
      `${at}.sha256`,
      "sha256.required",
      "缺少 sha256；客户端缺它直接拒装（E_SHA256_MISSING）",
    );
    if (shaOk) {
      const sha = entry.sha256;
      report.expect(
        typeof sha === "string",
        `${at}.sha256`,
        "sha256.type",
        "sha256 必须是字符串",
      );
      if (typeof sha === "string") {
        report.expect(
          /^[0-9a-f]{64}$/.test(sha),
          `${at}.sha256`,
          "sha256.format",
          /^[0-9A-Fa-f]{64}$/.test(sha)
            ? "sha256 必须小写十六进制；值看起来是同一个哈希，只是含大写字母"
            : `sha256 必须是 64 位小写十六进制，当前 ${sha.length} 位`,
        );
      }
    }

    // permissions ---------------------------------------------------------
    if (isPresent(entry.permissions)) {
      const listOk = report.expect(
        Array.isArray(entry.permissions),
        `${at}.permissions`,
        "permissions.type",
        "permissions 必须是数组",
      );
      if (listOk) {
        const seen = new Set();
        entry.permissions.forEach((permission, permissionIndex) => {
          const permissionAt = `${at}.permissions[${permissionIndex}]`;
          const isString = report.expect(
            typeof permission === "string",
            permissionAt,
            "permissions.type",
            "权限必须是字符串",
          );
          if (!isString) return;
          report.expect(
            KNOWN_PERMISSIONS.includes(permission),
            permissionAt,
            "permissions.known",
            `未知权限 \`${permission}\`；只允许 ${KNOWN_PERMISSIONS.join("、")}`,
          );
          report.expectSoft(
            !seen.has(permission),
            permissionAt,
            "permissions.duplicate",
            `权限 \`${permission}\` 重复声明`,
          );
          seen.add(permission);
        });
      }
    } else {
      report.expectSoft(
        false,
        `${at}.permissions`,
        "permissions.explicit",
        "建议显式写出 permissions（哪怕是 []），让用户能一眼看出这个插件要什么权限",
      );
    }

    // updatedAt -----------------------------------------------------------
    if (isPresent(entry.updatedAt)) {
      report.expect(
        isIsoTimestamp(entry.updatedAt),
        `${at}.updatedAt`,
        "entry.updatedAt.format",
        `updatedAt 必须是 ISO-8601 时间戳，当前是 ${JSON.stringify(entry.updatedAt)}`,
      );
    }
  });

  // -- 3. 仓库内 artifacts 与索引的一致性 ------------------------------------
  if (existsSync(EXAMPLES_DIR)) {
    const artifacts = readdirSync(EXAMPLES_DIR).filter((name) =>
      ALLOWED_ARCHIVE_SUFFIXES.some((suffix) => name.toLowerCase().endsWith(suffix)),
    );
    for (const artifact of artifacts) {
      report.expectSoft(
        referencedArtifacts.has(artifact),
        `examples/${artifact}`,
        "examples.orphan",
        "examples/ 里存在没有被 index.json 引用的包（留着会让人以为它已上架）",
      );
    }
  }

  return { report, entryCount: Array.isArray(document.plugins) ? document.plugins.length : 0, ids };
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

function formatDiagnostics(list, label) {
  if (list.length === 0) return "";
  const lines = [`${label} (${list.length})`];
  list.forEach((item, index) => {
    lines.push(`  ${index + 1}. ${item.at}`);
    lines.push(`     规则：${item.rule}`);
    lines.push(`     原因：${item.message}`);
  });
  return lines.join("\n");
}

function main() {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes("--json");
  const quiet = args.includes("--quiet");
  const explicitPath = args.find((arg) => !arg.startsWith("--"));
  const indexPath = explicitPath === undefined ? DEFAULT_INDEX_PATH : resolve(process.cwd(), explicitPath);

  const { report, entryCount, ids } = validateIndex(indexPath);

  if (jsonOutput) {
    process.stdout.write(
      JSON.stringify(
        {
          ok: report.errors.length === 0,
          indexPath,
          checks: report.checks,
          entryCount,
          ids,
          errors: report.errors,
          warnings: report.warnings,
        },
        null,
        2,
      ) + "\n",
    );
    process.exit(report.errors.length === 0 ? 0 : 1);
  }

  if (!quiet) {
    process.stdout.write(`青记插件索引校验 — ${indexPath}\n\n`);
    const errorText = formatDiagnostics(report.errors, "错误");
    const warningText = formatDiagnostics(report.warnings, "警告");
    if (errorText) process.stdout.write(`${errorText}\n\n`);
    if (warningText) process.stdout.write(`${warningText}\n\n`);

    const summary = [
      "统计",
      `  条目数        ${entryCount}`,
      `  规则检查次数   ${report.checks}`,
      `  id            ${ids.length === 0 ? "(无)" : ids.join(", ")}`,
      `  结果          ${report.errors.length} 个错误 / ${report.warnings.length} 个警告`,
    ];
    process.stdout.write(`${summary.join("\n")}\n\n`);
  }

  if (report.errors.length === 0) {
    process.stdout.write(`OK：${entryCount} 个条目通过全部检查。\n`);
    process.exit(0);
  }

  process.stdout.write(`FAILED：${report.errors.length} 个错误需要修复。\n`);
  process.exit(1);
}

main();
