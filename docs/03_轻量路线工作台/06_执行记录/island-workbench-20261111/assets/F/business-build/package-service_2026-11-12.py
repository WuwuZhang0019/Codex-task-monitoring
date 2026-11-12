# 日期：2026-11-12。核对固定构建资源manifest并仅压缩资源文件，不打包运行数据。
import pathlib,hashlib,json,zipfile,shutil,subprocess,re
RESOURCE=pathlib.Path(r'C:\Users\Zyf\.codex\worktrees\island-f-business-build\Codex-task-monitoring\app\desktop\resources')
ROOT=pathlib.Path(r'G:\rust\Codex-task-monitoring')
OUT=pathlib.Path(__file__).resolve().parent
DEST=ROOT/'app/test-results/island-F/delivery'
DEST.mkdir(parents=True,exist_ok=True)
COMMIT='1e4aa21678733930d36590a0a67fe6506f51f595'
actual=subprocess.check_output(['git','rev-parse','HEAD'],cwd=RESOURCE).decode().strip()
assert actual==COMMIT,(actual,COMMIT)
manifest=json.loads((RESOURCE/'manifest.json').read_text('utf-8'))
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
for rel,expected in manifest['resources'].items(): assert sha(RESOURCE/rel)==expected,rel
items=sorted(p for p in RESOURCE.rglob('*') if p.is_file())
for p in items:
    rel=p.relative_to(RESOURCE).as_posix()
    assert not re.search(r'(^|/)(runtime-private|data|\.env[^/]*)(/|$)|\.(sqlite|db)$|owner-session\.json|panel-session\.json|owner\.json',rel,re.I),rel
package=DEST/'route-workbench-service-0.1.0-1e4aa21-win-x64.zip'
with zipfile.ZipFile(package,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as z:
    for p in items:
        info=zipfile.ZipInfo(p.relative_to(RESOURCE).as_posix(),date_time=(2026,11,12,0,0,0))
        info.compress_type=zipfile.ZIP_DEFLATED
        info.external_attr=0o100644<<16
        z.writestr(info,p.read_bytes(),compress_type=zipfile.ZIP_DEFLATED,compresslevel=9)
with zipfile.ZipFile(package) as z:
    assert z.testzip() is None
    assert len(z.infolist())==len(items)
shutil.copyfile(RESOURCE/'manifest.json',OUT/'resource-manifest-final_2026-11-12.json')
summary={'date':'2026-11-12','sourceCommit':COMMIT,'sourceWorktree':str(RESOURCE.parents[2]),'protocolVersion':'island-workbench/1','commands':['npm ci','npm run build','npm run desktop:resources','node --test desktop/*.test.mjs','npm test'],'resourceManifestSha256':sha(RESOURCE/'manifest.json'),'manifestEntries':len(manifest['resources']),'resourceFileCount':len(items),'package':str(package),'packageSha256':sha(package),'packageBytes':package.stat().st_size,'nodeVersion':manifest['nodeVersion'],'nodeExeSha256':manifest['nodeExeSha256'],'nodeDistributionSha256':manifest['distributionSha256'],'runtimeDataIncluded':False,'zipIntegrity':'passed','files':[{'path':p.relative_to(RESOURCE).as_posix(),'sha256':sha(p),'bytes':p.stat().st_size} for p in items]}
(OUT/'business-delivery_2026-11-12.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({k:v for k,v in summary.items() if k!='files'},ensure_ascii=False,indent=2))
