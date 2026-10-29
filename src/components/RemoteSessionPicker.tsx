import { useEffect, useState } from 'react';
import type { PocketVibeRemoteDirectory, PocketVibeRemoteTarget } from '../types';
import { parsePocketVibeRemoteTarget, remoteSessionKey } from '../../electron/backends/pocket-vibe-target';
import { meetingStore, type HostGroupState } from '../lib/meeting-store';
import { Modal } from './Modal';

const statusLabels: Record<string, string> = {
  scanning: '正在扫描', ready: '目录已就绪', empty: '未发现已有会话',
  failed: '扫描失败', unsupported: 'Bridge 未提供会话目录，请更新并重启',
};
const executionLabels: Record<string, string> = { idle: '空闲', running: '执行中', waiting: '等待执行',
  'cleanup-unconfirmed': '进程退出未确认', unknown: '未知' };

export function RemoteSessionPicker({ sessionId, hosts, onClose }: {
  sessionId: string;
  hosts: Map<string, HostGroupState>;
  onClose: () => void;
}) {
  const [directory, setDirectory] = useState<PocketVibeRemoteDirectory | null>(null);
  const [loading, setLoading] = useState(false);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState('');
  const [computer, setComputer] = useState('');
  const [agent, setAgent] = useState('');
  const [selected, setSelected] = useState<PocketVibeRemoteTarget | null>(null);

  async function load() {
    setLoading(true); setError(''); setSelected(null); setDirectory(null);
    try {
      const result = await window.vibeMeet.sessions.remoteSessions(true);
      if (result.ok) setDirectory(result.directory);
      else setError(result.error);
    } catch (err) { setError(`会话目录查询失败：${String(err)}`); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);
  const alreadyJoined = (target: PocketVibeRemoteTarget) => [...hosts.values()].some(
    (host) => host.remoteTarget && remoteSessionKey(host.remoteTarget) === remoteSessionKey(target),
  );
  const computers = [...new Map(directory?.agents.map((item) => [item.device_id || item.computer_name, item.computer_name]) ?? []).entries()];
  const agents = directory?.agents.filter((item) => !computer || (item.device_id || item.computer_name) === computer) ?? [];
  const sessions = directory?.sessions.filter((item) => (!computer || (item.device_id || item.computer_name) === computer) && (!agent || item.agent_id === agent)) ?? [];
  async function join() {
    if (!selected || joining) return;
    if (meetingStore.getActiveId() !== sessionId) { onClose(); return; }
    setJoining(true); setError('');
    const result = await meetingStore.addHostGroup('pocket-vibe', selected);
    setJoining(false);
    if (result.ok) onClose(); else setError(result.error ?? '加入失败');
  }
  return (
    <Modal open onClose={joining ? undefined : onClose} className="remote-session-picker" ariaLabel="选择远端会话">
      <div className="remote-session-header"><strong>选择远端会话</strong><button onClick={onClose} disabled={joining} aria-label="关闭">×</button></div>
      <p>选择电脑端已有 Codex 桌面版 / CLI / Claude 会话，加入后可在聊天中 @ 该成员连续发送指令，也可语音说出唯一会话标题点名。桌面联动需先通过 Bridge 启动桌面并连接共享服务；日常完成或停止后可直接接续。</p>
      <div className="remote-session-filters">
        <select aria-label="筛选电脑" value={computer} onChange={(e) => { setComputer(e.target.value); setAgent(''); setSelected(null); }}>
          <option value="">全部电脑</option>{computers.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
        <select aria-label="筛选 Agent" value={agent} onChange={(e) => { setAgent(e.target.value); setSelected(null); }}>
          <option value="">全部 Agent</option>{agents.map((item) => <option key={item.agent_id} value={item.agent_id}>{item.display_name} · {item.agent_id}</option>)}
        </select>
        <button onClick={() => void load()} disabled={loading || joining}>{loading ? '刷新中…' : '刷新目录'}</button>
      </div>
      {error && <p role="alert" className="remote-session-error">{error}</p>}
      {directory?.status === 'disconnected' && <p role="status">没有电脑端 Bridge 连接到服务。请在远端电脑打开 Bridge，完成配对、项目授权和运行组件登录检查，再刷新。</p>}
      <div className="remote-session-list">
        {agents.filter((item) => !agent || item.agent_id === agent).map((item) => <div key={item.agent_id} className="remote-session-agent-status">
          {item.computer_name} / {item.agent_id}：{statusLabels[item.status] ?? item.status}{item.error ? `（${item.error}）` : ''}
        </div>)}
        {!loading && directory?.status === 'connected' && sessions.length === 0 && <p>当前筛选下没有可显示的已有会话。</p>}
        {sessions.map((item) => {
          const target = parsePocketVibeRemoteTarget(item);
          const joined = alreadyJoined(item);
          const key = `${remoteSessionKey(item)}:${item.agent_id}`;
          const checked = selected !== null && remoteSessionKey(selected) === remoteSessionKey(item) && selected.agent_id === item.agent_id;
          return <label key={key} className={`remote-session-row ${checked ? 'selected' : ''}`}>
            <input type="radio" name="remote-session" disabled={!target || !item.device_id || item.available === false || joined || joining} checked={checked} onChange={() => setSelected(target)} />
            <span><strong>{item.title}</strong><small>{item.cwd || '无法识别远端项目目录，不能加入'}</small><small>{item.computer_name} · {item.agent_id} · {item.provider} · {item.session_id}{joined ? ' · 已加入' : ''}</small>
              <small>{item.title.includes('Codex 桌面联动') ? `共享服务：${item.error || executionLabels[item.execution_status ?? 'unknown'] || '未知'}` : `Bridge 任务：${executionLabels[item.execution_status ?? 'unknown'] ?? '未知'}；其他原生客户端占用：未知`}</small></span>
            {!item.device_id && <small>Bridge 缺少设备标识，请更新并重启后刷新。</small>}
            {item.available === false && <small>{item.error || '远端项目目录不可用'}</small>}
          </label>;
        })}
      </div>
      <p>仅支持文本。桌面联动按同一服务的原生会话排队；独立 CLI 模式执行期间请勿在其他原生客户端操作同一会话。{directory?.controlMode === 'public' ? '停止只针对 Station 的任务；收到原生任务及执行命令退出确认前仍显示取消中或停止未确认。关闭窗口、断网不自动取消。' : 'LAN 兼容模式的停止只停止等待，远端任务可能继续运行。'}</p>
      <div className="remote-session-footer"><button onClick={() => void join()} disabled={!selected || alreadyJoined(selected) || loading || joining}>{joining ? '加入中…' : '加入当前会议'}</button></div>
    </Modal>
  );
}
