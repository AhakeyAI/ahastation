import type { BackendInfo, SkillInfo } from '../types';

/** Production voice handler shared by App and send-path regression tests. */
export async function handleVoiceFinal(text: string, options: {
  polish?: (text: string) => Promise<{ ok: boolean; text: string }>;
  skills: SkillInfo[];
  backends: BackendInfo[];
  activeBackendIds: ReadonlySet<string>;
  hosts: Iterable<{ id: string; remoteTarget?: { title: string } }>;
  send: (text: string) => void | Promise<void>;
  notify: (message: string) => void;
}): Promise<void> {
  const { polish, skills, backends, activeBackendIds, hosts, send, notify } = options;
  let finalText = text;
  if (polish) {
    try {
      const result = await polish(text);
      if (result.ok) finalText = result.text;
    } catch (err) {
      console.warn('[voice] polishAsrText IPC failed:', err);
    }
  }
  // Bind the actual member ID once, keeping the original utterance.
  const members = [...hosts];
  const explicitMention = [...finalText.matchAll(/@([a-zA-Z0-9._-]+)/g)].some((match) => {
    if (match.index && /[a-zA-Z0-9_.+-]/.test(finalText[match.index - 1])) return false;
    const id = match[1].toLowerCase();
    return members.some((host) => host.id.toLowerCase() === id) || backends.some((backend) => backend.id.toLowerCase() === id);
  });
  if (!explicitMention) {
    const normalize = (value: string) => value.toLowerCase().replace(/[\s_-]/g, '');
    const spoken = normalize(finalText);
    const candidates = members.filter((host) => {
      const title = normalize(host.remoteTarget?.title ?? '');
      return title.length > 0 && spoken.includes(title);
    });
    const localCandidates = backends.filter((backend) => backend.id !== 'pocket-vibe' && activeBackendIds.has(backend.id)
      && normalize(backend.displayName).length > 0 && spoken.includes(normalize(backend.displayName)));
    if (candidates.length > 1 || (candidates.length > 0 && localCandidates.length > 0)) {
      notify('语音点名无法唯一确定成员，请通过文本选择具体成员；本次未发送。');
      return;
    }
    if (candidates.length === 1) {
      await send(`@${candidates[0].id} ${finalText}`);
      return;
    }
    if (finalText.includes('@')) { await send(finalText); return; } // Preserve ordinary local @/email behavior after checking remote titles.
  } else {
    await send(finalText);
    return;
  }
  // Fuzzy match skill names from voice input — if spoken text contains a
  // skill name, prepend "/" to invoke it as a slash command.
  if (skills.length > 0 && !finalText.startsWith('/')) {
    const lower = finalText.toLowerCase();
    let bestMatch: SkillInfo | null = null;
    let bestScore = 0;
    for (const skill of skills) {
      const nameLower = skill.name.toLowerCase();
      // Check for exact substring match
      if (lower.includes(nameLower)) {
        const score = nameLower.length;
        if (score > bestScore) {
          bestScore = score;
          bestMatch = skill;
        }
      }
      // Check for fuzzy match: remove spaces and dashes for comparison
      const normalized = lower.replace(/[\s_-]/g, '');
      const nameNormalized = nameLower.replace(/[\s_-]/g, '');
      if (normalized.includes(nameNormalized)) {
        const score = nameNormalized.length;
        if (score > bestScore) {
          bestScore = score;
          bestMatch = skill;
        }
      }
    }
    if (bestMatch) {
      // Remove the matched skill name from the text and prepend the slash command
      const nameLower = bestMatch.name.toLowerCase();
      const idx = lower.indexOf(nameLower);
      if (idx >= 0) {
        const before = finalText.slice(0, idx).trim();
        const after = finalText.slice(idx + bestMatch.name.length).trim();
        const remaining = [before, after].filter(Boolean).join(' ');
        finalText = remaining ? `/${bestMatch.name} ${remaining}` : `/${bestMatch.name}`;
      }
    }
  }
  // Fuzzy match backend names from voice input — if spoken text contains a
  // backend display name, prepend "@" to invoke it as a mention.
  const mentionableBackends = backends.filter((backend) => activeBackendIds.has(backend.id));
  if (mentionableBackends.length > 0 && !finalText.includes('@')) {
    const lower = finalText.toLowerCase();
    let bestBackend: BackendInfo | null = null;
    let bestBackendScore = 0;
    for (const backend of mentionableBackends) {
      const nameLower = backend.displayName.toLowerCase();
      // Check for exact substring match
      if (lower.includes(nameLower)) {
        const score = nameLower.length;
        if (score > bestBackendScore) {
          bestBackendScore = score;
          bestBackend = backend;
        }
      }
      // Check for fuzzy match: remove spaces and dashes for comparison
      const normalized = lower.replace(/[\s_-]/g, '');
      const nameNormalized = nameLower.replace(/[\s_-]/g, '');
      if (normalized.includes(nameNormalized)) {
        const score = nameNormalized.length;
        if (score > bestBackendScore) {
          bestBackendScore = score;
          bestBackend = backend;
        }
      }
    }
    if (bestBackend) {
      // Remove the matched backend name from the text and prepend the @mention
      const nameLower = bestBackend.displayName.toLowerCase();
      const idx = lower.indexOf(nameLower);
      if (idx >= 0) {
        const before = finalText.slice(0, idx).trim();
        const after = finalText.slice(idx + bestBackend.displayName.length).trim();
        const remaining = [before, after].filter(Boolean).join(' ');
        finalText = remaining ? `@${bestBackend.id} ${remaining}` : `@${bestBackend.id}`;
      }
    }
  }
  await send(finalText);
}
