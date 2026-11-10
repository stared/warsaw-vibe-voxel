# /// script
# dependencies = ["pandas"]
# ///
"""Performance and usage of the live site, from the PostHog events web/index.html and web/src/stats.ts send.

uv run scripts/perf_stats.py [days]           report on real visitors (bots listed, then dropped)
uv run scripts/perf_stats.py [days] --pages   also write data/perf_pages.csv, one row per page view
uv run scripts/perf_stats.py -q "SELECT ..."  any HogQL query

Keys in data/.env: POSTHOG_PERSONAL_API_KEY (query:read), POSTHOG_PROJECT_ID.
"""
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).parent.parent
ENV = dict(l.split('=', 1) for l in (ROOT / 'data/.env').read_text().split() if '=' in l)
ACTIONS = ['mode', 'label', 'search', 'weather', 'date', 'hour', 'river']


def query(sql):
    req = urllib.request.Request(
        f"https://eu.posthog.com/api/projects/{ENV['POSTHOG_PROJECT_ID']}/query/",
        data=json.dumps({'query': {'kind': 'HogQLQuery', 'query': sql}}).encode(),
        headers={'Authorization': f"Bearer {ENV['POSTHOG_PERSONAL_API_KEY']}", 'Content-Type': 'application/json'})
    try:
        r = json.load(urllib.request.urlopen(req, timeout=300))
    except urllib.error.HTTPError as e:
        sys.exit(f'{e.code}: {e.read().decode()[:500]}')
    return r['columns'], r['results']


def events(days):
    _, rows = query(f"SELECT event, timestamp, properties FROM events WHERE timestamp > now() - INTERVAL {days} DAY "
                    "AND properties.pid IS NOT NULL ORDER BY timestamp LIMIT 100000")
    ev = pd.DataFrame([{'event': e, 'ts': t, **json.loads(p)} for e, t, p in rows])
    for c in ['t', 'share', 'median', 'p95', 'worst', 'slow', 'frames', 'late', 'heap', 'ratio', 'seconds', 'first', 'level']:
        if c in ev: ev[c] = pd.to_numeric(ev[c], errors='coerce')
    return ev


def has(ev, name, where=None):
    e = ev[ev.event == name]
    if where is not None: e = e[where(e)]
    return e.pid.unique()


def pages(ev):
    def first(col, name=None):
        e = ev[ev.event == name] if name else ev
        return e.dropna(subset=[col]).groupby('pid')[col].first() if col in e else None
    P = pd.DataFrame(index=pd.Index(has(ev, 'open'), name='pid'))
    for c in ['build', 'engine', 'gpu', 'cores', 'memory']: P[c] = first(c)
    for c in ['width', 'height', 'dpr', 'connection']: P[c] = first(c, 'open')
    for c in ['$browser', '$os', '$device_type', '$timezone', '$referring_domain']: P[c[1:]] = first(c, '$pageview')
    P['opened'] = ev.groupby('pid').ts.min()
    P['last_t'] = ev.groupby('pid').t.max()
    P['loaded_s'] = first('seconds', 'loaded')
    P['loaded'] = P.loaded_s.notna()
    msg = lambda pat: (lambda e: e.message.fillna('').str.contains(pat, case=False))
    for col, name, where in [('crashed', 'crashed', None), ('blank', 'blank', None), ('ctxlost', 'contextlost', None),
                             ('webgl_fail', 'error', msg('WebGL context')), ('oom', 'error', msg('allocation failed|out of memory'))]:
        P[col] = P.index.isin(has(ev, name, where))
    P['errors'] = ev[ev.event == 'error'].groupby('pid').size().reindex(P.index).fillna(0)
    P['actions'] = ev[ev.event.isin(ACTIONS)].groupby('pid').size().reindex(P.index).fillna(0)

    pu = ev[ev.event == 'pulse']
    ready = pu[(pu.phase == 'ready') & (pu.frames > 20)]
    w = lambda d, c: np.average(d[c], weights=d.frames)
    P = P.join(ready.groupby('pid').apply(lambda d: pd.Series({
        'frame_ms': w(d, 'median'), 'frame_p95_ms': w(d, 'p95'), 'slow_share': d.slow.sum() / d.frames.sum(),
        'ratio_first': d.ratio.iloc[0], 'ratio_last': d.ratio.iloc[-1], 'heap_max': d.heap.max()}), include_groups=False))
    P['fps'] = 1000 / P.frame_ms
    P['mpx'] = P.width * P.height * P.ratio_last.fillna(P.dpr.clip(upper=2)) ** 2 / 1e6
    loading = pu[pu.phase == 'loading']
    P['last_stage'] = loading.groupby('pid').stage.last()
    P['early_frame_ms'] = pu[(pu.t < 15) & (pu.frames > 0)].groupby('pid')['median'].median()
    P['device'] = np.where(P.device_type.isin(['Mobile', 'Tablet']), 'phone', 'computer')
    P['level_last'] = pu.dropna(subset=['level']).groupby('pid')['level'].last() if 'level' in pu else np.nan
    P['tier'] = P.apply(tier, axis=1)
    P['bot'] = bots(P)
    return P


