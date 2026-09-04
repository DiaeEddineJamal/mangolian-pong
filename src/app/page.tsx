import { PongGame } from "./pong-game";
export default function Home() { return <main className="game-page"><header className="game-topbar"><a className="back-link" href={process.env.NEXT_PUBLIC_ARCADE_URL ?? "http://localhost:3010"}>← LMOGOLYAN ARCADE</a><h1 className="game-brand">MANGOLIAN <span>PONG</span></h1><span className="back-link">CABINET 01</span></header><PongGame /></main>; }
