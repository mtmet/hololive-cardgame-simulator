import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { cardImageUrl } from "../../data/loader";
import type { GameState, LogEntry, PlayerId } from "../../game/types";

type StoredRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type OshiSkillLog = {
  logId: number;
  player: PlayerId;
  sp: boolean;
  skillName: string;
};

export type OshiSkillEffect = OshiSkillLog & {
  id: string;
  cardImage: string | null;
  source: StoredRect;
  delay: number;
};

const OSHI_SKILL_DURATION = 1500;
const SP_OSHI_SKILL_DURATION = 1750;

export function parseOshiSkillLogs(logs: LogEntry[]): OshiSkillLog[] {
  return logs.flatMap((entry) => {
    if (entry.player === null) return [];
    const match =
      /^(SP推しスキル|推しスキル)「([^」]+)」を使用しました(?: \(ホロパワー-[^)]+\))?$/.exec(
        entry.text,
      );
    if (!match) return [];
    return [
      {
        logId: entry.id,
        player: entry.player,
        sp: match[1] === "SP推しスキル",
        skillName: match[2],
      },
    ];
  });
}

function captureOshiRect(player: PlayerId): StoredRect | null {
  const slot = document.querySelector<HTMLElement>(
    `[data-oshi-player="${player}"]`,
  );
  const element = slot?.querySelector<HTMLElement>(".card") ?? slot;
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  };
}

export function useOshiSkillAnimations(game: GameState) {
  const [effects, setEffects] = useState<OshiSkillEffect[]>([]);
  const previousLogIdRef = useRef(game.log.at(-1)?.id ?? 0);
  const timersRef = useRef<number[]>([]);

  useLayoutEffect(() => {
    const previousLogId = previousLogIdRef.current;
    const latestLogId = game.log.at(-1)?.id ?? previousLogId;
    const newLogs = game.log.filter((entry) => entry.id > previousLogId);
    previousLogIdRef.current = latestLogId;

    if (
      newLogs.length === 0 ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }

    const nextEffects = parseOshiSkillLogs(newLogs).flatMap(
      (skill, index): OshiSkillEffect[] => {
        const source = captureOshiRect(skill.player);
        if (!source) return [];
        const oshiUid = game.players[skill.player].oshiUid;
        const cardId = game.uidToCard[oshiUid];
        return [
          {
            ...skill,
            id: `oshi-skill-${skill.logId}-${skill.player}`,
            cardImage: cardId
              ? cardImageUrl(cardId, game.uidToArtwork?.[oshiUid])
              : null,
            source,
            delay: index * 140,
          },
        ];
      },
    );

    if (nextEffects.length === 0) return;
    setEffects((current) => [...current, ...nextEffects]);

    for (const effect of nextEffects) {
      const duration = effect.sp ? SP_OSHI_SKILL_DURATION : OSHI_SKILL_DURATION;
      const timer = window.setTimeout(
        () => {
          setEffects((current) =>
            current.filter((item) => item.id !== effect.id),
          );
          timersRef.current = timersRef.current.filter((id) => id !== timer);
        },
        duration + effect.delay + 120,
      );
      timersRef.current.push(timer);
    }
  }, [game]);

  useEffect(
    () => () => {
      for (const timer of timersRef.current) window.clearTimeout(timer);
      timersRef.current = [];
    },
    [],
  );

  return effects;
}

export function OshiSkillAnimationLayer({
  effects,
}: {
  effects: OshiSkillEffect[];
}) {
  if (effects.length === 0) return null;

  return (
    <div className="oshi-skill-fx-layer" aria-hidden="true">
      {effects.map((effect) => {
        const x = effect.source.left + effect.source.width / 2;
        const y = effect.source.top + effect.source.height / 2;
        const style = {
          "--oshi-left": `${effect.source.left}px`,
          "--oshi-top": `${effect.source.top}px`,
          "--oshi-width": `${effect.source.width}px`,
          "--oshi-height": `${effect.source.height}px`,
          "--oshi-x": `${x}px`,
          "--oshi-y": `${y}px`,
          "--oshi-delay": `${effect.delay}ms`,
          "--oshi-duration": `${effect.sp ? SP_OSHI_SKILL_DURATION : OSHI_SKILL_DURATION}ms`,
        } as CSSProperties;

        return (
          <div
            key={effect.id}
            className={`oshi-skill-fx-effect${effect.sp ? " is-sp" : ""}`}
            style={style}
          >
            <div className="oshi-skill-fx-veil" />
            <div className="oshi-skill-fx-source-aura" />
            <div className="oshi-skill-fx-source-ring ring-one" />
            <div className="oshi-skill-fx-source-ring ring-two" />
            {effect.cardImage && (
              <img
                className="oshi-skill-fx-card"
                src={effect.cardImage}
                alt=""
              />
            )}
            <div className="oshi-skill-fx-particles">
              {Array.from({ length: effect.sp ? 12 : 8 }, (_, index) => (
                <i key={index} />
              ))}
            </div>
            <div className="oshi-skill-fx-banner">
              <span>{effect.sp ? "SP OSHI SKILL" : "OSHI SKILL"}</span>
              <strong>{effect.skillName}</strong>
            </div>
          </div>
        );
      })}
    </div>
  );
}
