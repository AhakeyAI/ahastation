# B05 · N5095 语音路径候选与验证方案

日期：2026-10-22。状态：**候选筛选 + 基准脚本，未在 N5095 实测**。依据：规格 10「语音」、决策 D15（每专家独立音色）、D25（ASR/TTS 不计项目用量）、Q05/Q21。

## 现状（代码事实，main `c134de2`）

- ASR：只有讯飞 IAT 云端流式（`electron/asr/xfyun-iat.ts`），本地 whisper 已被移除。
- TTS：系统 `speechSynthesis`（`src/lib/speech-session.ts`）。`src/lib/voice-registry.ts` 按 locale 只选一个 voice，**没有角色到音色的映射**。
- 所以无论最后选哪个引擎，都要先补一层 `VoiceProvider`：`AgentRole.voiceId` → 引擎 + speaker id。这层与引擎选型无关，可以先做。

## 候选矩阵

RTF 是处理时间除以音频时长，小于 1 才能实时。表中数字来自 sherpa-onnx 官方文档，测试机是**树莓派 4**（Cortex-A72），不是 N5095。N5095（4 核 Jasper Lake，带 AVX2）通常比树莓派 4 快，但快多少必须实测。

### 本地 TTS（多音色）

| 候选 | 音色数 | 采样率 | 许可 | 官方 RTF（树莓派 4，1/4 线程） | 初判 |
| --- | --- | --- | --- | --- | --- |
| VITS aishell3（`vits-icefall-zh-aishell3`） | 174 | 8 kHz | Apache-2.0（icefall），数据集条款待核 | 0.365 / 0.156 | **N5095 首选候选**：快、音色多；8 kHz 音质偏电话感，需主观评审 |
| VITS fanchen-C（`vits-zh-hf-fanchen-C`） | 187 | 16 kHz | 待核（HF 社区模型） | 4.31 / 1.60 | 音质更好但慢 10 倍，N5095 上可能勉强 |
| Kokoro v1.1-zh（`kokoro-int8-multi-lang-v1_1`） | 103（100 中文） | 24 kHz | Apache-2.0 | v1.0 为 7.6 / 3.2；v1.1 未公布 | 音质最好；N5095 上大概率不能实时，适合 Mac 端或预合成 |
| MeloTTS zh_en | **1** | 44.1 kHz | MIT | 6.7 / 2.5 | 单音色，不满足 D15，排除 |

### 本地 ASR（中文流式）

| 候选 | 体积（int8） | 官方 RTF（作者机器） | 初判 |
| --- | --- | --- | --- |
| `sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30` | 编码器 154M | 0.15（1 线程） | 首选，真流式，适合按键录音时的实时字幕 |
| `streaming-zipformer-multi-zh-hans-2023-12-12` | 67M | 0.088（1 线程） | 更小的备选 |
| SenseVoiceSmall（VAD 分段，非流式） | — | 官方称比 Whisper-Small 快 5 倍以上 | 适合松键后整段识别、可提高准确率；权重适用 FunASR 模型许可，允许商用但有署名要求 |

### API 路径（联网时）

| 候选 | 说明 | 待核 |
| --- | --- | --- |
| 讯飞（已有 IAT 接入） | 同一账号可开在线 TTS，发音人多 | 发音人数量、计费、与 IAT 共用凭据 |
| 火山引擎／豆包语音、Azure 中文神经音色 | 多音色 | 价格、国内可用性、许可 |
| Windows／macOS 系统音色 | 免费、离线 | 中文音色很少，**不够给每位专家一个独立音色**，只能作为兜底 |

规格要求 ASR/TTS 是「独立的本地模型或 API」，并且不计入项目用量。所以 API 路径合规，只是需要用户自带凭据，计费也要单独展示。

## 本机冒烟结果（M1 Pro，不能代表 N5095）

2026-10-22，sherpa-onnx 1.13.8，Python 3.9。原始数据见 `smoke-m1pro-all.json`。

| 模型 | 1 线程 RTF（均值/最大） | 4 线程 RTF（均值/最大） |
| --- | --- | --- |
| ASR streaming zipformer zh int8 | 0.073 | 0.077 |
| TTS VITS aishell3（174 个音色） | 0.055 / 0.072 | 0.019 / 0.022 |
| TTS Kokoro v1.1-zh int8（103 个音色） | 0.733 / 0.789 | **0.88 / 0.993**（多线程反而更慢） |

- 脚本在 macOS 上三条路径都跑通，Windows 上还没跑过。
- **Kokoro 即便在 M1 Pro 上也只是勉强实时。** N5095 的单核性能明显低于 M1 Pro，Kokoro 在 N5095 上基本不可能实时，可以先从 N5095 候选中排除，留给 Mac 端或预合成。
- Kokoro 合成时会对部分中文标点报 `Unknown token: ❓`，需要做文本前处理；aishell3 没有这个问题。
- 音质还没有主观评审，样本在 `samples-m1pro/`（每个模型 4 个音色，第一句）。

## 建议的组合（待实测确认）

- **N5095**：ASR 用流式 zipformer，TTS 用 aishell3 VITS 作为离线多音色基线；联网时可切到 API 音色以提升音质。
- **Mac Apple Silicon**：ASR 同上；TTS 可用 Kokoro v1.1-zh（音质更好），或同样用 API。
- 同一个专家在两端用不同引擎时，**音色会不一样**。需要产品确认：「独立音色」是指同一台设备上专家之间可以区分，还是跨设备也必须是同一个声音？后者会把 N5095 逼到 API 或预合成。

## 打断与回声（假设，需要验证）

当前 TTS 走系统 `speechSynthesis`，声音由操作系统直接播放。Chromium 的回声消除（`getUserMedia({echoCancellation:true})`）以 Chromium 自己的播放输出作为参考信号，**很可能消除不了系统 TTS 的声音**。如果改成本地合成 PCM、再通过 WebAudio 在应用内播放，回声消除可能会生效。这一点要在 N5095 的内置扬声器和麦克风上实测，不能只靠推理。

## 实测步骤（在 N5095 上，Windows x64）

1. 下载三个官方模型包，解压到 `models/`：
   - `asr-models/sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30.tar.bz2`
   - `tts-models/vits-icefall-zh-aishell3.tar.bz2`
   - `tts-models/kokoro-int8-multi-lang-v1_1.tar.bz2`

   下载地址统一为 `https://github.com/k2-fsa/sherpa-onnx/releases/download/<上面的路径>`。
2. `pip install sherpa-onnx==1.13.8 numpy soundfile`，再运行 `python bench_voice.py --models models --out n5095.json --threads 1 2 4`。
3. 记录：CPU 名称、是否接电源、各线程数的 RTF 均值和最大值；试听每个音色样本（`n5095-wav/`）的可接受度。
4. 通过线（建议值，待确认）：ASR RTF 低于 0.5（给 UI 和网络留余量），TTS RTF 低于 0.7（边合成边播放时不卡顿）；同时运行 ASR 和 TTS 时 CPU 不打满（Agent 执行还要算力）。
5. 补测：扬声器播放 TTS 时说话打断，记录回声导致的误识别率；分别测系统 TTS 和应用内播放两种情况。

脚本只测算力，**不代替**回声、打断、噪声和实体按键的实测。
