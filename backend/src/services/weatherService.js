import env from '../config/env.js';

export const WEATHER_UNAVAILABLE_MESSAGE = "I couldn't fetch real-time weather right now. Please try again in a moment.";
export const WEATHER_LOCATION_NOT_FOUND_MESSAGE = (location) => `I couldn't find weather data for "${location}". Please check the spelling or try a nearby city.`;
export const WEATHER_AUTH_MESSAGE = "The weather API key is missing or invalid. Check WEATHER_API_KEY (and WEATHER_PROVIDER) in backend/.env.";
export const WEATHER_QUOTA_MESSAGE = "The weather service is out of quota for now (usage limit reached). Please try again later.";
export const WEATHER_NOT_CONFIGURED_MESSAGE = "Live weather is not configured on this server. Set WEATHER_API_KEY in backend/.env to enable real-time weather.";

const OPENWEATHER_CURRENT = 'https://api.openweathermap.org/data/2.5/weather';
const OPENWEATHER_FORECAST = 'https://api.openweathermap.org/data/2.5/forecast';
const WEATHERAPI_FORECAST = 'https://api.weatherapi.com/v1/forecast.json';

const REQUEST_TIMEOUT_MS = 15000;

const throwFriendly = (message, statusCode) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.userMessage = message;
  return err;
};

const pad = (n) => String(n).padStart(2, '0');

// Provider-agnostic HTTP fetch with timeout + friendly error mapping.
// Never logs the API key.
const fetchJson = async (url, { notFoundMessage = null, statusCode = 502 } = {}) => {
  let res;
  try {
    res = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.cause?.name === 'TimeoutError' || err?.message?.includes('aborted');
    console.error('[Weather] network error:', timedOut ? 'timeout' : (err?.cause?.message || err?.message || err));
    throw throwFriendly(WEATHER_UNAVAILABLE_MESSAGE, timedOut ? 504 : statusCode);
  }

  const raw = await res.text().catch(() => '');
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch { /* non-JSON body (e.g. proxy HTML) -> parsed stays null */ }

  const upstream = parsed?.error || null;
  const upstreamCode = Number(upstream?.code);

  // Classify provider errors into friendly, non-fabricated messages.
  // WeatherAPI: 1006 = location not found, 1002/2006 = bad/missing key,
  //             2007/2008/2009 = quota exceeded. OpenWeather: 404 / 401 / 429.
  const classify = (code, status) => {
    if (code === 1006 || status === 404) return { message: notFoundMessage, statusCode: 404 };
    if (code === 1002 || code === 2006 || status === 401 || status === 403) {
      return { message: WEATHER_AUTH_MESSAGE, statusCode: 502 };
    }
    if (code === 2007 || code === 2008 || code === 2009 || status === 429) {
      return { message: WEATHER_QUOTA_MESSAGE, statusCode: 502 };
    }
    return null;
  };

  // Some providers (WeatherAPI quota errors) return HTTP 200 with an error body.
  if (upstream) {
    const c = classify(upstreamCode, res.status);
    if (c) {
      console.error(`[Weather] provider error (HTTP ${res.status}):`, upstream.message || upstreamCode);
      throw throwFriendly(c.message, c.statusCode);
    }
  }

  if (!res.ok) {
    console.error(`[Weather] HTTP ${res.status}:`, upstream?.message || raw.slice(0, 300) || '(no error body)');
    const c = classify(upstreamCode, res.status);
    if (c) throw throwFriendly(c.message, c.statusCode);
    throw throwFriendly(WEATHER_UNAVAILABLE_MESSAGE, statusCode);
  }

  if (parsed === null) {
    console.error('[Weather] Provider returned malformed JSON.');
    throw throwFriendly(WEATHER_UNAVAILABLE_MESSAGE, 502);
  }
  return parsed;
};

const shortCityName = (name) => String(name || '').split(',')[0].trim();

const emojiForCondition = (condition = '') => {
  const c = String(condition).toLowerCase();
  if (/(thunder|storm)/.test(c)) return '⛈️';
  if (/(rain|drizzle|shower)/.test(c)) return '🌧️';
  if (/(snow|sleet|blizzard|ice)/.test(c)) return '❄️';
  if (/(mist|fog|haze|smog)/.test(c)) return '🌫️';
  if (/(clear|sunny)/.test(c)) return '☀️';
  if (/partly\s+cloud/.test(c)) return '⛅';
  if (/cloud/.test(c)) return '☁️';
  return '🌤️';
};

const capitalize = (s = '') => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

// Normalized AURA-style message, e.g.:
//   🌤️ Weather in Kavali
//
//   Temperature: 32°C
//   Condition: Partly cloudy
//   Feels like: 35°C
//   Humidity: 70%
//   Wind: 18 km/h
//   Rain chance: 20%
//
//   Updated: 14:30 local
export const formatWeatherMessage = (data) => {
  const lines = [];
  lines.push(`${emojiForCondition(data.condition)} Weather in ${data.location || 'your area'}`);
  lines.push('');
  if (data.temperatureC != null) lines.push(`Temperature: ${Math.round(data.temperatureC)}°C`);
  if (data.condition) lines.push(`Condition: ${capitalize(data.condition)}`);
  if (data.feelsLikeC != null) lines.push(`Feels like: ${Math.round(data.feelsLikeC)}°C`);
  if (data.humidity != null) lines.push(`Humidity: ${Math.round(data.humidity)}%`);
  if (data.windKph != null) lines.push(`Wind: ${Math.round(data.windKph)} km/h`);
  if (data.rainChance != null) lines.push(`Rain chance: ${Math.round(data.rainChance)}%`);
  if (data.updatedAt) lines.push('');
  if (data.updatedAt) lines.push(`Updated: ${data.updatedAt}`);
  return lines.join('\n');
};

