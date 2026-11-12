"""Date: 2026-11-12. Vendor a pinned, offline LobeHub SVG catalog for Task Island."""

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import time
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET

REVISION = "a177c1e817204f8ddc0c8993610ca674fc6d9767"
BASE = f"https://raw.githubusercontent.com/lobehub/lobe-icons/{REVISION}"
# IDs are upstream identifiers; aliases only affect icon selection, never connection identity.
CATALOG = """
openai|OpenAI|ChatGPT,GPT
codex|Codex|OpenAI Codex
anthropic|Anthropic|
claude|Claude|
claudecode|Claude Code|claude-code
google|Google|
gemini|Gemini|
geminicli|Gemini CLI|gemini-cli
deepmind|Google DeepMind|
meta|Meta|Llama
mistral|Mistral|
cohere|Cohere|
perplexity|Perplexity|
xai|xAI|
grok|Grok|
nvidia|NVIDIA|
microsoft|Microsoft|
azureai|Azure AI|azure
aws|AWS|Amazon
bedrock|Amazon Bedrock|
github|GitHub|
githubcopilot|GitHub Copilot|copilot
huggingface|Hugging Face|
stability|Stability AI|Stable Diffusion
midjourney|Midjourney|
runway|Runway|
adobefirefly|Adobe Firefly|
elevenlabs|ElevenLabs|
groq|Groq|
together|Together AI|
fireworks|Fireworks AI|
replicate|Replicate|
cerebras|Cerebras|
sambanova|SambaNova|
vercel|Vercel|
ollama|Ollama|
lmstudio|LM Studio|lm-studio
cursor|Cursor|
windsurf|Windsurf|
antigravity|Antigravity|
opencode|OpenCode|
cline|Cline|
roocode|Roo Code|
kiro|Kiro|
devin|Devin|
replit|Replit|
openrouter|OpenRouter|
deepseek|DeepSeek|深度求索
qwen|Qwen|通义千问,通义
alibabacloud|Alibaba Cloud|阿里云
bailian|Bailian|百炼
bytedance|ByteDance|字节跳动
doubao|Doubao|豆包
zhipu|Zhipu|智谱
zai|Z.ai|z-ai
chatglm|ChatGLM|GLM
moonshot|Moonshot AI|月之暗面
kimi|Kimi|
minimax|MiniMax|稀宇
hailuo|Hailuo|海螺
baichuan|Baichuan|百川
baidu|Baidu|百度
wenxin|Wenxin|文心,文心一言
tencent|Tencent|腾讯
hunyuan|Hunyuan|混元
yuanbao|Yuanbao|元宝
spark|Spark|讯飞星火
iflytekcloud|iFlytek|科大讯飞,讯飞
yi|Yi|零一万物
sensenova|SenseNova|商汤日日新
stepfun|StepFun|阶跃星辰
siliconcloud|SiliconCloud|硅基流动,SiliconFlow
modelscope|ModelScope|魔搭
internlm|InternLM|书生
huawei|Huawei|华为
huaweicloud|Huawei Cloud|华为云
volcengine|Volcengine|火山引擎
trae|Trae|
codebuddy|CodeBuddy|代码助手
workbuddy|WorkBuddy|
qoder|Qoder|
manus|Manus|
longcat|LongCat|龙猫
xiaomimimo|Xiaomi MiMo|MiMo,小米
ling|Ling|蚂蚁百灵
kling|Kling|可灵
jimeng|Jimeng|即梦
tiangong|Tiangong|天工
skywork|Skywork|天工超级智能体
giteeai|Gitee AI|gitee-ai
coze|Coze|扣子
dify|Dify|
lobehub|LobeHub|
"""


def fetch(relative):
    for attempt in range(3):
        try:
            request = Request(f"{BASE}/{relative}", headers={"User-Agent": "TaskIsland-assets"})
            with urlopen(request, timeout=35) as response:
                return response.read()
        except Exception:
            if attempt == 2:
                raise
            time.sleep(attempt + 1)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--shell-root", type=Path, required=True)
    parser.add_argument("--tree", type=Path, help="Optional cached recursive GitHub tree for the pinned revision")
    args = parser.parse_args()
    if args.tree:
        tree = json.loads(args.tree.read_text(encoding="utf-8"))
    else:
        request = Request(f"https://api.github.com/repos/lobehub/lobe-icons/git/trees/{REVISION}?recursive=1",
                          headers={"User-Agent": "TaskIsland-assets"})
        with urlopen(request, timeout=35) as response:
            upstream = json.load(response)
        tree = {"sha": upstream["sha"], "paths": [entry["path"] for entry in upstream["tree"]]}
    assert tree["sha"] == REVISION
    paths = set(tree["paths"])
    destination = args.shell_root / "public/ai-icons"
    destination.mkdir(parents=True, exist_ok=True)
    catalog, downloads = [], []
    for line in CATALOG.strip().splitlines():
        icon_id, name, aliases = line.split("|")
        base = f"packages/static-svg/icons/{icon_id}.svg"
        assert base in paths, f"Missing upstream icon: {base}"
        color = f"packages/static-svg/icons/{icon_id}-color.svg"
        entry = {"id": icon_id, "name": name, "aliases": list(filter(None, aliases.split(","))), "color": color in paths}
        catalog.append(entry)
        downloads.append(base)
        if entry["color"]:
            downloads.append(color)

    def download(relative):
        data = fetch(relative)
        root = ET.fromstring(data)
        assert root.tag.endswith("svg")
        for node in root.iter():
            assert not node.tag.lower().endswith("script")
            for key, value in node.attrib.items():
                assert not key.lower().startswith("on")
                assert not (key.endswith("href") and value and not value.startswith("#"))
        name = relative.rsplit("/", 1)[-1]
        (destination / name).write_bytes(data)
        return {"file": name, "sha256": hashlib.sha256(data).hexdigest(), "source": f"{BASE}/{relative}"}

    with ThreadPoolExecutor(max_workers=8) as pool:
        assets = list(pool.map(download, downloads))
    license_data = fetch("LICENSE")
    (destination / "LICENSE").write_bytes(license_data)
    manifest = {"date": "2026-11-12", "source": "https://lobehub.com/zh/icons", "revision": REVISION,
                "license": "MIT", "brands": len(catalog), "assets": sorted(assets, key=lambda item: item["file"])}
    (destination / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (args.shell_root / "src/core/ai-icon-catalog.json").write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (destination / "NOTICE.md").write_text(
        "# Local AI icon catalog\n\nDate: 2026-11-12\n\n"
        f"Source: https://github.com/lobehub/lobe-icons/tree/{REVISION}\n\n"
        "Copyright (c) 2023 LobeHub. Distributed under the included MIT LICENSE.\n"
        "Brand names and logos remain the property of their respective owners; inclusion does not imply endorsement.\n"
        "SVG files are unmodified upstream assets. manifest.json records their sources and SHA-256 checksums.\n",
        encoding="utf-8")
    print(json.dumps({"brands": len(catalog), "svg_files": len(assets), "revision": REVISION}))


if __name__ == "__main__":
    main()
