# 日期：2026-11-12。对应源码ZIP独立编译后只读清点，不覆盖正式交付物。
import pathlib,json,hashlib,subprocess
root=pathlib.Path(r'G:\rust\Codex-task-monitoring')
out=pathlib.Path(__file__).resolve().parent
source=root/'app/test-results/island-F/source-verify/business-source'
resources=source/'app/desktop/resources'
manifest=json.loads((resources/'manifest.json').read_text('utf-8'))
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
for rel,h in manifest['resources'].items(): assert sha(resources/rel)==h,rel
probe=json.loads((source/'app/test-results/runtime-download/probe-package/plugins/task-workbench/release-manifest.json').read_text('utf-8'))
package=root/'app/test-results/island-F/delivery/route-workbench-service-0.1.0-1e4aa21-win-x64.zip'
result={'date':'2026-11-12','verification':'minimal corresponding-source ZIP compile completeness','originalCommit':'1e4aa21678733930d36590a0a67fe6506f51f595','importCommit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=source).decode().strip(),'sourceStatusTrackedAfterBuild':subprocess.check_output(['git','status','--porcelain','--untracked-files=no'],cwd=source).decode().strip(),'independentlyInstalledNodeModules':(source/'app/node_modules').is_dir(),'sourceNodeModulesIsSymlink':(source/'app/node_modules').is_symlink(),'commands':[{'command':'npm ci --prefix .','cwd':'exported business-source/app','exitCode':0},{'command':'npm run build','cwd':'exported business-source/app','exitCode':0},{'command':'npm run desktop:resources','cwd':'exported business-source/app','exitCode':0}],'manifestEntriesVerified':len(manifest['resources']),'resourceFileCount':len([p for p in resources.rglob('*') if p.is_file()]),'resourceManifestSha256':sha(resources/'manifest.json'),'schemaSha256':sha(resources/'app/mcp/contracts/v1.json'),'probeImportCommit':probe['sourceCommit'],'probeReleaseReady':probe['releaseReady'],'probeDirtySource':probe['dirtySource'],'nodeVersion':manifest['nodeVersion'],'nodeDistributionSha256':manifest['distributionSha256'],'finalServiceZipUnchangedSha256':sha(package),'testsRepeated':False,'sourceZipMissingFiles':False}
assert result['importCommit']!=result['originalCommit']
assert result['probeImportCommit']==result['importCommit']
assert result['finalServiceZipUnchangedSha256']=='5c6c6961f20e5be68442bacb87d3ab4d643552f538319ba865e34d0b78781226'
(out/'source-build-verification_2026-11-12.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps(result,ensure_ascii=False,indent=2))