def tier(r):
    g = r.gpu if isinstance(r.gpu, str) else ''
    if r.device_type in ('Mobile', 'Tablet'): return 'phone or tablet'
    if not g: return 'no renderer'
    if 'Basic Render' in g or 'SwiftShader' in g: return 'no GPU (software)'
    if 'Apple M' in g: return 'Apple M Pro/Max' if any(k in g for k in ['Pro', 'Max', 'Ultra']) else 'Apple M base'
    if g == 'Apple GPU': return 'Mac Safari (chip hidden)'
    for k, name in [('NVIDIA', 'NVIDIA'), ('GeForce', 'NVIDIA'), ('Radeon', 'AMD'), ('AMD', 'AMD'), ('Intel', 'Intel')]:
        if k in g: return name
    return 'other'


def bots(P):
    g = P.gpu.fillna('')
    no_info = P.os.isna()
    return pd.Series(np.select([
        g.str.contains('SwiftShader'),
        g.str.contains('D3D11') & ~g.str.contains(r'\(0x') & (P.browser.fillna('Chrome') != 'Firefox'),
        g.str.contains('Direct3D') & (P.os == 'Mac OS X'),
        (P.os == 'Linux') & (P.timezone == 'UTC'),
        no_info & (P.early_frame_ms > 400),
        no_info & P.webgl_fail,
        no_info & P.gpu.isna(),
    ], ['headless (SwiftShader)', 'spoofed GPU string', 'spoofed GPU string', 'headless (UTC Linux)',
        'starved VM', 'no WebGL, no browser info', 'died at once, nothing known'], default=''), index=P.index)


def q(k):
    f = lambda s: s.quantile(k)
    f.__name__ = f'p{int(k * 100)}'
    return f


def table(P, by, min_pages=3):
    t = P.groupby(by, observed=True).agg(
        pages=('loaded', 'size'), loaded=('loaded', 'mean'),
        load_p50=('loaded_s', 'median'), load_p75=('loaded_s', q(.75)), load_p90=('loaded_s', q(.9)),
        fps_p50=('fps', 'median'), fps_p10=('fps', q(.1)),
        p95ms_p50=('frame_p95_ms', 'median'), p95ms_p90=('frame_p95_ms', q(.9)),
        slow=('slow_share', 'median'), crashed=('crashed', 'mean'), webgl_fail=('webgl_fail', 'mean'), blank=('blank', 'mean'),
        stay_p50=('last_t', 'median'), stay_p90=('last_t', q(.9)), actions=('actions', 'mean'))
    t = t[t.pages >= min_pages].sort_values('pages', ascending=False)
    for c in t:
        if c != 'pages': t[c] = t[c].round(2 if t[c].max() <= 1 else 1 if c == 'actions' else 0)
    return t


def show(title, df):
    print(f'\n## {title}')
    print(df.to_string() if len(df) else '(none)')


