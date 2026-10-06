"""Preview only: refit seven rounded T97 representatives and extrapolate to 3500.

Does not update the production curve. Requires the study's numpy/matplotlib runtime.
Run with --out PATH to choose an output directory.
"""
import argparse
import csv
import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'data/cf-study/python-packages'))
os.environ.setdefault('MPLCONFIGDIR', str(Path(tempfile.gettempdir()) / 't97-preview-mpl'))
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib import font_manager

Q = np.arange(800, 2001, 200, dtype=float)
Y = np.array([20.62, 31.12, 37.26, 38.88, 39.75, 42.14, 44.54])
KINDS = ('saturation_linear', 'saturation', 'log')
NAMES = {'saturation_linear': '主候选：指数趋缓 + 线性增长',
         'saturation': '对照：指数趋于平台', 'log': '对照：对数增长'}


def matrix(q, kind, h):
    q = np.asarray(q, dtype=float)
    z = (q - 800) / 1000
    if kind == 'log':
        return np.column_stack([np.ones_like(z), np.log(q / 800)])
    saturation = -np.expm1(-z / h)
    if kind == 'saturation':
        return np.column_stack([np.ones_like(z), saturation])
    return np.column_stack([np.ones_like(z), z, saturation])


def fit(q, y, kind):
    def at(log_h):
        h = float(np.exp(log_h))
        x = matrix(q, kind, h)
        beta = np.linalg.lstsq(x, y, rcond=None)[0]
        # All candidates are nondecreasing for q >= 800.
        loss = float(np.mean((x @ beta - y) ** 2)) if np.all(beta[1:] >= 0) else float('inf')
        return loss, h, beta

    if kind == 'log':
        loss, h, beta = at(0)
    else:
        grid = np.linspace(np.log(.03), np.log(50), 1200)
        scores = [at(v)[0] for v in grid]
        i = int(np.argmin(scores))
        left, right = grid[max(0, i - 1)], grid[min(len(grid) - 1, i + 1)]
        # Profile one nonlinear scale; solve the remaining coefficients exactly by least squares.
        fraction = (np.sqrt(5) - 1) / 2
        for _ in range(65):
            c, d = right - fraction * (right-left), left + fraction * (right-left)
            if at(c)[0] <= at(d)[0]:
                right = d
            else:
                left = c
        loss, h, beta = at((left + right) / 2)
    if not np.isfinite(loss):
        raise ValueError('No admissible fit')
    return {'kind': kind, 'name': NAMES[kind], 'h': h, 'beta': beta.tolist(),
            'mse_minutes_squared': loss, 'rmse_minutes': float(np.sqrt(loss))}


