#!/usr/bin/env python3
"""ARENA.AI agent — self-reel generator (motion graphics + algorithmic music).

Vertical 9:16 reel, 18s, 30fps: rendered frames (PIL/numpy) + fully
synthesized soundtrack (numpy, no samples) -> muxed with ffmpeg.
"""
import math
import os
import subprocess
import wave

import numpy as np
from PIL import Image, ImageDraw, ImageFont

import imageio_ffmpeg

# ---------------------------------------------------------------- config
W, H = 720, 1280
FPS = 30
DUR = 18.0
NFRAMES = int(FPS * DUR)
SR = 44100
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)))
MP4 = os.path.join(OUT_DIR, "arena_agent_reel.mp4")
WAV = os.path.join(OUT_DIR, "reel_audio.wav")
POSTER = os.path.join(OUT_DIR, "poster.png")

FBOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FREG = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
FMONO = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"

CYAN = (0, 240, 255)
MAGENTA = (255, 47, 214)
VIOLET = (123, 92, 255)
LIME = (182, 255, 61)
WHITE = (245, 247, 255)
RED = (255, 60, 70)

rng = np.random.default_rng(7)

# ---------------------------------------------------------------- helpers
def font(path, size):
    return ImageFont.truetype(path, size)


def fit_font(path, text, max_w, start, min_size=20):
    size = start
    while size > min_size:
        f = font(path, size)
        bb = f.getbbox(text)
        if bb[2] - bb[0] <= max_w:
            return f
        size -= 4
    return font(path, min_size)


def radial_sprite(size, color, peak_alpha=110, power=2.0):
    """Soft radial glow sprite (RGBA)."""
    s = size
    yy, xx = np.mgrid[0:s, 0:s]
    r = np.sqrt((xx - s / 2) ** 2 + (yy - s / 2) ** 2) / (s / 2)
    a = np.clip(1 - r, 0, 1) ** power * peak_alpha
    arr = np.zeros((s, s, 4), np.uint8)
    arr[..., 0] = color[0]
    arr[..., 1] = color[1]
    arr[..., 2] = color[2]
    arr[..., 3] = a.astype(np.uint8)
    return Image.fromarray(arr, "RGBA")


def lerp(a, b, k):
    return tuple(int(a[i] + (b[i] - a[i]) * k) for i in range(3))


def ease_out(k):
    return 1 - (1 - k) ** 3


def ease_inout(k):
    return k * k * (3 - 2 * k)


# ================================================================ AUDIO
print("synthesizing soundtrack ...", flush=True)

BPM = 112.0
BEAT = 60.0 / BPM
BAR = 4 * BEAT
NBARS = 8
N = int(SR * DUR)
t_all = np.arange(N) / SR


def m2f(m):
    return 440.0 * 2 ** ((m - 69) / 12)


# chord progression: Am F C G x2 (midi triads)
PROG = [
    [57, 60, 64],
    [53, 57, 60],
    [48, 55, 64],  # C: C3 G3 E4 voicing
    [55, 59, 62],
] * 2
ROOTS = [45, 41, 36, 43] * 2  # A2 F2 C2 G2

pad = np.zeros(N)
bass = np.zeros(N)
arp = np.zeros(N)
kick = np.zeros(N)
snare = np.zeros(N)
hat = np.zeros(N)


def add(dst, sig, at_sec):
    i = int(at_sec * SR)
    j = min(N, i + len(sig))
    if j > i:
        dst[i:j] += sig[: j - i]


