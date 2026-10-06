"""Optional scientific figure renderer. Requires matplotlib; analysis itself is Node-only."""
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'data/cf-study/python-packages'))
os.environ.setdefault('MPLCONFIGDIR', str(ROOT / 'data/cf-study/mpl-cache'))
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np

out = ROOT / 'results/cf-study'
# 与 scripts/cf-study/core.mjs 的 FIT_MIN_Q / FIT_MAX_Q 对齐。Python 无法 import .mjs，
# 所以这里是唯一的镜像副本 —— 改拟合范围时两处必须一起改，否则图上的 x 轴会比数据窄/宽。
FIT_MIN_Q, FIT_MAX_Q = 800, 2400
summary = json.loads((out / 'summary.json').read_text(encoding='utf-8'))
rows = summary['baseline']
curves = json.loads((out / 'survival_curves.json').read_text(encoding='utf-8'))
# fit.json / smooth_fit.json 仍是产出物，但图上的曲线直接读 CSV，见下方 load_csv()。
_contest_years = sorted({datetime.fromtimestamp(c['start'], timezone.utc).year for c in summary['manifest']['contests']})
_year_span = f"{_contest_years[0]}–{_contest_years[-1]}" if _contest_years else 'year unknown'
plt.rcParams.update({'font.size': 10, 'axes.spines.top': False, 'axes.spines.right': False})
source = (f"Source: Codeforces official API | {_year_span} selected contests | empirical, Gaussian sigma=75\n"
          f"Main cohort: pre-contest rating ±100; prior rated contests ≥10. Exploratory sample; inferred start times.\n"
          f"History ledger: {len(summary['manifest'].get('historyContests', []))} official rating-change records.")
fig, axes = plt.subplots(2, 1, figsize=(12, 9), sharex=True, layout='constrained')
valid = [r for r in rows if r['t97KmSeconds'] is not None]
ax = axes[0]
ax.scatter([r['q'] for r in valid], [r['t97KmSeconds']/60 for r in valid], color='#236a92', label='Weighted KM median')
for r in valid:
    mid = r['t97KmSeconds']/60
    lo, hi = r['ciLowSeconds'], r['ciHighSeconds']
    if lo is not None and hi is not None:
        ax.vlines(r['q'], lo/60, hi/60, color='#236a92', alpha=.65)
        ax.plot([r['q']-12, r['q']+12], [lo/60]*2, color='#236a92')
        ax.plot([r['q']-12, r['q']+12], [hi/60]*2, color='#236a92')
    if r['ciStatus'] == 'upper_unbounded':
        ax.annotate('∞ CI', (r['q'], mid), xytext=(0, 8), textcoords='offset points', ha='center', fontsize=8)
    ax.annotate('n='+str(r['samples']), (r['q'],mid), xytext=(0,-15), textcoords='offset points', ha='center', fontsize=8)
ax.set(title='KM 50% solve time and 95% contest-cluster bootstrap CI', ylabel='Time since inferred start (minutes)')
ax.legend(loc='upper left')
ax.text(.01,.02,'Missing points: no data or solve CDF never reaches 50%. No finite CI from a single contest.',transform=ax.transAxes,fontsize=8)
for field,label,color in [('successP50Seconds','P50 among successful solves','#236a92'),('successP90Seconds','P90 among successful solves','#ae643a')]:
    values=[r for r in rows if r[field] is not None]
    axes[1].scatter([r['q'] for r in values],[r[field]/60 for r in values],label=label,color=color)
axes[1].set(title='Successful-solver conditional duration distribution',ylabel='Time since inferred start (minutes)',xlabel='Official problem rating')
axes[1].legend(loc='upper left')
for ax in axes:
    ax.grid(axis='y',alpha=.2)
    ax.set_xticks(range(800,2501,100))
fig.suptitle('Empirical experiment — no smoothing or monotonic constraint',fontsize=15)
fig.supxlabel(source,fontsize=9)
fig.savefig(out/'plots/empirical-summary.png',dpi=160)
fig.savefig(out/'plots/empirical-summary.svg')
plt.close(fig)

fig, ax = plt.subplots(figsize=(12,7),layout='constrained')
colors=plt.get_cmap('tab20')
for i,c in enumerate(curves):
    if c['t97KmSeconds'] is None: continue
    xs=[0]+[p['normalizedTime'] for p in c['curve']]
    ys=[0]+[p['cdf'] for p in c['curve']]
    ax.step(xs,ys,where='post',label=str(c['q']),color=colors(i%20),alpha=.85)
ax.set(xlabel='Time / weighted KM median (dimensionless)',ylabel='Cumulative solve probability',title='Empirical normalized solve distributions — no extrapolation beyond observation',xlim=(0,3),ylim=(0,1.03))
ax.axhline(.5,color='gray',linewidth=.8,linestyle='--')
ax.legend(title='Problem rating',ncols=4,loc='lower right',fontsize=9)
ax.grid(alpha=.15)
fig.supxlabel(source,fontsize=9)
fig.savefig(out/'plots/normalized-curves.png',dpi=160)
fig.savefig(out/'plots/normalized-curves.svg')
plt.close(fig)
fig, ax = plt.subplots(figsize=(12,7),layout='constrained')
for i,c in enumerate(curves):
    if c['successMedianSeconds'] is None: continue
    xs=[0]+[p['normalizedTime'] for p in c['successCurve']]
    ys=[0]+[p['cdf'] for p in c['successCurve']]
    ax.step(xs,ys,where='post',label=str(c['q']),color=colors(i%20),alpha=.85)
