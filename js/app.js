// app.js
// Non-module version. Requires calc.js loaded BEFORE this file.


let airportsArr = null;
let airportsByIata = null;

const DEFAULT_CARBON_PRICE_EUR_PER_T = 73.75;
const DEFAULT_CARBON_PRICE_DATE = "2026-02-20";

const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));
}

function fmt(x, digits = 2) {
  const n = Number(x);
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(digits);
}

// ---------------------------
// Airports loading
// ---------------------------
async function loadAirportsOnce() {
  if (airportsArr && airportsByIata) return;

  $("airportsStatus").textContent = "airports: loading…";

  const res = await fetch("./data/airports_min.json", { cache: "no-store" });
  if (!res.ok) {
    console.error("Failed to load airports_min.json", res.status);
    $("airportsStatus").textContent = "airports: load error";
    return;
  }

  airportsArr = await res.json();
  airportsByIata = {};

  for (const a of airportsArr) {
    if (a && a.iata) {
      airportsByIata[String(a.iata).toUpperCase()] = a;
    }
  }

  $("airportsStatus").textContent =
    "airports: " + airportsArr.length.toLocaleString();
}

// ---------------------------
// Autocomplete
// ---------------------------
function buildSuggestions(query) {
  if (!airportsArr) return [];
  const q = String(query || "").trim().toUpperCase();
  if (q.length < 2) return [];

  const out = [];
  for (const a of airportsArr) {
    const iata = String(a.iata || "");
    const city = String(a.city || "").toUpperCase();
    const name = String(a.name || "").toUpperCase();

    if (iata.startsWith(q) || city.includes(q) || name.includes(q)) {
      out.push(a);
      if (out.length >= 10) break;
    }
  }
  return out;
}

function showSuggest(boxEl, items, onPick) {
  if (!items.length) {
    boxEl.classList.add("hidden");
    boxEl.innerHTML = "";
    return;
  }

  boxEl.innerHTML = items.map(a => {
    const line =
      esc(a.iata) + " — " +
      esc(a.city || "") + ", " +
      esc(a.country || "") + " · " +
      esc(a.name || "");
    return `<div class="suggestitem" data-iata="${esc(a.iata)}">${line}</div>`;
  }).join("");

  boxEl.classList.remove("hidden");

  boxEl.querySelectorAll(".suggestitem").forEach(el => {
    el.addEventListener("click", () => {
      const iata = el.getAttribute("data-iata");
      onPick(iata);
      boxEl.classList.add("hidden");
    });
  });
}

function setupAutocomplete(inputEl, suggestEl) {
  inputEl.addEventListener("focus", loadAirportsOnce);

  inputEl.addEventListener("input", async () => {
    await loadAirportsOnce();
    const items = buildSuggestions(inputEl.value);
    showSuggest(suggestEl, items, (iata) => {
      inputEl.value = iata;
    });
  });

  document.addEventListener("click", (ev) => {
    if (!suggestEl.contains(ev.target) && ev.target !== inputEl) {
      suggestEl.classList.add("hidden");
    }
  });
}

// ---------------------------
// Carbon price (offline-safe)
// ---------------------------
async function fetchCarbonPriceEurPerT() {
  try {
    const r = await fetch("https://tradingeconomics.com/commodity/carbon", {
      cache: "no-store"
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const html = await r.text();

    let m = html.match(/rose to\s+(\d{1,3}(?:\.\d{1,2})?)\s+EUR\s+on\s+([A-Za-z]+\s+\d{1,2},\s+\d{4})/i);
    if (!m) {
      m = html.match(/\bto\s+(\d{1,3}(?:\.\d{1,2})?)\s+EUR\s+on\s+([A-Za-z]+\s+\d{1,2},\s+\d{4})/i);
    }
    if (!m) throw new Error("parse failed");

    return {
      ok: true,
      price: Number(m[1]),
      meta: { source: "TradingEconomics", date: m[2] }
    };
  } catch (e) {
    return {
      ok: false,
      price: DEFAULT_CARBON_PRICE_EUR_PER_T,
      meta: { source: "fallback_default", date: DEFAULT_CARBON_PRICE_DATE }
    };
  }
}

// ---------------------------
// Render
// ---------------------------
function renderResult(modelRes, carbon) {
  const el = $("result");
  el.classList.remove("hidden");

  if (!modelRes || !modelRes.ok) {
    el.innerHTML = "<b>Cannot calculate.</b>";
    return;
  }

  const cost = modelRes.co2_t_total * carbon.price;

  el.innerHTML = `
    <div><b>Total CO₂e:</b> ${fmt(modelRes.co2_kg_total)} kg (${fmt(modelRes.co2_t_total, 3)} t)</div>
    <div><b>Distance used:</b> ${fmt(modelRes.distance_km_used, 1)} km</div>
    <div><b>Per passenger:</b> ${fmt(modelRes.per_pax_kg)} kg</div>
    <br/>
    <div><b>Carbon price:</b> ${fmt(carbon.price)} EUR/t (${esc(carbon.meta.source)})</div>
    <div><b>Estimated emissions cost:</b> ${fmt(cost)} EUR</div>
  `;
}

// ---------------------------
// Calculate
// ---------------------------
async function onCalculate() {
  await loadAirportsOnce();

  const req = {
    origin: $("origin").value,
    destination: $("destination").value,
    cabin: $("cabin").value,
    pax: $("pax").value,
    roundtrip: $("roundtrip").checked
  };

  const carbon = await fetchCarbonPriceEurPerT();
  const result = window.CO2Calc.calculateFlight(req, airportsByIata);

  renderResult(result, carbon);
}

// ---------------------------
// Boot
// ---------------------------
function boot() {
  setupAutocomplete($("origin"), $("originSuggest"));
  setupAutocomplete($("destination"), $("destinationSuggest"));
  $("calcBtn").addEventListener("click", onCalculate);
}

boot();