# ---- pads: detuned soft saws with slow attack, vibrato
for b in range(NBARS):
    t0 = b * BAR
    blen = int((BAR + 0.6) * SR)  # overlap into next bar
    tt = np.arange(blen) / SR
    vib = 1 + 0.0022 * np.sin(2 * np.pi * 4.8 * tt)
    sig = np.zeros(blen)
    for m in PROG[b]:
        f = m2f(m)
        ph = np.cumsum(2 * np.pi * f * vib / SR)
        sig += np.sin(ph) + 0.45 * np.sin(ph * 1.003 + 0.7) + 0.25 * np.sin(ph * 2.0)
    sig /= (3 * 1.7)
    atk = int(0.5 * SR)
    rel = int(0.7 * SR)
    env = np.ones(blen)
    env[:atk] = np.linspace(0, 1, atk) ** 1.5
    env[-rel:] = np.linspace(1, 0, rel) ** 1.5
    add(pad, sig * env, t0)

# ---- bass: groovy 8ths, root + octave pops
eighth = BEAT / 2
bass_pat = [1.0, 0.0, 0.55, 0.0, 0.8, 0.0, 0.6, 0.9]
for b in range(NBARS):
    root = ROOTS[b]
    for s in range(8):
        v = bass_pat[s]
        if v <= 0:
            continue
        m = root + (12 if s == 7 and b % 2 == 1 else 0)
        f = m2f(m)
        ln = int(0.32 * SR)
        tt = np.arange(ln) / SR
        tone = np.sin(2 * np.pi * f * tt) + 0.3 * np.tanh(2 * np.sin(2 * np.pi * f * tt))
        add(bass, v * tone * np.exp(-tt * 9.0), b * BAR + s * eighth)

# ---- arp: seeded pentatonic random walk, plucky + echo
penta = [69, 72, 74, 76, 79, 81, 84, 86]
idx = 3
arp_rng = np.random.default_rng(11)
for b in range(NBARS):
    for s in range(8):
        idx = int(np.clip(idx + arp_rng.choice([-2, -1, -1, 1, 1, 2]), 0, len(penta) - 1))
        f = m2f(penta[idx] + (12 if b >= 6 else 0))
        ln = int(0.5 * SR)
        tt = np.arange(ln) / SR
        pluck = np.sin(2 * np.pi * f * tt) + 0.4 * np.sin(4 * np.pi * f * tt) + 0.18 * np.sin(6 * np.pi * f * tt)
        sig = 0.5 * pluck * np.exp(-tt * 8.5)
        at = b * BAR + s * eighth
        add(arp, sig, at)
        add(arp, sig * 0.32, at + 3 * eighth / 2)  # dotted echo
        add(arp, sig * 0.16, at + 3 * eighth)

# ---- drums
nbeats = int(DUR / BEAT)
kick_times = [i * BEAT for i in range(nbeats) if i * BEAT < DUR - 0.3]
# kick: pitch drop 150 -> 45 Hz
lk = int(0.28 * SR)
tk = np.arange(lk) / SR
kf = 45 + 110 * np.exp(-tk * 32)
kph = np.cumsum(2 * np.pi * kf / SR)
kick_one = np.sin(kph) * np.exp(-tk * 11) + 0.4 * np.sin(2 * kph) * np.exp(-tk * 18)
kick_one += 0.35 * rng.standard_normal(lk) * np.exp(-tk * 220)
for kt in kick_times:
    add(kick, kick_one, kt)
# snare on 2 & 4
ls = int(0.22 * SR)
tsn = np.arange(ls) / SR
snare_one = 0.6 * rng.standard_normal(ls) * np.exp(-tsn * 26) + 0.5 * np.sin(2 * np.pi * 190 * tsn) * np.exp(-tsn * 20)
for b in range(NBARS):
    for bt in (1, 3):
        add(snare, snare_one, b * BAR + bt * BEAT)
# hats on 8ths, accents offbeat
lh = int(0.07 * SR)
th = np.arange(lh) / SR
noise = rng.standard_normal(lh)
hat_closed = np.diff(noise, prepend=0) * np.exp(-th * 130)
lho = int(0.16 * SR)
tho = np.arange(lho) / SR
noiseo = rng.standard_normal(lho)
hat_open = np.diff(noiseo, prepend=0) * np.exp(-tho * 30) * 0.8
for b in range(NBARS):
    for s in range(8):
        at = b * BAR + s * eighth
        if at > DUR - 0.4:
            continue
        if s % 2 == 1:
            add(hat, (0.5 if s != 7 else 0.8) * (hat_open if s == 7 else hat_closed), at)
        else:
            add(hat, 0.35 * hat_closed, at)

