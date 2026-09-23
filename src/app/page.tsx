import { readdirSync } from "node:fs";
import { join } from "node:path";
import { PongGame } from "./pong-game";

/** The optional art in public/sprites, read when the page is built. */
function spriteFiles() {
  try { return readdirSync(join(process.cwd(), "public", "sprites")).filter((f) => f.toLowerCase().endsWith(".png")); } catch { return []; }
}
export default function Home() { return <main className="game-page"><header className="game-topbar"><a className="back-link" href={process.env.NEXT_PUBLIC_ARCADE_URL ?? "http://localhost:3010"}>← LMONGOLYAN ARCADE</a><h1 className="game-brand">MANGOLIAN <span>PONG</span></h1><span className="back-link">CABINET 01</span></header><PongGame sprites={spriteFiles()} /></main>; }
