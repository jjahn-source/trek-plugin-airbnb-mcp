'use strict';

/**
 * Turn OpenBnB tool payloads into the flat shape the client renders.
 *
 * The hosted openbnb.ai endpoint is a superset of the open-source server, and the
 * open-source server itself reshapes whatever Airbnb's page happens to contain
 * (arrays are joined into strings, optional subtrees come and go). So this file
 * never indexes a deep path directly — it searches for the value it wants and
 * falls back cleanly. A listing that is missing a price or a photo still renders;
 * only `id` is truly required.
 */

const AIRBNB_ROOM = 'https://www.airbnb.com/rooms/';

/** Depth-first search for the first value under `keys` that is a non-empty string. */
function findString(node, keys, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return null;
  for (const key of keys) {
    const v = node[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') {
      const hit = findString(value, keys, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

/** Depth-first search for a numeric lat/lng pair. */
function findCoords(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return null;
  const lat = node.latitude ?? node.lat;
  const lng = node.longitude ?? node.lng ?? node.lon;
  if (Number.isFinite(Number(lat)) && Number.isFinite(Number(lng))) {
    const la = Number(lat);
    const ln = Number(lng);
    // Guard against a "0,0" placeholder and out-of-range junk.
    if ((la !== 0 || ln !== 0) && Math.abs(la) <= 90 && Math.abs(ln) <= 180) {
      return { lat: la, lng: ln };
    }
  }
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') {
      const hit = findCoords(value, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

/** Collect https image URLs anywhere in the payload (the hosted endpoint may include them). */
function findPhotos(node, out = [], depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8 || out.length >= 8) return out;
  for (const value of Object.values(node)) {
    if (typeof value === 'string') {
      if (/^https:\/\/[^\s"']+\.(?:jpg|jpeg|png|webp|avif)(?:\?[^\s"']*)?$/i.test(value) && !out.includes(value)) {
        out.push(value);
      }
    } else if (value && typeof value === 'object') {
      findPhotos(value, out, depth + 1);
    }
  }
  return out;
}

/**
 * "4.92 out of 5 average rating, 148 reviews" -> { rating: 4.92, reviews: 148 }.
 * Airbnb also emits "New" for unrated listings, which yields nulls rather than a 0
 * that would sort as "terrible".
 */
function parseRating(label) {
  if (typeof label !== 'string') return { rating: null, reviews: null };
  const rating = label.match(/([\d.]+)\s*out of\s*5/i);
  const reviews = label.match(/([\d,]+)\s*review/i);
  return {
    rating: rating ? Number(rating[1]) : null,
    reviews: reviews ? Number(reviews[1].replace(/,/g, '')) : null,
  };
}

/**
 * Pull a comparable number out of a price label like "$1,234 total" or "€1.234".
 * Used only for client-side sorting — the label stays the source of truth on screen,
 * because we cannot reliably know whether a figure is nightly or total.
 *
 * Locale matters here: Airbnb renders prices in the viewer's locale, so "1.234" is
 * one thousand two hundred and thirty-four in most of Europe and one-point-two-three-four
 * nowhere useful. Treating it as a decimal made a €1,234 stay sort below a €99 one.
 * Rule: the LAST separator decides. Followed by exactly three digits (and not paired
 * with another separator) it is a thousands separator; otherwise it is the decimal point.
 */
function parsePriceAmount(label) {
  if (typeof label !== 'string') return null;
  const m = label.replace(/[\u00a0\u202f]/g, ' ').match(/\d[\d.,\s]*/);
  if (!m) return null;
  let s = m[0].replace(/\s/g, '').replace(/[.,]$/, '');
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  const lastSep = Math.max(lastComma, lastDot);

  if (lastSep === -1) {
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  const decimals = s.length - lastSep - 1;
  const hasBoth = lastComma !== -1 && lastDot !== -1;
  if (decimals === 3 && !hasBoth) {
    s = s.replace(/[.,]/g, '');
  } else {
    s = `${s.slice(0, lastSep).replace(/[.,]/g, '')}.${s.slice(lastSep + 1)}`;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function normalizeResult(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = raw.id != null ? String(raw.id) : null;
  if (!id) return null;

  const priceLabel =
    findString(raw.structuredDisplayPrice || {}, ['accessibilityLabel']) ||
    findString(raw.structuredDisplayPrice || {}, ['priceString']) ||
    null;

  const ratingLabel = typeof raw.avgRatingA11yLabel === 'string' ? raw.avgRatingA11yLabel : null;
  const { rating, reviews } = parseRating(ratingLabel);
  const coords = findCoords(raw.demandStayListing || raw) || null;

  const name =
    findString(raw.demandStayListing?.description || {}, [
      'localizedStringWithTranslationPreference',
      'name',
      'title',
    ]) ||
    findString(raw.structuredContent || {}, ['primaryLine', 'body']) ||
    `Listing ${id}`;

  const subtitle =
    findString(raw.structuredContent?.mapCategoryInfo || {}, ['body']) ||
    findString(raw.structuredContent?.secondaryLine || {}, ['body']) ||
    null;

  const area = findString(raw.structuredContent?.mapSecondaryLine || {}, ['body']) || null;

  return {
    id,
    url: typeof raw.url === 'string' ? raw.url : `${AIRBNB_ROOM}${id}`,
    name,
    subtitle,
    area,
    badge: findString(raw.badges || {}, ['text']),
    priceLabel,
    priceAmount: parsePriceAmount(priceLabel),
    ratingLabel,
    rating,
    reviews,
    lat: coords ? coords.lat : null,
    lng: coords ? coords.lng : null,
    photos: findPhotos(raw).slice(0, 3),
  };
}

/** `airbnb_search` payload -> { results, cursor, searchUrl }. Throws on a tool-level error. */
function normalizeSearch(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('empty search payload');
  if (payload.error) {
    const err = new Error(String(payload.error));
    err.searchUrl = payload.searchUrl || payload.url || null;
    throw err;
  }
  const raw = Array.isArray(payload.searchResults) ? payload.searchResults : [];
  const results = raw.map(normalizeResult).filter(Boolean);
  const pagination = payload.paginationInfo || {};
  return {
    results,
    cursor: pagination.nextPageCursor || pagination.cursor || null,
    searchUrl: payload.searchUrl || null,
  };
}

/**
 * `airbnb_listing_details` payload -> a flat detail record.
 * The details tool returns a `details` array of page sections whose ids differ by
 * listing, so amenities/rules are gathered by scanning rather than by index.
 */
function normalizeListing(id, payload) {
  if (!payload || typeof payload !== 'object') throw new Error('empty listing payload');
  if (payload.error) throw new Error(String(payload.error));

  const sections = Array.isArray(payload.details) ? payload.details : [];
  const byId = {};
  for (const s of sections) {
    if (s && typeof s === 'object' && typeof s.id === 'string') byId[s.id] = s;
  }

  const amenities = {};
  const groups = payload.seeAllAmenitiesGroups || byId.AMENITIES_DEFAULT?.seeAllAmenitiesGroups;
  if (groups && typeof groups === 'object') {
    for (const [group, value] of Object.entries(groups)) {
      if (typeof value === 'string' && value.trim()) amenities[group] = value.trim();
    }
  }

  const coords = findCoords(payload);
  return {
    id: String(id),
    url: typeof payload.url === 'string' ? payload.url : `${AIRBNB_ROOM}${id}`,
    title: findString(byId.TITLE_DEFAULT || {}, ['title', 'body']) || findString(payload, ['title']),
    description:
      findString(byId.DESCRIPTION_DEFAULT || {}, ['htmlDescription', 'body', 'text']) || null,
    highlights: findString(byId.HIGHLIGHTS_DEFAULT || {}, ['body', 'highlights']) || null,
    houseRules: findString(byId.POLICIES_DEFAULT || {}, ['houseRules', 'body']) || null,
    amenities,
    lat: coords ? coords.lat : null,
    lng: coords ? coords.lng : null,
    photos: findPhotos(payload).slice(0, 6),
  };
}

module.exports = {
  normalizeSearch,
  normalizeListing,
  normalizeResult,
  parseRating,
  parsePriceAmount,
  findCoords,
  findPhotos,
  findString,
};
