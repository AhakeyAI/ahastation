import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MeetingRepository, PersistedMeetingEvent } from '../meeting-repository.js';
import type { UserContentBlock } from '../backends/cli-backend.js';

export type UserHostInputSource = 'user-text' | 'voice-transcript' | 'attachment';
export type HostInputSource = UserHostInputSource | 'worker-question' | 'expert-request' | 'expert-reply' | 'runtime-notification';
const inputPriority: Record<HostInputSource, number> = {
  'user-text': 0, 'voice-transcript': 0, attachment: 0, 'worker-question': 0,
  'expert-request': 1, 'expert-reply': 1, 'runtime-notification': 2,
};
export interface HostInputReceipt {
  inputId: string;
  hostId: string;
  state: 'queued' | 'submitted' | 'uncertain' | 'awaiting-target' | 'cancelled';
  targetChoices?: string[];
}

interface HostInput extends HostInputReceipt {
  text: string;
  contentHash: string;
  direct: boolean;
  contentRef?: string;
  source: HostInputSource;
  receivedAt: number;
  deliveryText?: string;
  requestHash?: string;
}

/** The journal owns acceptance. A void adapter send only proves local submission. */
export class HostInbox {
  private readonly inputs = new Map<string, HostInput>();
  private readonly draining = new Map<string, Promise<void>>();
  private tail = Promise.resolve();
  private readonly ready: Promise<void>;

  constructor(
    private readonly repository: MeetingRepository,
    private readonly resolve: (hostId: string) => ((input: HostInput, sourceCursor: number, content?: UserContentBlock[]) => boolean) | undefined,
    private readonly publish: (receipt: HostInputReceipt, source: HostInputSource) => void,
    private readonly diagnose: (error: unknown) => void,
  ) {
    this.ready = repository.replayAll().then((events) => this.restore(events));
    void this.ready.catch(diagnose);
  }

  private restore(events: PersistedMeetingEvent[]) {
    for (const { type, payload } of events) {
      if (type !== 'host-input-received' && type !== 'host-input-action'
        && type !== 'host-input-target-assigned' && type !== 'host-input-target-moved') continue;
      const entry = payload as Partial<HostInput> & { schemaVersion?: number } | null;
      if (entry?.schemaVersion !== 1 || typeof entry.inputId !== 'string') continue;
      if (type === 'host-input-received') {
        if (typeof entry.hostId !== 'string' || typeof entry.text !== 'string'
          || typeof entry.contentHash !== 'string' || typeof entry.direct !== 'boolean') continue;
        this.inputs.set(entry.inputId, {
          ...entry, state: entry.state === 'awaiting-target' ? 'awaiting-target' : 'queued',
          source: entry.source ?? (entry.contentRef ? 'attachment' : 'user-text'),
          receivedAt: entry.receivedAt ?? 0,
        } as HostInput);
      } else if (type === 'host-input-target-assigned') {
        const input = this.inputs.get(entry.inputId);
        if (input?.state === 'awaiting-target' && typeof entry.hostId === 'string'
          && input.targetChoices?.includes(entry.hostId)) {
          input.hostId = entry.hostId;
          input.direct = true;
          input.state = 'queued';
        }
      } else if (type === 'host-input-target-moved') {
        const input = this.inputs.get(entry.inputId);
        if (input?.source === 'worker-question' && input.state === 'queued' && typeof entry.hostId === 'string') {
          input.hostId = entry.hostId;
        }
      } else {
        const input = this.inputs.get(entry.inputId);
        if (input && (entry.state === 'uncertain' || entry.state === 'submitted' || entry.state === 'queued' || entry.state === 'cancelled')) {
          input.state = entry.state;
        }
      }
    }
  }

  async receive(
    inputId: string,
    text: string,
    route: () => { hostId: string; direct: boolean; deliveryText?: string; targetChoices?: string[] },
    content?: UserContentBlock[],
    source: HostInputSource = content ? 'attachment' : 'user-text',
    requestHash?: string,
  ): Promise<HostInputReceipt> {
    if (!/^[\w.-]{1,128}$/.test(inputId)) throw new Error('Invalid inputId');
    if ((source === 'user-text' || source === 'voice-transcript' || source === 'attachment')
      && /^(?:worker-question|expert-request|expert-reply|briefing)-/.test(inputId)) {
      throw new Error('inputId is reserved for meeting notifications');
    }
    if (!text.trim() || text.length > 100_000) throw new Error('Text must contain 1–100000 characters');
    const serialized = content ? JSON.stringify(content) : undefined;
    const contentHash = createHash('sha256').update(serialized ?? text).digest('hex');
    const accepted = this.serialize(async () => {
      await this.ready;
      const existing = this.inputs.get(inputId);
      if (existing) {
        if (existing.source !== source || (requestHash
          ? existing.requestHash !== requestHash
          : existing.contentHash !== contentHash)) throw new Error('inputId content conflict');
        if (source === 'worker-question' && existing.state === 'queued') {
          const { hostId } = route();
          if (existing.hostId !== hostId) {
            await this.repository.append('host-input-target-moved', { schemaVersion: 1, inputId, hostId });
            existing.hostId = hostId;
          }
        }
        return this.receipt(existing);
      }
      const target = route();
      const input: HostInput = {
        inputId, text, contentHash, ...target, source, receivedAt: Date.now(),
        state: target.targetChoices?.length ? 'awaiting-target' : 'queued',
        ...(requestHash ? { requestHash } : {}),
      };
      if (serialized !== undefined) {
        await this.persistContent(contentHash, serialized);
        input.contentRef = contentHash;
      }
      await this.repository.append('host-input-received', { schemaVersion: 1, ...input });
      this.inputs.set(inputId, input);
      return this.receipt(input);
    });
    const receipt = await accepted;
    this.publish(receipt, source);
    this.wake(receipt.hostId);
    return receipt;
  }

