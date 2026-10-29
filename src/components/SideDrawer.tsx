import { memo, useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Send, Paperclip, X, FileText, FileType, Image as ImageIcon, FileWarning, FolderOpen, Users, MessageSquare, Settings, Zap } from 'lucide-react';
import type {
  ActivityEntry,
  AttachmentKind,
  BackendInfo,
  PendingPermission,
  SkillInfo,
  StagedAttachment,
  TranscriptEntry,
} from '../types';
import type { MeetingState } from '../lib/meeting-store';
import { shallowEqualArray, useMeetingSelector } from '../hooks/useMeetingSelector';
import {
  DISPATCH_MODE_HINTS,
  DISPATCH_MODE_LABELS,
  type DispatchMode,
} from '../lib/dispatch-mode';
import { ApprovalCard } from './ApprovalCard';
import { FileTree } from './FileTree';
import { Modal } from './Modal';
import { RemoteSessionPicker } from './RemoteSessionPicker';
import { remoteSessionLabel } from '../../electron/backends/pocket-vibe-target';
import { remotePickerReason } from '../lib/meeting-availability';
import { toast } from '../lib/toast';
import type {UnifiedModel} from '../lib/unified-meeting-store';
import {sharedTranscript,sharedMentionBackends} from '../lib/unified-meeting-store';
import {bindSharedMention,editSharedMentions,type SharedMention} from '../lib/shared-mentions';
import {SharedInvitation,SharedApprovals,SharedExecutionReconciliation} from './UnifiedMeetingParts';

interface SideDrawerProps {
  shared?:UnifiedModel;
  linkedTaskId?:string;
  onLinkTask?:(id:string)=>void;
  open: boolean;
  pending: PendingPermission | null;
  /** Resolving flag for the legacy single permission card, sourced from the
   *  worker that owns `pending.id`. Keeps the drawer card in lock-step with
   *  WorkerCard and TaskInspector. */
  pendingResolving?: boolean;
  /** Permission IPC error for the legacy single permission card. */
  pendingError?: string | null;
  /** 批准卡片四要素上下文（04 BR-A2：项目/任务/客户端）。 */
  approvalMeta?: { owner: string; backendId?: string; project: string };
  onResolve: (id: string, decision: 'allow' | 'deny') => Promise<{ ok: true } | { ok: false; error: string }> | void;
  onSend: (text: string,mentions?:SharedMention[],submissionId?:string) => void|Promise<void>;
  onSendAttachments?: (
    staged: StagedAttachment[],
    text: string,
    mentions?:SharedMention[],
    submissionId?:string,
  ) => Promise<{ ok: boolean; error?: string;pending?:boolean }>;
  onSubscribeDroppedFiles?: (cb: (files: File[]) => void) => () => void;
  multiAgent?: boolean;
  dispatchMode?: DispatchMode;
  onChangeDispatchMode?: (mode: DispatchMode) => void;
  disabled: boolean;
  disabledReason?: string;
  sessionId?: string | null;
  onViewFile?: (relativePath: string) => void;
  viewingFilePath?: string | null;
  backends?: BackendInfo[];
  activeBackendIds?: Set<string>;
  onAddHost?: (backendId: string) => void;
  forceParticipantsTab?: boolean|number;
}

const EMPTY_TRANSCRIPT: TranscriptEntry[] = [];
const MAX_AGGREGATE_ACTIVITY = 500;

/** Talker's transcript drives the chat timeline; subscribed internally so
 *  per-message updates re-render only the drawer, never the App tree.
 *
 *  The timeline shows EVERY host's assistant replies, not just the
 *  coordinator's. Coordinator/default replies (and the user's own messages)
 *  live under the 'talker' worker; @mentioned expert hosts — including
 *  terminal CLIs whose answers arrive via the session-transcript tailer —
 *  land under 'talker:<hostId>'. Merge them chronologically so a mentioned
 *  host's answer appears inline instead of vanishing into a hidden worker. */
function selectTalkerTranscript(s: MeetingState): TranscriptEntry[] {
  let only: TranscriptEntry[] = EMPTY_TRANSCRIPT;
  let merged: TranscriptEntry[] | null = null;
  let count = 0;
  for (const [key, ws] of s.workers) {
    if (key !== 'talker' && !key.startsWith('talker:')) continue;
    if (ws.transcript.length === 0) continue;
    count += 1;
    only = ws.transcript;
    (merged ??= []).push(...ws.transcript);
  }
  // Fast path: a single contributing talker — return its array by reference so
  // the shallow-equal bail-out can skip snapshots that touched nothing here.
  if (count <= 1 || !merged) return only;
  merged.sort((a, b) => a.ts - b.ts);
  return merged;
}

/** True while the host selected for the latest user turn is responding. */
function selectTalkerResponding(s: MeetingState): boolean {
  const key = s.lastMentionedHostId ? `talker:${s.lastMentionedHostId}` : 'talker';
  return s.workers.get(key)?.responding ?? false;
}

