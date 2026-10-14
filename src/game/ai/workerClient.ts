import type { PlannedMove } from "./types";
import type { AiWorkerRequest, AiWorkerResponse } from "./workerProtocol";

export interface AiPlanningWorker {
  addEventListener(type: string, listener: (event: any) => void): void;
  removeEventListener(type: string, listener: (event: any) => void): void;
  postMessage(message: unknown): void;
}

export const AI_WORKER_TIMEOUT_MS = 30_000;

export class AiWorkerTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`CPU Workerが${timeoutMs}ms以内に応答しませんでした`);
    this.name = "AiWorkerTimeoutError";
  }
}

interface PlanCallbacks {
  planned(planned: PlannedMove | null): void;
  failed(error: unknown): void;
}

/**
 * Workerへ一手を依頼し、応答・実行時エラー・応答不能を1回だけ通知する。
 *
 * LocalApp側は failed を受けたらWorkerを破棄し、軽量Workerで1回だけ復旧する。
 * cancel後の遅延応答は無視される。
 */
export function requestAiWorkerPlan(
  worker: AiPlanningWorker,
  request: Extract<AiWorkerRequest, { type: "plan" }>,
  callbacks: PlanCallbacks,
  timeoutMs = AI_WORKER_TIMEOUT_MS,
): () => void {
  let settled = false;
  let timeout: ReturnType<typeof setTimeout> | null = null;

  const cleanup = () => {
    if (timeout !== null) {
      clearTimeout(timeout);
      timeout = null;
    }
    worker.removeEventListener("message", onMessage);
    worker.removeEventListener("error", onError);
    worker.removeEventListener("messageerror", onMessageError);
  };
  const fail = (error: unknown) => {
    if (settled) return;
    settled = true;
    cleanup();
    callbacks.failed(error);
  };
  const onMessage = (event: { data: AiWorkerResponse }) => {
    const response = event.data;
    if (
      response.matchId !== request.matchId ||
      response.requestId !== request.requestId
    )
      return;
    if (response.type === "error") {
      fail(response.message);
      return;
    }
    if (settled) return;
    settled = true;
    cleanup();
    callbacks.planned(response.planned);
  };
  const onError = (event: { error?: unknown; message?: string }) =>
    fail(event.error ?? event.message ?? "CPU Workerでエラーが発生しました");
  const onMessageError = () =>
    fail(new Error("CPU Workerの応答を読み取れませんでした"));

  worker.addEventListener("message", onMessage);
  worker.addEventListener("error", onError);
  worker.addEventListener("messageerror", onMessageError);
  timeout = setTimeout(
    () => fail(new AiWorkerTimeoutError(Math.max(0, timeoutMs))),
    Math.max(0, timeoutMs),
  );
  try {
    worker.postMessage(request);
  } catch (error) {
    fail(error);
  }

  return () => {
    if (settled) return;
    settled = true;
    cleanup();
  };
}
