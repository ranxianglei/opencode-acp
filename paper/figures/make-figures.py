#!/usr/bin/env python3
"""Generate all paper figures -> figures/*.png (300 dpi).

Run: /usr/bin/python3 figures/make-figures.py
Data sources (read-only):
  - figures/data/opencode-top-marathon.csv   (per-call ctx, leading OpenCode session)
  - ~/.pi/agent/sessions/--home-dog-projects-pai-acp--/2026-08-01T02-57-43-024Z_*.jsonl (leading Pi session)
  - ~/.local/share/opencode/storage/plugin/acp/ses_*.json (corpus bucket aggregation)
"""
import csv, json, glob, os
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
plt.rcParams.update({
    'font.size': 9, 'axes.titlesize': 10, 'axes.labelsize': 9,
    'figure.dpi': 300, 'savefig.dpi': 300, 'axes.grid': True, 'grid.alpha': 0.3,
    'legend.fontsize': 7.5,
})

# ---------------- Fig 1: fold layout schematic ----------------
def fig1():
    fig, ax = plt.subplots(figsize=(7.6, 4.0))
    ax.set_xlim(0, 10); ax.set_ylim(0, 4.7); ax.axis('off')
    # window frame
    ax.add_patch(FancyBboxPatch((0.2, 0.95), 9.6, 3.35, boxstyle='round,pad=0.06',
                                fc='#f7f7f7', ec='black', lw=1.3))
    ax.text(5.0, 4.42, 'model window (e.g., 1M tokens)', ha='center', fontsize=9.5, style='italic')
    # digest zone (left)
    ax.add_patch(FancyBboxPatch((0.45, 1.15), 5.3, 2.9, boxstyle='round,pad=0.04',
                                fc='#ffffff', ec='#4a7c4a', lw=1.1))
    ax.text(3.1, 3.82, 'digest blocks (each recoverable on demand)', ha='center', fontsize=8.5, color='#2d5a2d')
    # measured from the production kernel corpus (Pi host, 116 sessions w/ resident digests)
    # LEFT  (share of digest resident space): T1 92.3% / T2 7.0% / T3 <1%
    # RIGHT (ABSOLUTE original history represented, corpus total): T1 13.47M / T2 4.75M / T3 3.28M tokens
    rows = [  # (tier label, y_top, resident_frac, hist_tokens_M, color)
        ('tier-3', 3.18, 0.007, 3.28, '#7cc47c'),
        ('tier-2', 2.58, 0.070, 4.75, '#a8d5a8'),
        ('tier-1', 1.98, 0.923, 13.47, '#cfe8cf'),
    ]
    xa, wa = 1.52, 1.70   # group A: resident share (sums to 100%)
    xb, wb = 3.62, 1.70   # group B: absolute history (linear, max = 13.47M)
    hist_max = 13.47
    for lab, y, fr, hm, c in rows:
        ax.text(xa - 0.12, y + 0.21, lab, ha='right', va='center', fontsize=7.5, color='#2d5a2d')
        # group A bar (share of resident space)
        wa_v = max(wa * fr, 0.06)
        ax.add_patch(FancyBboxPatch((xa, y), wa_v, 0.42, boxstyle='round,pad=0.02', fc=c, ec='#4a7c4a', lw=0.8))
        lab_a = f'{fr*100:.0f}%' if fr >= 0.01 else '<1%'
        ax.text(xa + wa_v + 0.06, y + 0.21, lab_a, va='center', fontsize=6.8, color='#2d5a2d')
        # group B bar (absolute original tokens represented, linear scale)
        wb_v = wb * (hm / hist_max)
        ax.add_patch(FancyBboxPatch((xb, y), wb_v, 0.42, boxstyle='round,pad=0.02', fc=c, ec='#4a7c4a', lw=0.8))
        ax.text(xb + wb_v + 0.06, y + 0.21, f'{hm:.1f}M', va='center', fontsize=6.8, color='#2d5a2d')
    ax.text(xa + wa/2, 1.66, 'resident space\n(share of digest)', ha='center', fontsize=7.2, color='#2d5a2d')
    ax.text(xb + wb/2, 1.66, 'original history\nrepresented (total)', ha='center', fontsize=7.2, color='#2d5a2d')
    ax.text(3.1, 1.47, 'per-block source span (median):', ha='center', fontsize=6.8, color='#555555')
    ax.text(3.1, 1.28, '~11K \u2192 ~55K \u2192 ~204K tokens (\u22484\u20135\u00d7 per tier)', ha='center', fontsize=6.8, color='#555555')
    # recent zone (right)
    ax.add_patch(FancyBboxPatch((5.95, 1.15), 3.65, 2.9, boxstyle='round,pad=0.04',
                                fc='#eaf2fb', ec='#3b6ea5', lw=1.1))
    ax.text(7.77, 2.6, 'recent zone — verbatim\n(~50K tokens)', ha='center', fontsize=8.5, color='#274b73')
    ax.text(7.77, 1.55, 'new turns append here;\nprotected: first/last messages,\nactive work', ha='center', fontsize=7.0, color='#274b73')
    # fold arrow (bottom -> digest zone)
    ax.annotate('consumed increments since last fold\n→ folded by model judgment',
                xy=(2.9, 0.95), xytext=(2.9, 0.15), ha='center', fontsize=8,
                arrowprops=dict(arrowstyle='-|>', color='#4a7c4a', lw=1.2))
    # decompress arrow (digest -> out)
    ax.annotate('', xy=(5.9, 0.35), xytext=(4.6, 1.15),
                arrowprops=dict(arrowstyle='-|>', color='#888888', lw=1.0, linestyle='dashed'))
    ax.text(6.5, 0.28, 'decompress-to-file (on demand)', fontsize=8, color='#555555')
    fig.savefig(f'{HERE}/fig1-fold-layout.png', bbox_inches='tight'); plt.close(fig)

