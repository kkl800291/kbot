import { command, native } from './runtime';

export function installWeather(A: any) {
  let cache: { at: number; coords: string; data: any } | null = A.stored.weather || null;
  A.persisters.weather = () => cache;
  const refresh = async () => {
    if (!native || !A.S.senseWeather || !A.S.onboarding) return;
    const coords = JSON.stringify(A.S.cityCoords);
    if (cache && cache.coords === coords && Date.now() - cache.at < 3600_000) return;
    try {
      const data = await command('weather_get', A.S.cityCoords);
      cache = { at: Date.now(), coords, data }; A.save();
    } catch { /* Weather failure never interrupts the user. */ }
  };
  A.weatherSummary = () => {
    if (!A.S.senseWeather || !cache || cache.coords !== JSON.stringify(A.S.cityCoords) || Date.now() - cache.at > 6 * 3600_000) return '';
    const { current, daily } = cache.data;
    if (!current || !daily) return '';
    const weather = current.weather_code === 0 ? '晴' : current.weather_code < 4 ? '多云' : current.weather_code < 50 ? '有雾' : current.weather_code < 70 ? '有雨' : current.weather_code < 80 ? '有雪' : '有阵雨';
    return `${A.S.city}，${weather}，${Math.round(daily.temperature_2m_min[0])}–${Math.round(daily.temperature_2m_max[0])}°C。${daily.precipitation_probability_max[0] >= 50 ? '出门请带伞。' : ''}`;
  };
  A.on('sense:city', refresh); A.on('set:senseWeather', refresh); A.on('onboarded', refresh);
  A.init(() => { refresh(); setInterval(refresh, 3600_000); });
}
