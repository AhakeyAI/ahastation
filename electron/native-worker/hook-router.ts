import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { denyHook, type HookAgent } from '../global-hooks/protocol.js';
import { NativeWorkerRun, type RunBasis } from './run.js';

const nativeSchema = z.object({ session_id: z.string().min(1).max(500),
  hook_event_name: z.enum(['SessionStart', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Stop']),
  tool_name: z.string().min(1).max(500).optional(), tool_input: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

/** Internal protected-transport consumer. Observation endpoints/tokens never
 * call this router. It does not install hooks or bypass admission. */
export class NativeWorkerHookRouter {
  constructor(readonly agent: HookAgent, private readonly run: NativeWorkerRun) {}
  async receive(peer: unknown, basis: RunBasis, native: unknown) {
    const parsed = nativeSchema.safeParse(native);
    if (!parsed.success) return { verdict: denyHook('PreToolUse', 'invalid-hook') };
    const value = parsed.data, stage = value.hook_event_name;
    // The first useful hook can be any supported stage. Peer/launch evidence
    // must already be attached; a self-reported session_id never suffices.
    try {
      if (!this.run.bindFromHook(peer, value.session_id, basis)) throw new Error('binding-rejected');
    } catch { return { verdict: denyHook(stage, 'binding-rejected') }; }
    if (stage === 'SessionStart') return { bound: true };
    if (stage === 'Stop') return { observed: true }; // no completed/exit claim
    if (stage === 'PostToolUse') return { observed: await this.run.afterTool(peer, basis) };
    if (!value.tool_name || !value.tool_input) return { verdict: denyHook(stage, 'invalid-tool') };
    const call = { invocationId: randomUUID(), stage, sessionId: value.session_id,
      toolName: value.tool_name, input: value.tool_input };
    const permit = await this.run.requestTool(peer, basis, call);
    if (!permit) return { verdict: denyHook(stage, 'authority-rejected') };
    // Return an internal permit, not a reusable native allow. The independent
    // guardian must consume it at execution. No production provider currently
    // supplies that boundary, so the global controlled relay stays deny-only.
    return { permit, call };
  }
}