# ---------------- Fig 2: retention R(k) ----------------
def fig2():
    k = np.arange(0, 13)
    fig, ax = plt.subplots(figsize=(5.4, 3.5))
    ax.fill_between(k, 0.4 ** k, 0.6 ** k, color='tab:red', alpha=0.15)
    for rho, ls in [(0.4, '--'), (0.5, '-'), (0.6, '--')]:
        ax.plot(k, rho ** k, ls, color='tab:red', lw=1.0,
                label=f'threshold compaction, ρ={rho}')
    ax.axhline(1 / 8, color='tab:green', lw=2.0, label='billion-context ρ₁ ≈ 1/8 (constant)')
    ax.axhline(1 / 24, color='tab:green', lw=1.0, ls=':', label='tool-dominated blocks ~1/24')
    ax.axhline(0, color='tab:gray', lw=1.2, label='sliding window: R ≡ 0')
    ax.annotate('after 4 rounds:\nonly 3–13% remains', xy=(4, 0.13), xytext=(5.2, 0.30),
                fontsize=7.5, arrowprops=dict(arrowstyle='->', lw=0.8))
    ax.set_xlabel('compression rounds k')
    ax.set_ylabel('retention R(k)')
    ax.set_title('Information retention over rounds')
    ax.set_xlim(-0.3, 12.3); ax.set_ylim(-0.03, 1.05)
    ax.legend(loc='upper right', framealpha=0.9)
    fig.savefig(f'{HERE}/fig2-retention.png', bbox_inches='tight'); plt.close(fig)

