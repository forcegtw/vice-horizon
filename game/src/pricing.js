// Gas-station till. The price table, the offer-board text and the price
// sanity guard live here, separate from Economy's money flow so a future
// data-driven price table only ever touches this file. Pure data and pure
// functions — no THREE, no DOM, no storage — the smoke harness exercises it
// through Economy without any browser around.
//
// Hotkey contract (mirrored in the offer lines): B health · N armor ·
// V engine tune · C plating. economy.buy() maps the same keys, so edit both
// sides together.

export const PRICES = {
  health: 150,       // full heal at a gas station
  armor: 400,        // full armor refill
  speed: 2500,       // permanent engine upgrade (one-time)
  plating: 1800,     // permanent armor upgrade (one-time)
};

// A future table must not brick the till: reject non-finite or negative
// prices before any cash moves. Zero-cost items stay legal (free promo).
export function priceCheck(cost) {
  return Number.isFinite(cost) && cost >= 0;
}

// Offer board lines for whatever the player can still buy — purchased
// one-time upgrades drop out of the list.
export function offerLines(upgrades) {
  const offers = ['B buy health $150', 'N buy armor $400'];
  if (!upgrades.speed) offers.push('V engine tune $2500');
  if (!upgrades.plating) offers.push('C plating $1800');
  return offers;
}

// Full menu toast text shown while parked inside a station canopy.
export function menuTitle(upgrades) {
  return 'GAS STATION — ' + offerLines(upgrades).join(' · ');
}
