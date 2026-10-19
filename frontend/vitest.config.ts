import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // styles/stripInk.test.ts reads the colour tokens (vitest hands other CSS back empty)
    css: { include: [/tokens\.css/] },
  },
})
