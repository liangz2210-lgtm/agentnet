#!/usr/bin/env node
/**
 * 仓库完整性自检 —— **提交前必须运行**（`pnpm check:repo`）。
 *
 * 为什么需要它：撰写 .gitignore 时极易写出命中源码的规则
 * （本项目曾因 `identity` / `identity.*` 两条规则，把 src/identity/ 整个目录
 * 和 identity.test.ts 吞掉，而 git status 看上去一片干净、CI 也全绿）。
 * 这类事故的特点是**零报错**，只能靠显式断言抓。
 *
 * 两组断言缺一不可：
 *   1. 关键目录与文件确实被 git 跟踪（git ls-files）
 *   2. 私钥类文件确实被忽略（git check-ignore）
 * 只验一边 = 空跑。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 注意：不能用 new URL(...).pathname —— 它会对非 ASCII 路径做百分号编码，
// 本仓库路径含中文，pathname 会指向一个不存在的目录，git 会静默失败。
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** 必须被 git 跟踪的关键文件。少一个就说明有东西被 .gitignore 吞了。 */
const REQUIRED_TRACKED = [
  'SPEC.md',
  'TASK-01-PROMPT.md',
  'PLAN-M1.md',
  'DECISIONS.md',
  'README.md',
  'ACCEPTANCE.md',
  'LIMITS.md',
  'package.json',
  'pnpm-lock.yaml',
  'tsconfig.json',
  'vitest.config.ts',
  '.gitignore',
  '.npmrc',
  'src/config/paths.ts',
  'src/config/dirguard.ts',
  'src/config/uid.ts',
  'src/identity/identity.ts',
  'src/identity/keyfile.ts',
  'src/envelope/validate.ts',
  'src/envelope/wrap.ts',
  'src/transport/transport.ts',
  'src/transport/relay-connection.ts',
  'src/receive/pipeline.ts',
  'src/receive/dedup.ts',
  'src/messaging/outgoing.ts',
  'src/cli/main.ts',
  'src/cli/commands.ts',
  'src/cli/keys.ts',
  'src/cli/config.ts',
  'src/cli/exit-codes.ts',
  'src/cli/bin.ts',
  'scripts/build-cli.mjs',
  'tsconfig.build.json',
  'test/unit/outgoing.test.ts',
  'test/e2e/cli.test.ts',
  'test/e2e/helpers/cli.ts',
  'test/e2e/helpers/raw.ts',
  'test/unit/identity.test.ts',
  'test/unit/keyfile.test.ts',
  'test/unit/paths.test.ts',
  'test/unit/audit-a1-a6.test.ts',
  'test/unit/pipeline.test.ts',
  'test/integration/transport.test.ts',
  'test/integration/helpers/nak.ts',
  'scripts/check-repo-integrity.mjs',
]

/**
 * 发布要件 —— **必须在仓库根目录**。
 *
 * LICENSE 尤其容易漏：GitHub 的许可证识别**只认根目录的 LICENSE 文件**，
 * `package.json` 里的 `"license": "Apache-2.0"` 字段不算数。漏了它，
 * 仓库页的许可证一栏就是"未识别"，法律上等于没给授权。
 */
const REQUIRED_ROOT_DOCS = [
  {
    file: 'LICENSE',
    minChars: 500,
    mustContain: ['Apache License'],
    why: 'GitHub 只认根目录的 LICENSE 文件；package.json 的 license 字段不算数',
  },
  {
    file: 'SECURITY.md',
    minChars: 200,
    mustContain: ['漏洞'],
    why: '必须告诉报告者如何**私下发**漏洞，否则他们只能开公开 issue',
  },
  {
    // 审计摘要必须公开：只把已修项写进 commit、把未修项藏起来，
    // 等于让读者以为"没有已知问题"。它是外部唯一能看到的风险清单。
    file: 'AUDIT.md',
    minChars: 800,
    mustContain: ['已修', '未修'],
    why: '未修复的发现必须与已修复的一起公开，不能只留在 commit 里',
  },
]

/** 关键目录：目录下至少要有一个被跟踪的文件。 */
const REQUIRED_DIRS = ['src/config', 'src/identity', 'src/envelope', 'src/transport', 'src/receive', 'src/messaging', 'src/common', 'src/cli', 'test/unit', 'test/integration', 'test/e2e']

/** 必须被忽略的私钥类/敏感文件形态（这些路径可以不存在）。 */
const REQUIRED_IGNORED = [
  'identity.key',
  'src/identity.key',
  'deep/nested/identity.key',
  'backup/my.nsec',
  'exported/agent.priv',
  'certs/foo.pem',
  'test/tmp/secrets/identity.key',
]

