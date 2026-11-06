import { randomUUID } from 'node:crypto';
import {
  completeCoordinatorReview,
  confirmCoordinatorReviewEvidence,
  createCoordinatorReviewSession,
  getCoordinatorReviewChunk,
  listUncoveredCoordinatorReviewChunkIds,
  safeCoordinatorReviewProjection,
  submitCoordinatorChunkReview,
  updateCoordinatorReviewLifecycle,
  type CoordinatorReviewFinding,
  type CoordinatorReviewSession,
} from './coordinator-review.js';
import type { FrozenDeliveryCandidate } from './delivery-candidate.js';
import type { VerificationEvidence } from './delivery-harness.js';

export interface CoordinatorReviewDriverOptions {
  maxTurns?: number;
  now?: () => number;
  id?: () => string;
  append: (type: string, payload: unknown) => Promise<unknown>;
  flush: () => Promise<void>;
  onCompleted?: (session: CoordinatorReviewSession & { reviewHash: string }) => Promise<void> | void;
}

export class CoordinatorReviewDriver {
  private readonly sessions = new Map<string, CoordinatorReviewSession>();
  private readonly completedCallbacks = new Set<string>();
  private readonly maxTurns: number;
  private readonly now: () => number;
  private readonly id: () => string;

  constructor(private readonly options: CoordinatorReviewDriverOptions) {
    this.maxTurns = options.maxTurns ?? 8;
    this.now = options.now ?? Date.now;
    this.id = options.id ?? randomUUID;
  }

  /**
   * Cover every chunk without a model/user in the loop (approval mode `auto`),
   * then complete the review. Withheld-evidence chunks are confirmed with the
   * supplied decision id. Completion fires `onCompleted`, which integrates the
   * candidate.
   */
  async autoReview(
    reviewId: string,
    decisionId: string,
  ): Promise<CoordinatorReviewSession & { reviewHash: string }> {
    const uncovered = listUncoveredCoordinatorReviewChunkIds(
      this.require(reviewId),
      Number.MAX_SAFE_INTEGER,
    );
    for (const chunkId of uncovered) {
      const chunk = getCoordinatorReviewChunk(this.require(reviewId), chunkId);
      if (!chunk) continue;
      if (chunk.requiresUserConfirmation) {
        await this.confirmEvidence(reviewId, { chunkId: chunk.id, chunkHash: chunk.hash, decisionId });
      } else {
        await this.submitChunkReview(reviewId, {
          chunkId: chunk.id,
          chunkHash: chunk.hash,
          verdict: 'passed',
          findings: [],
        });
      }
    }
    return this.complete(reviewId);
  }

  async request(input: {
    candidate: FrozenDeliveryCandidate;
    verification: VerificationEvidence;
  }): Promise<CoordinatorReviewSession> {
    const existing = this.findByDelivery(input.candidate.deliveryId, input.candidate.attempt);
    if (existing) {
      if (
        existing.candidate.commit !== input.candidate.commit
        || existing.candidate.diffHash !== input.candidate.diffHash
      ) {
        throw new Error('a different frozen candidate already owns this review attempt');
      }
      return structuredClone(existing);
    }
    if (!input.verification.passed) {
      throw new Error('Coordinator review requires passed deterministic verification');
    }
    const session = createCoordinatorReviewSession({
      reviewId: this.id(),
      candidate: input.candidate,
      maxTurns: this.maxTurns,
      now: this.now(),
    });
    this.sessions.set(session.id, session);
    await this.persist('coordinator-review-requested', session, {
      verificationHash: input.candidate.verificationHash,
    });
    return structuredClone(session);
  }

  restore(session: CoordinatorReviewSession): CoordinatorReviewSession {
    const cloned = structuredClone(session);
    if (this.sessions.has(cloned.id)) return this.inspect(cloned.id);
    // Re-run the pure assertions through an innocuous lookup before accepting
    // a recovered snapshot as the durable review owner.
    getCoordinatorReviewChunk(cloned);
    this.sessions.set(cloned.id, cloned);
    if (cloned.status === 'completed') this.completedCallbacks.add(cloned.id);
    return structuredClone(cloned);
  }

  inspect(reviewId: string): CoordinatorReviewSession {
    return structuredClone(this.require(reviewId));
  }

  inspectByDelivery(deliveryId: string, attempt?: number): CoordinatorReviewSession | null {
    const found = this.findByDelivery(deliveryId, attempt);
    return found ? structuredClone(found) : null;
  }

  snapshot(): CoordinatorReviewSession[] {
    return [...this.sessions.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((session) => structuredClone(session));
  }

  getChunk(reviewId: string, chunkId?: string) {
    const chunk = getCoordinatorReviewChunk(this.require(reviewId), chunkId);
    return chunk ? structuredClone(chunk) : null;
  }

  async submitChunkReview(
    reviewId: string,
    input: {
      chunkId: string;
      chunkHash: string;
      verdict: 'passed' | 'blocking';
      findings: CoordinatorReviewFinding[];
    },
  ): Promise<CoordinatorReviewSession> {
    const previous = this.require(reviewId);
    const next = submitCoordinatorChunkReview(previous, {
      ...input,
      reviewedAt: this.now(),
    });
    this.sessions.set(reviewId, next);
    if (stableStringify(previous) !== stableStringify(next)) {
      await this.persist('coordinator-review-chunk-submitted', next, {
        chunkId: input.chunkId,
        chunkHash: input.chunkHash,
        verdict: input.verdict,
        findings: next.reviews.find((review) => review.chunkId === input.chunkId)?.findings ?? [],
      });
    }
    return structuredClone(next);
  }

  async confirmEvidence(
    reviewId: string,
    input: {
      chunkId: string;
      chunkHash: string;
      decisionId: string;
    },
  ): Promise<CoordinatorReviewSession> {
    const previous = this.require(reviewId);
    const next = confirmCoordinatorReviewEvidence(previous, {
      ...input,
      confirmedAt: this.now(),
    });
    this.sessions.set(reviewId, next);
    if (stableStringify(previous) !== stableStringify(next)) {
      await this.persist('coordinator-review-evidence-confirmed', next, {
        chunkId: input.chunkId,
        chunkHash: input.chunkHash,
        decisionId: input.decisionId,
      });
    }
    return structuredClone(next);
  }

  async complete(reviewId: string): Promise<CoordinatorReviewSession & { reviewHash: string }> {
    const previous = this.require(reviewId);
    const next = completeCoordinatorReview(previous, this.now());
    this.sessions.set(reviewId, next);
    if (!previous.reviewHash) {
      await this.persist('coordinator-review-completed', next, {
        reviewHash: next.reviewHash,
      });
    }
    if (!this.completedCallbacks.has(reviewId)) {
      this.completedCallbacks.add(reviewId);
      await this.options.onCompleted?.(structuredClone(next));
    }
    return structuredClone(next);
  }

  private async persist(
    type: string,
    session: CoordinatorReviewSession,
    detail?: Record<string, unknown>,
  ): Promise<void> {
    await this.options.append(type, {
      session: safeCoordinatorReviewProjection(session),
      ...(detail ? { detail } : {}),
    });
    await this.options.flush();
  }

  private require(reviewId: string): CoordinatorReviewSession {
    const session = this.sessions.get(reviewId);
    if (!session) throw new Error(`Coordinator review not found: ${reviewId}`);
    return session;
  }

  private findByDelivery(
    deliveryId: string,
    attempt?: number,
  ): CoordinatorReviewSession | undefined {
    return [...this.sessions.values()].find(
      (session) => session.deliveryId === deliveryId
        && (attempt === undefined || session.attempt === attempt),
    );
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
