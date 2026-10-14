import {
  ROOM_CODE_MAX_LENGTH,
  validateRoomCode,
} from "../../game/online/protocol";

export { ROOM_CODE_MAX_LENGTH };
export const PLAYER_NAME_MAX_LENGTH = 40;
export const DECK_NAME_MAX_LENGTH = 128;

function requiredTrimmedTextError(
  value: string,
  label: string,
  maxLength: number,
): string | null {
  if (value.trim().length === 0) return `${label}を入力してください。`;
  if (value.length > maxLength)
    return `${label}は${maxLength}文字以内で入力してください。`;
  return null;
}

export function playerNameInputError(value: string): string | null {
  return requiredTrimmedTextError(
    value,
    "プレイヤー名",
    PLAYER_NAME_MAX_LENGTH,
  );
}

export type RoomCodeInputValidation =
  | { ok: true; room: string }
  | { ok: false; error: string };

export function validateRoomCodeInput(value: string): RoomCodeInputValidation {
  const validation = validateRoomCode(value);
  if (validation.ok) return validation;
  return {
    ok: false,
    error:
      validation.reason === "required"
        ? "部屋コードを入力してください。"
        : `部屋コードは${ROOM_CODE_MAX_LENGTH}文字以内で入力してください。`,
  };
}

export function roomCodeInputError(value: string): string | null {
  const validation = validateRoomCodeInput(value);
  return validation.ok ? null : validation.error;
}

export function deckNameInputError(value: string): string | null {
  return requiredTrimmedTextError(value, "デッキ名", DECK_NAME_MAX_LENGTH);
}
