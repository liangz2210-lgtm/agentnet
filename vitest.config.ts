import { defineConfig } from 'vitest/config'

// Vitest 5 的 InlineConfig 不再暴露 pool / poolOptions，故此处只保留稳定选项。
// 集成测试需要串行执行 —— 待第 5 步引入时间，届时在此补对应的并发控制。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
})
