"use client";

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { io, type Socket } from "socket.io-client";
import { createSpriteBank, drawFx, spawnFx, type Fx } from "../game/sprite-bank";
import { applyView, pointerToBoard, screenSize, uprightOverlay, uprightText, usePortrait, type BoardView } from "../game/board-view";

type Point = { x: number; y: number };
type Side = "left" | "right";
type Role = "local" | "host" | "guest";
type Mode = "local" | "cpu" | "online";
type Difficulty = "easy" | "normal" | "hard";
type GameState = { left: number; right: number; ball: Point; velocity: Point; leftScore: number; rightScore: number; hits: number; storm: number; nextStorm: number; paused: boolean };
type RoomInfo = { code: string; playing: boolean; players: { side: Side; connected: boolean }[] };
type RoomReply = { room?: RoomInfo; side?: Side; error?: string };
type NetStatus = "ok" | "reconnecting" | "partner-away";
/** Everything the online renderer needs between server snapshots. */
type Net = {
  offset: number; rtt: number; samples: number; hasSnap: boolean;
  ball: Point; vel: Point; hold: number; err: Point; opp: number; oppTarget: number;
  lastSent: number; lastSentY: number; round: number; status: NetStatus;
};

const W = 960, H = 540, PADDLE_H = 148, PADDLE_W = 52, SPEED = 440, DRAG_SPEED = 1500;
const SESSION_KEY = "mangolian-pong-session";
const fresh = (): GameState => ({ left: H / 2 - PADDLE_H / 2, right: H / 2 - PADDLE_H / 2, ball: { x: W / 2, y: H / 2 }, velocity: { x: 275, y: 132 }, leftScore: 0, rightScore: 0, hits: 0, storm: 0, nextStorm: 12, paused: false });
const freshNet = (): Net => ({ offset: 0, rtt: 0, samples: 0, hasSnap: false, ball: { x: W / 2, y: H / 2 }, vel: { x: 0, y: 0 }, hold: 0, err: { x: 0, y: 0 }, opp: H / 2 - PADDLE_H / 2, oppTarget: H / 2 - PADDLE_H / 2, lastSent: 0, lastSentY: -1, round: 0, status: "ok" });
const keyName = (key: string) => key.length === 1 ? key.toLowerCase() : key;
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
const sideOf = (role: Role): Side => role === "guest" ? "right" : "left";
/** CPU paddle per level: speed as a share of a player's, how often it re-reads the ball, aim error, and how much it angles returns off the paddle edge. */
const PONG_CPU = {
  easy: { speed: 0.55, react: 0.3, miss: 60, edge: 0.05 },
  normal: { speed: 0.82, react: 0.15, miss: 26, edge: 0.2 },
  hard: { speed: 1.08, react: 0.05, miss: 7, edge: 0.38 },
} as const;
/** Where the ball will reach x, bouncing between the rails. */
function predictY(ball: Point, vel: Point, x: number) {
  if (vel.x <= 0) return ball.y;
  const t = (x - ball.x) / vel.x, span = H - 28;
  let y = ball.y - 14 + vel.y * t;
  y = ((y % (2 * span)) + 2 * span) % (2 * span);
  return (y > span ? 2 * span - y : y) + 14;
}
const lobbyStart = { phase: "setup", code: "", joinCode: "", notice: "Create a private room or enter a friend’s code." };