# ---------------- Fig 3: real marathon trajectories ----------------
def fig3():
    op_x, op_y = [], []
    with open(f'{HERE}/data/opencode-top-marathon.csv') as f:
        for i, r in enumerate(csv.DictReader(f), start=1):
            c = int(r['ctx'])
            if c > 0:
                op_x.append(i); op_y.append(c / 1000)
    pi_path = glob.glob(os.path.expanduser(
        '~/.pi/agent/sessions/--home-dog-projects-pai-acp--/2026-08-01T02-57-43-024Z_*.jsonl'))[0]
    pi_x, pi_y = [], []
    idx = 0
    with open(pi_path) as f:
        for line in f:
            try:
                d = json.loads(line)
            except Exception:
                continue
            m = d.get('message', d) if isinstance(d, dict) else {}
            if not isinstance(m, dict) or m.get('role') != 'assistant':
                continue
            idx += 1
            u = m.get('usage') or {}
            c = (u.get('input') or 0) + (u.get('cacheRead') or 0)
            if c > 0:
                pi_x.append(idx); pi_y.append(c / 1000)
    fig, ax = plt.subplots(figsize=(6.6, 3.8))
    ax.plot(op_x, op_y, lw=0.6, alpha=0.85, color='tab:blue',
            label='OpenCode host · leading session · 12,049 calls (glm-5.3, 1M window)')
    ax.plot(pi_x, pi_y, lw=0.6, alpha=0.85, color='tab:orange',
            label='Pi host · leading session · 8,584 calls (1M-class window)')
    ax.axhline(204.8, color='tab:red', lw=1.0, ls='--')
    ax.annotate('204,800 ceiling (200K-class models)', xy=(11500, 204.8), xytext=(9800, 480),
                ha='center', fontsize=7.5, color='tab:red',
                arrowprops=dict(arrowstyle='->', lw=0.8, color='tab:red'))
    ax.axhline(1000, color='black', lw=1.0, ls=':')
    ax.text(len(op_x) * 0.985, 1000 + 12, '1M window', ha='right', fontsize=7.5)
    ax.set_xlabel('model calls within session')
    ax.set_ylabel('per-call context (K tokens)')
    ax.set_title('Per-call context in the two longest production sessions')
    ax.legend(loc='upper left')
    fig.savefig(f'{HERE}/fig3-marathon-trajectories.png', bbox_inches='tight'); plt.close(fig)

# ---------------- Fig 4: capacity simulation ----------------
def sim(limit, t2r, cpd=500, max_days=400):
    raw = t1 = t2 = t3 = cum = 0.0
    days, tots = [], []
    limit_day, cum_at_limit = None, None
    for day in range(1, max_days + 1):
        for _ in range(cpd):
            vis = 10000 + raw + t1 + t2 + t3
            cum += vis + 400
            raw += 9560
            if raw >= 50000:
                s_ = round(raw / 45); raw = 0.0; t1 += s_
            if t1 >= 50000:
                s_ = round(t1 / t2r); t1 = 0.0; t2 += s_
            if t2 >= 50000:
                s_ = round(t2 / 3); t2 = 0.0; t3 += s_
        days.append(day); tots.append(cum)
        if limit_day is None and 10000 + raw + t1 + t2 + t3 >= limit:
            limit_day, cum_at_limit = day, cum
    return np.array(days), np.array(tots), limit_day, cum_at_limit

def fig4():
    dA, tA, lA, cA = sim(1_000_000, 4)
    dB, tB, lB, cB = sim(400_000, 4)
    # no-fold curve (per-call resolution)
    nf_d, nf_t = [], []; raw = 0.0; cum = 0.0
    for call in range(1, 200):
        vis = 10000 + raw
        cum += vis + 400
        raw += 9560
        nf_d.append(call / 500); nf_t.append(cum)
        if vis >= 1_000_000:
            break
    fig, ax = plt.subplots(figsize=(5.8, 3.8))
    mA = dA <= lA; mB = dB <= lB
    ax.plot(nf_d, nf_t, lw=1.6, color='tab:red', label='no fold (raw accumulation)')
    ax.plot(dA[mA], tA[mA], lw=1.6, color='tab:blue', label='1M window (t₂ ratio 1/4)')
    ax.plot(dB[mB], tB[mB], lw=1.6, color='tab:green', label='400K window (t₂ ratio 1/4)')
    ax.scatter([lA], [cA], color='tab:blue', zorder=5)
    ax.annotate(f'day {lA} · {cA/1e9:.1f}B', xy=(lA, cA), xytext=(lA - 14, cA * 2.2),
                fontsize=8, color='tab:blue', arrowprops=dict(arrowstyle='->', lw=0.8))
    ax.scatter([lB], [cB], color='tab:green', zorder=5)
    ax.annotate(f'day {lB} · {cB/1e9:.1f}B', xy=(lB, cB), xytext=(lB + 10, cB / 2.2),
                fontsize=8, color='tab:green', arrowprops=dict(arrowstyle='->', lw=0.8))
    ax.scatter([nf_d[-1]], [nf_t[-1]], color='tab:red', zorder=5)
    ax.annotate(f'~{len(nf_d)} calls · {nf_t[-1]/1e6:.0f}M', xy=(nf_d[-1], nf_t[-1]),
                xytext=(4, 3e6), fontsize=8, color='tab:red',
                arrowprops=dict(arrowstyle='->', lw=0.8))
    ax.set_yscale('log')
    ax.set_xlabel('days')
    ax.set_ylabel('cumulative input tokens (log scale)')
    ax.set_title('Single-session capacity: cumulative work until the window fills')
    ax.set_xlim(0, 115)
    ax.legend(loc='lower right')
    fig.savefig(f'{HERE}/fig6-capacity-sim.png', bbox_inches='tight'); plt.close(fig)