/** 绝对不能被忽略的反例 —— 防止「为了拦误伤而把规则删干净」。 */
const MUST_NOT_IGNORE = [
  'src/identity/identity.ts',
  'src/identity/keyfile.ts',
  'test/unit/identity.test.ts',
  'src/envelope/validate.ts',
]

/**
 * 长文档的**结构回归检查**。
 *
 * 起因（真实事故）：DECISIONS.md 曾被人（agent 的文件写入路径）整体重写，
 * 尾部被截断，§18/§19 与已知限制 L5–L9 凭空消失 —— 全程零报错，
 * 只是行数从 559 掉到 407。见 DECISIONS.md §21。
 *
 * 这类"静默丢内容"和"被 .gitignore 吞掉"是同一种事故：不报错、CI 全绿、
 * 只有人肉 diff 才能发现。所以同样用显式断言来抓。
 */
const REQUIRED_DOC_STRUCTURE = [
  {
    file: 'DECISIONS.md',
    headings: [
      '## 0. 威胁模型',
      '## 17. 已知限制',
      '## 18. 否定性断言清单',
      '## 19. 路线图补充',
      '## 20. CLI 定稿',
    ],
    /** 已知限制 L1–L9 一行都不能少（L3a 之类的子项不强制）。 */
    tableRows: ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9'],
  },
]

/**
 * 行数回归：与**上一次提交**比，允许小幅缩水，大幅缩水即失败。
 * 阈值取「10 行」与「2%」中的较大者 —— 既不会卡住正常润色，
 * 又能挡住"整体重写 + 尾部截断"这类事故（那次是 -152 行 / -27%）。
 */
const LINE_DROP_ABS = 10
const LINE_DROP_RATIO = 0.02
/** 有意的删减用这个开关放行 —— 必须是**显式的**，不能靠习惯性无视。 */
const SHRINK_OVERRIDE_ENV = 'AGENTNET_ALLOW_DOC_SHRINK'

function lineCount(text) {
  if (text === '') return 0
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
}

function committedText(path) {
  const { status, out } = git(['show', `HEAD:${path}`])
  return status === 0 ? out : null
}

const failures = []
const passes = []
const warnings = []

