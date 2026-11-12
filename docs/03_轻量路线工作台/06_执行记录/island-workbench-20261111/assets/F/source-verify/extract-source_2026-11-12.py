# 日期：2026-11-12。解压并校验最小对应源码；拒绝越界、链接和覆盖已有目录。
import pathlib,json,zipfile,hashlib,stat
root=pathlib.Path(r'G:\rust\Codex-task-monitoring')
evidence=pathlib.Path(__file__).resolve().parent
manifest=json.loads((root/'app/test-results/island-F/delivery/source-manifest.json').read_text('utf-8-sig'))
source=next(x for x in manifest['sources'] if x['name']=='business-source')
archive=pathlib.Path(source['file'])
sha=hashlib.sha256(archive.read_bytes()).hexdigest()
assert sha==source['sha256']
target=root/'app/test-results/island-F/source-verify'
target.mkdir(parents=True,exist_ok=False)
with zipfile.ZipFile(archive) as z:
    for i in z.infolist():
        full=(target/i.filename).resolve()
        assert full.is_relative_to(target.resolve()),i.filename
        assert not stat.S_ISLNK(i.external_attr>>16),i.filename
    assert z.testzip() is None
    z.extractall(target)
result={'date':'2026-11-12','archive':str(archive),'sha256':sha,'originalSourceCommit':source['commit'],'entries':len(source['entries']),'extractedRoot':str(target/'business-source'),'originalGitHistoryIncluded':False,'gitImportPurpose':'local fixture only; import commit must not be presented as original source commit'}
(evidence/'source-import_2026-11-12.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps(result,ensure_ascii=False,indent=2))
