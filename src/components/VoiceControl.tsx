import { memo, useEffect, useRef, useState } from 'react';
import { AudioLines, ChevronDown, Mic, MicOff, RefreshCw, Volume2, VolumeX } from 'lucide-react';
import type { MicrophoneCaptureStatus } from '../lib/microphone-ui-state';
import { MicMeter } from './BottomToolbar';

interface VoiceControlProps {
  muted: boolean;
  onToggleMute: () => void;
  micSupported: boolean;
  listening: boolean;
  asrMode?: 'xfyun' | 'probing' | 'unavailable';
  micStatus: MicrophoneCaptureStatus;
  micRetryable: boolean;
  onRetryMic: () => void;
  ttsOn: boolean;
  onToggleTts: () => void;
}

/**
 * 顶栏语音控件：麦克风（含实时音量）与播报合成一个胶囊，取代底栏的两个按钮
 * 和顶栏原来的静态麦克风图标。左半边开关麦克风，右半边开关播报；▾ 展开
 * 识别状态和去 AhaTalk / 播报设置的入口。
 */
export const VoiceControl = memo(function VoiceControl({
  muted,
  onToggleMute,
  micSupported,
  listening,
  asrMode = 'probing',
  micStatus,
  micRetryable,
  onRetryMic,
  ttsOn,
  onToggleTts,
}: VoiceControlProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const micBusy = micStatus === 'requesting-permission' || micStatus === 'initializing';

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const micState = !micSupported ? '不可用' : micRetryable ? '启动失败' : micBusy ? '启动中' : muted ? '已静音' : listening ? '聆听中' : '待命';
  const micIcon = micRetryable ? <RefreshCw size={15} /> : muted ? <MicOff size={15} /> : listening ? <AudioLines size={15} /> : <Mic size={15} />;
  const micTitle = micRetryable ? '麦克风启动失败，点击重试' : muted ? '已静音，点击开启麦克风' : '点击静音';
  const asrLabel = asrMode === 'xfyun' ? '讯飞识别' : asrMode === 'unavailable' ? '未配置识别引擎' : '正在检测识别引擎';
  const openSettings = (focus: string) => {
    setOpen(false);
    void window.vibeMeet.settingsWindow.open({ focus });
  };

  return (
    <div className="voice-control" ref={ref}>
      <button
        type="button"
        className={`voice-control-mic${muted || micRetryable ? ' is-off' : ''}${!muted && listening ? ' is-live' : ''}`}
        onClick={micRetryable ? onRetryMic : onToggleMute}
        disabled={!micSupported}
        aria-pressed={!muted}
        aria-label={`麦克风：${micState}`}
        title={micTitle}
      >
        {micIcon}
        <MicMeter muted={muted} />
      </button>
      <button
        type="button"
        className={`voice-control-tts${ttsOn ? '' : ' is-off'}`}
        onClick={onToggleTts}
        aria-pressed={ttsOn}
        aria-label={ttsOn ? '播报已开，点击关闭' : '播报已关，点击开启'}
        title={ttsOn ? '播报已开' : '播报已关'}
      >
        {ttsOn ? <Volume2 size={15} /> : <VolumeX size={15} />}
      </button>
      <button
        type="button"
        className="voice-control-more"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="语音详情"
      >
        <ChevronDown size={12} />
      </button>
      {open && (
        <div className="voice-control-pop" role="dialog" aria-label="语音详情">
          <div className="voice-control-row"><span>麦克风</span><strong>{micState}</strong></div>
          <div className="voice-control-row"><span>识别</span><strong>{asrLabel}</strong></div>
          <div className="voice-control-row"><span>播报</span><strong>{ttsOn ? '开' : '关'}</strong></div>
          {micRetryable && <button type="button" className="voice-control-action" onClick={onRetryMic}>重试麦克风</button>}
          <div className="voice-control-links">
            <button type="button" onClick={() => openSettings('ahatalk')}>AhaTalk 设置</button>
            <button type="button" onClick={() => openSettings('speech')}>播报设置</button>
          </div>
        </div>
      )}
    </div>
  );
});
