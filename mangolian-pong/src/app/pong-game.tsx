"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";

type Point = { x: number; y: number };
type GameState = { left: number; right: number; ball: Point; velocity: Point; leftScore: number; rightScore: number; hits: number; storm: number; nextStorm: number; paused: boolean };
const W = 960, H = 540, PADDLE_H = 148, PADDLE_W = 52, SPEED = 440;
const fresh = (): GameState => ({ left: H / 2 - PADDLE_H / 2, right: H / 2 - PADDLE_H / 2, ball: { x: W / 2, y: H / 2 }, velocity: { x: 275, y: 132 }, leftScore: 0, rightScore: 0, hits: 0, storm: 0, nextStorm: 12, paused: false });
const keyName = (key: string) => key.length === 1 ? key.toLowerCase() : key;

export function PongGame() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const state = useRef<GameState>(fresh());
  const keys = useRef(new Set<string>());
  const sprite = useRef<HTMLImageElement | null>(null);
  const socket = useRef<Socket | null>(null);
  const roleRef = useRef<"local" | "host" | "guest">("local");
  const modeRef = useRef<"local" | "online">("local");
  const [hud, setHud] = useState({ left: 0, right: 0, message: "FIRST TO 11", storm: "CALM" });
  const [mode, setMode] = useState<"local" | "online">("local");
  const [role, setRole] = useState<"local" | "host" | "guest">("local");
  const [lobby, setLobby] = useState({ phase: "setup", code: "", joinCode: "", notice: "Create a private room or enter a friend’s code." });

  const announce = useCallback((message: string, storm = state.current.storm > 0 ? "FILM FRENZY" : "CALM") => {
    const s = state.current;
    setHud({ left: s.leftScore, right: s.rightScore, message, storm });
  }, []);
  const resetBall = useCallback((toLeft = Math.random() > 0.5) => {
    const s = state.current;
    s.ball = { x: W / 2, y: H / 2 };
    s.velocity = { x: (toLeft ? -1 : 1) * (260 + Math.min(s.hits * 8, 170)), y: Math.random() * 180 - 90 };
    s.hits = 0;
  }, []);

  const connect = useCallback(() => {
    if (socket.current) return socket.current;
    const client = io(process.env.NEXT_PUBLIC_RACING_SERVER_URL ?? "http://localhost:3000", { transports: ["websocket", "polling"] });
    socket.current = client;
    client.on("connect_error", () => setLobby((l) => ({ ...l, notice: "Can’t reach the arcade server. Please try again in a moment." })));
    client.on("pong:room", (room: { code: string; players: unknown[] }) => setLobby((l) => {
      const hasTwo = room.players.length === 2;
      const playing = hasTwo && l.phase === "playing";
      return { ...l, code: room.code, phase: playing ? "playing" : hasTwo ? "ready" : "waiting", notice: hasTwo ? (playing ? "LIVE" : "Friend connected. The host can start.") : "Share this four-letter room code." };
    }));
    client.on("pong:hostChanged", () => {
      roleRef.current = "host";
      setRole("host");
      setLobby((l) => ({ ...l, phase: "waiting", notice: "You are now the host. Invite another player." }));
    });
    client.on("pong:state", (snapshot: GameState) => {
      state.current = snapshot;
      const storm = snapshot.storm > 0 ? "FILM FRENZY" : "LIVE";
      const message = snapshot.storm > 0 ? "FILM FRENZY" : "LIVE ONLINE MATCH";
      setHud((current) => current.left === snapshot.leftScore && current.right === snapshot.rightScore && current.storm === storm && current.message === message ? current : { left: snapshot.leftScore, right: snapshot.rightScore, message, storm });
    });
    client.on("pong:start", () => setLobby((l) => ({ ...l, phase: "playing", notice: "LIVE" })));
    return client;
  }, []);

  useEffect(() => () => { socket.current?.emit("pong:leave"); socket.current?.disconnect(); }, []);
  useEffect(() => {
    const image = new Image();
    image.src = "/pong-sprites-tech.png";
    image.onload = () => { sprite.current = image; };
    const actionFor = (key: string) => roleRef.current === "host" ? (key === "w" ? "up" : key === "s" ? "down" : null) : roleRef.current === "guest" ? (key === "ArrowUp" ? "up" : key === "ArrowDown" ? "down" : null) : null;
    const down = (event: KeyboardEvent) => {
      const key = keyName(event.key);
      if (["w", "s", "ArrowUp", "ArrowDown", " "].includes(key)) event.preventDefault();
      if (event.repeat) return;
      keys.current.add(key);
      if (modeRef.current === "local") { if (key === " ") state.current.paused = !state.current.paused; return; }
      const action = actionFor(key);
      if (action) socket.current?.emit("pong:input", { action, down: true });
    };
    const up = (event: KeyboardEvent) => {
      const key = keyName(event.key);
      keys.current.delete(key);
      if (modeRef.current !== "online") return;
      const action = actionFor(key);
      if (action) socket.current?.emit("pong:input", { action, down: false });
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current, ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    let animation = 0, last = performance.now(), elapsed = 0;
    const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
    const drawSprite = (sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number) => {
      if (sprite.current?.complete) ctx.drawImage(sprite.current, sx, sy, sw, sh, dx, dy, dw, dh);
      else { ctx.fillStyle = "#ffc234"; ctx.fillRect(dx, dy, dw, dh); }
    };
    const score = (leftWon: boolean) => {
      const s = state.current;
      if (leftWon) s.leftScore++; else s.rightScore++;
      const won = (leftWon ? s.leftScore : s.rightScore) >= 11;
      announce(won ? `${leftWon ? "TEAL" : "BRICK"} WINS — NEW ROUND` : `${leftWon ? "TEAL" : "BRICK"} SCORES`);
      if (won) { s.leftScore = 0; s.rightScore = 0; }
      resetBall(!leftWon);
    };
    const draw = () => {
      const s = state.current;
      ctx.fillStyle = "#385954"; ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = s.storm ? "#a44f39" : "#d9c89f"; ctx.lineWidth = 3; ctx.setLineDash([7, 11]);
      ctx.beginPath(); ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H); ctx.stroke(); ctx.setLineDash([]);
      for (let y = 42; y < H; y += 80) { ctx.fillStyle = "rgba(244,233,202,.16)"; ctx.fillRect(W / 2 - 3, y, 6, 40); }
      if (s.storm) { ctx.fillStyle = "rgba(164,79,57,.16)"; for (let x = 0; x < W; x += 45) ctx.fillRect(x + ((elapsed * 90) % 45), 0, 12, H); }
      drawSprite(75, 45, 320, 930, 24, s.left, PADDLE_W, PADDLE_H);
      drawSprite(1160, 45, 300, 930, W - 76, s.right, PADDLE_W, PADDLE_H);
      ctx.fillStyle = s.storm ? "rgba(164,79,57,.32)" : "rgba(198,151,58,.24)";
      ctx.beginPath(); ctx.arc(s.ball.x, s.ball.y, s.storm ? 34 : 20, 0, Math.PI * 2); ctx.fill();
      drawSprite(620, 350, 320, 320, s.ball.x - 23, s.ball.y - 23, 46, 46);
      if (s.paused) { ctx.fillStyle = "rgba(32,27,22,.78)"; ctx.fillRect(0, 0, W, H); ctx.fillStyle = "#f2e8ca"; ctx.font = "48px Bungee"; ctx.textAlign = "center"; ctx.fillText("PAUSED", W / 2, H / 2); }
    };
    const frame = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.032); last = now; elapsed += dt;
      const s = state.current;
      if (modeRef.current === "local" && !s.paused) {
        const leftMove = (keys.current.has("w") ? -1 : 0) + (keys.current.has("s") ? 1 : 0);
        const rightMove = (keys.current.has("ArrowUp") ? -1 : 0) + (keys.current.has("ArrowDown") ? 1 : 0);
        s.left = clamp(s.left + leftMove * SPEED * dt, 0, H - PADDLE_H);
        s.right = clamp(s.right + rightMove * SPEED * dt, 0, H - PADDLE_H);
        s.ball.x += s.velocity.x * dt; s.ball.y += s.velocity.y * dt;
        if (s.ball.y < 14 || s.ball.y > H - 14) { s.velocity.y *= -1; s.ball.y = clamp(s.ball.y, 14, H - 14); }
        const leftHit = s.velocity.x < 0 && s.ball.x - 18 < 76 && s.ball.x + 18 > 24 && s.ball.y > s.left && s.ball.y < s.left + PADDLE_H;
        const rightHit = s.velocity.x > 0 && s.ball.x + 18 > W - 76 && s.ball.x - 18 < W - 24 && s.ball.y > s.right && s.ball.y < s.right + PADDLE_H;
        if (leftHit || rightHit) {
          const paddleY = leftHit ? s.left : s.right, relative = (s.ball.y - (paddleY + PADDLE_H / 2)) / (PADDLE_H / 2);
          s.velocity.x = (leftHit ? 1 : -1) * Math.min(Math.abs(s.velocity.x) + 21, 610);
          s.velocity.y += relative * 105; s.ball.x = leftHit ? 78 : W - 78; s.hits++;
          if (s.hits % 5 === 0) announce(`RALLY ×${s.hits} — BALL IS HOT`);
        }
        if (s.ball.x < -30) score(false);
        if (s.ball.x > W + 30) score(true);
        s.nextStorm -= dt;
        if (s.nextStorm <= 0) {
          s.storm = s.storm ? 0 : 5.5; s.nextStorm = s.storm ? 5.5 : 12;
          if (s.storm) { s.velocity.y *= 1.65; announce("FILM FRENZY — CURVES GO WILD", "FILM FRENZY"); } else announce("STORM PASSED");
        }
        if (s.storm) { s.storm -= dt; s.velocity.y += Math.sin(elapsed * 6) * 2.8; }
      }
      draw(); animation = requestAnimationFrame(frame);
    };
    animation = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(animation);
  }, [announce, resetBall]);

  const createRoom = () => {
    roleRef.current = "host"; setRole("host");
    connect().emit("pong:create", {}, (reply: { room?: { code: string }; error?: string }) => {
      if (reply.error) setLobby((l) => ({ ...l, notice: reply.error ?? "Could not create a room." }));
      else setLobby((l) => ({ ...l, code: reply.room?.code ?? "", phase: "waiting", notice: "Share this code. You play TEAL." }));
    });
  };
  const joinRoom = () => {
    roleRef.current = "guest"; setRole("guest");
    connect().emit("pong:join", { code: lobby.joinCode }, (reply: { room?: { code: string }; error?: string }) => {
      if (reply.error) setLobby((l) => ({ ...l, notice: reply.error ?? "Could not join that room." }));
      else setLobby((l) => ({ ...l, code: reply.room?.code ?? "", phase: "ready", notice: "Connected. You play BRICK." }));
    });
  };
  const copyCode = async () => {
    if (!lobby.code) return;
    try { await navigator.clipboard.writeText(lobby.code); setLobby((l) => ({ ...l, notice: "Code copied. Send it to your friend." })); }
    catch { setLobby((l) => ({ ...l, notice: `Room code: ${l.code}` })); }
  };
  const start = () => {
    if (roleRef.current !== "host") return;
    setLobby((l) => ({ ...l, phase: "playing", notice: "LIVE" }));
    socket.current?.emit("pong:start");
  };
  const local = () => {
    socket.current?.emit("pong:leave"); keys.current.clear(); roleRef.current = "local"; modeRef.current = "local";
    setRole("local"); state.current = fresh(); setMode("local");
    setLobby({ phase: "setup", code: "", joinCode: "", notice: "Create a private room or enter a friend’s code." }); announce("FIRST TO 11");
  };
  const online = () => {
    if (modeRef.current === "online") return;
    keys.current.clear(); modeRef.current = "online"; state.current = fresh();
    setHud({ left: 0, right: 0, message: "ONLINE LOBBY", storm: "READY" }); setMode("online");
  };

  return <><section className="game-shell">
    <div className="scoreboard"><div className="score"><strong>{hud.left}</strong><small>TEAL<br />W / S</small></div><span className="round-status">{hud.storm}<br />{hud.message}</span><div className="score score-right"><small>BRICK<br />↑ / ↓</small><strong>{hud.right}</strong></div></div>
    <div className="play-switch"><button className={mode === "local" ? "active" : ""} onClick={local}>LOCAL</button><button className={mode === "online" ? "active" : ""} onClick={online}>ONLINE</button></div>
    {mode === "online" && lobby.phase !== "playing" ? <div className="online-lobby">
      <header className="lobby-intro"><b>PRIVATE MATCH</b><p>{lobby.notice}</p></header>
      <section className="room-panel"><span className="room-step">01 / HOST</span><h3>CREATE A ROOM</h3><p>Generate a private code, then send it to your opponent.</p>{role === "host" && lobby.code ? <div className="room-code"><span>YOUR ROOM CODE</span><output>{lobby.code}</output><button onClick={copyCode}>COPY CODE</button></div> : <button onClick={createRoom}>CREATE PRIVATE ROOM</button>}</section>
      <section className="room-panel"><span className="room-step">02 / GUEST</span><h3>JOIN A ROOM</h3><p>Enter the four-character code your friend sent you.</p><label><span>ROOM CODE</span><input aria-label="Four-character room code" autoComplete="off" maxLength={4} value={lobby.joinCode} onChange={(e) => setLobby((l) => ({ ...l, joinCode: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "") }))} placeholder="ABCD" /></label><button disabled={lobby.joinCode.length !== 4} onClick={joinRoom}>JOIN ROOM</button></section>
      {role === "host" && lobby.phase === "ready" && <button className="start-button" onClick={start}>FRIEND CONNECTED: START MATCH ↗</button>}
    </div> : <canvas className="game-canvas" ref={canvasRef} width={W} height={H} aria-label="Mangolian Pong game board" />}
    <div className="game-bottom"><span className="control-hint">{mode === "local" ? "SHARE THE KEYBOARD · W / S + ↑ / ↓ · SPACE = PAUSE" : role === "guest" ? "YOU ARE BRICK · ↑ / ↓ TO PLAY" : "YOU ARE TEAL · W / S TO PLAY"}</span><button className="mode-button" onClick={local}>↻ NEW LOCAL MATCH</button></div>
  </section><section className="game-notes"><p>LOCAL / TWO FRIENDS. ONE KEYBOARD.</p><p>ONLINE / CREATE A CODE. SHARE IT. PLAY.</p><p>FILM FRENZY / EVERY 12 SECONDS THE WIND BENDS THE RALLY.</p></section></>;
}
