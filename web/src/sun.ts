const RAD = Math.PI / 180, LAT = 52.23 * RAD, LON = 21.01;

const lastSunday = (year: number, month: number) => { const d = new Date(Date.UTC(year, month + 1, 0)); return d.getUTCDate() - d.getUTCDay(); };
export const dayOfYear = (d: Date) => Math.round((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(d.getFullYear(), 0, 0)) / 864e5);
export const dateOf = (day: number, year = new Date().getFullYear()) => new Date(year, 0, day);

export function utcOffset(day: number, year = new Date().getFullYear()) {
  const start = dayOfYear(new Date(year, 2, lastSunday(year, 2))), end = dayOfYear(new Date(year, 9, lastSunday(year, 9)));
  return day >= start && day < end ? 2 : 1;
}

// NOAA low-precision declination and equation of time
export function sunAt(day: number, hour: number) {
  const g = 2 * Math.PI / 365 * (day - 1 + (hour - 12) / 24);
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g)
    - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const eot = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const solar = hour - utcOffset(day) + LON / 15 + eot / 60;
  const H = (solar - 12) * 15 * RAD;
  const el = Math.asin(Math.sin(LAT) * Math.sin(decl) + Math.cos(LAT) * Math.cos(decl) * Math.cos(H));
  const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(LAT) - Math.tan(decl) * Math.cos(LAT)) + Math.PI;
  return { el, az };
}

const elDeg = (day: number, h: number) => sunAt(day, h).el / RAD;

export function solarNoon(day: number) {
  let lo = 9, hi = 16;
  for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; if (elDeg(day, m + 1e-3) > elDeg(day, m)) lo = m; else hi = m; }
  return lo;
}

export function hourAt(day: number, deg: number, evening: boolean) {
  const noon = solarNoon(day);
  let lo = evening ? noon : noon - 12, hi = evening ? noon + 12 : noon;
  for (let i = 0; i < 30; i++) {
    const m = (lo + hi) / 2, above = elDeg(day, m) > deg;
    if (above === evening) lo = m; else hi = m;
  }
  return (lo + hi) / 2;
}

// Clear-sky transmittance of the direct beam at 610, 550, 465 nm: Rayleigh (Bucholtz), urban haze (Ångström β 0.05,
// α 1.3), ozone (Chappuis band); Kasten-Young air mass
const TAU = [0.191, 0.244, 0.339];
export const airMass = (elDeg: number) => { const h = Math.max(elDeg, -0.5); return 1 / (Math.sin(h * RAD) + 0.50572 * (h + 6.07995) ** -1.6364); };
export const beam = (elDeg: number) => TAU.map((t) => Math.exp(-airMass(elDeg) * t)) as [number, number, number];