ax.set(xlabel='Time / successful-solver weighted median (dimensionless)',ylabel='Conditional cumulative probability among successful solves',title='Revised 97% anchor: successful-solver distributions normalized by their medians',xlim=(0,3),ylim=(0,1.03))
ax.axhline(.5,color='gray',linewidth=.8,linestyle='--')
ax.legend(title='Problem rating',ncols=4,loc='lower right',fontsize=9)
ax.grid(alpha=.15)
fig.supxlabel(source+'\nThis conditions on success; it does not measure the probability of solving.',fontsize=9)
fig.savefig(out/'plots/success-normalized-curves.png',dpi=160)
fig.savefig(out/'plots/success-normalized-curves.svg')
plt.close(fig)
main=[r for r in rows if FIT_MIN_Q <= r['q'] <= FIT_MAX_Q]
fig,axes=plt.subplots(2,1,figsize=(13,10),sharex=True,layout='constrained',gridspec_kw={'height_ratios':[2,1]})
for field,lofield,hifield,offset,label,color in [
    ('t97KmSeconds','ciLowSeconds','ciHighSeconds',-10,'A: KM 50% solve time','#236a92'),
    ('successP50Seconds','successMedianCiLowSeconds','successMedianCiHighSeconds',10,'B: median among successful solves','#ae643a')]:
    valid=[r for r in main if r[field] is not None]
    axes[0].plot([r['q']+offset for r in valid],[r[field]/60 for r in valid],marker='o',color=color,label=label,linewidth=1)
    for r in valid:
        lo,hi=r[lofield],r[hifield]
        if lo is not None and hi is not None:
            axes[0].vlines(r['q']+offset,lo/60,hi/60,color=color,alpha=.6,linewidth=2)
            axes[0].plot([r['q']+offset]*2,[lo/60,hi/60],marker='_',color=color,linestyle='none')
        elif hi is None:
            axes[0].annotate('CI unavailable / unbounded',(r['q']+offset,r[field]/60),rotation=90,fontsize=6,xytext=(2,10),textcoords='offset points')
# 曲线一律直接读脚本产出的 CSV。以前这里是手写的一遍 Nadaraya-Watson 局部常数平滑，
# 与 smooth-fit.mjs 的局部线性不是同一个估计量，图上的线和 t97_smooth.csv 对不上。
def load_csv(path):
    text = path.read_text(encoding='utf-8').strip().split('\n')
    header = text[0].split(',')
    return [dict(zip(header, line.split(','))) for line in text[1:]]
unconstrained = load_csv(out / 't97_smooth.csv')
monotone = load_csv(out / 't97_monotone.csv')
for model, color, offset, label in [('km', '#236a92', -10, 'A local-linear (unconstrained)'), ('success', '#ae643a', 10, 'B local-linear (unconstrained)')]:
    curve = [r for r in unconstrained if r['model'] == model]
    axes[0].plot([float(r['q']) + offset for r in curve], [float(r['fittedSeconds']) / 60 for r in curve],
                 color=color, linestyle=':', linewidth=1.8, label=label)
for model, color, offset, label in [('km', '#236a92', -10, 'A + isotonic (monotone)'), ('success', '#ae643a', 10, 'B + isotonic (monotone)')]:
    curve = [r for r in monotone if r['model'] == model]
    axes[0].plot([float(r['q']) + offset for r in curve], [float(r['monotoneSeconds']) / 60 for r in curve],
                 color=color, linestyle='-.', linewidth=2.4, label=label)
axes[0].set(title='Two T97 definitions on the same cohort: estimates, 95% paired contest-bootstrap CI, and monotone fits',ylabel='Minutes since inferred start')
axes[0].legend(loc='upper left')
for r in main:
    axes[0].text(r['q'],.98,'n='+str(r['samples'])+'\nc='+str(r['contests']),transform=axes[0].get_xaxis_transform(),ha='center',va='top',fontsize=8)
    if r['kmMinusSuccessMedianSeconds'] is not None:
        axes[1].scatter(r['q'],r['kmMinusSuccessMedianSeconds']/60,color='#236a92')
        lo,hi=r['differenceCiLowSeconds'],r['differenceCiHighSeconds']
        if lo is not None and hi is not None: axes[1].vlines(r['q'],lo/60,hi/60,color='#236a92',linewidth=2)
axes[1].axhline(0,color='gray',linestyle='--',linewidth=1)
axes[1].set(title='Paired difference A − B with 95% CI',ylabel='Difference (minutes)',xlabel='Official problem rating')
for ax in axes:
    ax.set_xticks(range(FIT_MIN_Q, FIT_MAX_Q + 1, 100));ax.grid(axis='y',alpha=.2)
fig.supxlabel(source+'\nn = player-problem observations; c = distinct contests. Connected points are visual guides; dotted = kernel smooth, dash-dot = same smooth after weighted isotonic regression.',fontsize=9)
fig.savefig(out/'plots/t97-comparison.png',dpi=170)
fig.savefig(out/'plots/t97-comparison.svg')
plt.close(fig)
print('Rendered empirical summaries, normalized curves, and paired T97 comparison (PNG + SVG)')
