// 日期：2026-11-13。离线校验候选请求，不连接服务，不写业务状态。
import {readFile} from 'node:fs/promises';
import {validateLightToolArguments} from './light.mjs';
const [name, file] = process.argv.slice(2);
if (!name || !file) throw Error('Usage: node validate.mjs <tool-name> <request.json>');
const validationErrors = validateLightToolArguments(name, JSON.parse(await readFile(file, 'utf8')));
console.log(JSON.stringify({date:'2026-11-13', valid:validationErrors.length===0, validationErrors}, null, 2));
process.exitCode = validationErrors.length ? 1 : 0;