def report(ev, P):
    show('bots dropped', P[P.bot != ''].groupby('bot').size().rename('pages').to_frame())
    H = P[P.bot == '']
    print(f'\nreal visitors: {len(H)} page views of {len(P)}; loaded {H.loaded.mean():.0%}')
    print('load_p90 above ~300 s is mostly tabs left in the background while loading')
    print('fps_p10: the slowest tenth; p95ms: frame time of the slowest 5% of frames')
    for by in ['device', 'tier', ['os', 'browser'], 'build']:
        show(f'by {by}', table(H, by))

    c = H[H.device == 'computer']
    rows = []
    for T in [10, 20, 30, 45, 60, 90, 120, 180]:
        rows.append({'t': T, 'loaded': (c.loaded_s <= T).mean(), 'left before loading': ((c.last_t < T) & ~(c.loaded_s <= T)).mean()})
    show('computers: loaded vs gone by time t', pd.DataFrame(rows).set_index('t').round(2))

    cl = c[c.loaded]
    cl = cl.assign(workers=(cl.cores - 2).clip(2, 10), fps_band=pd.cut(cl.fps, [0, 15, 30, 45, 1000]))
    show('computers: load time by mesher workers (cores - 2, max 10)', cl.groupby('workers').loaded_s.agg(['size', 'median', q(.9)]).round(0))
    show('computers: load time by fps after load', cl.groupby('fps_band', observed=True).loaded_s.agg(['size', 'median', q(.9)]).round(0))

    f = c[c.fps.notna()].assign(mpx_band=pd.cut(c.mpx, [0, 1.5, 3, 5, 40]))
    show('computers: fps (median) by GPU tier and megapixels drawn', f.pivot_table(index='tier', columns='mpx_band', values='fps', aggfunc='median', observed=True).round(0))
    show('computers: fps (p10) by GPU tier and megapixels drawn', f.pivot_table(index='tier', columns='mpx_band', values='fps', aggfunc=q(.1), observed=True).round(0))
    show('render size (0-1) the page ended at, by GPU tier', f.groupby('tier').level_last.agg(['size', 'median', q(.1), q(.9)]).round(2))

    e = H[H.loaded & H.fps.notna()].assign(after=lambda d: d.last_t - d.loaded_s, fps_band=lambda d: pd.cut(d.fps, [0, 15, 30, 45, 1000]))
    show('time on page after load and actions, by fps', e.groupby(['device', 'fps_band'], observed=True).agg(
        n=('after', 'size'), after_p50=('after', 'median'), after_p90=('after', q(.9)), actions=('actions', 'mean')).round(1))

    cr = ev[ev.event == 'crashed'][['pid', 'last_t', 'last_phase', 'last_stage']].join(P[['os', 'browser', 'tier']], on='pid')
    cr['last_t'] = pd.cut(cr.last_t, [0, 10, 30, 60, 120, 1e6])
    show('crashes (reported by the reload): where and when the dead page was', cr.groupby(['os', 'browser', 'tier', 'last_phase', 'last_stage', 'last_t'], dropna=False, observed=True).size().rename('n').sort_values(ascending=False).to_frame())

    er = ev[(ev.event == 'error') & ev.pid.isin(H.index)]
    er = er.assign(msg=er.message.fillna('').str.slice(0, 80), source=er.source.fillna('').str.slice(0, 40))
    show('errors (real visitors)', er.groupby(['msg', 'source']).pid.nunique().rename('pages').sort_values(ascending=False).head(15).to_frame())
    show('blank screen / lost context (real visitors)', H[H.blank | H.ctxlost][['tier', 'gpu', 'os', 'browser', 'blank', 'ctxlost']])
    show('heap peak MB (Chrome only)', H.groupby('tier').heap_max.agg(['count', 'median', q(.9), 'max']).dropna().round(0))
    show('referrers', table(H.assign(ref=H.referring_domain.fillna('?')), 'ref', 5)[['pages', 'loaded', 'stay_p50', 'stay_p90', 'actions']].head(12))
    act = ev[ev.event.isin(ACTIONS) & ev.pid.isin(H.index)]
    what = act['mode'].astype(str).where(act.event == 'mode', act.get('weather', pd.Series(dtype=str)).astype(str).where(act.event == 'weather', act.get('name', pd.Series(dtype=str)).astype(str)))
    show('what people do', act.assign(what=what).groupby(['event', 'what']).pid.nunique().rename('pages').sort_values(ascending=False).head(20).to_frame())


if __name__ == '__main__':
    pd.set_option('display.width', 250); pd.set_option('display.max_rows', 200); pd.set_option('display.max_colwidth', 70)
    args = sys.argv[1:]
    if args[:1] == ['-q']:
        cols, rows = query(args[1])
        print(pd.DataFrame(rows, columns=cols).to_string())
        sys.exit()
    days = int(next((a for a in args if a.isdigit()), 30))
    ev = events(days)
    P = pages(ev)
    if '--pages' in args:
        P.to_csv(ROOT / 'data/perf_pages.csv')
    report(ev, P)
