import { validateRoomCodeInput } from "../common/inputValidation";

export type OnlineRoomRoute =
  | { kind: "absent" }
  | { kind: "valid"; room: string }
  | { kind: "invalid"; error: string };

/** URLのroom指定を、接続を始める前に入力フォームと同じ規則で検証する。 */
export function resolveOnlineRoomRoute(search: string): OnlineRoomRoute {
  const rawRoom = new URLSearchParams(search).get("room");
  if (rawRoom === null) return { kind: "absent" };
  const validation = validateRoomCodeInput(rawRoom);
  return validation.ok
    ? { kind: "valid", room: validation.room }
    : { kind: "invalid", error: validation.error };
}