/** Merged activity from all workers (timestamp-sorted, capped) — same
 *  projection the legacy useClaude aggregate produced, but selected here so
 *  the shallow-equal bail-out skips snapshots that only touched transcripts. */
function selectMergedActivity(s: MeetingState): ActivityEntry[] {
  const merged: ActivityEntry[] = [];
  for (const ws of s.workers.values()) merged.push(...ws.activity);
  merged.sort((a, b) => a.ts - b.ts);
  return merged.length > MAX_AGGREGATE_ACTIVITY
    ? merged.slice(merged.length - MAX_AGGREGATE_ACTIVITY)
    : merged;
}

const TIME_TICK_MS = 30_000;
const STAGED_MAX = 10;
const PER_FILE_MAX = 25 * 1024 * 1024;
const TOTAL_MAX = 50 * 1024 * 1024;

const ACCEPT_ATTR = [
  '.md', '.markdown', '.txt', '.log',
  '.json', '.jsonc',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.kt', '.swift',
  '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.rb', '.php',
  '.css', '.scss', '.less', '.html', '.htm', '.xml', '.svg',
  '.yaml', '.yml', '.toml', '.ini', '.env',
  '.sh', '.bash', '.zsh', '.fish',
  '.sql', '.graphql', '.gql',
  '.csv', '.tsv',
  '.docx', '.pdf', '.pptx', '.xlsx', '.xls',
  'image/png', 'image/jpeg', 'image/webp',
].join(',');

type Tab = 'chat' | 'participants' | 'files';

const dotColor: Record<ActivityEntry['kind'], string> = {
  'tool-call': '#7cc6ff',
  'tool-result': '#9ae29a',
  system: '#c8c8c8',
  error: '#ff7a7a',
  document: '#5b8def',
};

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function formatMessageTime(ts: number, now: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const diffMs = now - ts;
  if (diffMs < 60_000) return '刚刚';
  if (diffMs < 60 * 60_000) return `${Math.floor(diffMs / 60_000)} 分钟前`;
  const d = new Date(ts);
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const sameDay = new Date(now).toDateString() === d.toDateString();
  return sameDay ? time : `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${time}`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

const TEXT_EXTS = new Set([
  'md', 'markdown', 'txt', 'log', 'json', 'jsonc',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'py', 'go', 'rs', 'java', 'kt', 'swift',
  'c', 'cc', 'cpp', 'h', 'hpp', 'cs', 'rb', 'php',
  'css', 'scss', 'less', 'html', 'htm', 'xml', 'svg',
  'yaml', 'yml', 'toml', 'ini', 'env',
  'sh', 'bash', 'zsh', 'fish',
  'sql', 'graphql', 'gql',
  'csv', 'tsv',
]);

function classifyKind(name: string, mime: string): AttachmentKind | null {
  const m = (mime || '').toLowerCase();
  if (m === 'application/pdf') return 'pdf';
  if (m === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'word';
  if (m === 'image/png' || m === 'image/jpeg' || m === 'image/jpg' || m === 'image/webp') return 'image';
  if (m.startsWith('text/') || m.startsWith('application/json') || m.startsWith('application/xml')) return 'text';
  const idx = name.lastIndexOf('.');
  if (idx < 0) return null;
  const ext = name.slice(idx + 1).toLowerCase();
  if (ext === 'docx') return 'word';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'webp') return 'image';
  if (TEXT_EXTS.has(ext)) return 'text';
  return null;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const idx = result.indexOf(',');
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsDataURL(file);
  });
}

function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

function iconFor(kind: AttachmentKind) {
  if (kind === 'image') return <ImageIcon size={12} aria-hidden="true" />;
  if (kind === 'pdf') return <FileType size={12} aria-hidden="true" />;
  if (kind === 'word') return <FileType size={12} aria-hidden="true" />;
  return <FileText size={12} aria-hidden="true" />;
}

