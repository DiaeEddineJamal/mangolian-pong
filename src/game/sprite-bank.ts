"use client";
/**
 * SHARED FILE: optional art and animation for every game. Canonical copy
 * lives in /shared; `npm run sync:cores` copies it into each game.
 *
 * Each game's page lists the PNGs in its public/sprites folder and hands the
 * list to the game, so only files that exist are ever requested. Singles are
 * named `thing.png`; animations are numbered frames, `thing_1.png`,
 * `thing_2.png`, ... Images are downscaled once on load so drawing stays cheap
 * on phones. Teal art gets a brick twin by recolouring when the brick file
 * is missing, so only one colour has to be generated.
 */

type Img = HTMLCanvasElement;
export type SpriteBank = {
  /** Increments whenever an image finishes loading; lets cached layers repaint. */
  version: () => number;
  get: (name: string) => Img | undefined;
  frames: (name: string) => Img[];
  /** A looping frame for time `seconds` at `fps`, or undefined without art. */
  loop: (name: string, seconds: number, fps: number) => Img | undefined;
  /** A one-shot frame at `seconds` since it began, or undefined when finished/missing. */
  once: (name: string, seconds: number, fps: number) => Img | undefined | null;
  has: (name: string) => boolean;
};

/** Longest side kept in memory, from how large each kind of art is drawn (2x screens included). */
const maxSide = (name: string) =>
  /^(court|table_surface|fx_storm)/.test(name) ? 1920
  : /^fx_goal/.test(name) ? 512
  : /^paddle_/.test(name) ? 320
  : 256;

function rgbToHsl(r: number, g: number, b: number) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min, s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
function hslToRgb(h: number, s: number, l: number) {
  const k = (n: number) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

/** Turns the teal parts of an image brick red, leaving creams, inks and golds alone. */
function tealToBrick(src: Img): Img {
  const c = document.createElement("canvas");
  c.width = src.width; c.height = src.height;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(src, 0, 0);
  const data = ctx.getImageData(0, 0, c.width, c.height);
  const px = data.data;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue;
    const [h, s, l] = rgbToHsl(px[i], px[i + 1], px[i + 2]);
    if (s < 0.12 || h < 140 || h > 220) continue;
    const [r, g, b] = hslToRgb(12 + (h - 180) * 0.15, Math.min(1, s * 1.35), l * 0.95);
    px[i] = r; px[i + 1] = g; px[i + 2] = b;
  }
  ctx.putImageData(data, 0, 0);
  return c;
}

function downscale(img: HTMLImageElement, limit: number): Img {
  const k = Math.min(1, limit / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(img.naturalWidth * k));
  c.height = Math.max(1, Math.round(img.naturalHeight * k));
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

export function createSpriteBank(files: string[], dir = "/sprites/"): SpriteBank {
  const images = new Map<string, Img>();
  const present = new Set(files.map((f) => f.replace(/\.png$/i, "")));
  let version = 0;
  const frameCache = new Map<string, { v: number; list: Img[] }>();

  if (typeof window !== "undefined") {
    for (const name of present) {
      const img = new Image();
      img.onload = () => {
        const art = downscale(img, maxSide(name));
        images.set(name, art);
        // Brick twins for teal art the folder doesn't have a brick version of.
        if (name.includes("teal")) {
          const twin = name.replace("teal", "brick");
          if (!present.has(twin)) images.set(twin, tealToBrick(art));
        }
        version++;
      };
      img.src = `${dir}${name}.png`;
    }
  }

  const frames = (name: string) => {
    const hit = frameCache.get(name);
    if (hit && hit.v === version) return hit.list;
    const list: Img[] = [];
    for (let i = 1; i < 32; i++) {
      const img = images.get(`${name}_${i}`);
      if (!img) break;
      list.push(img);
    }
    frameCache.set(name, { v: version, list });
    return list;
  };

  return {
    version: () => version,
    get: (name) => images.get(name),
    frames,
    has: (name) => images.has(name) || frames(name).length > 0,
    loop: (name, seconds, fps) => {
      const list = frames(name);
      return list.length ? list[Math.floor(seconds * fps) % list.length] : undefined;
    },
    once: (name, seconds, fps) => {
      const list = frames(name);
      if (!list.length) return undefined;
      const i = Math.floor(seconds * fps);
      return i < list.length ? list[i] : null;
    },
  };
}

// --- One-shot effects ----------------------------------------------------------
// Hits, goals and serves spawn a short effect. With frames in the bank the
// frames play; without them a small drawn version plays instead.

export type FxKind = "spark" | "burst" | "ring";
export type Fx = { name: string; kind: FxKind; x: number; y: number; size: number; color: string; born: number; life: number };

export function spawnFx(list: Fx[], fx: Omit<Fx, "born">, now: number) {
  list.push({ ...fx, born: now });
  if (list.length > 24) list.shift();
}

export function drawFx(ctx: CanvasRenderingContext2D, bank: SpriteBank, list: Fx[], now: number) {
  for (let i = list.length - 1; i >= 0; i--) {
    const fx = list[i], age = (now - fx.born) / 1000;
    const art = bank.once(fx.name, age, 14);
    if (art === null || (art === undefined && age > fx.life)) { list.splice(i, 1); continue; }
    if (art) { ctx.drawImage(art, fx.x - fx.size / 2, fx.y - fx.size / 2, fx.size, fx.size); continue; }
    const t = age / fx.life, fade = 1 - t;
    ctx.save();
    ctx.globalAlpha = fade;
    ctx.strokeStyle = fx.color; ctx.fillStyle = fx.color;
    if (fx.kind === "ring" || fx.kind === "burst") {
      ctx.lineWidth = fx.kind === "burst" ? 8 * fade + 2 : 4 * fade + 1;
      ctx.beginPath(); ctx.arc(fx.x, fx.y, fx.size * 0.2 + fx.size * 0.5 * t, 0, Math.PI * 2); ctx.stroke();
    }
    if (fx.kind === "spark" || fx.kind === "burst") {
      const rays = fx.kind === "burst" ? 12 : 7;
      for (let r = 0; r < rays; r++) {
        const a = (r / rays) * Math.PI * 2 + fx.born, d0 = fx.size * 0.15 + fx.size * 0.35 * t, d1 = d0 + fx.size * 0.14 * fade;
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(fx.x + Math.cos(a) * d0, fx.y + Math.sin(a) * d0); ctx.lineTo(fx.x + Math.cos(a) * d1, fx.y + Math.sin(a) * d1); ctx.stroke();
      }
    }
    ctx.restore();
  }
}