# ---------------- Fig 5: corpus buckets ----------------
def fig5():
    rows = []
    for f in glob.glob('/home/dog/.local/share/opencode/storage/plugin/acp/ses_*.json'):
        try:
            d = json.load(open(f))
        except Exception:
            continue
        pr = len(d.get('prune', {}).get('messages', {}).get('byMessageId', {}))
        pt = d.get('stats', {}).get('totalPruneTokens', 0)
        rows.append((pr, pt))
    b = {'<100': [0, 0], '100–999': [0, 0], '≥1000': [0, 0]}
    for pr, pt in rows:
        k = '<100' if pr < 100 else ('100–999' if pr < 1000 else '≥1000')
        b[k][0] += 1; b[k][1] += pt
    N = len(rows); T = sum(v[1] for v in b.values())
    labels = [f'{k}\n({v[0]:,} sessions)' for k, v in b.items()]
    sess_pct = [100 * v[0] / N for v in b.values()]
    tok_pct = [100 * v[1] / T for v in b.values()]
    x = np.arange(3); w = 0.38
    fig, ax = plt.subplots(figsize=(5.6, 3.6))
    ax.bar(x - w / 2, sess_pct, w, color='#9ecae1', label='share of sessions')
    ax.bar(x + w / 2, tok_pct, w, color='#fc8d59', label='share of compressed tokens')
    for xi, (sp, tp) in enumerate(zip(sess_pct, tok_pct)):
        ax.text(xi - w / 2, sp + 1, f'{sp:.1f}%', ha='center', fontsize=7.5)
        ax.text(xi + w / 2, tp + 1, f'{tp:.1f}%', ha='center', fontsize=7.5)
    ax.set_xticks(x, labels)
    ax.set_ylabel('% of total')
    ax.set_title('Where compression lives (pruned-message buckets, 4,843 sessions)')
    ax.set_ylim(0, 108)
    ax.legend()
    fig.savefig(f'{HERE}/fig5-corpus-buckets.png', bbox_inches='tight'); plt.close(fig)

# ---------------- Fig 6: cache stratification ----------------
def fig6():
    gaps = ['<2 min', '2–10 min', '10–60 min', '>60 min']
    share = [94.2, 70.2, 43.7, 9.1]
    fig, ax = plt.subplots(figsize=(5.4, 3.4))
    bars = ax.bar(gaps, share, color=['#4a7c4a', '#7cc47c', '#a8d5a8', '#d5e8d5'], edgecolor='#2d5a2d', lw=0.8)
    for xi, v in enumerate(share):
        ax.text(xi, v + 1.5, f'{v}%', ha='center', fontsize=8.5)
    ax.annotate('89% of traffic', xy=(0, 94.2), xytext=(0.55, 88), fontsize=8,
                arrowprops=dict(arrowstyle='->', lw=0.8))
    ax.set_ylabel('cache-read share (%)')
    ax.set_title('Cache-read share by inter-call gap (08-20 snapshot)')
    ax.set_ylim(0, 105)
    fig.savefig(f'{HERE}/fig4-cache-stratification.png', bbox_inches='tight'); plt.close(fig)

if __name__ == '__main__':
    for fn in (fig1, fig2, fig3, fig4, fig5, fig6):
        fn(); print('wrote', fn.__name__)