export const SideDrawer = memo(function SideDrawer({
  open,
  pending,
  pendingResolving,
  pendingError,
  approvalMeta,
  onResolve,
  onSend,
  onSendAttachments,
  onSubscribeDroppedFiles,
  multiAgent = false,
  dispatchMode = 'direct',
  onChangeDispatchMode,
  disabled,
  disabledReason = '会议未开始',
  sessionId,
  onViewFile,
  viewingFilePath,
  backends = [],
  activeBackendIds = new Set(),
  onAddHost,
  forceParticipantsTab,
  shared,linkedTaskId,onLinkTask,
}: SideDrawerProps) {
  // High-frequency meeting streams are subscribed in-component (not threaded
  // through App): transcript/activity append many times per minute during a
  // voice session, and those updates must not re-render the App tree.
  const localTranscript = useMeetingSelector(selectTalkerTranscript, shallowEqualArray);
  const transcript=useMemo(()=>shared?sharedTranscript(shared):localTranscript,[shared,localTranscript]);
  const localResponding = useMeetingSelector(selectTalkerResponding);
  const talkerResponding=shared?(shared.view.snapshot.entities.message??[]).some(m=>m.meetingId===shared.meeting.id&&!m.replyTo&&m.route==='host'&&m.executionStatus==='running'):localResponding;
  // The bubble names the host the input was actually routed to (default:
  // the coordinator host), so @mentioning qoder no longer reads "Codex 正在思考".
  const thinkingHostId = useMeetingSelector((s) => s.lastMentionedHostId ?? null);
  const activity = useMeetingSelector(selectMergedActivity, shallowEqualArray);
  const hostGroups = useMeetingSelector((s) => s.hostGroups);
  const [tab, setTab] = useState<Tab>('chat');
  const [remotePickerSession, setRemotePickerSession] = useState<string | null>(null);
  useEffect(() => { setRemotePickerSession(null); }, [sessionId]);
  const [text, setText] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(() => Date.now());
  const [staged, setStaged] = useState<StagedAttachment[]>([]);
  const [previewImg, setPreviewImg] = useState<string | null>(null);
  const [rejected, setRejected] = useState<Array<{ id: string; name: string; reason: string }>>([]);
  const [staging, setStaging] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // ── Slash command picker ───────────────────────────────────────────────
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [slashPickerOpen, setSlashPickerOpen] = useState(false);
  const [slashFilter, setSlashFilter] = useState('');
  const [slashSelectedIdx, setSlashSelectedIdx] = useState(0);
  const slashStartRef = useRef<number>(-1); // position of '/' in text

  // ── @mention picker for backends ───────────────────────────────────────
  const [mentionPickerOpen, setMentionPickerOpen] = useState(false);
  const [mentionFilter, setMentionFilter] = useState('');
  const [mentionSelectedIdx, setMentionSelectedIdx] = useState(0);
  const mentionStartRef = useRef<number>(-1); // position of '@' in text
  const [sharedMentions,setSharedMentions]=useState<SharedMention[]>([]);
  const draftVersion=useRef(0);
  const flight=useRef<{id:string;version:number;fileIds:string[]}|null>(null);
  const [sending,setSending]=useState(false),[pendingSubmission,setPendingSubmission]=useState<string|null>(null);
  const updateDraft=(value:string)=>{draftVersion.current++;if(shared)setSharedMentions(current=>editSharedMentions(text,value,current));setText(value);};
  useEffect(()=>{draftVersion.current++;},[linkedTaskId]);
  const finishSubmission=()=>{const submitted=flight.current;if(!submitted)return;setStaged(current=>current.filter(file=>!submitted.fileIds.includes(file.id)));if(draftVersion.current===submitted.version){draftVersion.current++;setText('');setSharedMentions([]);setRejected([]);}flight.current=null;setSending(false);setPendingSubmission(null);};
  useEffect(()=>{if(!pendingSubmission)return;const result=shared?.view.messageSubmissions?.find(s=>s.requestId===pendingSubmission);if(result?.status==='accepted')finishSubmission();else if(result?.status==='rejected'){flight.current=null;setSending(false);setPendingSubmission(null);toast.error(result.error??'原提交已被拒绝，输入保留');}},[shared?.view.messageSubmissions,pendingSubmission]);

  // Load skills list on mount
  useEffect(() => {
    window.vibeMeet.skills.list().then((res) => {
      if (res.ok) setSkills(res.skills);
    }).catch(() => {});
  }, []);

  const filteredSkills = useMemo(() => {
    if (!slashFilter) return skills;
    const lower = slashFilter.toLowerCase();
    return skills.filter((s) =>
      s.name.toLowerCase().includes(lower) ||
      s.description.toLowerCase().includes(lower)
    );
  }, [skills, slashFilter]);

  const filteredBackends = useMemo(() => {
    if(shared){const members=sharedMentionBackends(shared,backends);return mentionFilter?members.filter(m=>m.displayName.toLowerCase().includes(mentionFilter.toLowerCase())):members;}
    const participants = backends.filter((backend) => activeBackendIds.has(backend.id));
    for (const host of hostGroups.values()) {
      if (!host.remoteTarget) continue;
      const backend = backends.find((b) => b.id === 'pocket-vibe');
      if (backend) participants.push({ ...backend, id: host.id, displayName: remoteSessionLabel(host.remoteTarget) });
    }
    if (!mentionFilter) return participants;
    const lower = mentionFilter.toLowerCase();
    return participants.filter((b) =>
      b.displayName.toLowerCase().includes(lower)
    );
  }, [activeBackendIds, backends, hostGroups, mentionFilter,shared]);

  // Participants tab shows configured agents only (loggedIn via OAuth or a
  // saved API key — same auth-state split as BackendSettings). Unconfigured
  // ones are reachable through the ＋新增 → settings flow instead.
  const configuredBackends = useMemo(
    () => backends.filter((b) => b.loggedIn || b.hasApiKey),
    [backends],
  );

  const handleSlashSelect = useCallback((skill: SkillInfo) => {
    const before = text.slice(0, slashStartRef.current);
    const after = text.slice(slashStartRef.current + 1 + slashFilter.length);
    const newText = `${before}/${skill.name} ${after}`;
    updateDraft(newText);
    setSlashPickerOpen(false);
    setSlashFilter('');
    slashStartRef.current = -1;
    // Focus textarea after selection
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, [text, slashFilter]);

  const handleMentionSelect = useCallback((backend: BackendInfo) => {
    draftVersion.current++;
    const before = text.slice(0, mentionStartRef.current);
    const after = text.slice(mentionStartRef.current + 1 + mentionFilter.length);
    const newText = `${before}@${shared?backend.displayName:backend.id} ${after}`;
    if(shared){const member=shared.members.find(m=>m.id===backend.id);if(!member)return;const binding=bindSharedMention(member,before.length);setSharedMentions(current=>[...editSharedMentions(text,newText,current).filter(m=>m.end<=binding.start||m.start>=binding.end),binding]);}
    setText(newText);
    setMentionPickerOpen(false);
    setMentionFilter('');
    mentionStartRef.current = -1;
    // Focus textarea after selection
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, [text, mentionFilter,shared]);

  const handleTextChange = useCallback((newText: string) => {
    updateDraft(newText);
    const cursorPos = textareaRef.current?.selectionStart ?? newText.length;
    const beforeCursor = newText.slice(0, cursorPos);

    // Detect slash command: '/' at start or after whitespace
    const lastSlash = beforeCursor.lastIndexOf('/');
    if (lastSlash >= 0) {
      const charBefore = lastSlash > 0 ? beforeCursor[lastSlash - 1] : ' ';
      // Slash must be at start or after whitespace
      if (lastSlash === 0 || /\s/.test(charBefore)) {
        const afterSlash = beforeCursor.slice(lastSlash + 1);
        // No space between slash and cursor = still typing the command
        if (!/\s/.test(afterSlash)) {
          slashStartRef.current = lastSlash;
          setSlashFilter(afterSlash);
          setSlashPickerOpen(true);
          setSlashSelectedIdx(0);
          // Close mention picker if open
          setMentionPickerOpen(false);
          mentionStartRef.current = -1;
          return;
        }
      }
    }
    setSlashPickerOpen(false);
    slashStartRef.current = -1;

    // Detect @mention: '@' at start or after whitespace
    const lastMention = beforeCursor.lastIndexOf('@');
    if (lastMention >= 0) {
      const charBefore = lastMention > 0 ? beforeCursor[lastMention - 1] : ' ';
      // @ must be at start or after whitespace
      if (lastMention === 0 || /\s/.test(charBefore)) {
        const afterMention = beforeCursor.slice(lastMention + 1);
        // No space between @ and cursor = still typing the mention
        if (!/\s/.test(afterMention)) {
          mentionStartRef.current = lastMention;
          setMentionFilter(afterMention);
          setMentionPickerOpen(true);
          setMentionSelectedIdx(0);
          return;
        }
      }
    }
    setMentionPickerOpen(false);
    mentionStartRef.current = -1;
  }, [text,shared]);

  useEffect(() => {
    if (viewingFilePath) setTab('files');
  }, [viewingFilePath]);

  useEffect(() => {
    if (forceParticipantsTab) setTab('participants');
  }, [forceParticipantsTab]);

  useEffect(() => {
    if (tab !== 'chat') return;
    const id = window.setInterval(() => setNow(Date.now()), TIME_TICK_MS);
    return () => window.clearInterval(id);
  }, [tab]);

  // Resolve hostId → display name from backends list
  const backendNameForHost = useCallback((hostId: string | undefined): string => {
    // For default/undefined hostId, look up the actual backendId from hostGroups
    if (!hostId || hostId === 'default') {
      const defaultHg = hostGroups.get('default');
      if (defaultHg) {
        const backend = backends.find((b) => b.id === defaultHg.backendId);
        return backend?.displayName ?? defaultHg.backendId;
      }
      return 'Claude';
    }
    // For added hosts, try direct backend match first, then hostGroup lookup
    const backend = backends.find((b) => b.id === hostId);
    if (backend) return backend.displayName;
    const hg = hostGroups.get(hostId);
    if (hg) {
      if (hg.remoteTarget) return remoteSessionLabel(hg.remoteTarget);
      const fallback = backends.find((b) => b.id === hg.backendId);
      return fallback?.displayName ?? hg.backendId;
    }
    return 'Claude';
  }, [backends, hostGroups]);

  // Resolve hostId → iconId from backends list
  const backendIconIdForHost = useCallback((hostId: string | undefined): string => {
    if (!hostId || hostId === 'default') {
      const defaultHg = hostGroups.get('default');
      if (defaultHg) {
        const backend = backends.find((b) => b.id === defaultHg.backendId);
        return backend?.iconId ?? defaultHg.backendId;
      }
      return 'claude';
    }
    const backend = backends.find((b) => b.id === hostId);
    if (backend) return backend.iconId;
    const hg = hostGroups.get(hostId);
    if (hg) {
      const fallback = backends.find((b) => b.id === hg.backendId);
      return fallback?.iconId ?? hg.backendId;
    }
    return 'claude';
  }, [backends, hostGroups]);

  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  useEffect(() => {
    if (tab !== 'chat') return;
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [transcript.length, tab, pending, talkerResponding]);

  const totalStagedBytes = useMemo(
    () => staged.reduce((acc, a) => acc + a.sizeBytes, 0),
    [staged],
  );

  const enqueueFiles = async (files: File[] | FileList) => {
    if (disabled) return;
    if (!onSendAttachments) return;
    const list = Array.from(files);
    if (list.length === 0) return;
    setStaging(true);
    try {
      const accepted: StagedAttachment[] = [];
      const rejects: Array<{ id: string; name: string; reason: string }> = [];
      let runningTotal = totalStagedBytes + accepted.reduce((a, x) => a + x.sizeBytes, 0);
      for (const f of list) {
        if (staged.length + accepted.length >= STAGED_MAX) {
          rejects.push({ id: uid(), name: f.name, reason: `已达 ${STAGED_MAX} 个附件上限` });
          continue;
        }
        if (f.size > PER_FILE_MAX) {
          rejects.push({ id: uid(), name: f.name, reason: `超过单文件 ${formatBytes(PER_FILE_MAX)} 上限` });
          continue;
        }
        if (runningTotal + f.size > TOTAL_MAX) {
          rejects.push({ id: uid(), name: f.name, reason: `本次合计将超过 ${formatBytes(TOTAL_MAX)} 上限` });
          continue;
        }
        const kind = classifyKind(f.name, f.type);
        if (!kind) {
          rejects.push({ id: uid(), name: f.name, reason: '不支持的文件类型' });
          continue;
        }
        try {
          const dataBase64 = await fileToBase64(f);
          accepted.push({
            id: uid(),
            name: f.name,
            mime: f.type || '',
            sizeBytes: f.size,
            kind,
            dataBase64,
          });
          runningTotal += f.size;
        } catch {
          rejects.push({ id: uid(), name: f.name, reason: '读取失败' });
        }
      }
      if (accepted.length > 0) {draftVersion.current++;setStaged((prev) => [...prev, ...accepted]);}
      if (rejects.length > 0) setRejected((prev) => [...prev, ...rejects]);
    } finally {
      setStaging(false);
    }
  };

  // Subscribe to window-level drops published by App.tsx.
  useEffect(() => {
    if (!onSubscribeDroppedFiles) return;
    const unsub = onSubscribeDroppedFiles((files) => {
      void enqueueFiles(files);
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onSubscribeDroppedFiles, disabled, totalStagedBytes, staged.length, onSendAttachments]);

  const removeStaged = (id: string) => {
    draftVersion.current++;
    setStaged((prev) => prev.filter((a) => a.id !== id));
  };

  const dismissRejected = (id: string) => {
    setRejected((prev) => prev.filter((r) => r.id !== id));
  };

  const submit = async () => {
    if(disabled||staging||flight.current)return;
    const trimmed = text.trim();
    if(!trimmed&&!staged.length)return;
    const submission={id:crypto.randomUUID(),version:draftVersion.current,fileIds:staged.map(f=>f.id)};
    // Ref is set before the first await, including before attachment publication.
    flight.current=submission;setSending(true);
    try{
      if(staged.length&&onSendAttachments){const result=await onSendAttachments(structuredClone(staged),shared?text:trimmed,shared?structuredClone(sharedMentions):undefined,submission.id);if(!result.ok)throw Object.assign(new Error(result.error??'附件发送失败'),{pending:result.pending});}
      else await onSend(shared?text:trimmed,shared?structuredClone(sharedMentions):undefined,submission.id);
      finishSubmission();
    }catch(error){if((error as {pending?:boolean})?.pending)setPendingSubmission(submission.id);else{flight.current=null;setSending(false);}toast.error(String(error instanceof Error?error.message:error));}
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (!onSendAttachments) return;
    const files = Array.from(e.clipboardData.files ?? []);
    if (files.length > 0) {
      e.preventDefault();
      void enqueueFiles(files);
    }
  };

  const placeholder = disabled
    ? disabledReason
    : multiAgent
      ? dispatchMode === 'plan'
        ? 'Plan 模式 · Enter 发送 · Shift+Enter 换行 · 📎/拖放/粘贴可附文件'
        : '直接派活 · Enter 发送 · Shift+Enter 换行 · 📎/拖放/粘贴可附文件'
      : 'Type a message · Enter 发送 · 📎 附件 / 拖放 / 粘贴均可';

  const sendDisabled = disabled || staging || sending || (staged.length === 0 && !text.trim());

  return (
    <aside className={`drawer ${open ? 'drawer-open' : ''}`}>
      <div className="drawer-tabs">
        <button className={`drawer-tab ${tab === 'participants' ? 'active' : ''}`} onClick={() => setTab('participants')}>
          <Users size={14} aria-hidden="true" style={{ marginRight: 4, verticalAlign: -2 }} />
          Participants
          {backends.filter((b) => activeBackendIds.has(b.id)).length > 0 && (
            <span className="drawer-badge">{backends.filter((b) => activeBackendIds.has(b.id)).length}</span>
          )}
        </button>
        <button className={`drawer-tab ${tab === 'chat' ? 'active' : ''}`} onClick={() => setTab('chat')}>
          <MessageSquare size={14} aria-hidden="true" style={{ marginRight: 4, verticalAlign: -2 }} />
          Chat
          {transcript.length > 0 && <span className="drawer-badge">{transcript.length}</span>}
        </button>
        <button className={`drawer-tab ${tab === 'files' ? 'active' : ''}`} onClick={() => setTab('files')}>
          <FolderOpen size={14} aria-hidden="true" style={{ marginRight: 4, verticalAlign: -2 }} />
          Files
        </button>
      </div>

      {tab === 'participants' && shared&&<div className="drawer-participants"><SharedInvitation model={shared}/></div>}
      {tab === 'participants' && !shared&&(
        <div className="drawer-participants">
          <div className="drawer-participants-header">
            <span className="drawer-participants-title">已配置的智能体</span>
            <span className="drawer-participants-count">{configuredBackends.length} 个</span>
            <button
              className="drawer-participant-add"
              onClick={() => void window.vibeMeet.settingsWindow.open({ focus: 'backends-unconfigured' })}
              title="打开设置，配置新的智能体"
            >
              ＋ 新增
            </button>
          </div>
          {disabled && <div className="drawer-empty" role="status">{disabledReason}</div>}
          <div className="drawer-participants-list">
            {configuredBackends.length === 0 && (
              <div className="drawer-empty">暂无已配置的智能体。点击「新增」去设置中配置。</div>
            )}
            {configuredBackends.map((b) => {
              const isActive = activeBackendIds.has(b.id);
              return (
                <div key={b.id} className={`drawer-participant-row ${isActive ? 'active' : ''}`}>
                  <div className="drawer-participant-info">
                    <span className="drawer-participant-name">{b.displayName}</span>
                    <span className="drawer-participant-status">
                      {b.available ? '✓ 已安装' : '✗ 未安装'}
                      {' · '}
                      {'✓ 已配置'}
                    </span>
                  </div>
                  {isActive ? (
                    <span className="drawer-participant-badge" title={disabled ? disabledReason : undefined}>{disabled ? '已保存 · 未就绪' : '已加入'}</span>
                  ) : b.remoteControlMode === 'public' ? null : (
                    <button
                      className="drawer-participant-invite"
                      onClick={() => onAddHost?.(b.id)}
                      disabled={!b.available || disabled}
                      title={
                        !b.available
                          ? 'CLI 未安装，无法邀请'
                          : disabled
                            ? disabledReason
                            : `邀请 ${b.displayName}`
                      }
                    >
                      邀请
                    </button>
                  )}
                  {b.id === 'pocket-vibe' && (
                    <button className="drawer-participant-invite" disabled={Boolean(remotePickerReason(true, disabled ? disabledReason : '', sessionId ?? null))}
                      title={remotePickerReason(true, disabled ? disabledReason : '', sessionId ?? null) || '选择远端会话加入当前会议'}
                      onClick={() => { if (sessionId && !disabled) setRemotePickerSession(sessionId); }}>
                      选择远端会话
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {tab === 'chat' && (
        <div className="drawer-chat">
          <div className="drawer-scroll">
            {transcript.length === 0 && (
              <div className="drawer-empty">{disabled ? disabledReason : 'Host 已就绪。直接输入任务，或用 @ 点名已参会的 Expert。'}</div>
            )}
            {transcript.map((e) => {
              const timeLabel = formatMessageTime(e.ts, now);
              const isoTitle = e.ts ? new Date(e.ts).toISOString() : undefined;
              const authorName = shared?String((e as TranscriptEntry&{source?:string}).source??'Host'):e.role === 'assistant'
                ? backendNameForHost(e.hostId)
                : e.role === 'user' ? 'You' : 'System';
              return (
                <div key={e.id} className={`msg msg-${e.role}`}>
                  <div className="msg-meta">
                    <span className="msg-author">
                      {authorName}
                    </span>
                    {timeLabel && (
                      <span className="msg-time" title={isoTitle}>{timeLabel}</span>
                    )}
                  </div>
                  {e.imageUrl && (
                    <img
                      className="msg-image msg-image-clickable"
                      src={e.imageUrl}
                      alt={e.text || 'Shared screenshot'}
                      role="button"
                      tabIndex={0}
                      onClick={() => setPreviewImg(e.imageUrl!)}
                      onKeyDown={(ev) => {
                        if (ev.key === 'Enter' || ev.key === ' ') {
                          ev.preventDefault();
                          setPreviewImg(e.imageUrl!);
                        }
                      }}
                    />
                  )}
                  {e.attachments && e.attachments.length > 0 && (
                    <div className="msg-attachments">
                      {e.attachments.map((a, idx) => (
                        <span key={`${e.id}-att-${idx}`} className={`attachment-chip attachment-chip-${a.kind} attachment-chip-sent`}>
                          <span className="attachment-icon">{iconFor(a.kind)}</span>
                          <span className="attachment-name">{a.name}</span>
                          <span className="attachment-size">{formatBytes(a.sizeBytes)}</span>
                        </span>
                      ))}
                    </div>
                  )}
                  {e.text && <div className="msg-body">{e.text}</div>}{shared&&<SharedExecutionReconciliation model={shared} messageId={e.id}/>}
                </div>
              );
            })}
            {shared&&<SharedApprovals model={shared}/>}
            {talkerResponding && (
              <div className="msg msg-assistant msg-thinking" aria-live="polite">
                <div className="msg-meta">
                  <span className="msg-author">{backendNameForHost(thinkingHostId ?? undefined)}</span>
                </div>
                <div className="msg-body thinking-body">
                  <span className="thinking-dots" aria-hidden="true"><i /><i /><i /></span>
                  <span className="thinking-text">正在思考</span>
                </div>
              </div>
            )}
            {pending && (
              <ApprovalCard
                pending={pending}
                owner={approvalMeta?.owner ?? 'Coordinator'}
                backendId={approvalMeta?.backendId}
                project={approvalMeta?.project ?? '当前项目'}
                onDecide={onResolve}
                resolving={pendingResolving}
                error={pendingError}
              />
            )}
            <div ref={endRef} />
          </div>
          <div className="drawer-composer">
            {multiAgent && onChangeDispatchMode && (
              <div
                className="dispatch-mode-switch"
                role="group"
                aria-label="派活方式"
              >
                {(['direct', 'plan'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className={`dispatch-mode-option ${dispatchMode === mode ? 'is-active' : ''}`}
                    aria-pressed={dispatchMode === mode}
                    title={DISPATCH_MODE_HINTS[mode]}
                    onClick={() => onChangeDispatchMode(mode)}
                  >
                    {DISPATCH_MODE_LABELS[mode]}
                  </button>
                ))}
              </div>
            )}
            {(staged.length > 0 || rejected.length > 0) && (
              <div className="attachment-strip">
                {staged.map((a) => (
                  <span key={a.id} className={`attachment-chip attachment-chip-${a.kind}`}>
                    <span className="attachment-icon">{iconFor(a.kind)}</span>
                    <span className="attachment-name" title={a.name}>{a.name}</span>
                    <span className="attachment-size">{formatBytes(a.sizeBytes)}</span>
                    <button
                      type="button"
                      className="attachment-chip-remove"
                      onClick={() => removeStaged(a.id)}
                      aria-label={`移除 ${a.name}`}
                      title="移除"
                    >
                      <X size={10} aria-hidden="true" />
                    </button>
                  </span>
                ))}
                {rejected.map((r) => (
                  <span key={r.id} className="attachment-chip attachment-chip-rejected" title={r.reason}>
                    <span className="attachment-icon"><FileWarning size={12} aria-hidden="true" /></span>
                    <span className="attachment-name">{r.name}</span>
                    <span className="attachment-size">{r.reason}</span>
                    <button
                      type="button"
                      className="attachment-chip-remove"
                      onClick={() => dismissRejected(r.id)}
                      aria-label={`关闭 ${r.name}`}
                      title="关闭"
                    >
                      <X size={10} aria-hidden="true" />
                    </button>
                  </span>
                ))}
              </div>
            )}
              {shared&&<label className="unified-task-link">关联任务补充<select aria-label="明确关联任务" value={linkedTaskId??''} onChange={e=>onLinkTask?.(e.target.value)}><option value="">普通讨论（默认 Host／@）</option>{shared.tasks.filter(t=>t.status!=='accepted').map(t=><option key={t.id} value={t.id}>{String(t.title)}</option>)}</select></label>}
            <div className="drawer-input-wrap">
              {slashPickerOpen && filteredSkills.length > 0 && (
                <div className="slash-picker">
                  {filteredSkills.map((skill, idx) => (
                    <button
                      key={skill.name}
                      type="button"
                      className={`slash-picker-item ${idx === slashSelectedIdx ? 'slash-picker-item-active' : ''}`}
                      onClick={() => handleSlashSelect(skill)}
                      onMouseEnter={() => setSlashSelectedIdx(idx)}
                    >
                      <Zap size={12} className="slash-picker-icon" />
                      <div className="slash-picker-text">
                        <span className="slash-picker-name">/{skill.name}</span>
                        <span className="slash-picker-desc">{skill.description}</span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
              {slashPickerOpen && filteredSkills.length === 0 && (
                <div className="slash-picker slash-picker-empty">
                  <span>没有找到匹配的 skill</span>
                </div>
              )}
              {mentionPickerOpen && filteredBackends.length > 0 && (
                <div className="slash-picker">
                  {filteredBackends.map((backend, idx) => (
                    <button
                      key={backend.id}
                      type="button"
                      className={`slash-picker-item ${idx === mentionSelectedIdx ? 'slash-picker-item-active' : ''}`}
                      onClick={() => handleMentionSelect(backend)}
                      onMouseEnter={() => setMentionSelectedIdx(idx)}
                    >
                      <Users size={12} className="slash-picker-icon" />
                      <div className="slash-picker-text">
                        <span className="slash-picker-name">@{backend.displayName}</span>
                        <span className="slash-picker-desc">{backend.sharedStatus ?? (backend.authMode === 'oauth' ? 'OAuth' : backend.authMode === 'apikey' ? 'API Key' : 'None')}</span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
              {mentionPickerOpen && filteredBackends.length === 0 && (
                <div className="slash-picker slash-picker-empty">
                  <span>没有找到匹配的参会 Talker，请先在 Participants 邀请</span>
                </div>
              )}
              <input
                ref={fileInputRef}
                type="file"
                hidden
                multiple
                accept={ACCEPT_ATTR}
                onChange={(e) => {
                  const files = e.target.files;
                  if (files && files.length > 0) void enqueueFiles(files);
                  // Reset so picking the same file twice still fires onChange.
                  e.target.value = '';
                }}
              />
              {onSendAttachments && (
                <button
                  type="button"
                  className="drawer-attach-icon"
                  disabled={disabled || staging}
                  onClick={() => fileInputRef.current?.click()}
                  aria-label="添加附件"
                  title="添加附件 (.md, .docx, .pdf, 图片…)"
                >
                  <Paperclip size={16} aria-hidden="true" />
                </button>
              )}
              <textarea
                ref={textareaRef}
                className="drawer-input"
                value={text}
                disabled={disabled}
                placeholder={placeholder}
                onChange={(e) => handleTextChange(e.target.value)}
                onPaste={onPaste}
                onKeyDown={(e) => {
                  // Handle slash command picker navigation
                  if (slashPickerOpen && filteredSkills.length > 0) {
                    if (e.key === 'ArrowDown') {
                      e.preventDefault();
                      setSlashSelectedIdx((i) => (i + 1) % filteredSkills.length);
                      return;
                    }
                    if (e.key === 'ArrowUp') {
                      e.preventDefault();
                      setSlashSelectedIdx((i) => (i - 1 + filteredSkills.length) % filteredSkills.length);
                      return;
                    }
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleSlashSelect(filteredSkills[slashSelectedIdx]);
                      return;
                    }
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      setSlashPickerOpen(false);
                      return;
                    }
                  }
                  // Handle @mention picker navigation
                  if (mentionPickerOpen && filteredBackends.length > 0) {
                    if (e.key === 'ArrowDown') {
                      e.preventDefault();
                      setMentionSelectedIdx((i) => (i + 1) % filteredBackends.length);
                      return;
                    }
                    if (e.key === 'ArrowUp') {
                      e.preventDefault();
                      setMentionSelectedIdx((i) => (i - 1 + filteredBackends.length) % filteredBackends.length);
                      return;
                    }
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleMentionSelect(filteredBackends[mentionSelectedIdx]);
                      return;
                    }
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      setMentionPickerOpen(false);
                      return;
                    }
                  }
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void submit();
                  }
                }}
                rows={2}
              />
              <button
                type="button"
                className="drawer-send-icon"
                disabled={sendDisabled}
                onClick={() => void submit()}
                aria-label="发送"
                title="发送 · Enter"
              >
                <Send size={16} aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>
      )}

      {tab === 'files' && shared&&<div className="drawer-files"><p>文件以用户选入的准确 Git 版本共享。请从任务成果查看文件／Diff，或选择附件发布到已授权资料仓库。</p></div>}
      {tab === 'files' && !shared&&(
        <div className="drawer-files">
          <FileTree
            sessionId={sessionId ?? null}
            onViewFile={(path) => onViewFile?.(path)}
            viewingPath={viewingFilePath ?? null}
          />
        </div>
      )}

      {remotePickerSession && remotePickerSession === sessionId && (
        <RemoteSessionPicker sessionId={remotePickerSession} hosts={hostGroups} onClose={() => setRemotePickerSession(null)} />
      )}

      {previewImg && (
        <Modal
          open
          onClose={() => setPreviewImg(null)}
          backdropClassName="img-preview-backdrop"
          ariaLabel="图片预览"
        >
          <button
            type="button"
            className="img-preview-close"
            onClick={() => setPreviewImg(null)}
            aria-label="关闭预览"
          >
            <X size={20} aria-hidden="true" />
          </button>
          <img
            className="img-preview-img"
            src={previewImg}
            alt="Preview"
            onClick={(ev) => ev.stopPropagation()}
          />
        </Modal>
      )}
    </aside>
  );
});
