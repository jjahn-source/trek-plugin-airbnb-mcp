'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { project, tileUrl, staticMap, TILE, GRID } = require('../server/map');

/**
 * Web-Mercator tile maths. The reference values are real tiles: 14/8296/5636 covers the
 * Eiffel Tower and was confirmed to return an image from the default tile source.
 */
test('projects a known point onto the right tile', () => {
  const p = project(48.8584, 2.2945, 14); // Eiffel Tower
  assert.equal(Math.floor(p.x), 8296);
  assert.equal(Math.floor(p.y), 5636);
});

test('zoom 0 puts every point inside the single world tile', () => {
  for (const [lat, lng] of [[0, 0], [48.85, 2.29], [-33.86, 151.2], [64.1, -21.9]]) {
    const p = project(lat, lng, 0);
    assert.ok(p.x >= 0 && p.x < 1, `x for ${lat},${lng}`);
    assert.ok(p.y >= 0 && p.y < 1, `y for ${lat},${lng}`);
  }
});

test('latitude is clamped to the Mercator limit instead of going infinite', () => {
  const p = project(89.9, 0, 10);
  // Without the clamp tan(90°) sends this to Infinity; and a y a few billionths below
  // zero floors to tile -1, shifting the whole mosaic. It must land inside [0, n).
  assert.ok(Number.isFinite(p.y));
  assert.ok(p.y >= 0, `y=${p.y}`);
  assert.equal(Math.floor(p.y), 0);
});

test('fills every placeholder in a tile template', () => {
  const url = tileUrl('https://{s}.tiles.example/{z}/{x}/{y}{r}.png', 14, 8296, 5636);
  assert.equal(url, 'https://a.tiles.example/14/8296/5636.png');
});

test('a template without placeholders is left alone rather than mangled', () => {
  assert.equal(tileUrl('https://example.com/static.png', 1, 2, 3), 'https://example.com/static.png');
});

/**
 * staticMap does the fetching, so the network is stubbed to keep this a unit test.
 * Each case uses its own template host: tiles are cached by URL for the life of the
 * process, so sharing one would serve an earlier case's result.
 */
function withFetch(impl, fn) {
  const real = global.fetch;
  global.fetch = impl;
  return fn().finally(() => { global.fetch = real; });
}

const okTile = () => ({
  ok: true,
  headers: { get: () => 'image/png' },
  arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
});

test('builds a full mosaic and centres the point inside it', async () => {
  await withFetch(async () => okTile(), async () => {
    const m = await staticMap({ lat: 48.8584, lng: 2.2945, zoom: 14, template: 'https://mosaic/{z}/{x}/{y}.png' });
    assert.equal(m.tiles.length, GRID * GRID);
    assert.ok(m.tiles.every((t) => typeof t === 'string' && t.startsWith('data:image/png;base64,')));
    // The marker sits inside the centre tile of the mosaic.
    assert.ok(m.markerX >= TILE && m.markerX <= TILE * 2);
    assert.ok(m.markerY >= TILE && m.markerY <= TILE * 2);
  });
});

test('one failing tile leaves a hole, it does not fail the whole map', async () => {
  let n = 0;
  await withFetch(async () => { n += 1; return n === 3 ? { ok: false, status: 500 } : okTile(); }, async () => {
    const m = await staticMap({ lat: 0, lng: 0, zoom: 5, template: 'https://hole/{z}/{x}/{y}.png' });
    assert.equal(m.tiles.length, GRID * GRID);
    assert.equal(m.tiles.filter((t) => t === null).length, 1);
    assert.ok(m.tiles.some(Boolean));
  });
});

test('a non-image response is refused rather than embedded', async () => {
  await withFetch(async () => ({ ok: true, headers: { get: () => 'text/html' }, arrayBuffer: async () => new ArrayBuffer(4) }), async () => {
    const m = await staticMap({ lat: 0, lng: 0, zoom: 5, template: 'https://nonimage/{z}/{x}/{y}.png' });
    assert.ok(m.tiles.every((t) => t === null));
  });
});

test('rows off the top of the world are skipped, not requested', async () => {
  const asked = [];
  await withFetch(async (u) => { asked.push(u); return okTile(); }, async () => {
    // Near the north pole at zoom 1 the row above the centre tile does not exist.
    await staticMap({ lat: 85, lng: 0, zoom: 1, template: 'https://poles/{z}/{x}/{y}.png' });
  });
  assert.ok(asked.every((u) => !/\/-1\.png$/.test(u)), asked.join(','));
});

test('columns wrap around the antimeridian instead of going negative', async () => {
  const asked = [];
  await withFetch(async (u) => { asked.push(u); return okTile(); }, async () => {
    await staticMap({ lat: 0, lng: -179.9, zoom: 2, template: 'https://wrap/{z}/{x}/{y}.png' });
  });
  assert.ok(asked.every((u) => !u.includes('/-')), asked.join(','));
});

/**
 * The content type is not just a gate, it is CONCATENATED into the `data:` URI the
 * client puts in an <img src>. A tile server that answers
 *   Content-Type: image/png" onerror="…
 * would otherwise close the src attribute and open an event handler inside the frame.
 * `startsWith('image/')` passes that string happily, so the check has to name the
 * subtypes it accepts rather than describe the prefix it wants.
 */
test('a content type that only STARTS as an image is refused', async () => {
  const crafted = 'image/png" onerror="alert(1)';
  await withFetch(async () => ({
    ok: true,
    headers: { get: () => crafted },
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
  }), async () => {
    const m = await staticMap({ lat: 0, lng: 0, zoom: 5, template: 'https://crafted/{z}/{x}/{y}.png' });
    assert.ok(m.tiles.every((t) => t === null), 'a crafted content type must yield no tile');
  });
});

test('the real image subtypes are still accepted', async () => {
  for (const [type, host] of [['image/png', 'png'], ['image/jpeg', 'jpeg'], ['image/webp', 'webp']]) {
    await withFetch(async () => ({
      ok: true,
      headers: { get: () => type },
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    }), async () => {
      const m = await staticMap({ lat: 0, lng: 0, zoom: 5, template: `https://${host}/{z}/{x}/{y}.png` });
      assert.ok(m.tiles.some((t) => t && t.startsWith(`data:${type};base64,`)), type);
    });
  }
});
