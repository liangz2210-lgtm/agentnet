#!/usr/bin/env node
/**
 * CLI 构建脚本：
 * 1. `tsc -p tsconfig.build.json` 编译到 dist/（CommonJS —— 扩展名无关的
 *    require 解析让"源码用无扩展名导入"可以原样工作）；
 * 2. dist/package.json 标记 `{"type":"commonjs"}` —— 根 package.json 是
 *    `type: module`，不标记的话 dist/*.js 会被 Node 当 ESM 解析然后炸掉。
 */

import { spawnSync } from 'node:child_process'
import { writeFileSync, rmSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')

rmSync(join(root, 'dist'), { recursive: true, force: true })
const result = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.build.json'], {
  cwd: root,
  stdio: 'inherit',
})
if (result.status !== 0) process.exit(result.status ?? 1)

writeFileSync(join(root, 'dist', 'package.json'), JSON.stringify({ type: 'commonjs' }, null, 2))
if (!existsSync(join(root, 'dist', 'cli', 'bin.js'))) {
  console.error('构建产物缺失：dist/cli/bin.js')
  process.exit(1)
}
console.log('✓ CLI 构建完成: dist/cli/bin.js')
