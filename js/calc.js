// calc.js
// Non-module version (no export/import). Exposes API via window.CO2Calc.
// Model: simplified myclimate-inspired, ported from our Python implementation.

function haversineKm(lat1, lon1, lat2, lon2) {
  const r = 6371.0088; // km
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const dphi = ((lat2 - lat1) * Math.PI) / 180;
  const dl = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dphi / 2) ** 2 +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(dl / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return r * c;
}

function interp(t, a, b) {
  return (1 - t) * a + t * b;
}

function distanceCorrectionKm(gcdKm, dcShort, dcLong, transition) {
  const [t0, t1] = transition;
  if (gcdKm <= t0) return dcShort;
  if (gcdKm >= t1) return dcLong;
  const t = (gcdKm - t0) / (t1 - t0);
  return dcShort + t * (dcLong - dcShort);
}

function polyFuelKg(xKm, a, b, c) {
  return a * (xKm ** 2) + b * xKm + c;
}

function fuelKgMyclimate(gcdKm, xKm, polyShort, polyLong, transition) {
  const fShort = polyFuelKg(xKm, polyShort.a, polyShort.b, polyShort.c);
  const fLong = polyFuelKg(xKm, polyLong.a, polyLong.b, polyLong.c);

  const [t0, t1] = transition;
  if (gcdKm <= t0) return fShort;
  if (gcdKm >= t1) return fLong;

  const t = (gcdKm - t0) / (t1 - t0);
  return interp(t, fShort, fLong);
}

function aircraftCo2eKg(fuelKg, opts) {
  const fuelToCo2 = Number(opts.fuelToCo2);
  const includeNonCo2 = Boolean(opts.includeNonCo2);
  const nonCo2Multiplier = Number(opts.nonCo2Multiplier);
  const fuelPreprod = Number(opts.fuelPreprod);

  let combustion = fuelKg * fuelToCo2;
  const combustionNoUplift = combustion;
  let upliftMultiplier = 1.0;

  if (includeNonCo2) {
    combustion *= nonCo2Multiplier;
    upliftMultiplier = nonCo2Multiplier;
  }

  const preprod = fuelKg * fuelPreprod;

  return {
    total: combustion + preprod,
    combustion_no_uplift: combustionNoUplift,
    combustion_with_uplift: combustion,
    non_co2_multiplier_used: upliftMultiplier,
    preproduction: preprod,
  };
}

function seatsForLeg(haul, seatsShort, seatsLong, transition, gcdKm) {
  const [t0, t1] = transition;
  if (haul === "short") return seatsShort;
  if (haul === "long") return seatsLong;
  const t = (gcdKm - t0) / (t1 - t0);
  return interp(t, seatsShort, seatsLong);
}

function cabinWeight(haul, cwShort, cwLong, transition, gcdKm, cabin) {
  const c = String(cabin || "economy").toLowerCase();
  const [t0, t1] = transition;

  if (haul === "short") return cwShort[c];
  if (haul === "long") return cwLong[c];

  const t = (gcdKm - t0) / (t1 - t0);
  return interp(t, cwShort[c], cwLong[c]);
}

function perPassengerEmissions(
  passengerPoolCo2eKg,
  gcdKm,
  haul,
  plf,
  seatsShort,
  seatsLong,
  transition,
  cwShort,
  cwLong
) {
  const seats = seatsForLeg(haul, seatsShort, seatsLong, transition, gcdKm);
  const avg = passengerPoolCo2eKg / (seats * plf);
  const byCabin = {
    economy: avg * cabinWeight(haul, cwShort, cwLong, transition, gcdKm, "economy"),
    business: avg * cabinWeight(haul, cwShort, cwLong, transition, gcdKm, "business"),
    first: avg * cabinWeight(haul, cwShort, cwLong, transition, gcdKm, "first"),
  };
  return { averageKg: avg, byCabin };
}

function classifyHaul(gcdKm, transition) {
  const [t0, t1] = transition;
  if (gcdKm <= t0) return "short";
  if (gcdKm >= t1) return "long";
  return "transition";
}

