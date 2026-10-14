import type { ReactNode } from "react";
import { cardIndex } from "../../data/loader";
import hocgLogo from "../../assets/logo.png";
import { CardView } from "../cards/CardView";

type IconName =
  | "cards"
  | "gamepad"
  | "globe"
  | "arrow"
  | "plus"
  | "upload"
  | "spark";

const icons: Record<IconName, ReactNode> = {
  cards: (
    <>
      <rect x="7" y="3" width="13" height="17" rx="2" />
      <path d="M4 7H3v14a1 1 0 0 0 1 1h11M11 8h5m-5 4h5" />
    </>
  ),
  gamepad: (
    <>
      <path d="M7 6h10a3 3 0 0 1 3 2.5l1.5 9a2 2 0 0 1-3.3 1.8L15 16H9l-3.2 3.3a2 2 0 0 1-3.3-1.8l1.5-9A3 3 0 0 1 7 6Z" />
      <path d="M8 9v5m-2.5-2.5h5m5.5-1h.01M18 13h.01" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <ellipse cx="12" cy="12" rx="4" ry="9" />
      <path d="M3 12h18" />
    </>
  ),
  arrow: <path d="M4 12h15m-6-6 6 6-6 6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  upload: (
    <>
      <path d="M12 16V3m-5 5 5-5 5 5M4 15v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5" />
    </>
  ),
  spark: <path d="m12 2 2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5Z" />,
};

export function Icon({
  name,
  className = "",
}: {
  name: IconName;
  className?: string;
}) {
  return (
    <svg
      className={`ui-icon ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {icons[name]}
    </svg>
  );
}

export function Brand() {
  return (
    <span className="brand">
      <img
        className="brand-logo"
        src={hocgLogo}
        width="284"
        height="78"
        alt="hololive OFFICIAL CARD GAME"
      />
    </span>
  );
}

export function HomeHeader({ onBuild }: { onBuild: () => void }) {
  return (
    <header className="site-header">
      <div className="site-header-inner">
        <a
          className="brand-link"
          href={window.location.pathname}
          aria-label="hololive カードゲームシミュレーター ホーム"
        >
          <Brand />
        </a>
        <nav className="site-nav" aria-label="メインナビゲーション">
          <a className="is-current" href="#home" aria-current="page">
            ホーム
          </a>
          <a href="#my-decks">マイデッキ</a>
          <a href="#play">対戦</a>
        </nav>
        <button className="header-build" onClick={onBuild}>
          <Icon name="plus" />
          デッキを作成
        </button>
      </div>
    </header>
  );
}

export function HomeHero({ onBuild }: { onBuild: () => void }) {
  // OUR画像は公式配信ファイルとバイト単位で照合済み。配列順からレアリティを推測しない。
  const featured = [
    { cardId: "hBP02-001", artworkKey: "hBP02-001_2.png" },
    { cardId: "hSD01-001", artworkKey: "hSD01-001.png" },
    { cardId: "hBP01-007", artworkKey: "hBP01-007_2.png" },
  ];
  return (
    <section className="home-hero" aria-labelledby="home-title">
      <div className="hero-copy">
        <span className="hero-kicker">
          <span /> hololive OFFICIAL CARD GAME
        </span>
        <h1 id="home-title">
          ホロカ
          <br />
          <em>対戦シミュレーター</em>
        </h1>
        <p>
          デッキの作成・編集、CPU対戦、オンライン対戦に対応。
          <br />
          保存したデッキやサンプルデッキを使用できます。
        </p>
        <div className="hero-actions">
          <a className="home-primary" href="#play">
            <Icon name="gamepad" />
            対戦を選択
            <Icon name="arrow" />
          </a>
          <button className="hero-secondary" onClick={onBuild}>
            <Icon name="cards" />
            デッキを作成
          </button>
        </div>
      </div>
      <div className="hero-art" aria-hidden="true">
        <span className="hero-orbit" />
        <span className="hero-orbit orbit-two" />
        <Icon name="spark" className="hero-spark spark-one" />
        <Icon name="spark" className="hero-spark spark-two" />
        <div className="hero-card-fan">
          {featured.map(
            (card, index) =>
              cardIndex.has(card.cardId) && (
                <div
                  className={`hero-featured-card featured-${index}`}
                  key={card.cardId}
                >
                  <CardView
                    cardId={card.cardId}
                    artworkKey={card.artworkKey}
                    size="lg"
                  />
                </div>
              ),
          )}
        </div>
      </div>
    </section>
  );
}

export function HomeFooter() {
  return (
    <footer className="home-footer">
      <Brand />
      <p>
        hololive OFFICIAL CARD GAME の非公式ファンメイドシミュレーターです。
      </p>
    </footer>
  );
}

export function BackToHome() {
  return (
    <a className="back-to-home" href={window.location.pathname}>
      <Icon name="arrow" />
      ホームへ戻る
    </a>
  );
}
