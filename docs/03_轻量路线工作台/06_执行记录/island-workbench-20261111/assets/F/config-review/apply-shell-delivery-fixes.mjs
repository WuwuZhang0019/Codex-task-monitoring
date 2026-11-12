// 日期：2026-11-12。F 必要交付修复；只允许明确的原 Fork 目标。
import fs from 'node:fs';
import path from 'node:path';
const root = 'G:/rust/windows-dynamic-island';
function replace(file, before, after) {
  const target = path.join(root, file);
  const text = fs.readFileSync(target, 'utf8');
  if (!text.includes(before)) throw new Error(`Expected source missing: ${file}`);
  fs.writeFileSync(target, text.replace(before, after), 'utf8');
}
replace('src/settings/pages/AboutPage.tsx',
  'const UPSTREAM_URL = "https://github.com/HeyyCzer/windows-dynamic-island";',
  'const UPSTREAM_URL = "https://github.com/HeyyCzer/windows-dynamic-island";\nconst LICENSE_URL = `${UPSTREAM_URL}/blob/e286d9045746837bf1960e0d13b7ed572b8d9e50/LICENSE`;');
replace('src/settings/pages/AboutPage.tsx',
  '\treturn (',
  '\tconst openLicense = () =>\n\t\tisTauri ? command("open_external", { url: LICENSE_URL }) : window.open(LICENSE_URL, "_blank", "noopener");\n\treturn (');
replace('src/settings/pages/AboutPage.tsx',
  'GPL-3.0-or-later · © HeyyCzer / Vorssaint · 修改日期：2026-11-11',
  'GPL-3.0-or-later · © HeyyCzer · 致谢 Vorssaint · 修改日期：2026-11-12');
replace('src/settings/pages/AboutPage.tsx',
  '\t\t\t\t\t<Button onClick={openUpstream}>上游来源</Button>',
  '\t\t\t\t\t<Button onClick={openLicense}>许可证</Button>\n\t\t\t\t\t<Button onClick={openUpstream}>上游来源</Button>');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <!-- Date: 2026-11-12. Task Island original capsule and three task nodes. -->
  <rect x="64" y="64" width="896" height="896" rx="220" fill="#15171d"/>
  <rect x="160" y="288" width="704" height="448" rx="224" fill="none" stroke="#e6ebf2" stroke-width="48"/>
  <circle cx="320" cy="512" r="64" fill="#e6ebf2"/>
  <circle cx="512" cy="512" r="64" fill="#38d9d0"/>
  <circle cx="704" cy="512" r="64" fill="#e6ebf2"/>
</svg>
`;
fs.writeFileSync(path.join(root, 'src-tauri/app-icon.svg'), svg, 'utf8');
replace('src/components/icons.tsx', 'import { type SVGProps, useId } from "react";', 'import type { SVGProps } from "react";');
const icons = fs.readFileSync(path.join(root, 'src/components/icons.tsx'), 'utf8');
const start = icons.indexOf('/** The app icon');
const end = icons.indexOf('\nexport const GitHubIcon');
if (start < 0 || end < start) throw new Error('AppLogo source boundary missing');
const logo = `/** Date: 2026-11-12. Original task-node icon, matching src-tauri/app-icon.svg. */
export function AppLogo({ size = 16, ...rest }: P) {
\treturn (
\t\t<svg width={size} height={size} viewBox="0 0 1024 1024" aria-hidden {...rest}>
\t\t\t<rect x="64" y="64" width="896" height="896" rx="220" fill="#15171d" />
\t\t\t<rect x="160" y="288" width="704" height="448" rx="224" fill="none" stroke="#e6ebf2" strokeWidth="48" />
\t\t\t<circle cx="320" cy="512" r="64" fill="#e6ebf2" />
\t\t\t<circle cx="512" cy="512" r="64" fill="#38d9d0" />
\t\t\t<circle cx="704" cy="512" r="64" fill="#e6ebf2" />
\t\t</svg>
\t);
}
`;
fs.writeFileSync(path.join(root, 'src/components/icons.tsx'), icons.slice(0, start) + logo + icons.slice(end), 'utf8');
const confPath = path.join(root, 'src-tauri/tauri.conf.json');
const conf = JSON.parse(fs.readFileSync(confPath, 'utf8'));
conf.bundle.icon = ['icons/task-island/32x32.png', 'icons/task-island/128x128.png', 'icons/task-island/128x128@2x.png', 'icons/task-island/icon.ico'];
conf.bundle.resources = { '../LICENSE': 'licenses/LICENSE', '../THIRD-PARTY-NOTICES.txt': 'licenses/THIRD-PARTY-NOTICES.txt', '../SOURCE.md': 'licenses/SOURCE.md' };
fs.writeFileSync(confPath, JSON.stringify(conf, null, 2) + '\n', 'utf8');
console.log('F delivery fixes applied to explicit Fork files');
