// app.js (non-module)
// Requires calc.js loaded BEFORE this file.
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
    if (a && a.iata) airportsByIata[String(a.iata).toUpperCase()] = a;
  }
  $("airportsStatus").textContent = "airports: " + airportsArr.length.toLocaleString();
}

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
    const line = esc(a.iata) + " — " + esc(a.city || "") + ", " + esc(a.country || "") + " · " + esc(a.name || "");
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
    showSuggest(suggestEl, items, (iata) => { inputEl.value = iata; });
  });

  document.addEventListener("click", (ev) => {
    if (!suggestEl.contains(ev.target) && ev.target !== inputEl) {
      suggestEl.classList.add("hidden");
    }
  });
}

async function fetchCarbonPriceEurPerT() {
  try {
    const r = await fetch("https://tradingeconomics.com/commodity/carbon", { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const html = await r.text();

    let m = html.match(/rose to\s+(\d{1,3}(?:\.\d{1,2})?)\s+EUR\s+on\s+([A-Za-z]+\s+\d{1,2},\s+\d{4})/i);
    if (!m) m = html.match(/\bto\s+(\d{1,3}(?:\.\d{1,2})?)\s+EUR\s+on\s+([A-Za-z]+\s+\d{1,2},\s+\d{4})/i);
    if (!m) throw new Error("parse failed");

    return { ok: true, price: Number(m[1]), meta: { source: "TradingEconomics", date: m[2] } };
  } catch (e) {
    return { ok: false, price: DEFAULT_CARBON_PRICE_EUR_PER_T, meta: { source: "fallback_default", date: DEFAULT_CARBON_PRICE_DATE } };
  }
}

/** ---------- Segments UI ---------- **/

let segCounter = 0;

function makeSegmentRow(fromVal = "", toVal = "") {
  segCounter += 1;
  const id = "seg" + segCounter;

  const wrap = document.createElement("div");
  wrap.className = "card";
  wrap.style.marginTop = "10px";

  wrap.innerHTML = `
    <div style="display:grid; grid-template-columns: 1fr 1fr auto; gap:10px; align-items:end;">
      <div class="row suggest">
        <label>From (IATA)</label>
        <input id="${id}_from" autocomplete="off" placeholder="e.g. SOF" value="${esc(fromVal)}" />
        <div id="${id}_fromSug" class="suggestbox hidden"></div>
      </div>

      <div class="row suggest">
        <label>To (IATA)</label>
        <input id="${id}_to" autocomplete="off" placeholder="e.g. VIE" value="${esc(toVal)}" />
        <div id="${id}_toSug" class="suggestbox hidden"></div>
      </div>

      <button id="${id}_del" class="smallbtn" type="button">Remove</button>
    </div>
  `;

  // Wire autocomplete
  const fromInput = wrap.querySelector("#" + id + "_from");
  const toInput = wrap.querySelector("#" + id + "_to");
  const fromSug = wrap.querySelector("#" + id + "_fromSug");
  const toSug = wrap.querySelector("#" + id + "_toSug");

  setupAutocomplete(fromInput, fromSug);
  setupAutocomplete(toInput, toSug);

  // Remove button
  wrap.querySelector("#" + id + "_del").addEventListener("click", () => {
    wrap.remove();
  });

  return wrap;
}

function getSegments() {
  const container = $("segments");
  const cards = Array.from(container.children);
  const segs = [];

  for (const card of cards) {
    const inputs = card.querySelectorAll("input");
    if (inputs.length < 2) continue;
    const from = String(inputs[0].value || "").trim().toUpperCase();
    const to = String(inputs[1].value || "").trim().toUpperCase();
    if (from || to) segs.push({ from, to });
  }
  return segs;
}

/** ---------- Calculation over itinerary ---------- **/

function itineraryToLegs(segments, roundtrip) {
  // segments: [{from,to}, ...] as entered
  // legs: forward segments + (optional) reversed back segments
  const forward = segments.map(s => ({ from: s.from, to: s.to }));
  if (!roundtrip) return forward;

  const back = forward.slice().reverse().map(l => ({ from: l.to, to: l.from }));
  return forward.concat(back);
}

function sumLegResults(legResults, pax, cabin) {
  const warnings = [];
  let co2kg = 0;
  let gcd = 0;
  let used = 0;

  const legsOut = [];

  for (const r of legResults) {
    if (!r.ok) {
      (r.warnings || []).forEach(w => warnings.push(w));
      continue;
    }
    co2kg += Number(r.co2_kg_total || 0);
    gcd += Number(r.great_circle_km || 0);
    used += Number(r.distance_km_used || 0);

    // r.legs is always length 1 because we call calculateFlight per leg
    if (r.legs && r.legs[0]) legsOut.push(r.legs[0]);
    (r.warnings || []).forEach(w => warnings.push(w));
  }

  return {
    ok: true,
    co2_kg_total: co2kg,
    co2_t_total: co2kg / 1000.0,
    great_circle_km: gcd,
    distance_km_used: used,
    per_pax_kg: co2kg / Math.max(1, pax),
    cabin,
    pax,
    legs: legsOut,
    warnings
  };
}

function renderResult(totalRes, carbon) {
  const el = $("result");
  el.classList.remove("hidden");

  if (!totalRes || !totalRes.ok) {
    el.innerHTML = "<b>Cannot calculate.</b>";
    return;
  }

  const cost = totalRes.co2_t_total * carbon.price;

  const warningsHtml = totalRes.warnings && totalRes.warnings.length
    ? `<div class="muted" style="margin-top:10px;"><b>Warnings</b><br/>${totalRes.warnings.map(esc).join("<br/>")}</div>`
    : "";

  const legsHtml = (totalRes.legs || []).map((l, i) => {
    return `<div class="muted" style="margin-top:6px;">Leg ${i + 1}: ${esc(l.from)} → ${esc(l.to)} · used ${fmt(l.corrected_distance_km, 1)} km · CO₂e ${fmt(l.allocation?.people_co2e_kg, 2)} kg</div>`;
  }).join("");

  el.innerHTML = `
    <div><b>Total CO₂e:</b> ${fmt(totalRes.co2_kg_total, 2)} kg (${fmt(totalRes.co2_t_total, 3)} t)</div>
    <div><b>Distance used:</b> ${fmt(totalRes.distance_km_used, 1)} km (great circle: ${fmt(totalRes.great_circle_km, 1)} km)</div>
    <div><b>Per passenger:</b> ${fmt(totalRes.per_pax_kg, 2)} kg</div>
    <br/>
    <div><b>Carbon price:</b> ${fmt(carbon.price, 2)} EUR/t (${esc(carbon.meta.source)})</div>
    <div><b>Estimated emissions cost:</b> ${fmt(cost, 2)} EUR</div>
    <div style="margin-top:10px;"><b>Itinerary legs</b>${legsHtml || `<div class="muted">—</div>`}</div>
    ${warningsHtml}
  `;
}

async function onCalculate() {
  await loadAirportsOnce();

  const cabin = $("cabin").value;
  const pax = Math.max(1, Number($("pax").value || 1) | 0);
  const roundtrip = $("roundtrip").checked;

  const segments = getSegments();

  // Basic validation: need at least 1 complete segment
  const clean = segments.filter(s => s.from && s.to);
  if (clean.length === 0) {
    $("result").classList.remove("hidden");
    $("result").innerHTML = "<b>Please add at least one complete segment (From + To).</b>";
    return;
  }

  const legs = itineraryToLegs(clean, roundtrip);

  // Run model per leg and sum
  const legResults = legs.map(l => {
    return window.CO2Calc.calculateFlight(
      { origin: l.from, destination: l.to, cabin, pax, roundtrip: false },
      airportsByIata
    );
  });

  const carbon = await fetchCarbonPriceEurPerT();
  const total = sumLegResults(legResults, pax, cabin);

  renderResult(total, carbon);
}

function boot() {
  // Initialize with one default segment row
  const container = $("segments");
  container.appendChild(makeSegmentRow("SOF", "VAR"));

  $("addSegmentBtn").addEventListener("click", () => {
    container.appendChild(makeSegmentRow("", ""));
  });

  $("calcBtn").addEventListener("click", onCalculate);
}

boot();