function calculateFlight(req, airportsByIata, assumptionsOverride) {
  const warnings = [];
  const origin = String(req.origin || "").trim().toUpperCase();
  const destination = String(req.destination || "").trim().toUpperCase();
  const cabin = String(req.cabin || "economy").toLowerCase();
  const pax = Math.max(1, Number(req.pax || 1) | 0);
  const roundtrip = Boolean(req.roundtrip);

  if (!airportsByIata || typeof airportsByIata !== "object") {
    throw new Error("airportsByIata map missing");
  }

  const aFrom = airportsByIata[origin];
  const aTo = airportsByIata[destination];
  if (!aFrom) warnings.push("unknown IATA: " + origin);
  if (!aTo) warnings.push("unknown IATA: " + destination);
  if (!aFrom || !aTo) {
    return { ok: false, warnings: warnings, assumptions_used: null };
  }

  const A = Object.assign(
    {
      include_non_co2: true,
      non_co2_multiplier: 2.0,
      fuel_to_co2_kg_per_kg: 3.15,
      fuel_preproduction_kgco2e_per_kg: 0.51,
      cargo_share_fraction: 0.049,
      plf: 0.77,
      seats_short_haul: 158.44,
      seats_long_haul: 280.39,
      dc_short_km: 50.0,
      dc_long_km: 125.0,
      transition_short_long_km: [1500.0, 2500.0],
      cabin_weights: {
        short_haul: { economy: 0.96, business: 1.26, first: 2.4 },
        long_haul: { economy: 0.8, business: 1.54, first: 2.4 },
      },
      fuel_polynomials: {
        short_haul: { a: 3.87871e-05, b: 2.9866, c: 1263.42 },
        long_haul: { a: 1.34576e-04, b: 6.1798, c: 3446.2 },
      },
    },
    assumptionsOverride || {}
  );

  const transition = [
    Number((A.transition_short_long_km && A.transition_short_long_km[0]) || 1500.0),
    Number((A.transition_short_long_km && A.transition_short_long_km[1]) || 2500.0),
  ];

  const legs = roundtrip
    ? [{ from: origin, to: destination }, { from: destination, to: origin }]
    : [{ from: origin, to: destination }];

  let totalGcd = 0;
  let totalX = 0;
  let totalFuel = 0;
  let totalCo2e = 0;
  const legsOut = [];

  for (const leg of legs) {
    const f = airportsByIata[leg.from];
    const t = airportsByIata[leg.to];

    const gcd = haversineKm(f.lat, f.lon, t.lat, t.lon);
    const haul = classifyHaul(gcd, transition);

    const dc = distanceCorrectionKm(
      gcd,
      Number(A.dc_short_km),
      Number(A.dc_long_km),
      transition
    );

    const x = gcd + dc;

    const fuel = fuelKgMyclimate(
      gcd,
      x,
      A.fuel_polynomials.short_haul,
      A.fuel_polynomials.long_haul,
      transition
    );

    const co2eAircraft = aircraftCo2eKg(fuel, {
      fuelToCo2: Number(A.fuel_to_co2_kg_per_kg),
      includeNonCo2: Boolean(A.include_non_co2),
      nonCo2Multiplier: Number(A.non_co2_multiplier),
      fuelPreprod: Number(A.fuel_preproduction_kgco2e_per_kg),
    });

    const co2ePaxPool = co2eAircraft.total * (1 - Number(A.cargo_share_fraction));

    const perPax = perPassengerEmissions(
      co2ePaxPool,
      gcd,
      haul,
      Number(A.plf),
      Number(A.seats_short_haul),
      Number(A.seats_long_haul),
      transition,
      A.cabin_weights.short_haul,
      A.cabin_weights.long_haul
    );

    if (!(cabin in perPax.byCabin)) {
      warnings.push("unknown cabin: " + cabin + " (allowed: economy, business, first)");
    }

    const perPaxKg = Number(perPax.byCabin[cabin] != null ? perPax.byCabin[cabin] : perPax.byCabin.economy);
    const legTotal = perPaxKg * pax;

    totalGcd += gcd;
    totalX += x;
    totalFuel += fuel;
    totalCo2e += legTotal;

    legsOut.push({
      from: leg.from,
      to: leg.to,
      gcd_km: gcd,
      distance_correction_km: dc,
      corrected_distance_km: x,
      haul: haul,
      fuel_kg: fuel,
      aircraft: {
        co2e_total_kg: co2eAircraft.total,
        combustion_no_uplift_kg: co2eAircraft.combustion_no_uplift,
        combustion_with_uplift_kg: co2eAircraft.combustion_with_uplift,
        non_co2_multiplier_used: co2eAircraft.non_co2_multiplier_used,
        preproduction_kg: co2eAircraft.preproduction,
      },
      passenger_pool_co2e_kg: co2ePaxPool,
      per_passenger: {
        average_kg: perPax.averageKg,
        by_cabin_kg: perPax.byCabin,
      },
      allocation: {
        pax_count: pax,
        cabin: cabin,
        people_co2e_kg: legTotal,
      },
    });
  }

  return {
    ok: true,
    co2_kg_total: totalCo2e,
    co2_t_total: totalCo2e / 1000.0,
    distance_km_used: totalX,
    great_circle_km: totalGcd,
    per_pax_kg: totalCo2e / pax,
    legs: legsOut,
    assumptions_used: {
      include_non_co2: Boolean(A.include_non_co2),
      non_co2_multiplier: Number(A.non_co2_multiplier),
      plf: Number(A.plf),
      cargo_share_fraction: Number(A.cargo_share_fraction),
      seats_short_haul: Number(A.seats_short_haul),
      seats_long_haul: Number(A.seats_long_haul),
      dc_short_km: Number(A.dc_short_km),
      dc_long_km: Number(A.dc_long_km),
      transition_short_long_km: transition,
      cabin_weights: A.cabin_weights,
      fuel_polynomials: A.fuel_polynomials,
    },
    warnings: warnings,
  };
}

// Public API (no modules)
window.CO2Calc = {
  calculateFlight: calculateFlight,
  haversineKm: haversineKm,
};