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

/**
 * Read a field that the hosted endpoint returns as a bare string but the
 * open-source server wraps in an object (`{body}` / `{text}`). Verified against
 * real hosted output: `badges` is "Guest favourite", and structuredContent's
 * lines are plain strings — both were being silently dropped before.
 */
function textOf(value, keys) {
  if (typeof value === 'string') return value.trim() || null;
  if (value && typeof value === 'object') {
    for (const key of keys || ['body', 'text']) {
      if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim();
    }
  }
  return null;
}

/**
 * The next page's cursor.
 *
 * The hosted endpoint returns `pageCursors`: every page's cursor, in order —
 * not a "next" pointer. Reading it as one left the cursor null, so Load more
 * never appeared. Find where we are and step forward; the open-source server's
 * `nextPageCursor` still wins when present.
 */
function nextCursor(pagination, currentCursor) {
  if (!pagination || typeof pagination !== 'object') return null;
  if (typeof pagination.nextPageCursor === 'string' && pagination.nextPageCursor) return pagination.nextPageCursor;
  const cursors = Array.isArray(pagination.pageCursors) ? pagination.pageCursors : null;
  if (!cursors || !cursors.length) return typeof pagination.cursor === 'string' ? pagination.cursor : null;
  const index = currentCursor ? cursors.indexOf(currentCursor) : 0;
  if (index < 0) return null; // a cursor we did not issue — stop rather than loop
  return cursors[index + 1] || null;
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

  const sc = raw.structuredContent || {};

  const name =
    findString(raw.demandStayListing?.description || {}, [
      'localizedStringWithTranslationPreference',
      'name',
      'title',
    ]) ||
    textOf(sc.primaryLine) ||
    `Listing ${id}`;

  // The two servers use these lines differently. Open-source: mapCategoryInfo is the
  // category ("Entire rental unit") and mapSecondaryLine the size ("2 beds"). Hosted:
  // there is no mapCategoryInfo, primaryLine carries the room summary ("1 queen bed,
  // 1 bathroom") and secondaryLine the host ("Individual host"), with mapSecondaryLine
  // empty. Preferring the more specific field first satisfies both.
  const subtitle = textOf(sc.mapCategoryInfo) || textOf(sc.primaryLine) || null;
  const area = textOf(sc.mapSecondaryLine) || textOf(sc.secondaryLine) || null;

  return {
    id,
    url: typeof raw.url === 'string' ? raw.url : `${AIRBNB_ROOM}${id}`,
    name,
    subtitle: subtitle === name ? null : subtitle,
    area,
    badge: textOf(raw.badges, ['text']),
    priceLabel,
    priceAmount: parsePriceAmount(priceLabel),
    ratingLabel,
    rating,
    reviews,
    lat: coords ? coords.lat : null,
    lng: coords ? coords.lng : null,
    photos: photosOf(raw).slice(0, 6),
  };
}

/**
 * The hosted endpoint returns an explicit `photos` array (and a `thumbnailUrl`),
 * already proxied through its own /image endpoint. Prefer those; fall back to
 * scanning for image URLs, which is all the open-source server would ever offer.
 */
function photosOf(raw) {
  const out = [];
  const push = (u) => { if (typeof u === 'string' && u && !out.includes(u)) out.push(u); };
  if (Array.isArray(raw.photos)) raw.photos.forEach(push);
  push(raw.thumbnailUrl);
  if (!out.length) findPhotos(raw).forEach(push);
  return out;
}

/** `airbnb_search` payload -> { results, cursor, searchUrl }. Throws on a tool-level error. */
function normalizeSearch(payload, currentCursor) {
  if (!payload || typeof payload !== 'object') throw new Error('empty search payload');
  if (payload.error) {
    const err = new Error(String(payload.error));
    err.searchUrl = payload.searchUrl || payload.url || null;
    throw err;
  }
  const raw = Array.isArray(payload.searchResults) ? payload.searchResults : [];
  const results = raw.map(normalizeResult).filter(Boolean);
  return {
    results,
    cursor: nextCursor(payload.paginationInfo, currentCursor),
    searchUrl: payload.searchUrl || null,
  };
}


/**
 * Amenity groups. The hosted server returns an ARRAY of
 * `{title, amenities:[{title}]}`; the open-source one an object keyed by group
 * with a comma-joined string. Reading only the latter left amenities empty.
 */
