'use strict';

/**
 * Travel time from a stay to the places already on the trip.
 *
 * This is the thing a standalone Airbnb search cannot do: TREK knows the
 * itinerary, so it can answer "is this stay actually convenient for what I am
 * doing?" rather than only "how much is it?".
 *
 * One `maps_distance_matrix` call covers up to 20 results, since the tool takes many
 * origins and destinations at once, so this costs one round trip, not one per
 * listing.
 */

/** Google's matrix APIs cap elements per request; stay well inside it. */
const MAX_ORIGINS = 20;
const MAX_DESTINATIONS = 5;
const MODES = new Set(['driving', 'walking', 'bicycling', 'transit']);

function coordString(lat, lng) {
  // Number(null), Number('') and Number('   ') are all zero. Coordinates coming
  // from optional form/database fields must not silently turn those missing
  // values into a real point on the equator or prime meridian.
  if (lat == null || lng == null) return null;
  if (!['number', 'string'].includes(typeof lat) || !['number', 'string'].includes(typeof lng)) return null;
  if (typeof lat === 'string' && !lat.trim()) return null;
  if (typeof lng === 'string' && !lng.trim()) return null;
  const a = Number(lat);
  const b = Number(lng);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (Math.abs(a) > 90 || Math.abs(b) > 180) return null;
  if (a === 0 && b === 0) return null;
  // Six decimals is ~11cm; more just bloats the request.
  return `${a.toFixed(6)},${b.toFixed(6)}`;
}

/**
 * Choose which trip places to measure against. Places without coordinates cannot
 * be routed to, and the cap keeps one page inside the matrix element limit.
 */
function pickDestinations(places, limit = MAX_DESTINATIONS) {
  const out = [];
  for (const p of Array.isArray(places) ? places : []) {
    if (!p || typeof p !== 'object') continue;
    const coord = coordString(p.lat, p.lng);
    if (!coord) continue;
    out.push({ id: p.id, name: typeof p.name === 'string' ? p.name : `Place ${p.id}`, coord });
    if (out.length >= limit) break;
  }
  return out;
}

function pickOrigins(listings, limit = MAX_ORIGINS) {
  const out = [];
  for (const l of Array.isArray(listings) ? listings : []) {
    if (!l || typeof l !== 'object' || l.id == null) continue;
    const coord = coordString(l.lat, l.lng);
    if (!coord) continue;
    out.push({ id: String(l.id), coord });
    if (out.length >= limit) break;
  }
  return out;
}

/** "12 mins" / 743 -> a compact label the card can show. */
function durationLabel(element) {
  const text = element && element.duration && typeof element.duration.text === 'string' ? element.duration.text : null;
  if (text) return text.replace(/\bmins\b/, 'min').replace(/\bhours\b/, 'hr').replace(/\bhour\b/, 'hr');
  const secs = durationSeconds(element);
  if (secs == null) return null;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

function durationSeconds(element) {
  if (!element || typeof element !== 'object') return null;
  const d = element.duration;
  if (d && ['number', 'string'].includes(typeof d.value) && d.value !== ''
      && Number.isFinite(Number(d.value))) return Number(d.value);
  if (['number', 'string'].includes(typeof d) && d !== '' && Number.isFinite(Number(d))) return Number(d);
  if (element.duration_seconds != null && element.duration_seconds !== ''
      && ['number', 'string'].includes(typeof element.duration_seconds)
      && Number.isFinite(Number(element.duration_seconds))) return Number(element.duration_seconds);
  return null;
}

/**
 * A matrix payload -> `{ [originId]: [{ placeId, name, label, seconds }] }`.
 *
 * Written defensively on purpose: this endpoint's shapes have already differed
 * from their documentation nine times, so anything missing degrades to "no time
 * for that pair" rather than throwing the whole page away. `rows[i].elements[j]`
 * is Google's own layout, which the tool is a thin wrapper over.
 */
function normalizeMatrix(payload, origins, destinations) {
  const out = {};
  if (!payload || typeof payload !== 'object') return out;
  const rows = Array.isArray(payload.rows) ? payload.rows : [];

  origins.forEach((origin, i) => {
    const row = rows[i];
    const elements = row && Array.isArray(row.elements) ? row.elements : [];
    const legs = [];
    destinations.forEach((dest, j) => {
      const el = elements[j];
      // Google marks unroutable pairs with a status; only OK carries a duration.
      if (!el || (typeof el.status === 'string' && el.status !== 'OK')) return;
      const label = durationLabel(el);
      if (!label) return;
      legs.push({
        placeId: dest.id,
        name: dest.name,
        label,
        seconds: durationSeconds(el),
        distance: el.distance && typeof el.distance.text === 'string' ? el.distance.text : null,
      });
    });
    if (legs.length) out[origin.id] = legs;
  });
  return out;
}

/** Validate and default the travel mode. */
function normalizeMode(mode) {
  return typeof mode === 'string' && MODES.has(mode) ? mode : 'transit';
}

module.exports = {
  coordString,
  pickDestinations,
  pickOrigins,
  normalizeMatrix,
  normalizeMode,
  durationLabel,
  durationSeconds,
  MAX_ORIGINS,
  MAX_DESTINATIONS,
  MODES,
};