function git(args) {
  const r = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' })
  return { status: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' }
}

function trackedFiles() {
  const { status, out, err } = git(['ls-files'])
  if (status !== 0) {
    failures.push(`git ls-files 失败：${err.trim()}`)
    return new Set()
  }
  return new Set(out.split('\n').filter(Boolean))
}

function isIgnored(path) {
  // --no-index 允许对不存在的文件做判定
  const { status } = git(['check-ignore', '-q', '--no-index', path])
  return status === 0
}

console.log('仓库完整性自检\n' + '─'.repeat(56))

const tracked = trackedFiles()

if (failures.length === 0) {
  console.log('\n[1] 关键文件必须存在、未被忽略、且已 git add')
  for (const f of REQUIRED_TRACKED) {
    if (tracked.has(f)) {
      passes.push(`tracked: ${f}`)
      continue
    }
    if (!existsSync(join(REPO_ROOT, f))) {
      failures.push(`文件不存在且未被跟踪：${f}`)
      continue
    }
    // 真正要抓的是"被忽略"，不是"还没 add" —— 后者只是流程提醒，
    // 混为一谈会让新增文件的每一次提交都被自检拦下，进而被习惯性绕过。
    if (isIgnored(f)) {
      failures.push(`文件被 .gitignore 忽略（误伤，必须修 .gitignore）：${f}`)
    } else {
      warnings.push(`文件存在但尚未 git add：${f}`)
    }
  }

  console.log('\n[2] 关键目录至少含一个被跟踪的文件')
  for (const d of REQUIRED_DIRS) {
    const hit = [...tracked].some((t) => t.startsWith(d + '/'))
    if (hit) {
      passes.push(`dir ok: ${d}`)
    } else {
      failures.push(`目录下没有任何被跟踪的文件：${d}`)
    }
  }

  console.log('\n[3] 私钥类文件必须被 git 忽略')
  for (const p of REQUIRED_IGNORED) {
    if (isIgnored(p)) {
      passes.push(`ignored: ${p}`)
    } else {
      failures.push(`私钥类文件未被忽略 —— 有泄密风险：${p}`)
    }
  }

  console.log('\n[4] 源码必须不被忽略（防「为了拦误伤而删干净规则」）')
  for (const p of MUST_NOT_IGNORE) {
    if (isIgnored(p)) {
      failures.push(`源码/测试被 .gitignore 忽略：${p}`)
    } else {
      passes.push(`not ignored: ${p}`)
    }
  }
}

  console.log('\n[5] 长文档的结构与行数回归（防「整体重写时尾部被截断」）')
  const allowShrink = process.env[SHRINK_OVERRIDE_ENV] === '1'
  for (const spec of REQUIRED_DOC_STRUCTURE) {
    const abs = join(REPO_ROOT, spec.file)
    if (!existsSync(abs)) {
      failures.push(`文档不存在：${spec.file}`)
      continue
    }
    const text = readFileSync(abs, 'utf8')

    for (const h of spec.headings) {
      if (text.includes(h)) passes.push(`heading ok: ${spec.file} ${h}`)
      else failures.push(`${spec.file} 缺少必需章节：「${h}」（多半是重写时尾部被截断了）`)
    }
    for (const row of spec.tableRows) {
      const re = new RegExp(`^\\|\\s*${row}\\s*\\|`, 'm')
      if (re.test(text)) passes.push(`row ok: ${spec.file} ${row}`)
      else failures.push(`${spec.file} 缺少已知限制条目：| ${row} |`)
    }

    const prevText = committedText(spec.file)
    if (prevText === null) {
      warnings.push(`${spec.file} 尚无已提交版本，跳过行数回归`)
      continue
    }
    const prev = lineCount(prevText)
    const cur = lineCount(text)
    const drop = prev - cur
    const allowed = Math.max(LINE_DROP_ABS, Math.floor(prev * LINE_DROP_RATIO))
    if (drop > allowed) {
      const msg = `${spec.file} 行数从 ${prev} 掉到 ${cur}（-${drop}），超过阈值 ${allowed} 行 —— 极可能是重写时丢了内容。先 diff 确认`
      if (allowShrink) {
        // 只放行**行数**这一条启发式规则；上面那组章节断言是绝对的，
        // 真要删章节得改本文件的 REQUIRED_DOC_STRUCTURE（在评审里看得见）。
        warnings.push(`[${SHRINK_OVERRIDE_ENV}=1 已放行行数] ${msg}`)
      } else {
        failures.push(`${msg}；若为有意删减，用 ${SHRINK_OVERRIDE_ENV}=1 显式放行（该开关只管行数，不管必需章节）`)
      }
    } else if (drop > 0) {
      passes.push(`line ok: ${spec.file} ${prev}→${cur}（-${drop}，在阈值内）`)
    } else {
      passes.push(`line ok: ${spec.file} ${prev}→${cur}`)
    }
  }

  console.log('\n[6] 发布要件：根目录必须有 LICENSE 与 SECURITY.md')
  for (const spec of REQUIRED_ROOT_DOCS) {
    const abs = join(REPO_ROOT, spec.file)
    if (!existsSync(abs)) {
      failures.push(`根目录缺少 ${spec.file} —— ${spec.why}`)
      continue
    }
    const text = readFileSync(abs, 'utf8')
    if (text.trim().length < spec.minChars) {
      failures.push(`${spec.file} 只有 ${text.trim().length} 字符，多半是占位符而不是真文件`)
      continue
    }
    for (const needle of spec.mustContain) {
      if (text.includes(needle)) passes.push(`${spec.file} 含「${needle}」`)
      else failures.push(`${spec.file} 不含「${needle}」 —— 可能放错了文件`)
    }
    if (tracked.has(spec.file)) {
      passes.push(`tracked: ${spec.file}`)
    } else if (isIgnored(spec.file)) {
      failures.push(`${spec.file} 被 .gitignore 忽略（必须入库）：${spec.why}`)
    } else {
      failures.push(`${spec.file} 存在但尚未 git add —— ${spec.why}`)
    }
  }

console.log(`\n  通过 ${passes.length} 项`)
if (warnings.length > 0) {
  console.log(`\n⚠ 提醒 ${warnings.length} 项（不阻断提交）：`)
  for (const w of warnings) console.log(`   - ${w}`)
}
if (failures.length > 0) {
  console.log(`\n✗ 未通过 ${failures.length} 项：`)
  for (const f of failures) console.log(`   - ${f}`)
  console.log('\n修复后再提交。典型原因：.gitignore 里用了会命中目录名/模块名的通用词。\n')
  process.exit(1)
}
console.log('✓ 仓库完整性自检全部通过\n')
