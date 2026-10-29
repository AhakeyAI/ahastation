# R6 · 讯飞 / 豆包 / Azure 在线语音首轮基准

日期：2026-10-26。状态：**脚本与离线验证完成，三家真实在线实测未执行**。本目录不产生“已通过 A-08”的结论；真实结果必须来自 `--execute` 生成的 JSON 和可播放音频。

## 范围与官方依据

- 讯飞：在线 TTS `wss://tts-api.xfyun.cn/v2/tts` 与流式 ASR `wss://iat-api.xfyun.cn/v2/iat`，HMAC-SHA256 签名，见[讯飞 TTS API](https://www.xfyun.cn/doc/tts/online_tts/API.html)和[讯飞 ASR API](https://www.xfyun.cn/doc/asr/voicedictation/API.html)。
- 豆包：TTS 用 HTTP Chunked `https://openspeech.bytedance.com/api/v3/tts/unidirectional`，ASR 用 `wss://openspeech.bytedance.com/api/v3/sauc/bigmodel`，见[豆包 HTTP Chunked/SSE](https://www.volcengine.com/docs/6561/1598757)和[豆包流式 ASR](https://www.volcengine.com/docs/6561/1354869)。默认资源为 `seed-tts-2.0` 与 `volc.seedasr.sauc.duration`。
- Azure：TTS 用区域 `tts.speech.microsoft.com/cognitiveservices/v1`，ASR 用短音频 REST；见[Azure TTS REST](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-text-to-speech)和[Azure 短音频 ASR REST](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-speech-to-text-short)。短音频 REST 只给最终结果，所以 `firstPacketMs=null`，不能冒充流式首字数据；A-08 若要公平比较首字，应再接 Speech SDK/WebSocket。
- 价格：豆包和 Azure 来源见 `pricing.json`，包括[豆包计费](https://www.volcengine.com/docs/DoubaoVoice/Billinginstructions-21)与[Azure Speech 价格](https://azure.microsoft.com/en-us/pricing/details/speech/)。**讯飞公开页未确认当前账号的超额单价，配置保留 `null`，因此真实执行会在发请求前停止；先从讯飞控制台填入价格。** Azure 的 USD/CNY=7.20 是预算假设，执行前按实际支付汇率更新。

## 测试矩阵

每个 provider 串行执行，不自动重试：

1. TTS：3 段固定中文冷调用 + 第 1 段 1 次热调用，记录连接后首包、首个音频、总时延、音频字节、音色、logid 和服务端字符用量。
2. ASR：同一 16 kHz / mono / PCM16 / 不超过 60 秒 WAV，冷/热两组，记录首响应、首文本、总时延、最终文本和计费秒数。文本应与 `bench_voice.py` 的固定句对应，以便比较识别准确率。
3. 输出：每次结果带 `realApiCalls=true`、价格文件 SHA-256、输入音频路径和时长、重试次数 0、错误分类。TTS 音频写入同名结果目录；`audioDecodable` 初检只代表音频非空，A-08 必须实际播放和解码验证。
4. 通过判定：三家都完成真实调用后才比较延迟、准确率和音色。失败项保持 `ok=false`，不把另一家通过写成整组通过。

## 100 元独立预算器

- 总上限 **100 CNY**，与 Claude/Codex 完全分账；`pricing.json` 保存单价来源和日期。
- 每次调用前先按输入字符或音频秒数预留；秒数向上取整。`spent + reserved` 超过上限时，请求不会发出。
- 有服务端用量则按服务端值结算；只有输入用量时标为 `input-observed`；错误/未知结果按完整预留保守结算，不返还成可用余额。
- 不提供自动重试；预算错误会停止后续调用。预留/结算写入 `<result>.budget.jsonl`。
- 这是客户端硬停止，不是云端限额，不能撤销已完成的计费，也不替代供应商控制台预算告警。

## 运行

默认只 dry-run，不实例化 provider、不发网络请求：

```bash
python -m pip install -r docs/c0/b05-voice/online/requirements.txt
python docs/c0/b05-voice/online/bench_online.py --operations tts --repeat 1
python docs/c0/b05-voice/online/test_offline.py
```

准备 ASR 样本：录制或转码为 16 kHz、单声道、PCM16 WAV，内容使用固定中文句。不要用 8 kHz 的 aishell3 输出直接冒充三家可比的 16 kHz 输入。

真实执行前在 shell 当前进程设置凭据，**不要写入文件或命令历史共享记录**：

- 讯飞：`XFYUN_APP_ID`、`XFYUN_API_KEY`、`XFYUN_API_SECRET`；`XFYUN_TTS_SPEAKER` 默认 `x4_xiaoyan`，可按已授权音色覆盖。
- 豆包：`DOUBAO_API_KEY`、`DOUBAO_TTS_SPEAKER`（必须确认该音色属于 `seed-tts-2.0`）。
- Azure：`AZURE_SPEECH_KEY`、`AZURE_SPEECH_REGION`；`AZURE_TTS_VOICE` 默认 `zh-CN-XiaoxiaoNeural`。

```bash
python docs/c0/b05-voice/online/bench_online.py \
  --audio /path/to/fixed-16k-mono.wav \
  --providers xfyun doubao azure \
  --operations tts asr --repeat 2 --execute
```

结果默认写到 `docs/c0/results/online-voice-<UTC>.json`。也可加 `--out /path/to/result.json`。敏感值只从环境读取；错误文本会按环境变量中的凭据做替换后才落盘。日志包含 APPID 或 request id 仅当 provider 协议需要，不能将完整签名 URL 写入结果。

## A-08 接线边界

- 本轮是在线能力基准，不改 Electron 代码。A-08 的 `VoiceProvider` 应复用相同的环境变量、resource id、音色和错误分类，不应把 Python 脚本当生产进程直接打包。
- TTS 首包可以直接进入 WebAudio；PCM 要补采样率/声道元数据，MP3/WAV 用浏览器解码。打断 <150 ms、AEC、播报中说话仍需 N5095 真机测试。
- 讯飞和豆包可测流式首文本；Azure 短音频 REST 只作准确率/总时延基线，不能据此宣称其实时路径满足 A-08。