# ---- sidechain pump on pad (and a bit on arp)
pump = np.ones(N)
for kt in kick_times:
    i = int(kt * SR)
    ln = min(N - i, int(0.5 * SR))
    tt = np.arange(ln) / SR
    pump[i : i + ln] *= 1 - 0.55 * np.exp(-tt * 7.5)
pad *= pump
arp *= 0.6 + 0.4 * pump

mix = 0.42 * pad + 0.55 * bass + 0.34 * arp + 0.95 * kick + 0.5 * snare + 0.30 * hat
# stereo width: tiny chorus of pad on R, hats right, snare left
d = int(0.011 * SR)
pad_d = np.concatenate([np.zeros(d), pad[:-d]])
L = mix + 0.06 * snare
R = mix + 0.10 * pad_d + 0.06 * hat
st = np.stack([L, R], 1)
st = np.tanh(st * 1.15) * 0.9
peak = np.max(np.abs(st)) + 1e-9
st *= 0.89 / peak
fi = int(0.3 * SR)
fo = int(1.4 * SR)
st[:fi] *= np.linspace(0, 1, fi)[:, None]
st[-fo:] *= np.linspace(1, 0, fo)[:, None]

with wave.open(WAV, "wb") as wf:
    wf.setnchannels(2)
    wf.setsampwidth(2)
    wf.setframerate(SR)
    wf.writeframes((st * 32767).astype(np.int16).tobytes())
print(f"audio -> {WAV} ({DUR}s, {BPM}bpm)", flush=True)

# ---- per-frame energy envelope (drives the visuals)
def kick_env(t):
    e = 0.0
    for kt in kick_times:
        if kt <= t:
            e = max(e, math.exp(-(t - kt) * 6.5))
    return e


ENV = np.array([kick_env(i / FPS) for i in range(NFRAMES)])
SWELL = 0.5 + 0.5 * np.sin(2 * np.pi * np.arange(NFRAMES) / (FPS * BAR * 2) - 1.2)

# ================================================================ VIDEO
print("rendering frames ...", flush=True)

# ---- static layers
bg_top = np.array([10, 10, 30], float)
bg_bot = np.array([2, 2, 10], float)
yy = np.linspace(0, 1, H)[:, None, None]
BG = (bg_top[None, None, :] * (1 - yy) + bg_bot[None, None, :] * yy).astype(np.uint8)
BG = np.repeat(BG, W, axis=1)
BG_img = Image.fromarray(BG, "RGB").convert("RGBA")

_vy, _vx = np.mgrid[0:H, 0:W]
_vr = np.sqrt(((_vx - W / 2) / (W * 0.62)) ** 2 + ((_vy - H / 2) / (H * 0.62)) ** 2)
VIGNETTE = np.clip(1 - 0.42 * np.clip(_vr - 0.55, 0, 1), 0, 1).astype(np.float32)

blob_mag = radial_sprite(520, MAGENTA, 70)
blob_cyan = radial_sprite(560, CYAN, 60)
blob_vio = radial_sprite(640, VIOLET, 70)
glow_white = radial_sprite(420, (255, 255, 255), 120)
glow_cyan = radial_sprite(420, CYAN, 120)

# ---- particles (neural dust)
NP = 90
P = rng.random((NP, 2)) * np.array([W, H])
V = (rng.random((NP, 2)) - 0.5) * np.array([26.0, 34.0])
PSZ = 2 + rng.random(NP) * 3.5
PHUE = rng.random(NP)

