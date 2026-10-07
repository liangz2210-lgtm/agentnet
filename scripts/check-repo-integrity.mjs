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
import { existsSync } from 'node:fs'
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
  'test/unit/identity.test.ts',
  'test/unit/keyfile.test.ts',
  'test/unit/paths.test.ts',
  'test/unit/audit-a1-a6.test.ts',
  'scripts/check-repo-integrity.mjs',
]

/** 关键目录：目录下至少要有一个被跟踪的文件。 */
const REQUIRED_DIRS = ['src/config', 'src/identity', 'src/envelope', 'test/unit', 'test/integration']

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

const failures = []
const passes = []

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
  console.log('\n[1] 关键文件必须被 git 跟踪')
  for (const f of REQUIRED_TRACKED) {
    if (tracked.has(f)) {
      passes.push(`tracked: ${f}`)
    } else if (!existsSync(join(REPO_ROOT, f))) {
      failures.push(`文件不存在且未被跟踪：${f}`)
    } else {
      failures.push(`文件存在但未被 git 跟踪（极可能被 .gitignore 误伤）：${f}`)
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

console.log(`\n  通过 ${passes.length} 项`)
if (failures.length > 0) {
  console.log(`\n✗ 未通过 ${failures.length} 项：`)
  for (const f of failures) console.log(`   - ${f}`)
  console.log('\n修复后再提交。典型原因：.gitignore 里用了会命中目录名/模块名的通用词。\n')
  process.exit(1)
}
console.log('✓ 仓库完整性自检全部通过\n')
