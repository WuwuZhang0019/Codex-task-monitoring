# 日期：2026-11-12
"""只读审计本地锁定依赖声明、许可文件和分发资源；不下载或修改产品。"""
import json, pathlib, hashlib, subprocess, tomllib, re
# 使用明确仓库，避免依赖脚本目录层数
ROOT=pathlib.Path(r'G:\rust\Codex-task-monitoring')
OUT=pathlib.Path(__file__).resolve().parent
sha=lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
def files(d):
    return [p for p in d.iterdir() if p.is_file() and re.match(r'(?i)^(licen[sc]e|copying|notice|copyright|unlicense)',p.name)] if d.is_dir() else []
def meta_files(fs):
    return [{'path':str(p),'sha256':sha(p),'bytes':p.stat().st_size} for p in fs]
lock=json.loads((ROOT/'app/package-lock.json').read_text('utf-8'))
npm=[]
for rel,p in lock['packages'].items():
    if not rel: continue
    d=ROOT/'app'/rel
    installed=None
    if (d/'package.json').exists(): installed=json.loads((d/'package.json').read_text('utf-8'))
    npm.append({'path':rel,'name': installed.get('name') if installed else rel.rsplit('node_modules/',1)[-1], 'version':p['version'], 'lockLicense':p.get('license'), 'dev':p.get('dev',False),'optional':p.get('optional',False),'resolved':p.get('resolved'),'integrity':p.get('integrity'),'installedVersion':installed.get('version') if installed else None,'installedLicense':installed.get('license') if installed else None,'repository':installed.get('repository') if installed else None,'author':installed.get('author') if installed else None,'licenseFiles':meta_files(files(d))})
cargo=[]
cache=pathlib.Path(r'C:\Users\Zyf\.cargo\registry\src')
for p in tomllib.loads((ROOT/'app/src-tauri/Cargo.lock').read_text('utf-8'))['package']:
    if not p.get('source'): continue
    matches=list(cache.glob('*/'+p['name']+'-'+p['version']))
    manifest=matches[0]/'Cargo.toml' if matches else None
    data=tomllib.loads(manifest.read_text('utf-8'))['package'] if manifest and manifest.exists() else {}
    cargo.append({'name':p['name'],'version':p['version'],'source':p.get('source'),'checksum':p.get('checksum'),'license':data.get('license'),'licenseFile':data.get('license-file'),'authors':data.get('authors'),'repository':data.get('repository'),'manifest':str(manifest) if manifest else None,'licenseFiles':meta_files(files(matches[0])) if matches else []})
tracked=subprocess.check_output(['git','ls-files','-z'],cwd=ROOT).decode().split('\0')
assets=[]
for f in tracked:
    if f and pathlib.Path(f).suffix.lower() in ['.png','.jpg','.jpeg','.webp','.svg','.ico','.ttf','.otf','.woff','.woff2']:
        p=ROOT/f
        if p.exists(): assets.append({'path':f,'sha256':sha(p),'bytes':p.stat().st_size,'firstCommit':subprocess.check_output(['git','log','--follow','--diff-filter=A','--format=%H','--',f],cwd=ROOT).decode().strip()})
data={'date':'2026-11-12','repository':str(ROOT),'commit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT).decode().strip(),'authors':subprocess.check_output(['git','log','--format=%an <%ae>'],cwd=ROOT).decode().splitlines(),'npm':npm,'cargo':cargo,'trackedAssets':assets,'rootLicenseFiles':meta_files(files(ROOT))}
data['authors']=sorted(set(data['authors']))
(OUT/'business-license-inventory_2026-11-12.json').write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
summary={'npmCount':len(npm),'npmInstalled':sum(x['installedVersion'] is not None for x in npm),'npmNoLicenseDeclaration':[x['path'] for x in npm if not x['lockLicense']],'npmRuntimeCount':sum(not x['dev'] for x in npm),'npmRuntimeMissingLicenseText':[x['name'] for x in npm if not x['dev'] and x['installedVersion'] and not x['licenseFiles']],'cargoCount':len(cargo),'cargoCacheManifests':sum(x['manifest'] is not None for x in cargo),'cargoCachedNoLicenseDeclaration':[x['name'] for x in cargo if x['manifest'] and not x['license']],'cargoUncached':[x['name']+'@'+x['version'] for x in cargo if not x['manifest']],'cargoCachedNoTopLevelLicenseText':[x['name'] for x in cargo if x['manifest'] and not x['licenseFiles']],'rootLicenses':data['rootLicenseFiles'],'authors':data['authors'],'assetCount':len(assets)}
(OUT/'summary_2026-11-12.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps(summary,ensure_ascii=False,indent=2))