function amenityGroups(raw) {
  const out = {};
  if (Array.isArray(raw)) {
    for (const group of raw) {
      if (!group || typeof group !== 'object') continue;
      const name = typeof group.title === 'string' ? group.title.trim() : '';
      const items = Array.isArray(group.amenities)
        ? group.amenities
            .map((a) => (a && typeof a.title === 'string' ? a.title.trim() : typeof a === 'string' ? a.trim() : ''))
            .filter(Boolean)
        : [];
      if (name && items.length) out[name] = items.join(', ');
    }
    return out;
  }
  if (raw && typeof raw === 'object') {
    for (const [name, value] of Object.entries(raw)) {
      if (typeof value === 'string' && value.trim()) out[name] = value.trim();
    }
  }
  return out;
}

/**
 * The description arrives as HTML (`{htmlText}` with `<br />` breaks). The frame
 * escapes what it renders and relies on white-space:pre-wrap, so the markup has to
 * become real line breaks here or it shows up literally as "<br />".
 */
function htmlToText(value) {
  const html =
    typeof value === 'string'
      ? value
      : value && typeof value === 'object' && typeof value.htmlText === 'string'
        ? value.htmlText
        : null;
  if (!html) return null;
  const text = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text || null;
}

/** Highlights: an array of `{title}` on the hosted server, a string elsewhere. */
function highlightsOf(value) {
  if (typeof value === 'string') return value.trim() || null;
  if (!Array.isArray(value)) return null;
  const items = value
    .map((h) => (h && typeof h === 'object' && typeof h.title === 'string' ? h.title.trim() : typeof h === 'string' ? h.trim() : ''))
    .filter(Boolean);
  return items.length ? items.join('\n') : null;
}

/**
 * `airbnb_listing` / `airbnb_listing_details` payload -> a flat detail record.
 * The details tool returns a `details` array of page sections whose ids differ by
 * listing, so amenities/rules are gathered by scanning rather than by index.
 */
function normalizeListing(id, payload) {
  if (!payload || typeof payload !== 'object') throw new Error('empty listing payload');
  if (payload.error) throw new Error(String(payload.error));

  const sections = Array.isArray(payload.details) ? payload.details : [];
  const byId = {};
  for (const section of sections) {
    if (section && typeof section === 'object' && typeof section.id === 'string') byId[section.id] = section;
  }

  const location = byId.LOCATION_DEFAULT || {};
  const coords = findCoords(payload);

  return {
    id: String(id),
    // The hosted server calls this `listingUrl`, and it carries the dates and guest
    // count — worth keeping over a URL rebuilt from the id alone.
    url:
      (typeof payload.listingUrl === 'string' && payload.listingUrl) ||
      (typeof payload.url === 'string' && payload.url) ||
      `${AIRBNB_ROOM}${id}`,
    title: textOf(byId.TITLE_DEFAULT && byId.TITLE_DEFAULT.title) || findString(payload, ['title']),
    location: textOf(location.subtitle) || textOf(location.title) || null,
    description: htmlToText(byId.DESCRIPTION_DEFAULT && byId.DESCRIPTION_DEFAULT.htmlDescription),
    highlights: highlightsOf(byId.HIGHLIGHTS_DEFAULT && byId.HIGHLIGHTS_DEFAULT.highlights),
    houseRules:
      textOf(byId.POLICIES_DEFAULT && byId.POLICIES_DEFAULT.houseRules) ||
      highlightsOf(byId.POLICIES_DEFAULT && byId.POLICIES_DEFAULT.houseRules) ||
      null,
    amenities: amenityGroups(
      payload.seeAllAmenitiesGroups || (byId.AMENITIES_DEFAULT && byId.AMENITIES_DEFAULT.seeAllAmenitiesGroups),
    ),
    lat: coords ? coords.lat : null,
    lng: coords ? coords.lng : null,
    photos: photosOf(payload).slice(0, 8),
  };
}

module.exports = {
  normalizeSearch,
  normalizeListing,
  nextCursor,
  textOf,
  amenityGroups,
  htmlToText,
  highlightsOf,
  photosOf,
  normalizeResult,
  parseRating,
  parsePriceAmount,
  findCoords,
  findPhotos,
  findString,
};