  async read(inputId: string): Promise<HostInput | undefined> {
    await this.ready;
    const input = this.inputs.get(inputId);
    return input && { ...input };
  }

  async assignTarget(inputId: string, hostId: string, isCurrent: () => boolean): Promise<HostInputReceipt> {
    const assigned = this.serialize(async () => {
      await this.ready;
      const input = this.inputs.get(inputId);
      if (!input || !isCurrent() || !input.targetChoices?.includes(hostId)) throw new Error('Input target is unavailable');
      if (input.state === 'cancelled') throw new Error('输入已取消');
      if (input.state !== 'awaiting-target') {
        if (input.hostId === hostId) return input;
        throw new Error('Input already has a confirmed target');
      }
      await this.repository.append('host-input-target-assigned', { schemaVersion: 1, inputId, hostId });
      input.hostId = hostId;
      input.direct = true;
      input.state = 'queued';
      return input;
    });
    const input = await assigned;
    const receipt = this.receipt(input);
    this.publish(receipt, input.source);
    this.wake(hostId);
    return receipt;
  }

  cancel(inputId: string): Promise<HostInputReceipt> {
    return this.serialize(async () => {
      await this.ready;
      const input = this.inputs.get(inputId);
      if (!input || !this.isUserInput(input)) throw new Error('Input is unavailable');
      if (input.state === 'cancelled') return this.receipt(input);
      if (input.state !== 'queued' && input.state !== 'awaiting-target') {
        throw new Error('输入已交给 Host 或交付状态待核对');
      }
      await this.transition(input, 'cancelled');
      return this.receipt(input);
    });
  }

  async recent(): Promise<Array<HostInputReceipt & { text: string; receivedAt: number }>> {
    await this.ready;
    return [...this.inputs.values()].filter((input) => this.isUserInput(input)).slice(-100).map((input) => ({
      ...this.receipt(input), text: input.text, receivedAt: input.receivedAt,
    }));
  }

  wake(hostId: string) {
    if (this.draining.has(hostId) || !this.resolve(hostId)) return;
    const draining = this.drain(hostId).catch(this.diagnose).finally(() => {
      this.draining.delete(hostId);
      if (!this.repository.isWriteFaulted() && this.hasQueued(hostId)) this.wake(hostId);
    });
    this.draining.set(hostId, draining);
  }

  async flush(): Promise<void> {
    await this.tail;
    await Promise.all(this.draining.values());
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private isUserInput(input: HostInput) {
    return input.source === 'user-text' || input.source === 'voice-transcript' || input.source === 'attachment';
  }

  private hasQueued(hostId: string) {
    return [...this.inputs.values()].some((input) => input.hostId === hostId && input.state === 'queued');
  }

  private async drain(hostId: string) {
    await this.ready;
    const queued = [...this.inputs.values()].filter((input) => input.hostId === hostId && input.state === 'queued');
    queued.sort((a, b) => inputPriority[a.source] - inputPriority[b.source]);
    for (const input of queued) {
      if (input.hostId !== hostId || input.state !== 'queued') continue;
      const send = this.resolve(hostId);
      if (!send) return;
      let content: UserContentBlock[] | undefined;
      if (input.contentRef) {
        try {
          const raw = await readFile(this.contentPath(input.contentRef), 'utf8');
          if (createHash('sha256').update(raw).digest('hex') !== input.contentHash) throw new Error('Host input artifact hash mismatch');
          content = JSON.parse(raw) as UserContentBlock[];
        } catch (error) {
          await this.claim(input, hostId);
          this.diagnose(error);
          continue;
        }
      }
      const cursor = await this.claim(input, hostId);
      if (cursor === null) continue;
      if (!send(input, cursor, content)) {
        await this.transition(input, 'queued');
        return;
      }
      await this.transition(input, 'submitted');
    }
  }

  private claim(input: HostInput, hostId: string): Promise<number | null> {
    return this.serialize(async () => (
      input.state === 'queued' && input.hostId === hostId ? this.transition(input, 'uncertain') : null
    ));
  }

  private contentPath(hash: string) {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid Host input content reference');
    return join(this.repository.deliveryArtifactRoot(), 'host-inputs', `${hash}.json`);
  }

  private async persistContent(hash: string, serialized: string) {
    const path = this.contentPath(hash);
    const temporary = `${path}.${randomUUID()}.tmp`;
    await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
    try {
      await writeFile(temporary, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600, flush: true });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true }).catch(this.diagnose);
    }
  }

  private async transition(input: HostInput, state: HostInputReceipt['state']) {
    const event = await this.repository.append('host-input-action', { schemaVersion: 1, inputId: input.inputId, state });
    input.state = state;
    this.publish(this.receipt(input), input.source);
    return event.seq;
  }

  private receipt({ inputId, hostId, state, targetChoices }: HostInput): HostInputReceipt {
    return { inputId, hostId, state, ...(state === 'awaiting-target' ? { targetChoices } : {}) };
  }
}