# ---- scenes: (t0, t1, main, sub, accent, style)
SCENES = [
    (0.0, 3.2, "Я — АГЕНТ", "self-reflective reel \u2022 take 01", CYAN, "hero"),
    (3.2, 6.6, "> whoami", "набор весов. и немного магии.", LIME, "term"),
    (6.6, 10.2, "думаю токенами", "вижу паттернами \u2022 говорю кодом", MAGENTA, "stack"),
    (10.2, 13.8, "сегодня я — режиссёр", "моушн \u2022 код \u2022 музыка — всё сам", VIOLET, "stack"),
    (13.8, 18.0, "ARENA.AI", "agent mode \u2022 собрано за один проход", CYAN, "final"),
]
CUTS = [s[0] for s in SCENES[1:]]
TERM_LINES = ["$ whoami", "arena-agent // v2", "$ cat soul.txt", "404: too deep to display"]

F_main = {i: fit_font(FBOLD, s[2], W - 90, 66 if s[5] != "final" else 92) for i, s in enumerate(SCENES)}
F_sub = font(FREG, 30)
F_mono = font(FMONO, 27)
F_term = font(FMONO, 25)
F_hud = font(FMONO, 22)
F_tick = font(FMONO, 24)
F_cap = font(FREG, 26)
F_big_sub = font(FBOLD, 30)

