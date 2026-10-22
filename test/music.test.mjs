import test from 'node:test';
import assert from 'node:assert/strict';
import { composePhrase, MOODS, BARS, fitRange, midiToHz } from '../src/core/music.js';
import { skyState, DAY_LENGTH } from '../src/core/sky.js';

test('music: phrases are deterministic per seed and differ between seeds', () => {
  assert.deepEqual(composePhrase(5, 'day'), composePhrase(5, 'day'));
  assert.notDeepEqual(composePhrase(5, 'day').events, composePhrase(6, 'day').events);
});

test('music: every mood yields sorted, in-range, musical events', () => {
  for (const mood of Object.keys(MOODS)) {
    for (let seed = 1; seed <= 40; seed++) {
      const p = composePhrase(seed, mood);
      const cfg = MOODS[mood];
      const bar = (60 / cfg.bpm) * 4;
      assert.equal(p.bpm, cfg.bpm);
      assert.ok(p.duration > BARS * bar);
      let prev = -1;
      const pcs = new Set(cfg.scale.map((s) => (cfg.root + s) % 12));
      const voices = { pad: 0, bass: 0, lead: 0 };
      for (const e of p.events) {
        assert.ok(e.t >= prev - 1e-9, 'sorted');
        prev = e.t;
        assert.ok(e.t >= 0 && e.t < BARS * bar, 'starts inside the phrase');
        assert.ok(e.dur > 0 && e.vel > 0 && e.vel <= 0.5);
        voices[e.voice]++;
        if (e.voice === 'lead') {
          assert.ok(e.midi >= 67 && e.midi <= 88, 'lead range');
          assert.ok(pcs.has(e.midi % 12), `lead pitch ${e.midi} belongs to the scale`);
        }
        if (e.voice === 'bass') assert.ok(e.midi >= 34 && e.midi <= 50);
        if (e.voice === 'pad') assert.ok(e.midi >= 52 && e.midi <= 80);
      }
      assert.ok(voices.pad >= BARS * 3 && voices.bass >= BARS && voices.lead >= 6, JSON.stringify(voices));
    }
  }
});

test('music: the phrase ends by resolving to the tonic or fifth with a long lead note', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const p = composePhrase(seed, 'day');
    const leads = p.events.filter((e) => e.voice === 'lead');
    const last = leads[leads.length - 1];
    assert.ok([0, 7].includes((last.midi - MOODS.day.root) % 12), `ends on tonic/fifth (${last.midi})`);
    assert.ok(last.dur > (60 / MOODS.day.bpm) * 3);
  }
});

test('music helpers', () => {
  assert.equal(fitRange(30, 40, 51), 42);
  assert.equal(fitRange(100, 40, 51), 40 + ((100 - 40) % 12));
  assert.ok(Math.abs(midiToHz(69) - 440) < 1e-9);
  assert.ok(Math.abs(midiToHz(81) - 880) < 1e-9);
});

test('sky: noon is bright, midnight dark, sun and moon opposite', () => {
  const noon = skyState(0.25), night = skyState(0.75), dawn = skyState(0.0);
  assert.ok(noon.daylight > 0.95 && night.daylight < 0.4);
  assert.ok(noon.sunDir[1] > 0.9 && night.sunDir[1] < -0.9);
  assert.ok(!noon.isNight && night.isNight);
  assert.ok(noon.skyColor[2] > night.skyColor[2] * 4);
  assert.ok(Math.abs(noon.sunDir[0] + noon.moonDir[0]) < 1e-9);
  assert.ok(dawn.skyColor[0] > noon.skyColor[0], 'warm tint at the horizon');
  assert.ok(DAY_LENGTH >= 600);
  for (let t = 0; t < 1; t += 0.05) {
    const s = skyState(t);
    for (const c of [...s.skyColor, ...s.fogColor]) assert.ok(c >= 0 && c <= 1);
    assert.ok(s.daylight >= 0.3 && s.daylight <= 1);
  }
});