// Returns normalized weather data for a place name.
//   { provider, location, temperatureC, feelsLikeC, condition, humidity,
//     windKph, rainChance, updatedAt }
const getOpenWeather = async (location) => {
  const key = env.weather.apiKey;

  const currentUrl = `${OPENWEATHER_CURRENT}?${new URLSearchParams({ q: location, appid: key, units: 'metric' })}`;
  const current = await fetchJson(currentUrl, { notFoundMessage: WEATHER_LOCATION_NOT_FOUND_MESSAGE(location), statusCode: 502 });

  // 5-day / 3-hour forecast used only to read the precipitation probability
  // (pop). Optional: if it fails we simply omit the rain chance.
  let pop = null;
  let tzOffsetSec = 0;
  try {
    const forecastUrl = `${OPENWEATHER_FORECAST}?${new URLSearchParams({ q: location, appid: key, units: 'metric', cnt: '1' })}`;
    const forecast = await fetchJson(forecastUrl, { notFoundMessage: WEATHER_LOCATION_NOT_FOUND_MESSAGE(location), statusCode: 502 });
    const p = forecast?.list?.[0]?.pop;
    if (typeof p === 'number') pop = Math.round(p * 100);
    const tz = Number(forecast?.city?.timezone);
    if (!Number.isNaN(tz)) tzOffsetSec = tz;
  } catch (err) {
    console.error('[Weather] OpenWeather forecast call failed (rain chance omitted):', err?.message || err);
  }

  const dt = Number(current?.dt);
  let updatedAt = null;
  if (dt && !Number.isNaN(dt)) {
    const d = new Date((dt + tzOffsetSec) * 1000);
    updatedAt = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} local`;
  }

  const windMs = Number(current?.wind?.speed);
  return {
    provider: 'openweather',
    location: shortCityName(current?.name) || location,
    temperatureC: rn(current?.main?.temp),
    feelsLikeC: rn(current?.main?.feels_like),
    condition: current?.weather?.[0]?.description || null,
    humidity: current?.main?.humidity,
    windKph: Number.isFinite(windMs) ? Math.round(windMs * 3.6) : null,
    rainChance: pop,
    updatedAt,
  };
};

const rn = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const getWeatherApiCom = async (location) => {
  const key = env.weather.apiKey;
  // forecast.json (days=1) is a strict superset of current.json: it includes the
  // full `current` block plus forecast.forecastday[0].day.daily_chance_of_rain,
  // which current.json does not provide (needed for "Rain chance").
  const url = `${WEATHERAPI_FORECAST}?${new URLSearchParams({ key, q: location, days: '1', aqi: 'no' })}`;
  const data = await fetchJson(url, { notFoundMessage: WEATHER_LOCATION_NOT_FOUND_MESSAGE(location), statusCode: 502 });

  const current = data?.current || {};
  const day = data?.forecast?.forecastday?.[0];

  const chance = Number(day?.day?.daily_chance_of_rain);
  return {
    provider: 'weatherapi',
    location: shortCityName(data?.location?.name) || location,
    temperatureC: rn(current?.temp_c),
    feelsLikeC: rn(current?.feelslike_c),
    condition: current?.condition?.text || null,
    humidity: typeof current?.humidity === 'number' ? current.humidity : null,
    windKph: rn(current?.wind_kph),
    rainChance: Number.isFinite(chance) ? Math.round(chance) : null,
    updatedAt: current?.last_updated || null,
  };
};

export const getWeather = async (location) => {
  const provider = env.weather.provider;
  if (provider === 'openweather') return getOpenWeather(String(location).trim());
  if (provider === 'weatherapi') return getWeatherApiCom(String(location).trim());
  console.error(`[Weather] Unknown provider "${provider}" (set WEATHER_PROVIDER=openweather or weatherapi).`);
  throw throwFriendly(WEATHER_UNAVAILABLE_MESSAGE, 502);
};

// Controller-friendly helper. Returns:
//  - { type: 'ok', message, metadata }            real weather, ready to send
//  - { type: 'not_configured' }                   no key set -> caller may fall back
//  - { type: 'error', message }                   provider failed / place not found
export const tryGetWeather = async (location) => {
  if (!env.weather.apiKey) {
    console.warn('[Weather] WEATHER_API_KEY not set; falling back (no live weather).');
    return { type: 'not_configured' };
  }
  let data;
  try {
    data = await getWeather(location);
  } catch (err) {
    console.error('[Weather] Failed:', err?.message || err);
    return { type: 'error', message: err?.userMessage || WEATHER_UNAVAILABLE_MESSAGE };
  }
  return {
    type: 'ok',
    message: formatWeatherMessage(data),
    metadata: { weather: { used: true, provider: data.provider, location: data.location } },
  };
};