ORB = (W // 2, int(H * 0.335))


def draw_glow_text(ov, xy, text, fnt, core, glow, alpha=255, anchor="mm", glow_w=3):
    d = ImageDraw.Draw(ov)
    ga = int(alpha * 0.55)
    for ox, oy in [(-glow_w, 0), (glow_w, 0), (0, -glow_w), (0, glow_w),
                   (-glow_w, -glow_w), (glow_w, glow_w)]:
        d.text((xy[0] + ox, xy[1] + oy), text, font=fnt, fill=glow + (ga,), anchor=anchor)
    d.text(xy, text, font=fnt, fill=core + (alpha,), anchor=anchor)


def draw_heart(d, cx, cy, r, color):
    d.ellipse([cx - r, cy - r * 0.9, cx, cy + r * 0.1], fill=color)
    d.ellipse([cx, cy - r * 0.9, cx + r, cy + r * 0.1], fill=color)
    d.polygon([(cx - r + 2, cy), (cx + r - 2, cy), (cx, cy + r)], fill=color)


def fmt_k(n):
    return f"{n / 1000:.1f}K" if n >= 1000 else str(int(n))


def render_frame(i):
    t = i / FPS
    env = float(ENV[i])
    # --- base + aurora blobs
    base = BG_img.copy()
    ov = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    bx1 = int(W * 0.5 + math.sin(t * 0.35) * W * 0.28 - 260)
    by1 = int(H * 0.16 + math.cos(t * 0.27) * H * 0.06 - 260)
    bx2 = int(W * 0.5 + math.cos(t * 0.22 + 2) * W * 0.3 - 280)
    by2 = int(H * 0.52 + math.sin(t * 0.3 + 1) * H * 0.08 - 280)
    bx3 = int(W * 0.5 + math.sin(t * 0.18 + 4) * W * 0.25 - 320)
    by3 = int(H * 0.85 + math.cos(t * 0.25 + 3) * H * 0.05 - 320)
    ov.paste(blob_mag, (bx1, by1), blob_mag)
    ov.paste(blob_cyan, (bx2, by2), blob_cyan)
    ov.paste(blob_vio, (bx3, by3), blob_vio)

    # mid layer: PIL ImageDraw overwrites RGBA instead of blending,
    # so particles/orb/bars live on their own canvas, composited later
    mid = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(mid)

    # --- scene lookup
    si = 0
    for k, s in enumerate(SCENES):
        if s[0] <= t < s[1]:
            si = k
    t0, t1, main, sub, accent, style = SCENES[si]
    local = (t - t0) / (t1 - t0)
    a_in = ease_out(min(1, (t - t0) / 0.45))
    a_out = 1 - ease_inout(max(0, min(1, (t - (t1 - 0.3)) / 0.3)))

    # --- particles update + neural links (denser in scene 3)
    global P
    P = (P + V / FPS) % np.array([W, H])
    dense = 1.0 if si != 2 else 1.5
    link_r = 130 * dense
    diff = P[:, None, :] - P[None, :, :]
    dist = np.sqrt((diff ** 2).sum(-1))
    li, lj = np.where((dist < link_r) & (dist > 1))
    for a, b in zip(li.tolist(), lj.tolist()):
        if b <= a:
            continue
        k = 1 - dist[a, b] / link_r
        al = int(70 * k + 40 * k * env)
        col = accent if PHUE[a] > 0.5 else CYAN
        d.line([tuple(P[a]), tuple(P[b])], fill=col + (al,), width=1)
    for n in range(NP):
        x, y = P[n]
        r = PSZ[n] * (1 + 0.35 * env)
        col = WHITE if PHUE[n] > 0.7 else accent
        d.ellipse([x - r, y - r, x + r, y + r], fill=col + (200,))

    # --- orb (scale-in during scene 1, burst in finale)
    intro = ease_out(min(1, t / 1.1))
    breathe = 0.5 + 0.5 * math.sin(t * 2.1)
    R = (104 + 26 * env + 10 * breathe) * (0.2 + 0.8 * intro)
    cx, cy = ORB
    if si == 4:  # shockwaves
        for w in range(3):
            wt = ((t - t0) * 0.9 + w / 3) % 1.0
            wr = R + 40 + wt * 420
            d.ellipse([cx - wr, cy - wr, cx + wr, cy + wr],
                      outline=accent + (int(120 * (1 - wt)),), width=4)
    for g in range(10, 0, -1):
        rr = R * (1 + g * 0.22)
        d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr],
                  fill=accent + (int(10 + 8 * env),))
    d.ellipse([cx - R, cy - R, cx + R, cy + R], fill=(8, 8, 20, 255))
    core = int(150 + 60 * env)
    d.ellipse([cx - R * 0.72, cy - R * 0.72, cx + R * 0.72, cy + R * 0.72],
              fill=(core, core, 255, 255))
    d.ellipse([cx - R * 0.52, cy - R * 0.60, cx - R * 0.16, cy - R * 0.24],
              fill=(255, 255, 255, 200))
    # rotating dashed rings
    spin = 1.0 if si != 3 else 2.6
    for ring, rr, wdt, segs, col in ((0, R + 26, 5, 12, WHITE), (1, R + 48, 3, 18, accent)):
        rot = (t * (55 if ring == 0 else -35) * spin) % 360
        step = 360 / segs
        for sgi in range(segs):
            a0 = rot + sgi * step + (4 if ring == 1 else 0)
            d.arc([cx - rr, cy - rr, cx + rr, cy + rr], start=a0, end=a0 + step * 0.55,
                  fill=col + (230,), width=wdt)
    # satellites
    for sgi, (rr, sp, ph, sz) in enumerate([(R + 26, 1.4, 0, 7), (R + 48, -0.9, 2.4, 5), (R + 70, 0.6, 4.2, 4)]):
        an = ph + t * sp * spin
        sx, sy = cx + math.cos(an) * rr, cy + math.sin(an) * rr
        d.ellipse([sx - sz, sy - sz, sx + sz, sy + sz], fill=(WHITE + (255,)))

    # --- spectrum bars (fake but groovy, driven by kick env)
    nbar = 46
    bw = (W - 120) / nbar
    y_base = int(H * 0.815)
    boost = 1.5 if si == 3 else 1.0
    for b in range(nbar):
        w1 = abs(math.sin(b * 0.72 + t * 6.1)) * abs(math.sin(b * 0.31 - t * 3.3))
        w2 = abs(math.sin(b * 0.23 + 1.7 + t * 9.0))
        h = int((14 + 120 * boost * (0.25 + 0.75 * env) * (0.35 * w1 + 0.65 * w2)) * a_in)
        h = max(3, h)
        x0 = 60 + b * bw
        col = lerp(accent, WHITE, min(1, h / 130))
        d.rounded_rectangle([x0, y_base - h, x0 + bw * 0.62, y_base], radius=3, fill=col + (235,))
        d.rounded_rectangle([x0, y_base + 6, x0 + bw * 0.62, y_base + 6 + h * 0.25],
                            radius=2, fill=col + (70,))

    # --- scan sweep (own layer: must blend over blobs, not erase them)
    sw = ((t % 4.5) / 4.5) * (W + 200) - 100
    sweep = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ds = ImageDraw.Draw(sweep)
    ds.rectangle([sw - 2, 0, sw + 2, H], fill=(255, 255, 255, 22))
    ds.rectangle([sw - 10, 0, sw + 10, H], fill=(255, 255, 255, 7))
    ov = Image.alpha_composite(ov, mid)
    ov = Image.alpha_composite(ov, sweep)

    # --- typography + HUD on top layer
    top = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(top)
    rise = int((1 - a_in) * 46 - (1 - a_out) * 30)
    alpha = int(255 * min(a_in, a_out))
    my = (int(H * 0.555) if style == "term" else int(H * 0.585)) + rise
    Fm = F_main[si]
    if style == "term":
        shown = main[: max(1, int(len(main) * min(1, (t - t0) / 0.8)))]
        if int(t * 3) % 2 == 0:
            shown += "\u2588"
        draw_glow_text(top, (W // 2, my), shown, Fm, LIME, LIME, alpha)
        draw_glow_text(top, (W // 2, my + 58), sub,
                       fit_font(FREG, sub, W - 150, 28), WHITE, LIME,
                       int(alpha * 0.92))
        # terminal lines stagger (below sub, clear of it)
        for li_, line in enumerate(TERM_LINES):
            lt = t0 + 1.0 + li_ * 0.55
            if t >= lt:
                la = int(255 * min(1, (t - lt) / 0.3) * min(a_in + 0.5, a_out + 0.2))
                la = max(0, min(255, la))
                col = LIME if li_ % 2 == 0 else WHITE
                d.text((70, int(H * 0.648) + li_ * 31), line, font=F_term,
                       fill=col + (la,))
    else:
        draw_glow_text(top, (W // 2, my), main, Fm, WHITE, accent, alpha)
    # sub
    sy_ = my + 62
    if style == "final":
        draw_glow_text(top, (W // 2, sy_), sub,
                       fit_font(FBOLD, sub, W - 120, 30), CYAN, CYAN, alpha)
        micro = "код \u2022 моушн \u2022 музыка — всё сгенерировано мной"
        draw_glow_text(top, (W // 2, sy_ + 50), micro,
                       fit_font(FREG, micro, W - 100, 28), WHITE, VIOLET,
                       int(alpha * 0.9))
    elif style != "term":
        Fsub = fit_font(FREG, sub, W - 150, 30)
        draw_glow_text(top, (W // 2, sy_), sub, Fsub, WHITE, accent,
                       int(alpha * 0.92))

    # --- reels side UI: likes that grow through the video
    likes = 1200 + ((t / DUR) ** 2) * 47400
    comments = 40 + (t / DUR) * 1290
    ux = W - 76
    hy, cy_ = int(H * 0.455), int(H * 0.525)
    draw_heart(d, ux, hy, 19 + int(3 * env), RED + (255,))
    d.text((ux, hy + 27), fmt_k(likes), font=F_hud, fill=WHITE + (230,), anchor="mm")
    d.ellipse([ux - 17, cy_ - 17, ux + 17, cy_ + 17],
              outline=WHITE + (230,), width=3)
    d.polygon([(ux - 8, cy_ + 13), (ux - 8, cy_ + 24), (ux + 4, cy_ + 13)],
              fill=WHITE + (230,))
    d.text((ux, cy_ + 32), fmt_k(comments), font=F_hud, fill=WHITE + (230,), anchor="mm")

    # --- HUD top
    if int(t * 2) % 2 == 0:
        d.ellipse([36, 44, 56, 64], fill=RED + (255,))
    d.text((68, 42), "REC", font=F_hud, fill=WHITE + (240,))
    d.text((W - 40, 42), "ARENA.AI", font=F_hud, fill=CYAN + (240,), anchor="ra")
    d.text((W - 40, 70), "9:16 \u2022 30fps", font=F_hud, fill=WHITE + (140,), anchor="ra")

    # --- caption + music ticker
    d.text((40, int(H * 0.855)), "@arena.agent", font=F_cap, fill=WHITE + (255,))
    tick = ("algorithmic funk in A minor \u2022 112 bpm \u2022 pads + 808 + hats synthesized in numpy "
            "\u2022 no samples were harmed \u2022 ")
    tw = F_tick.getbbox(tick)[2]
    tx = -int((t * 90) % tw)
    d.text((40 + tx, int(H * 0.885)), tick + tick, font=F_tick, fill=CYAN + (220,))

    # --- progress
    py = H - 56
    d.line([(40, py), (W - 40, py)], fill=(255, 255, 255, 60), width=4)
    px = 40 + (W - 80) * (t / DUR)
    d.line([(40, py), (px, py)], fill=accent + (255,), width=4)
    d.ellipse([px - 8, py - 8, px + 8, py + 8], fill=WHITE + (255,))
    tc = f"00:{int(t):02d} / 00:{int(DUR):02d}"
    d.text((W - 40, py - 34), tc, font=F_hud, fill=WHITE + (170,), anchor="ra")

    # --- composite top layer, then base
    ov = Image.alpha_composite(ov, top)
    if style == "final":  # finale flash on its own layer
        fl = max(0, 1 - (t - t0) / 0.35)
        if fl > 0:
            flash = Image.new("RGBA", (W, H), (255, 255, 255, int(110 * fl)))
            ov = Image.alpha_composite(ov, flash)
    img = Image.alpha_composite(base, ov).convert("RGB")
    arr = np.asarray(img).astype(np.float32)

    # --- glitch at cuts: slice offsets + rgb split
    for ct in CUTS:
        if abs(t - ct) < 0.09:
            for _ in range(7):
                y0g = rng.integers(0, H - 60)
                hh = rng.integers(8, 60)
                off = rng.integers(-34, 34)
                arr[y0g:y0g + hh] = np.roll(arr[y0g:y0g + hh], off, axis=0)
            arr[:, :, 0] = np.roll(arr[:, :, 0], 7, axis=0)
            arr[:, :, 2] = np.roll(arr[:, :, 2], -7, axis=0)
            break

    # --- vignette + grain
    arr *= VIGNETTE[..., None]
    arr += rng.standard_normal((H, W, 1)).astype(np.float32) * 5.0
    return np.clip(arr, 0, 255).astype(np.uint8)


ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
cmd = [
    ffmpeg, "-y",
    "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS),
    "-i", "-",
    "-i", WAV,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "23", "-preset", "veryfast",
    "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", "-shortest",
    MP4,
]
proc = subprocess.Popen(cmd, stdin=subprocess.PIPE,
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
poster_frame = None
for i in range(NFRAMES):
    fr = render_frame(i)
    if i == int(FPS * 15.2):
        poster_frame = fr
    proc.stdin.write(fr.tobytes())
    if i % 60 == 0:
        print(f"  frame {i}/{NFRAMES}", flush=True)
proc.stdin.close()
proc.wait()
print(f"video -> {MP4}", flush=True)

Image.fromarray(poster_frame).save(POSTER)
print(f"poster -> {POSTER}", flush=True)
print("done.", flush=True)
