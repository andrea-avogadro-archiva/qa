"use strict";
/*
 * Logica della qualità dell'aria, senza DOM: porting fedele delle parti "pure" di
 * weather_tray.py (parse_config, parse_station_payload, evaluate, trend).
 * Funziona sia nel browser (variabile globale `AQ`) sia in Node (module.exports),
 * così può essere confrontata con la versione Python.
 *
 * Se cambi una regola in weather_tray.py, cambiala anche qui.
 */
const AQ = (() => {
  /** Livello di qualità: un valore più alto è peggiore. */
  const Level = Object.freeze({ GOOD: 0, MEDIUM: 1, POOR: 2 });

  /** Direzione dell'ultima variazione (il valore è la freccia mostrata). */
  const Trend = Object.freeze({ UP: "↑", FLAT: "=", DOWN: "↓" });

  class ConfigError extends Error {
    constructor(message) {
      super(message);
      this.name = "ConfigError";
    }
  }

  // -------------------------------------------------------------------------
  // Configurazione (config.js, equivalente di air_quality.toml)
  // -------------------------------------------------------------------------
  const isTable = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

  function readNumber(table, key, fallback, where, { integer = false, minimum = 0 } = {}) {
    const value = table[key] === undefined ? fallback : table[key];
    if (value === undefined || value === null) {
      throw new ConfigError(`[${where}] manca '${key}'`);
    }
    const valid = typeof value === "number" && Number.isFinite(value) && (!integer || Number.isInteger(value));
    if (!valid) {
      throw new ConfigError(`[${where}] '${key}' deve essere un numero${integer ? " intero" : ""}`);
    }
    if (value < minimum) {
      throw new ConfigError(`[${where}] '${key}' deve essere >= ${minimum}`);
    }
    return value;
  }

  function readTable(raw, key) {
    const table = raw[key] === undefined ? {} : raw[key];
    if (!isTable(table)) throw new ConfigError(`'${key}' deve essere una sezione [${key}]`);
    return table;
  }

  function readTables(raw, key) {
    const items = raw[key];
    if (!Array.isArray(items) || items.length === 0 || !items.every(isTable)) {
      throw new ConfigError(`serve almeno una sezione [[${key}]]`);
    }
    return items;
  }

  /** Valida l'oggetto di configurazione e lo trasforma in una configurazione immutabile. */
  function parseConfig(raw) {
    if (!isTable(raw)) throw new ConfigError("la configurazione deve essere un oggetto");

    const areaName = raw.area_name === undefined ? "Verona" : raw.area_name;
    if (typeof areaName !== "string" || !areaName.trim()) {
      throw new ConfigError("'area_name' deve essere un testo non vuoto");
    }

    const source = readTable(raw, "source");
    const apiUrl = source.api_url;
    if (typeof apiUrl !== "string" || !/^https?:\/\//.test(apiUrl)) {
      throw new ConfigError("[source] 'api_url' deve essere un URL http(s)");
    }

    const rating = readTable(raw, "rating");
    const trend = readTable(raw, "trend");
    const orange = readNumber(rating, "orange_min_days_over", 1, "rating", { integer: true, minimum: 1 });
    const red = readNumber(rating, "red_min_days_over", 2, "rating", { integer: true, minimum: 1 });
    if (red < orange) {
      throw new ConfigError("[rating] 'red_min_days_over' deve essere >= 'orange_min_days_over'");
    }

    const stations = readTables(raw, "stations").map((table) =>
      readNumber(table, "code", null, "stations", { integer: true, minimum: 1 })
    );

    const pollutants = readTables(raw, "pollutants").map((table) => {
      const name = table.name;
      if (typeof name !== "string" || !name.trim()) {
        throw new ConfigError("[[pollutants]] 'name' deve essere un testo non vuoto");
      }
      const threshold = readNumber(table, "threshold", null, `pollutants ${name}`);
      return Object.freeze({ name: name.trim(), threshold });
    });

    return Object.freeze({
      areaName: areaName.trim(),
      apiUrl,
      refreshMinutes: readNumber(source, "refresh_minutes", 60, "source", { minimum: 1 }),
      requestTimeoutSeconds: readNumber(source, "request_timeout_seconds", 15, "source", { minimum: 1 }),
      windowDays: readNumber(rating, "window_days", 5, "rating", { integer: true, minimum: 1 }),
      orangeMinDaysOver: orange,
      redMinDaysOver: red,
      stations: Object.freeze(stations),
      pollutants: Object.freeze(pollutants),
      trendWindowDays: readNumber(trend, "window_days", 5, "trend", { integer: true, minimum: 2 }),
      trendTolerance: readNumber(trend, "tolerance_percent", 10, "trend", { minimum: 0 }) / 100,
    });
  }

  // -------------------------------------------------------------------------
  // Dati ARPAV
  // -------------------------------------------------------------------------
  const MS_PER_DAY = 86400000;

  /** "2026-11-10T23:59:00" -> { day: "2026-11-10", ord: giorni dall'epoca } (solo la data conta). */
  function parseDay(text) {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(text));
    if (!match) throw new TypeError(`data non valida: ${text}`);
    const [year, month, dayOfMonth] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const ms = Date.UTC(year, month - 1, dayOfMonth);
    const check = new Date(ms);
    if (
      check.getUTCFullYear() !== year ||
      check.getUTCMonth() !== month - 1 ||
      check.getUTCDate() !== dayOfMonth
    ) {
      throw new TypeError(`data non valida: ${text}`);
    }
    return { day: match[0], ord: ms / MS_PER_DAY };
  }

  /**
   * Converte una risposta `aria_valori_giornalieri` in
   * { code, name, series: { PARAMETRO_MAIUSCOLO: [{ day, ord, value }, ...] } }
   * con ogni serie ordinata per giorno.
   */
  function parseStationPayload(code, payload) {
    if (!isTable(payload) || !payload.success) throw new Error("risposta ARPAV non valida");
    try {
      const rows = payload.data;
      if (!Array.isArray(rows)) throw new TypeError("'data' non è una lista");
      const named = rows.find((row) => row.STAZIONE);
      const name = named ? named.STAZIONE : `Stazione ${code}`;
      const series = {};
      for (const row of rows) {
        if (!("MEDIA" in row)) throw new TypeError("manca 'MEDIA'");
        if (row.MEDIA === null) continue; // nessuna misura per quel giorno
        const value = Number(row.MEDIA);
        if (!Number.isFinite(value)) throw new TypeError(`MEDIA non numerica: ${row.MEDIA}`);
        const { day, ord } = parseDay(row.DATA);
        (series[row.PARAMETRO.toUpperCase()] ||= []).push({ day, ord, value });
      }
      for (const values of Object.values(series)) values.sort((a, b) => a.ord - b.ord);
      return { code, name, series };
    } catch (error) {
      throw new Error(`formato inatteso (${error.name}: ${error.message})`);
    }
  }

  // -------------------------------------------------------------------------
  // Valutazione e andamento
  // -------------------------------------------------------------------------
  function levelFor(daysOver, config) {
    if (daysOver >= config.redMinDaysOver) return Level.POOR;
    if (daysOver >= config.orangeMinDaysOver) return Level.MEDIUM;
    return Level.GOOD;
  }

  /**
   * Variazione totale (primo -> ultimo giorno) lungo la retta ai minimi quadrati.
   * Si usa la retta e non "ultimo meno primo" perché un singolo giorno anomalo non
   * deve ribaltare l'andamento; si usano le date vere perché i giorni mancanti non
   * falsino la pendenza.
   */
  function changeOverWindow(values) {
    const xs = values.map((v) => v.ord);
    const ys = values.map((v) => v.value);
    const n = xs.length;
    const meanX = xs.reduce((a, b) => a + b, 0) / n;
    const meanY = ys.reduce((a, b) => a + b, 0) / n;
    let sxx = 0;
    let sxy = 0;
    for (let i = 0; i < n; i++) {
      sxx += (xs[i] - meanX) ** 2;
      sxy += (xs[i] - meanX) * (ys[i] - meanY);
    }
    if (sxx === 0) return 0;
    return (sxy / sxx) * (xs[n - 1] - xs[0]);
  }

  /** `change` e `tolerance` sono frazioni della soglia dell'inquinante. */
  function classifyTrend(change, tolerance) {
    if (change > tolerance) return Trend.UP;
    if (change < -tolerance) return Trend.DOWN;
    return Trend.FLAT;
  }

  /**
   * Valuta ogni coppia stazione/inquinante sugli ultimi `windowDays` valori.
   * `stations` è un oggetto { codice: dati stazione }; le stazioni non in config sono ignorate.
   */
  function evaluate(stations, config) {
    const results = [];
    for (const code of config.stations) {
      const data = stations[code];
      if (!data) continue;
      for (const pollutant of config.pollutants) {
        const values = data.series[pollutant.name.toUpperCase()];
        if (!values || values.length === 0) continue;

        const window = values.slice(-config.windowDays);
        const daysOver = window.filter((v) => v.value > pollutant.threshold).length;

        let trend = null;
        let trendChange = null;
        const recent = values.slice(-config.trendWindowDays);
        if (recent.length >= 2) {
          trendChange = changeOverWindow(recent) / (pollutant.threshold || 1);
          trend = classifyTrend(trendChange, config.trendTolerance);
        }

        results.push({
          station: data.name,
          pollutant: pollutant.name,
          threshold: pollutant.threshold,
          window,
          latest: window[window.length - 1],
          daysOver,
          level: levelFor(daysOver, config),
          trend,
          trendChange,
        });
      }
    }

    const changes = results.filter((r) => r.trendChange !== null).map((r) => r.trendChange);
    const overallTrend = changes.length
      ? classifyTrend(changes.reduce((a, b) => a + b, 0) / changes.length, config.trendTolerance)
      : null;

    return {
      results,
      trend: overallTrend,
      trendWindowDays: config.trendWindowDays,
      // livello complessivo: il peggiore tra tutte le stazioni e gli inquinanti
      level: results.length ? Math.max(...results.map((r) => r.level)) : null,
      latestDay: results.length
        ? results.map((r) => r.latest.day).reduce((a, b) => (a > b ? a : b))
        : null,
    };
  }

  return Object.freeze({
    Level,
    Trend,
    ConfigError,
    parseConfig,
    parseStationPayload,
    evaluate,
    levelFor,
    changeOverWindow,
    classifyTrend,
  });
})();

if (typeof module !== "undefined" && module.exports) module.exports = AQ;
