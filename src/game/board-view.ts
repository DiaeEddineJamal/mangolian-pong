"use client";
/**
 * SHARED FILE: turns a landscape game board upright on phones held in portrait.
 * Canonical copy lives in /shared; `npm run sync:cores` copies it into each game.
 *
 * The game keeps simulating in its own landscape coordinates (W x H). Only
 * drawing and input are rotated a quarter turn, so the board fills a tall
 * screen instead of a thin strip across it. `bottom` picks which end of the
 * landscape board lands at the bottom of the phone: your own side.
 *
 *   landscape: screen = (x, y)
 *   bottom "left":  screen = (y, W - x)      the left edge sits at the bottom
 *   bottom "right": screen = (H - y, x)      the right edge sits at the bottom
 */
import { useEffect, useState } from "react";

export type Side = "left" | "right";
export type BoardView = { portrait: boolean; bottom: Side; W: number; H: number };

const QUERY = "(orientation: portrait) and (max-width: 900px)";

/** True while the screen is a portrait phone or small tablet. */
export function usePortrait() {
  const [portrait, setPortrait] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(QUERY);
    const sync = () => setPortrait(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return portrait;
}

/** Size of the board as it appears on screen, in board units. */
export const screenSize = (v: BoardView) => (v.portrait ? { w: v.H, h: v.W } : { w: v.W, h: v.H });

/** Sets the canvas transform so drawing in board coordinates lands rotated and crisp. */
export function applyView(ctx: CanvasRenderingContext2D, v: BoardView, dpr: number) {
  if (!v.portrait) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  else if (v.bottom === "left") ctx.setTransform(0, -dpr, dpr, 0, 0, v.W * dpr);
  else ctx.setTransform(0, dpr, -dpr, 0, v.H * dpr, 0);
}

/** Board point to screen point (board units, before device pixels). */
export function toScreen(v: BoardView, x: number, y: number) {
  if (!v.portrait) return { x, y };
  return v.bottom === "left" ? { x: y, y: v.W - x } : { x: v.H - y, y: x };
}

/** A pointer on the canvas element to a board point. */
export function pointerToBoard(v: BoardView, clientX: number, clientY: number, rect: DOMRect) {
  const s = screenSize(v);
  const sx = ((clientX - rect.left) * s.w) / rect.width, sy = ((clientY - rect.top) * s.h) / rect.height;
  if (!v.portrait) return { x: sx, y: sy };
  return v.bottom === "left" ? { x: v.W - sy, y: sx } : { x: sy, y: v.H - sx };
}

/** A direction on screen (a thumbstick, a swipe) to a direction on the board. */
export function screenDirToBoard(v: BoardView, dx: number, dy: number) {
  if (!v.portrait) return { x: dx, y: dy };
  return v.bottom === "left" ? { x: -dy, y: dx } : { x: dy, y: -dx };
}

/**
 * Draws text upright at a board point, whatever the rotation, then puts the
 * board transform back. Use it for labels and banners.
 */
export function uprightText(ctx: CanvasRenderingContext2D, v: BoardView, dpr: number, text: string, x: number, y: number, font: string, color: string) {
  const p = toScreen(v, x, y);
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = font; ctx.fillStyle = color; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(text, p.x, p.y);
  ctx.restore();
}

/** Full-board dim overlay with a centred upright message (one or more lines). */
export function uprightOverlay(ctx: CanvasRenderingContext2D, v: BoardView, dpr: number, lines: string[], color = "#f2e8ca") {
  const s = screenSize(v);
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "rgba(32,27,22,.78)"; ctx.fillRect(0, 0, s.w, s.h);
  ctx.fillStyle = color; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  // Scale the banner to whichever side of the screen is shorter.
  const big = Math.round(Math.min(44, s.w / 12));
  lines.forEach((line, i) => {
    ctx.font = i === 0 ? `${big}px Bungee, sans-serif` : `700 ${Math.round(big * 0.46)}px Rubik, sans-serif`;
    ctx.fillText(line, s.w / 2, s.h / 2 + (i - (lines.length - 1) / 2) * big * 1.1);
  });
  ctx.restore();
}
