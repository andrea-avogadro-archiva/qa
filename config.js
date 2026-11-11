"use strict";
/*
 * Configurazione della pagina web: equivale ad air_quality.toml (stessi nomi di chiavi).
 * Qui puoi cambiare stazioni, soglie e finestre di valutazione; dopo la modifica basta
 * ricaricare la pagina.
 *
 *  - Si considerano le ultime `rating.window_days` medie giornaliere disponibili e si
 *    contano i giorni in cui la media supera (>) la soglia dell'inquinante.
 *  - giorni sopra soglia >= red_min_days_over    -> ROSSO     (qualità scadente)
 *  - giorni sopra soglia >= orange_min_days_over -> ARANCIONE (intermedia)
 *  - altrimenti                                  -> VERDE     (buona)
 *  - Il colore complessivo è il peggiore tra tutte le stazioni e gli inquinanti.
 *  - L'andamento (↑ = ↓) usa la retta ai minimi quadrati sulle ultime `trend.window_days`
 *    medie; è "stabile" se la variazione è entro `tolerance_percent` % della soglia.
 *  - Gli inquinanti non elencati (es. O3, ozono) vengono ignorati.
 */
const AIR_QUALITY_CONFIG = {
  // Nome mostrato nel titolo della pagina.
  area_name: "Verona",

  source: {
    api_url: "https://api.arpa.veneto.it/REST/v1/aria_valori_giornalieri",
    refresh_minutes: 60, // ogni quanto riscaricare i dati mentre la pagina è aperta (minimo 1)
    request_timeout_seconds: 15,
  },

  rating: {
    window_days: 5,
    orange_min_days_over: 1,
    red_min_days_over: 2,
  },

  trend: {
    window_days: 5,
    tolerance_percent: 10,
  },

  // Stazioni ARPAV da interrogare (parametro `codseqst` dell'API).
  stations: [
    { code: 500000134 }, // Verona - C.so Milano
    { code: 500031115 }, // VR-Giarol Grande
  ],

  // Inquinanti considerati e relative soglie in µg/m³ ("PARAMETRO" dell'API).
  pollutants: [
    { name: "PM10", threshold: 50 },
    { name: "PM2.5", threshold: 25 },
  ],
};