def predict(model, q):
    return matrix(q, model['kind'], model['h']) @ np.array(model['beta'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, default=ROOT / 'results/cf-study-preview3500')
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    models = [fit(Q, Y, kind) for kind in KINDS]
    grid = np.arange(800, 3501, 5)
    for model in models:
        values = predict(model, grid)
        assert np.all(np.isfinite(values)) and np.all(values > 0)
        assert np.all(np.diff(values) >= -1e-10)
        residual = predict(model, Q) - Y
        assert abs(np.mean(residual**2) - model['mse_minutes_squared']) < 1e-10
        model['predictions_minutes'] = {str(q): float(predict(model, [q])[0]) for q in (2000, 2500, 3000, 3500)}
    main_fit = models[0]
    baseline, slope, gain = main_fit['beta']
    scale = main_fit['h'] * 1000
    formula = f'T97(q) = {baseline:.6f} + {slope/1000:.9f}(q-800) + {gain:.6f}[1-exp(-(q-800)/{scale:.6f})]'
    result = {
        'kind': 'illustrative_refit_and_extrapolation',
        'source': 'Seven rounded representative values from the conversation; these are earlier fitted estimates, not raw observations.',
        'input_points': [{'q': int(q), 'minutes': float(y)} for q, y in zip(Q, Y)],
        'fit_domain': [800, 2000], 'preview_domain': [800, 3500],
        'selection': 'Main candidate chosen for smooth, monotone growth with an initially decaying slope and a positive long-run slope. Comparison families are illustrative, not exhaustive.',
        'weighting': 'Equal weights for the seven supplied points; no other ratings used.',
        'scale_search_domain_ratings': [30, 50000],
        'main_formula_minutes': formula,
        'warning': 'Above 2000 is unvalidated extrapolation. Training MSE measures reproduction of seven fitted anchors, not accuracy on real solve times. Model spread is not a confidence interval.',
        'production_curve_changed': False,
        'models': models,
    }
    (args.out / 'fit.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    with (args.out / 'curve.csv').open('w', newline='', encoding='utf-8-sig') as f:
        writer = csv.writer(f)
        writer.writerow(['problem_rating', 'region', *[m['kind'] + '_minutes' for m in models]])
        for q in range(800, 3501, 25):
            writer.writerow([q, 'extrapolation' if q > 2000 else 'fit', *[round(float(predict(m, [q])[0]), 6) for m in models]])

    font = Path('C:/Windows/Fonts/msyh.ttc')
    if font.exists():
        font_manager.fontManager.addfont(str(font))
        plt.rcParams['font.family'] = font_manager.FontProperties(fname=str(font)).get_name()
    plt.rcParams.update({'font.size': 11, 'axes.unicode_minus': False,
                         'axes.spines.top': False, 'axes.spines.right': False,
                         'svg.fonttype': 'path'})
    fig, ax = plt.subplots(figsize=(12, 7.5), dpi=170)
    fig.subplots_adjust(left=.085, right=.96, top=.84, bottom=.22)
    fig.text(.085, .94, '题目难度与 T97：从 7 个代表值外推到 3500', fontsize=20, weight='bold')
    fig.text(.085, .885, f'主候选训练 RMSE {main_fit["rmse_minutes"]:.2f} 分钟  ·  MSE {main_fit["mse_minutes_squared"]:.3f} 分钟²  ·  仅用于预览', color='#52606d')
    ax.axvspan(2000, 3500, color='#f1f3f5', zorder=0)
    ax.axvline(2000, color='#9aa3ad', linewidth=1)
    ax.text(2040, 60.3, '外推区域（没有用于拟合的数据）', fontsize=10, color='#52606d')
    colors = ['#146b80', '#919ba5', '#9a7150']
    for model, color in zip(models[1:], colors[1:]):
        ax.plot(grid, predict(model, grid), color=color, linewidth=1.5, alpha=.9, label=model['name'])
    fitted, extended = grid[grid <= 2000], grid[grid >= 2000]
    ax.plot(fitted, predict(main_fit, fitted), color=colors[0], linewidth=2.8, label=NAMES['saturation_linear'])
    ax.plot(extended, predict(main_fit, extended), color=colors[0], linewidth=2.8, linestyle=(0, (5, 3)), label='主候选的外推段')
    ax.scatter(Q, Y, s=49, facecolor='#ffffff', edgecolor='#152b3c', linewidth=1.6, zorder=5, label='用于拟合的 7 个代表值')
    for q, y in zip(Q, Y):
        ax.annotate(f'{y:.2f}', (q, y), xytext=(0, -18 if q in (1400, 1800, 2000) else 10), textcoords='offset points', ha='center', fontsize=9)
    for q in (2500, 3000, 3500):
        y = float(predict(main_fit, [q])[0])
        ax.scatter([q], [y], color=colors[0], s=22, zorder=4)
        ax.annotate(f'{y:.2f} 分', (q, y), xytext=(-6 if q == 3500 else 0, 10), textcoords='offset points', ha='right' if q == 3500 else 'center', color=colors[0], fontsize=10)
    ax.set(xlim=(750, 3550), ylim=(17, 63), xlabel='Codeforces 题目难度（Rating）', ylabel='T97（分钟）')
    ax.set_xticks([800, 1000, 1200, 1400, 1600, 1800, 2000, 2500, 3000, 3500])
    ax.grid(axis='y', color='#dce1e5', linewidth=.6)
    ax.set_axisbelow(True)
    handles, labels = ax.get_legend_handles_labels()
    order = [2, 3, 4, 0, 1]
    ax.legend([handles[i] for i in order], [labels[i] for i in order], loc='lower right', fontsize=9, frameon=False)
    fig.text(.085, .115, '来源：对话中 800、1000、1200、1400、1600、1800、2000 的 T97 代表值；各点等权。', fontsize=10, color='#52606d')
    fig.text(.085, .073, '这些点本身是旧曲线的拟合值。2000 以上仅为函数外推，对照曲线的差异不是置信区间。', fontsize=10, color='#52606d')
    fig.text(.085, .031, '当前预览未修改生产评分曲线。', fontsize=10, color='#52606d')
    for suffix in ('png', 'svg'):
        fig.savefig(args.out / f't97-preview-3500.{suffix}', facecolor='white')
    plt.close(fig)
    print(json.dumps({'formula': formula, 'main_fit': main_fit, 'output': str(args.out)}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
