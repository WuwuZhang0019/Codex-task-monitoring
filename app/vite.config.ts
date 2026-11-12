import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { bundledLicenses } from './mcp/licenses.mjs';
export default defineConfig({
  // 日期：2026-11-12。随实际前端产物携带保留版权的完整依赖许可。
  plugins: [react(), {
    name: 'frontend-third-party-notices',
    async generateBundle(_options, bundle) {
      const inputs = Object.fromEntries(Object.values(bundle)
        .flatMap(output => output.type === 'chunk' ? Object.keys(output.modules) : [])
        .filter(id => !id.startsWith('\u0000')).map(id => [id, {}]));
      const { licenses } = await bundledLicenses({ inputs }, process.cwd());
      this.emitFile({ type: 'asset', fileName: 'THIRD-PARTY-NOTICES.txt',
        source: `日期：2026-11-12\n\n${licenses.join('\n\n---\n\n')}\n` });
    },
  }],
  server: { host: '127.0.0.1', port: 4317, strictPort: true, proxy: { '/api': 'http://127.0.0.1:4318' } },
  preview: { host: '127.0.0.1', port: 4317, strictPort: true },
});
