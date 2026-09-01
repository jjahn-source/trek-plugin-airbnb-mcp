'use strict';
/**
 * "Three nights with nowhere to stay."
 *
 * For a plugin about stays, that is the most useful sentence it can say — and the
 * planner already has a place to say it. The hard part is not finding the gap, it is
 * knowing when to keep quiet: a warning provider runs on every trip in an instance
 * that installed this, so one that speaks up unprompted becomes the noisiest thing in
 * the planner and gets the whole plugin uninstalled.
 *
 * The rule these tests pin down: speak only to someone who has already started
 * booking lodging. Zero accommodations is not a problem to report, it is a trip whose
 * lodging is handled elsewhere, or not yet begun.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMockHost } = require('trek-plugin-sdk/testing');
const plugin = require('../server/index.js');

const GRANTS = ['db:own', 'db:read:trips', 'hook:trip-warning-provider'];

/**
 * A trip with `days` consecutive days from 2026-10-10.
 *
 * `book` names lodging blocks by DAY INDEX — [[0, 1]] is "booked from the first day to
 * the second" — because the day ids do not exist until this function has built them.
 */
function tripHost({ days = 5, book = [], grants = GRANTS } = {}) {
  const dayRows = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.UTC(2026, 9, 10 + i));
    dayRows.push({ id: 100 + i, date: d.toISOString().slice(0, 10) });
  }
  const accommodations = book.map(([from, to], i) => ({
    id: i + 1,
    start_day_id: dayRows[from].id,
    end_day_id: dayRows[to].id,
  }));

  return {
    dayRows,
    host: createMockHost({
      grants,
      actingUserId: 42,
      trips: {
        7: {
          members: [42],
          data: { id: 7, title: 'Japan', start_date: '2026-10-10' },
          days: dayRows,
          accommodations,
        },
      },
    }),
  };
}

const warn = async (h) => plugin.hooks.warningProvider.getWarnings(7, h.ctx);

test('a trip with no lodging at all is left alone', async () => {
  const { host } = tripHost({ book: [] });
  assert.deepEqual(await warn(host), [],
    'a trip that has not started booking is not a trip with a problem');
});

test('a trip whose lodging covers every night says nothing', async () => {
  const { host } = tripHost({ days: 5, book: [[0, 4]] });
  assert.deepEqual(await warn(host), []);
});

test('a gap between two booked stays is reported', async () => {
  // Six days is five nights (the sixth is check-out). Booking day 0->1 covers night 0
  // and day 4->5 covers night 4, leaving nights 1, 2 and 3 uncovered.
  const { host } = tripHost({ days: 6, book: [[0, 1], [4, 5]] });
  const out = await warn(host);
  assert.equal(out.length, 1);
  assert.equal(out[0].level, 'info');
  assert.match(out[0].message, /3 nights/);
});

test('the warning points at a day, so the planner can take you there', async () => {
  const { host, dayRows } = tripHost({ days: 4, book: [[0, 1]] });
  const out = await warn(host);
  assert.equal(out.length, 1);
  assert.equal(out[0].dayId, dayRows[1].id, 'the first uncovered night');
});

test('one uncovered night is worded as one, not "1 nights"', async () => {
  const { host } = tripHost({ days: 3, book: [[0, 1]] });
  const out = await warn(host);
  assert.match(out[0].message, /1 night\b/);
  assert.doesNotMatch(out[0].message, /1 nights/);
});

/**
 * The final night of a trip is a CHECK-OUT day, not a night anyone sleeps through.
 * Counting it would tell every correctly-booked trip it had a hole on its last day.
 */
test('the departure day is not counted as an unbooked night', async () => {
  const { host } = tripHost({ days: 4, book: [[0, 3]] });
  assert.deepEqual(await warn(host), []);
});

test('a refused read degrades to silence rather than breaking the planner', async () => {
  // No db:read:trips: the host throws PERMISSION_DENIED. A warning provider that
  // propagates that is a plugin that can break somebody else's trip page.
  const { host } = tripHost({ grants: ['db:own', 'hook:trip-warning-provider'] });
  assert.deepEqual(await warn(host), []);
});