/** A per-tab identity, so a dropped connection can take its seat back. */
function sessionToken() {
  try {
    const saved = sessionStorage.getItem(`${SESSION_KEY}-token`);
    if (saved) return saved;
  } catch { /* storage blocked: fall through to a fresh token */ }
  const token = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  try { sessionStorage.setItem(`${SESSION_KEY}-token`, token); } catch { /* ignore */ }
  return token;
}
const saveRoom = (code: string | null) => {
  try { if (code) sessionStorage.setItem(SESSION_KEY, code); else sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
};
const savedRoom = () => {
  try { return sessionStorage.getItem(SESSION_KEY); } catch { return null; }
};

/**
 * Moves the ball the way the server does: wall bounces and paddle returns.
 * Used to draw the online ball where it is *now*, between snapshots, instead
 * of where it was when the last packet left the server.
 */
function advanceBall(ball: Point, vel: Point, dt: number, left: number, right: number) {
  ball.x += vel.x * dt; ball.y += vel.y * dt;
  if (ball.y < 14 || ball.y > H - 14) { vel.y *= -1; ball.y = clamp(ball.y, 14, H - 14); }
  const leftHit = vel.x < 0 && ball.x - 18 < 76 && ball.x + 18 > 24 && ball.y > left - 14 && ball.y < left + PADDLE_H + 14;
  const rightHit = vel.x > 0 && ball.x + 18 > W - 76 && ball.x - 18 < W - 24 && ball.y > right - 14 && ball.y < right + PADDLE_H + 14;
  if (leftHit || rightHit) {
    const paddleY = leftHit ? left : right, relative = clamp((ball.y - (paddleY + PADDLE_H / 2)) / (PADDLE_H / 2), -1, 1);
    vel.x = (leftHit ? 1 : -1) * Math.min(Math.abs(vel.x) + 21, 610);
    vel.y += relative * 105; ball.x = leftHit ? 78 : W - 78;
  }
}

/** Keeps a finger's events on this element; harmless if the browser refuses. */
const capture = (el: Element, id: number) => { try { el.setPointerCapture(id); } catch { /* not a live pointer */ } };

export function PongGame({ sprites: files }: { sprites: string[] }) {
  // Optional art from /public/sprites (see docs/ASSET_PROMPTS.md); missing pieces use the built-in sheet.
  const [art] = useState(() => createSpriteBank(files));
  // State, not a ref: the drawing loop restarts whenever the canvas element is replaced.
  const [canvasEl, setCanvasEl] = useState<HTMLCanvasElement | null>(null);
  const state = useRef<GameState>(fresh());
  const net = useRef<Net>(freshNet());
  const keys = useRef(new Set<string>());
  const touchMoves = useRef(new Set<string>());
  const drags = useRef(new Map<number, { side: Side; y: number }>());
  const sprites = useRef<{ left: HTMLCanvasElement; right: HTMLCanvasElement; ball: HTMLCanvasElement } | null>(null);
  const socket = useRef<Socket | null>(null);
  const token = useRef("");
  const roomCode = useRef<string | null>(null);
  const roleRef = useRef<Role>("local");
  const modeRef = useRef<Mode>("local");
  const difficultyRef = useRef<Difficulty>("normal");
  const cpu = useRef({ think: 0, target: H / 2, aim: 0, incoming: false });
  const [hud, setHud] = useState({ left: 0, right: 0, message: "FIRST TO 11", storm: "CALM", ping: 0 });
  const [mode, setMode] = useState<Mode>("local");
  const [difficulty, setDifficulty] = useState<Difficulty>("normal");
  const [role, setRole] = useState<Role>("local");
  const [lobby, setLobby] = useState(lobbyStart);
  // On a phone held upright the board turns so your own paddle sits at the bottom.
  const portrait = usePortrait();
  const bottomSide: Side = mode === "online" && role === "guest" ? "right" : "left";
  const view = useRef<BoardView>({ portrait: false, bottom: "left", W, H });
  useEffect(() => { view.current = { portrait, bottom: bottomSide, W, H }; }, [portrait, bottomSide]);

  const announce = useCallback((message: string, storm = state.current.storm > 0 ? "FILM FRENZY" : "CALM") => {
    const s = state.current;
    setHud((h) => ({ ...h, left: s.leftScore, right: s.rightScore, message, storm }));
  }, []);
  const resetBall = useCallback((toLeft = Math.random() > 0.5) => {
    const s = state.current;
    s.ball = { x: W / 2, y: H / 2 };
    s.velocity = { x: (toLeft ? -1 : 1) * (260 + Math.min(s.hits * 8, 170)), y: Math.random() * 180 - 90 };
    s.hits = 0;
  }, []);
  const assignRole = useCallback((next: Role) => { roleRef.current = next; setRole(next); }, []);

  const setTouchMove = useCallback((side: "host" | "guest", action: "up" | "down", down: boolean) => {
    const id = `${side}:${action}`;
    if (down) { drags.current.clear(); touchMoves.current.add(id); } else touchMoves.current.delete(id);
  }, []);
  const releaseInputs = useCallback(() => { keys.current.clear(); touchMoves.current.clear(); drags.current.clear(); }, []);

  /** Applies a room update from the server to the lobby and the network status. */
  const applyRoom = useCallback((room: RoomInfo) => {
    const both = room.players.length === 2;
    const everyoneHere = room.players.every((p) => p.connected);
    if (net.current.status !== "reconnecting") net.current.status = both && !everyoneHere ? "partner-away" : "ok";
    setLobby((l) => {
      if (room.playing) return { ...l, code: room.code, phase: "playing", notice: "LIVE" };
      if (l.phase === "playing") state.current = fresh();
      if (both) return { ...l, code: room.code, phase: "ready", notice: roleRef.current === "host" ? "Friend connected. Start when you are both ready." : "Connected. Waiting for the host to start." };
      return { ...l, code: room.code, phase: "waiting", notice: "Share this four-letter room code." };
    });
    if (!room.playing && both) announce(roleRef.current === "host" ? "FRIEND CONNECTED" : "READY", "LOBBY");
  }, [announce]);

  const joinedRoom = useCallback((reply: RoomReply) => {
    if (!reply.room || !reply.side) return;
    roomCode.current = reply.room.code;
    saveRoom(reply.room.code);
    net.current.status = "ok";
    applyRoom(reply.room);
  }, [applyRoom]);

  const connect = useCallback(() => {
    if (socket.current) return socket.current;
    // WebSocket first; long-polling only if a network blocks sockets, since
    // it adds a round trip per packet.
    const client = io(process.env.NEXT_PUBLIC_RACING_SERVER_URL ?? "http://localhost:3000", { transports: ["websocket", "polling"], reconnectionDelay: 400, reconnectionDelayMax: 2500 });
    socket.current = client;

    const ping = () => {
      const sent = Date.now();
      client.timeout(3000).emit("pong:ping", null, (err: Error | null, serverNow: number) => {
        if (err || typeof serverNow !== "number") return;
        const n = net.current;
        const now = Date.now(), rtt = now - sent, offset = serverNow + rtt / 2 - now;
        // Trust fast samples most: a slow round trip usually means one leg
        // was delayed, which skews the clock estimate.
        if (n.samples === 0) { n.offset = offset; n.rtt = rtt; }
        else { n.offset += (offset - n.offset) * (rtt <= n.rtt * 1.25 ? 0.35 : 0.08); n.rtt += (rtt - n.rtt) * 0.25; }
        n.samples++;
        setHud((h) => Math.abs(h.ping - Math.round(n.rtt)) < 4 ? h : { ...h, ping: Math.round(n.rtt) });
      });
    };
    let pinger = 0;
    client.on("connect", () => {
      window.clearInterval(pinger);
      ping(); window.setTimeout(ping, 250); window.setTimeout(ping, 600);
      pinger = window.setInterval(ping, 2000);
      if (!roomCode.current) return;
      client.emit("pong:resume", { code: roomCode.current, token: token.current }, (reply: RoomReply) => {
        if (reply.error || !reply.side) {
          roomCode.current = null; saveRoom(null); net.current = freshNet();
          assignRole("local"); state.current = fresh();
          setLobby({ ...lobbyStart, notice: reply.error ?? "That match has ended." });
          return;
        }
        assignRole(reply.side === "left" ? "host" : "guest");
        joinedRoom(reply);
      });
    });
    client.on("disconnect", () => {
      window.clearInterval(pinger);
      if (!roomCode.current) return;
      net.current.status = "reconnecting";
      setHud((h) => ({ ...h, message: "RECONNECTING…", storm: "OFFLINE" }));
    });
    client.on("connect_error", () => {
      if (roomCode.current) return;
      setLobby((l) => ({ ...l, notice: "Can’t reach the arcade server. Please try again in a moment." }));
    });
    client.on("pong:room", (room: RoomInfo) => applyRoom(room));
    client.on("pong:hostChanged", () => {
      assignRole("host");
      setLobby((l) => ({ ...l, phase: "waiting", notice: "Your friend left. Share the code to invite someone new." }));
    });
    client.on("pong:start", () => {
      const { offset, rtt, samples } = net.current;
      net.current = { ...freshNet(), offset, rtt, samples };
      state.current = fresh();
      setLobby((l) => ({ ...l, phase: "playing", notice: "LIVE" }));
      announce("SERVE INCOMING", "LIVE");
    });
    client.on("pong:s", (snap: number[]) => {
      const [t, bx, by, vx, vy, l, r, ls, rs, storm, round, winner, hold] = snap;
      const cur = net.current, s = state.current, mine = sideOf(roleRef.current);
      const ball = { x: bx, y: by }, vel = { x: vx, y: vy };
      // Bring the snapshot up to the present using the estimated one-way delay.
      const age = clamp((Date.now() + cur.offset - t) / 1000, 0, 0.25);
      const moving = Math.max(0, age - hold);
      const opponent = mine === "left" ? r : l;
      if (!cur.hasSnap) { cur.opp = opponent; if (cur.lastSentY < 0) s[mine] = mine === "left" ? l : r; }
      cur.oppTarget = opponent;
      const leftNow = mine === "left" ? s.left : cur.opp, rightNow = mine === "right" ? s.right : cur.opp;
      for (let left = moving; left > 0; left -= 1 / 120) advanceBall(ball, vel, Math.min(left, 1 / 120), leftNow, rightNow);
      if (cur.hasSnap) {
        // Keep drawing from where the ball was, and fold the difference away
        // over the next few frames. Big jumps (a point scored) snap instead.
        const ex = s.ball.x - ball.x, ey = s.ball.y - ball.y;
        cur.err = Math.hypot(ex, ey) > 90 ? { x: 0, y: 0 } : { x: ex, y: ey };
      }
      cur.ball = ball; cur.vel = vel; cur.hold = Math.max(0, hold - age); cur.hasSnap = true;
      if (cur.status === "reconnecting") cur.status = "ok";

      const stormLabel = storm ? "FILM FRENZY" : "LIVE";
      if (round !== cur.round) {
        cur.round = round; s.leftScore = ls; s.rightScore = rs; s.storm = storm ? 1 : 0;
        announce(`${winner === 1 ? "TEAL" : "BRICK"} WINS · NEW ROUND`, stormLabel);
      } else if (ls !== s.leftScore || rs !== s.rightScore) {
        const tealScored = ls > s.leftScore;
        s.leftScore = ls; s.rightScore = rs; s.storm = storm ? 1 : 0;
        announce(`${tealScored ? "TEAL" : "BRICK"} SCORES`, stormLabel);
      } else if ((s.storm > 0) !== !!storm) {
        s.storm = storm ? 1 : 0;
        announce(storm ? "FILM FRENZY · CURVES GO WILD" : "STORM PASSED", stormLabel);
      }
    });
    return client;
  }, [announce, applyRoom, assignRole, joinedRoom]);

  useEffect(() => {
    token.current = sessionToken();
    // A phone that reloaded the tab mid-match drops straight back into it.
    const code = savedRoom();
    if (!code) return;
    roomCode.current = code;
    modeRef.current = "online";
    const resume = window.setTimeout(() => {
      setMode("online");
      setLobby((l) => ({ ...l, code, phase: "waiting", notice: "Rejoining your match…" }));
      connect();
    }, 0);
    return () => window.clearTimeout(resume);
  }, [connect]);
  useEffect(() => () => { socket.current?.emit("pong:leave"); socket.current?.disconnect(); }, []);

  useEffect(() => {
    const image = new Image();
    image.src = "/pong-sprites-tech.png";
    // Cut the sprites out of the 1.5k sheet once. Drawing from small canvases
    // every frame is far cheaper than resampling the full sheet on phones.
    image.onload = () => {
      const cut = (sx: number, sy: number, sw: number, sh: number, dw: number, dh: number) => {
        const c = document.createElement("canvas"); c.width = dw * 2; c.height = dh * 2;
        c.getContext("2d")?.drawImage(image, sx, sy, sw, sh, 0, 0, dw * 2, dh * 2);
        return c;
      };
      sprites.current = { left: cut(75, 45, 320, 930, PADDLE_W, PADDLE_H), right: cut(1160, 45, 300, 930, PADDLE_W, PADDLE_H), ball: cut(620, 350, 320, 320, 46, 46), ...sprites.current };
    };
    const down = (event: KeyboardEvent) => {
      const key = keyName(event.key);
      if ((event.target as HTMLElement | null)?.tagName === "INPUT") return;
      if (["w", "s", "ArrowUp", "ArrowDown", " "].includes(key)) event.preventDefault();
      if (event.repeat) return;
      keys.current.add(key);
      drags.current.clear();
      if (modeRef.current !== "online" && key === " ") state.current.paused = !state.current.paused;
    };
    const up = (event: KeyboardEvent) => { keys.current.delete(keyName(event.key)); };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", releaseInputs);
    const onVisibilityChange = () => { if (document.hidden) releaseInputs(); };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); window.removeEventListener("blur", releaseInputs); document.removeEventListener("visibilitychange", onVisibilityChange); };
  }, [releaseInputs]);

  useEffect(() => {
    const canvas = canvasEl, ctx = canvas?.getContext("2d", { alpha: false, desynchronized: true });
    if (!canvas || !ctx) return;
    let animation = 0, last = performance.now(), elapsed = 0;
    const lastBall = { x: W / 2 };
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    // Soft glows are painted once and stamped, which is cheaper than a gradient per frame.
    const glow = (color: string) => {
      const g = document.createElement("canvas"); g.width = g.height = 128;
      const c = g.getContext("2d")!, grd = c.createRadialGradient(64, 64, 6, 64, 64, 64);
      grd.addColorStop(0, color); grd.addColorStop(1, "rgba(0,0,0,0)");
      c.fillStyle = grd; c.fillRect(0, 0, 128, 128);
      return g;
    };
    const glowCalm = glow("rgba(236,196,98,.55)"), glowStorm = glow("rgba(214,96,66,.62)");
    const ball = { angle: 0, trail: [] as { x: number; y: number }[], squash: 0, axis: 0, lastX: W / 2, lastY: H / 2, lastVy: 0, recoil: { left: 0, right: 0 } };
    const drawSprite = (sprite: HTMLCanvasElement | undefined, dx: number, dy: number, dw: number, dh: number) => {
      if (!sprite) { ctx.fillStyle = "#ffc234"; ctx.fillRect(dx, dy, dw, dh); return; }
      // Fit art inside its slot at its own proportions instead of stretching it.
      const k = Math.min(dw / sprite.width, dh / sprite.height), w = sprite.width * k, h = sprite.height * k;
      ctx.drawImage(sprite, dx + (dw - w) / 2, dy + (dh - h) / 2, w, h);
    };
    const score = (leftWon: boolean) => {
      const s = state.current;
      if (leftWon) s.leftScore++; else s.rightScore++;
      const won = (leftWon ? s.leftScore : s.rightScore) >= 11;
      announce(won ? `${leftWon ? "TEAL" : "BRICK"} WINS · NEW ROUND` : `${leftWon ? "TEAL" : "BRICK"} SCORES`);
      if (won) { s.leftScore = 0; s.rightScore = 0; }
      resetBall(!leftWon);
    };
    /** Keyboard, hold-buttons and finger drags all resolve to one paddle position. */
    const movePaddle = (side: Side, current: number, dt: number, up: boolean, downKey: boolean) => {
      let drag: number | null = null;
      for (const d of drags.current.values()) if (d.side === side) drag = d.y - PADDLE_H / 2;
      if (drag !== null) {
        const step = DRAG_SPEED * dt;
        return clamp(current + clamp(drag - current, -step, step), 0, H - PADDLE_H);
      }
      return clamp(current + ((up ? -1 : 0) + (downKey ? 1 : 0)) * SPEED * dt, 0, H - PADDLE_H);
    };
    const fx: Fx[] = [];
    const hitAt = { left: 0, right: 0 };
    let lastDir = 0;
    const draw = (overlay: string | null, you: Side | null, dt: number) => {
      const s = state.current, sp = sprites.current, now = performance.now(), t = now / 1000;
      const v = view.current, size = screenSize(v);
      const cw = Math.round(size.w * dpr), ch = Math.round(size.h * dpr);
      if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
      applyView(ctx, v, dpr);
      // A paddle return shows up as the ball changing direction near a paddle.
      const dir = Math.sign(s.ball.x - lastBall.x);
      if (dir && lastDir && dir !== lastDir && (s.ball.x < 140 || s.ball.x > W - 140)) {
        const side: Side = s.ball.x < W / 2 ? "left" : "right";
        hitAt[side] = now;
        ball.squash = 1; ball.axis = 0; ball.recoil[side] = 1;
        spawnFx(fx, { name: "fx_hit", kind: "spark", x: side === "left" ? 78 : W - 78, y: s.ball.y, size: 110, color: "#f2e8ca", life: 0.35 }, now);
      }
      if (dir) lastDir = dir;
      lastBall.x = s.ball.x;
      const court = art.get("court");
      if (court) ctx.drawImage(court, 0, 0, W, H);
      else { ctx.fillStyle = "#385954"; ctx.fillRect(0, 0, W, H); }
      ctx.strokeStyle = s.storm ? "#a44f39" : "#d9c89f"; ctx.lineWidth = 3; ctx.setLineDash([7, 11]);
      ctx.beginPath(); ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = "rgba(244,233,202,.16)";
      for (let y = 42; y < H; y += 80) ctx.fillRect(W / 2 - 3, y, 6, 40);
      if (s.storm) {
        const storm = art.loop("fx_storm", t, 8);
        if (storm) ctx.drawImage(storm, 0, 0, W, H);
        else { ctx.fillStyle = "rgba(164,79,57,.16)"; for (let x = 0; x < W; x += 45) ctx.fillRect(x + ((elapsed * 90) % 45), 0, 12, H); }
      }
      const paddle = (name: string, side: Side) => (now - hitAt[side] < 120 && art.get(`${name}_hit`)) || art.get(name) || sp?.[side];
      // A struck paddle gives a little, then springs back.
      const decay = Math.exp(-dt * 14);
      ball.recoil.left *= decay; ball.recoil.right *= decay;
      drawSprite(paddle("paddle_teal", "left"), 24 - ball.recoil.left * 7, s.left, PADDLE_W, PADDLE_H);
      drawSprite(paddle("paddle_brick", "right"), W - 76 + ball.recoil.right * 7, s.right, PADDLE_W, PADDLE_H);
      if (you) uprightText(ctx, v, dpr, "YOU", you === "left" ? 50 : W - 50, Math.max(20, (you === "left" ? s.left : s.right) - 16), "700 15px Rubik, sans-serif", "#f2e8ca");
      drawBall(s, sp?.ball, dt);
      drawFx(ctx, art, fx, now);
      if (overlay) uprightOverlay(ctx, v, dpr, [overlay]);
    };

    /**
     * The ball rolls: it spins with the distance it travels, leaves a short
     * trail, stretches a little at speed and squashes when it hits something.
     */
    const drawBall = (s: GameState, fallback: HTMLCanvasElement | undefined, dt: number) => {
      const b = s.ball, dx = b.x - ball.lastX, dy = b.y - ball.lastY, dist = Math.hypot(dx, dy);
      if (dist > 120) ball.trail = [];  // a serve reset, not motion
      ball.lastX = b.x; ball.lastY = b.y;
      const vdir = Math.sign(dy);
      if (vdir && ball.lastVy && vdir !== ball.lastVy && (b.y < 50 || b.y > H - 50)) { ball.squash = 1; ball.axis = Math.PI / 2; }
      if (vdir) ball.lastVy = vdir;
      ball.angle += (Math.min(dist, 120) / 23) * (dx >= 0 ? 1 : -1);
      ball.squash = Math.max(0, ball.squash - dt / 0.16);
      ball.trail.push({ x: b.x, y: b.y });
      if (ball.trail.length > 9) ball.trail.shift();
      const img = art.get("ball_spin_1") || art.get("ball") || fallback;
      const speed = dt > 0 && dist < 120 ? dist / dt : 0;
      if (img) ball.trail.forEach((p, i, all) => {
        if (i === all.length - 1) return;
        const k = (i + 1) / all.length, r = 23 * (0.4 + 0.6 * k);
        ctx.globalAlpha = k * k * 0.32;
        ctx.drawImage(img, p.x - r, p.y - r, r * 2, r * 2);
      });
      ctx.globalAlpha = 1;
      const g = s.storm ? glowStorm : glowCalm, gr = (s.storm ? 64 : 48) * (1 + ball.squash * 0.25);
      ctx.drawImage(g, b.x - gr, b.y - gr, gr * 2, gr * 2);
      ctx.fillStyle = "rgba(10,14,12,.26)";
      ctx.beginPath(); ctx.ellipse(b.x + 5, b.y + 8, 20, 15, 0, 0, Math.PI * 2); ctx.fill();
      const motion = dist > 0.01 ? Math.atan2(dy, dx) : 0, stretch = 1 + Math.min(speed / 700, 1) * 0.13;
      const q = ball.squash * 0.3;
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(motion); ctx.scale(stretch, 1 / stretch); ctx.rotate(-motion);
      if (q > 0) { ctx.rotate(ball.axis); ctx.scale(1 - q, 1 + q * 0.75); ctx.rotate(-ball.axis); }
      ctx.rotate(ball.angle);
      if (img) ctx.drawImage(img, -23, -23, 46, 46);
      else { ctx.fillStyle = "#f2e8ca"; ctx.beginPath(); ctx.arc(0, 0, 21, 0, Math.PI * 2); ctx.fill(); }
      ctx.restore();
    };
    const localFrame = (dt: number) => {
      const s = state.current, k = keys.current, t = touchMoves.current;
      if (s.paused) return;
      // In a CPU match the arrows steer your paddle too.
      const solo = modeRef.current === "cpu";
      s.left = movePaddle("left", s.left, dt, k.has("w") || t.has("host:up") || (solo && k.has("ArrowUp")), k.has("s") || t.has("host:down") || (solo && k.has("ArrowDown")));
      if (modeRef.current === "cpu") {
        const ai = cpu.current, cfg = PONG_CPU[difficultyRef.current], incoming = s.velocity.x > 0;
        if (incoming && !ai.incoming) ai.aim = (Math.random() * 2 - 1) * PADDLE_H * cfg.edge;
        ai.incoming = incoming;
        ai.think -= dt;
        if (ai.think <= 0) {
          ai.think = cfg.react;
          ai.target = incoming ? predictY(s.ball, s.velocity, W - 94) + (Math.random() * 2 - 1) * cfg.miss + ai.aim : H / 2 + (s.ball.y - H / 2) * 0.35;
        }
        const step = SPEED * cfg.speed * dt;
        s.right = clamp(s.right + clamp(ai.target - (s.right + PADDLE_H / 2), -step, step), 0, H - PADDLE_H);
      } else s.right = movePaddle("right", s.right, dt, k.has("ArrowUp") || t.has("guest:up"), k.has("ArrowDown") || t.has("guest:down"));
      s.ball.x += s.velocity.x * dt; s.ball.y += s.velocity.y * dt;
      if (s.ball.y < 14 || s.ball.y > H - 14) { s.velocity.y *= -1; s.ball.y = clamp(s.ball.y, 14, H - 14); }
      const leftHit = s.velocity.x < 0 && s.ball.x - 18 < 76 && s.ball.x + 18 > 24 && s.ball.y > s.left && s.ball.y < s.left + PADDLE_H;
      const rightHit = s.velocity.x > 0 && s.ball.x + 18 > W - 76 && s.ball.x - 18 < W - 24 && s.ball.y > s.right && s.ball.y < s.right + PADDLE_H;
      if (leftHit || rightHit) {
        const paddleY = leftHit ? s.left : s.right, relative = (s.ball.y - (paddleY + PADDLE_H / 2)) / (PADDLE_H / 2);
        s.velocity.x = (leftHit ? 1 : -1) * Math.min(Math.abs(s.velocity.x) + 21, 610);
        s.velocity.y += relative * 105; s.ball.x = leftHit ? 78 : W - 78; s.hits++;
        if (s.hits % 5 === 0) announce(`RALLY ×${s.hits} · BALL IS HOT`);
      }
      if (s.ball.x < -30) score(false);
      if (s.ball.x > W + 30) score(true);
      s.nextStorm -= dt;
      if (s.nextStorm <= 0) {
        s.storm = s.storm ? 0 : 5.5; s.nextStorm = s.storm ? 5.5 : 12;
        if (s.storm) { s.velocity.y *= 1.65; announce("FILM FRENZY · CURVES GO WILD", "FILM FRENZY"); } else announce("STORM PASSED");
      }
      if (s.storm) { s.storm -= dt; s.velocity.y += Math.sin(elapsed * 6) * 2.8; }
    };
    const onlineFrame = (dt: number, now: number) => {
      const s = state.current, n = net.current, k = keys.current, t = touchMoves.current;
      const mine = sideOf(roleRef.current), button = roleRef.current === "guest" ? "guest" : "host";
      // Your paddle answers instantly; the server hears where it went.
      s[mine] = movePaddle(mine, s[mine], dt, k.has("w") || k.has("ArrowUp") || t.has(`${button}:up`), k.has("s") || k.has("ArrowDown") || t.has(`${button}:down`));
      const moved = Math.abs(s[mine] - n.lastSentY) > 0.4;
      if ((moved && now - n.lastSent > 30) || now - n.lastSent > 250) {
        socket.current?.volatile.emit("pong:paddle", Math.round(s[mine] * 10) / 10);
        n.lastSent = now; n.lastSentY = s[mine];
      }
      if (!n.hasSnap) return;
      const other: Side = mine === "left" ? "right" : "left";
      n.opp += (n.oppTarget - n.opp) * (1 - Math.exp(-dt * 22));
      s[other] = n.opp;
      if (n.status === "ok") {
        if (n.hold > 0) n.hold = Math.max(0, n.hold - dt);
        else advanceBall(n.ball, n.vel, dt, s.left, s.right);
      }
      const decay = Math.exp(-dt * 11);
      n.err.x *= decay; n.err.y *= decay;
      s.ball = { x: n.ball.x + n.err.x, y: n.ball.y + n.err.y };
    };
    const frame = (now: number) => {
      // rAF timestamps can land a hair before `last` on the first frame.
      const dt = Math.max(0, Math.min((now - last) / 1000, 0.05)); last = now; elapsed += dt;
      const online = modeRef.current === "online";
      if (online) onlineFrame(dt, now); else localFrame(dt);
      const status = net.current.status;
      const overlay = online ? (status === "reconnecting" ? "RECONNECTING…" : status === "partner-away" ? "WAITING FOR PARTNER" : null) : state.current.paused ? "PAUSED" : null;
      draw(overlay, online && net.current.hold > 0 ? sideOf(roleRef.current) : null, dt);
      animation = requestAnimationFrame(frame);
    };
    animation = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(animation);
  // The online lobby temporarily removes the canvas. Re-run the renderer when
  // the game surface returns so it never keeps drawing to the old local canvas.
  }, [announce, resetBall, mode, canvasEl, art]);

  const createRoom = () => {
    assignRole("host");
    connect().emit("pong:create", { token: token.current }, (reply: RoomReply) => {
      if (reply.error) setLobby((l) => ({ ...l, notice: reply.error ?? "Could not create a room." }));
      else { joinedRoom(reply); setLobby((l) => ({ ...l, notice: "Share this code. You play TEAL." })); }
    });
  };
  const joinRoom = () => {
    assignRole("guest");
    connect().emit("pong:join", { code: lobby.joinCode, token: token.current }, (reply: RoomReply) => {
      if (reply.error) setLobby((l) => ({ ...l, notice: reply.error ?? "Could not join that room." }));
      else { assignRole(reply.side === "left" ? "host" : "guest"); joinedRoom(reply); }
    });
  };
  const copyCode = async () => {
    if (!lobby.code) return;
    try { await navigator.clipboard.writeText(lobby.code); setLobby((l) => ({ ...l, notice: "Code copied. Send it to your friend." })); }
    catch { setLobby((l) => ({ ...l, notice: `Room code: ${l.code}` })); }
  };
  const start = () => {
    if (roleRef.current !== "host") return;
    socket.current?.emit("pong:start");
  };
  const playOffline = (next: "local" | "cpu") => {
    releaseInputs(); socket.current?.emit("pong:leave"); roomCode.current = null; saveRoom(null);
    const { offset, rtt, samples } = net.current;
    assignRole("local"); modeRef.current = next; state.current = fresh(); net.current = { ...freshNet(), offset, rtt, samples }; setMode(next);
    setLobby(lobbyStart); announce(next === "cpu" ? `CPU · ${difficultyRef.current.toUpperCase()}` : "FIRST TO 11");
  };
  const local = () => playOffline(modeRef.current === "cpu" ? "cpu" : "local");
  const pickDifficulty = (d: Difficulty) => { difficultyRef.current = d; setDifficulty(d); playOffline("cpu"); };
  const online = () => {
    if (modeRef.current === "online") return;
    releaseInputs(); modeRef.current = "online"; state.current = fresh();
    setHud((h) => ({ ...h, left: 0, right: 0, message: "ONLINE LOBBY", storm: "READY" })); setMode("online");
  };

  const controlProps = (side: "host" | "guest", action: "up" | "down") => ({
    "aria-label": `${side === "host" ? "Teal" : "Brick"} paddle ${action}`,
    onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => { event.preventDefault(); capture(event.currentTarget, event.pointerId); setTouchMove(side, action, true); },
    onPointerUp: () => setTouchMove(side, action, false),
    onPointerCancel: () => setTouchMove(side, action, false),
    onLostPointerCapture: () => setTouchMove(side, action, false),
  });

  // Touch the board and drag: your paddle follows your finger. In a local
  // match each half of the board belongs to one player.
  const boardY = (event: ReactPointerEvent<HTMLCanvasElement>) =>
    pointerToBoard(view.current, event.clientX, event.clientY, event.currentTarget.getBoundingClientRect());

  /**
   * Touch buttons point the way the paddle moves on screen. In portrait the
   * paddle slides left and right; a set shown upside down for the player across
   * the table has its arrows swapped so they point the way that player sees.
   */
  const screenAction = (dir: "left" | "right", flipped: boolean): "up" | "down" => {
    let up = dir === "left" ? bottomSide === "left" : bottomSide !== "left";
    if (flipped) up = !up;
    return up ? "up" : "down";
  };
  const offline = mode !== "online";
  const padSet = (group: "host" | "guest", slot: "top" | "bottom" | "left" | "right", flipped = false) => {
    const colour = group === "host" ? "teal" : "brick";
    const buttons = portrait
      ? ([["◀", "left"], ["▶", "right"]] as const).map(([glyph, dir]) => ({ glyph, action: screenAction(dir, flipped) }))
      : [{ glyph: "▲", action: "up" as const }, { glyph: "▼", action: "down" as const }];
    return (
      <div className={`pad-set pad-set--${colour}`} data-slot={slot} data-flipped={flipped} key={group}>
        {buttons.map((b) => <button key={b.glyph} className="pad-btn" {...controlProps(group, b.action)}>{b.glyph}</button>)}
        {offline && group === "host" && <button className="pad-btn pad-btn--small" aria-label="Pause" onClick={() => { state.current.paused = !state.current.paused; }}>Ⅱ</button>}
      </div>
    );
  };
  const mySet: "host" | "guest" = mode === "online" && role === "guest" ? "guest" : "host";
  const padSets = mode === "local"
    ? [padSet("host", portrait ? "bottom" : "left"), padSet("guest", portrait ? "top" : "right", portrait)]
    : [padSet(mySet, portrait ? "bottom" : mySet === "host" ? "left" : "right")];
  const boardStyle = {
    "--board-ratio": portrait ? H / W : W / H,
    "--chrome": mode === "local" ? "300px" : "236px",
  } as React.CSSProperties;
  const boardProps = {
    onPointerDown: (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const point = boardY(event);
      const side: Side = modeRef.current === "online" ? sideOf(roleRef.current) : modeRef.current === "cpu" || point.x < W / 2 ? "left" : "right";
      capture(event.currentTarget, event.pointerId);
      drags.current.set(event.pointerId, { side, y: point.y });
    },
    onPointerMove: (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const drag = drags.current.get(event.pointerId);
      if (drag) drag.y = boardY(event).y;
    },
    onPointerUp: (event: ReactPointerEvent<HTMLCanvasElement>) => { drags.current.delete(event.pointerId); },
    onPointerCancel: (event: ReactPointerEvent<HTMLCanvasElement>) => { drags.current.delete(event.pointerId); },
  };

  const status = mode === "online" && lobby.phase === "playing" && hud.ping > 0 ? `${hud.storm} · ${hud.ping} MS` : hud.storm;
  return <><section className="game-shell">
    <div className="scoreboard"><div className="score"><strong>{hud.left}</strong><small>TEAL<br />W / S</small></div><span className="round-status">{status}<br />{hud.message}</span><div className="score score-right"><small>{mode === "cpu" ? <>CPU<br />{difficulty.toUpperCase()}</> : <>BRICK<br />↑ / ↓</>}</small><strong>{hud.right}</strong></div></div>
    <div className="mode-row"><div className="play-switch"><button className={mode === "local" ? "active" : ""} onClick={() => playOffline("local")}><span className="lbl-long">2 PLAYERS</span><span className="lbl-short">2P</span></button><button className={mode === "cpu" ? "active" : ""} onClick={() => playOffline("cpu")}><span className="lbl-long">VS CPU</span><span className="lbl-short">CPU</span></button><button className={mode === "online" ? "active" : ""} onClick={online}>ONLINE</button></div>{mode === "cpu" && <div className="difficulty" role="group" aria-label="CPU difficulty"><span>CPU</span>{(["easy", "normal", "hard"] as const).map((d) => <button key={d} className={difficulty === d ? "active" : ""} aria-pressed={difficulty === d} onClick={() => pickDifficulty(d)}>{d.toUpperCase()}</button>)}</div>}</div>
    {mode === "online" && lobby.phase !== "playing" ? <div className="online-lobby">
      <header className="lobby-intro"><b>PRIVATE MATCH</b><p>{lobby.notice}</p></header>
      <section className="room-panel"><span className="room-step">01 / HOST</span><h3>CREATE A ROOM</h3><p>Generate a private code, then send it to your opponent.</p>{role === "host" && lobby.code ? <div className="room-code"><span>YOUR ROOM CODE</span><output>{lobby.code}</output><button onClick={copyCode}>COPY CODE</button></div> : <button onClick={createRoom}>CREATE PRIVATE ROOM</button>}</section>
      <section className="room-panel"><span className="room-step">02 / GUEST</span><h3>JOIN A ROOM</h3><p>Enter the four-character code your friend sent you.</p><label><span>ROOM CODE</span><input aria-label="Four-character room code" autoComplete="off" maxLength={4} value={lobby.joinCode} onChange={(e) => setLobby((l) => ({ ...l, joinCode: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "") }))} placeholder="ABCD" /></label><button disabled={lobby.joinCode.length !== 4} onClick={joinRoom}>JOIN ROOM</button></section>
      {role === "host" && lobby.phase === "ready" && <button className="start-button" onClick={start}>FRIEND CONNECTED: START MATCH ↗</button>}
    </div> : <div className="board-wrap" style={boardStyle}>
      <canvas className="game-canvas" ref={setCanvasEl} width={W} height={H} style={{ aspectRatio: portrait ? `${H} / ${W}` : `${W} / ${H}` }} aria-label="Mangolian Pong game board" {...boardProps} />
      {padSets}
    </div>}
    <div className="game-bottom"><a className="mobile-back" href={process.env.NEXT_PUBLIC_ARCADE_URL ?? "http://localhost:3010"}>← ARCADE</a><span className="control-hint">{mode === "local" ? "KEYBOARD: W / S + ↑ / ↓ · TOUCH: DRAG ON YOUR HALF OF THE BOARD" : mode === "cpu" ? "YOU ARE TEAL · W / S OR ↑ / ↓ · OR DRAG ON THE BOARD" : role === "guest" ? "YOU ARE BRICK · W / S OR ↑ / ↓ · OR DRAG ON THE BOARD" : "YOU ARE TEAL · W / S OR ↑ / ↓ · OR DRAG ON THE BOARD"}</span><button className="mode-button" onClick={local}>↻ {mode === "cpu" ? "NEW CPU MATCH" : "NEW LOCAL MATCH"}</button></div>
  </section><section className="game-notes"><p>LOCAL / TWO FRIENDS. ONE KEYBOARD.</p><p>ONLINE / CREATE A CODE. SHARE IT. PLAY.</p><p>FILM FRENZY / EVERY 12 SECONDS THE WIND BENDS THE RALLY.</p></section></>;
}
