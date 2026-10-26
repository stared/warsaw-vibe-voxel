import { clamp, fetchJson } from './util';
import type { Weather } from './weather';

interface Current { cloud_cover: number; rain: number; showers: number; snowfall: number; snow_depth: number; visibility: number; weather_code: number }

// the weather over Warsaw now, from Open-Meteo (no key): rain and snowfall are the last 15 minutes' sums, WMO codes 45 and 48 are fog
export async function liveWeather(): Promise<Weather> {
  const url = 'https://api.open-meteo.com/v1/forecast?latitude=52.23&longitude=21.01&current=cloud_cover,rain,showers,snowfall,snow_depth,visibility,weather_code';
  const { current: c } = await fetchJson<{ current: Current }>(url);
  const fog = c.weather_code === 45 || c.weather_code === 48 ? 1 : clamp((3000 - c.visibility) / 2000, 0, 1);
  return { cloud: c.cloud_cover / 100, fog, rain: clamp((c.rain + c.showers) * 4 / 2.5, 0, 1), snow: clamp(c.snowfall * 4 / 1.5, 0, 1), cover: clamp(c.snow_depth / 0.03, 0, 1) };
}
