/* ComfortRoute — manually seeded Brisbane POIs (approximate coords).
 * Merged with live OpenStreetMap amenities; each: id, type (water|bench|cool),
 * lat, lon, name, dog (dog-friendly water). */
'use strict';
const SEED_POIS = [
  // ---- Water taps / fountains ----
  { id: 'seed-w1', type: 'water', lat: -27.4767, lon: 153.0246, name: 'South Bank — Streets Beach tap', dog: true },
  { id: 'seed-w2', type: 'water', lat: -27.4779, lon: 153.0226, name: 'South Bank — Rainforest Green fountain', dog: false },
  { id: 'seed-w3', type: 'water', lat: -27.4746, lon: 153.0305, name: 'City Botanic Gardens — main fountain', dog: false },
  { id: 'seed-w4', type: 'water', lat: -27.4739, lon: 153.0292, name: 'City Botanic Gardens — riverside tap', dog: true },
  { id: 'seed-w5', type: 'water', lat: -27.4604, lon: 153.0178, name: 'Roma Street Parkland — Spectacle Garden tap', dog: false },
  { id: 'seed-w6', type: 'water', lat: -27.4737, lon: 153.0494, name: 'New Farm Park — playground tap', dog: true },
  { id: 'seed-w7', type: 'water', lat: -27.4776, lon: 153.0392, name: 'Kangaroo Point Cliffs — park tap', dog: true },
  { id: 'seed-w8', type: 'water', lat: -27.4735, lon: 153.0360, name: 'Riverwalk — water station', dog: false },
  { id: 'seed-w9', type: 'water', lat: -27.4780, lon: 153.0380, name: 'Captain Burke Park — tap (under Story Bridge)', dog: true },
  { id: 'seed-w10', type: 'water', lat: -27.4626, lon: 153.0147, name: 'Victoria Park — golf course path tap', dog: true },
  { id: 'seed-w11', type: 'water', lat: -27.4824, lon: 153.0155, name: 'Orleigh Park — West End tap', dog: true },
  { id: 'seed-w12', type: 'water', lat: -27.4740, lon: 153.0420, name: 'Mowbray Park — East City tap', dog: false },

  // ---- Benches / rest points ----
  { id: 'seed-b1', type: 'bench', lat: -27.4773, lon: 153.0237, name: 'South Bank — riverfront bench' },
  { id: 'seed-b2', type: 'bench', lat: -27.4751, lon: 153.0298, name: 'City Botanic Gardens — mangrove boardwalk bench' },
  { id: 'seed-b3', type: 'bench', lat: -27.4768, lon: 153.0383, name: 'Kangaroo Point Cliffs — outlook bench' },
  { id: 'seed-b4', type: 'bench', lat: -27.4743, lon: 153.0470, name: 'New Farm Powerhouse lawn bench' },
  { id: 'seed-b5', type: 'bench', lat: -27.4651, lon: 153.0210, name: 'Roma Street Parkland — lookout bench' },
  { id: 'seed-b6', type: 'bench', lat: -27.4810, lon: 153.0131, name: 'Davies Park — bench' },

  // ---- Air-conditioned public spaces ----
  { id: 'seed-c1', type: 'cool', lat: -27.4770, lon: 153.0249, name: 'State Library of Queensland' },
  { id: 'seed-c2', type: 'cool', lat: -27.4770, lon: 153.0226, name: 'Gallery of Modern Art (GOMA)' },
  { id: 'seed-c3', type: 'cool', lat: -27.4705, lon: 153.0210, name: 'Brisbane Square Library' },
  { id: 'seed-c4', type: 'cool', lat: -27.4774, lon: 153.0283, name: 'QUT Gardens Point Library' },
  { id: 'seed-c5', type: 'cool', lat: -27.4745, lon: 153.0486, name: 'Brisbane Powerhouse' }
];