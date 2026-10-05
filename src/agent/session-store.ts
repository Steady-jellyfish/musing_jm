/**
 * SessionStore
 *
 * /process 요청의 세션 상태와 requestId별 실행 중인 제너레이터를 관리합니다.
 * 세션: 멀티턴 대화(되묻기 → 응답)를 위한 상태 저장
 * 요청: 취소 지원 + 실행 중/대기 중 건수 집계
 */

import { randomUUID } from "crypto";

// ── 타입 정의 ──────────────────────────────────────────────

export interface ClarificationOption {
  label: string;
  description: string;
}

export interface ClarificationQuestion {
  question: string;
  options: ClarificationOption[];
  multiSelect: boolean;
}

export interface TraceEntry {
  label: string;
  detail?: string;
  elapsedMs: number;
}

export interface SessionState {
  sessionId: string;
  memberId: string;
  originalQuestion: string;
  /** Agent SDK가 발급한 세션 ID (resume 에 사용) */
  agentSessionId?: string;
  /** waiting_input 상태일 때의 미결 질문 목록 */
  pendingQuestions?: ClarificationQuestion[];
  /** waiting_input 상태일 때의 trace 스냅샷 */
  pendingTrace?: TraceEntry[];
  /** 엔진이 판별한 질의 유형 */
  queryType?: "LOGIC_REVIEW" | "ERROR_CAUSE";
  status: "active" | "waiting_input" | "done" | "failed";
}

// ── SessionStore ───────────────────────────────────────────

export class SessionStore {
  private sessions = new Map<string, SessionState>();
  /** requestId → 실행 중인 AsyncGenerator */
  private generators = new Map<string, AsyncGenerator<unknown>>();
  /** requestId별 상태 */
  private requestStatus = new Map<string, "running" | "done" | "cancelled">();

  // ─── Session ────────────────────────────────────────────

  createSession(memberId: string, originalQuestion: string): string {
    const sessionId = randomUUID();
    this.sessions.set(sessionId, {
      sessionId,
      memberId,
      originalQuestion,
      status: "active",
    });
    return sessionId;
  }

  getSession(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId);
  }

  updateSession(sessionId: string, updates: Partial<SessionState>): void {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      this.sessions.set(sessionId, { ...existing, ...updates });
    }
  }

  // ─── Request ────────────────────────────────────────────

  /** 실행 중인 제너레이터를 등록합니다. */
  registerRequest(requestId: string, gen: AsyncGenerator<unknown>): void {
    this.generators.set(requestId, gen);
    this.requestStatus.set(requestId, "running");
  }

  /** 요청이 이미 등록(실행 중)인지 확인합니다. */
  isRequestRunning(requestId: string): boolean {
    return this.requestStatus.get(requestId) === "running";
  }

  /** 요청 완료를 표시합니다. */
  completeRequest(requestId: string): void {
    this.generators.delete(requestId);
    this.requestStatus.set(requestId, "done");
  }

  /**
   * 실행 중인 요청을 취소합니다.
   * @returns 취소 성공 여부
   */
  cancelRequest(requestId: string): boolean {
    const gen = this.generators.get(requestId);
    if (!gen || this.requestStatus.get(requestId) !== "running") return false;

    gen.return(undefined).catch(() => undefined);
    this.generators.delete(requestId);
    this.requestStatus.set(requestId, "cancelled");
    return true;
  }

  // ─── 집계 ───────────────────────────────────────────────

  get runningCount(): number {
    let count = 0;
    for (const s of this.requestStatus.values()) {
      if (s === "running") count++;
    }
    return count;
  }

  /** 큐 기반 처리가 없으므로 항상 0 */
  get queuedCount(): number {
    return 0;
  }
}

export const sessionStore = new SessionStore();
