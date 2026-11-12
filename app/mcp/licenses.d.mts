// 日期：2026-11-12。供构建配置调用既有许可收集器。
export function bundledLicenses(metafile: { inputs: Record<string, unknown> }, workingDirectory?: string): Promise<{ licenses: string[]; count: number }>;
