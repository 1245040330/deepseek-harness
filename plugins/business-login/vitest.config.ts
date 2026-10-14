import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'
import { standardDecoratorPlugin, vitestExecArgv } from '../../vitest.shared.ts'

export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['./tsconfig.base.json'] }), standardDecoratorPlugin()],
  test: { include: ['plugins/business-login/*.spec.ts'], execArgv: [...vitestExecArgv, '--import', 'tsx/esm'], testTimeout: 15000 },
})
