import { cardsReady } from "../../data/loader";
import { planCpuMove } from "./driver";
import { mulberry32, type AiOptions } from "./types";
import type { AiWorkerRequest, AiWorkerResponse } from "./workerProtocol";

// DOM用tsconfigのままWorkerエントリを型検査できるよう、必要な形だけを定義する。
const workerScope = globalThis as unknown as {
  onmessage: ((event: { data: AiWorkerRequest }) => void) | null;
  postMessage(message: AiWorkerResponse): void;
};

let configuredMatchId = -1;
let options: AiOptions | null = null;

const handleRequest = (request: AiWorkerRequest) => {
  if (request.type === "configure") {
    configuredMatchId = request.matchId;
    options = {
      level: request.level,
      rng: mulberry32(request.seed),
      opponentDeck: request.opponentDeck,
    };
    return;
  }

  const respond = (response: AiWorkerResponse) =>
    workerScope.postMessage(response);
  if (!options || configuredMatchId !== request.matchId) {
    respond({
      type: "error",
      matchId: request.matchId,
      requestId: request.requestId,
      message: "CPU Workerが現在の対局向けに初期化されていません",
    });
    return;
  }

  try {
    respond({
      type: "planned",
      matchId: request.matchId,
      requestId: request.requestId,
      planned: planCpuMove(request.state, request.seat, options),
    });
  } catch (error) {
    respond({
      type: "error",
      matchId: request.matchId,
      requestId: request.requestId,
      message:
        error instanceof Error ? error.message : "CPUの行動計画に失敗しました",
    });
  }
};

// カードデータ (静的JSONのfetch) が揃うまでの依頼は順序を保って保留する。
// 読み込みに失敗した場合もplan依頼へ必ず応答し、UI側の軽量Worker復旧を起動する。
let cardsLoaded = false;
let cardsLoadError: string | null = null;
const queued: AiWorkerRequest[] = [];
const rejectForCardLoad = (request: AiWorkerRequest) => {
  if (request.type !== "plan" || cardsLoadError === null) return;
  workerScope.postMessage({
    type: "error",
    matchId: request.matchId,
    requestId: request.requestId,
    message: cardsLoadError,
  });
};
workerScope.onmessage = (event) => {
  if (cardsLoadError !== null) {
    rejectForCardLoad(event.data);
    return;
  }
  if (!cardsLoaded) {
    queued.push(event.data);
    return;
  }
  handleRequest(event.data);
};
cardsReady
  .then(() => {
    cardsLoaded = true;
    for (const request of queued) handleRequest(request);
    queued.length = 0;
  })
  .catch((error: unknown) => {
    cardsLoadError =
      error instanceof Error
        ? `カードデータの読み込みに失敗しました: ${error.message}`
        : "カードデータの読み込みに失敗しました";
    for (const request of queued) rejectForCardLoad(request);
    queued.length = 0;
  });
