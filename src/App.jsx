import { Midi } from '@tonejs/midi';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownUp, ArrowLeftRight, FileMusic, Pause, Play, RotateCcw, Volume2 } from 'lucide-react';

const DEFAULT_SONG_LENGTH = 46;
const PREROLL_SECONDS = 3;
const AUDIO_LOOKAHEAD_SECONDS = 1.5;
const FUTURE_PREVIEW_MEASURES = 4;
const EXIT_TRAIL_MEASURES = 1;
const VERTICAL_TARGET_POSITION = 72;
const PREVIEW_SLOT_SCALE = 1.08;
const STRIP_EDGE_PADDING = 24;
const HINT_PULSE_WINDOW = 0.18;
const REFERENCE_BPM = 120;
const MAX_NATIVE_BPM = 240;
const GAME_BOX_SLOTS = 4;
const MELODY_MIN_MIDI = 48;
const JUDGEMENTS = [
  { name: 'Perfect', window: 0.055, score: 1000 },
  { name: 'Good', window: 0.16, score: 450 },
];
const BURST_COLORS = ['#36cfc9', '#f5c84c', '#ff6b8a', '#f8fbff'];
const DEFAULT_BURST = {
  intensity: 1,
  flashScale: 2.8,
  ringScale: 3,
  sparks: Array.from({ length: 8 }, (_, index) => {
    const angle = (Math.PI * 2 * index) / 8;
    return {
      x1: Math.cos(angle) * 7,
      y1: Math.sin(angle) * 7,
      x2: Math.cos(angle) * 22,
      y2: Math.sin(angle) * 22,
      color: BURST_COLORS[index % BURST_COLORS.length],
      delay: 0,
      width: 3,
    };
  }),
};

function midiToFrequency(midi) {
  return 440 * 2 ** ((midi - 69) / 12);
}

function cloneMeasures(measures) {
  return measures.map((measure) => ({
    ...measure,
    state: 'waiting',
    dots: measure.dots.map((dot) => ({
      ...dot,
      hit: false,
      hitOrder: null,
      missed: false,
      burst: null,
      hitJudgement: null,
    })),
  }));
}

function getComboIntensity(comboValue) {
  if (comboValue >= 100) return 3;
  if (comboValue >= 10) return 2;
  return 1;
}

function createHitBurst(intensity = 1) {
  const power = Math.max(1, Math.min(3, intensity));
  const sparkCount = 7 + Math.floor(Math.random() * 6) + (power - 1) * 4;
  const spin = Math.random() * Math.PI * 2;

  return {
    intensity: power,
    flashScale: 2.2 + Math.random() * 1.2 + (power - 1) * 0.7,
    ringScale: 2.6 + Math.random() * 1.1 + (power - 1) * 0.55,
    sparks: Array.from({ length: sparkCount }, (_, index) => {
      const spread = (Math.PI * 2 * index) / sparkCount;
      const angle = spread + spin + (Math.random() - 0.5) * (0.55 + (power - 1) * 0.12);
      const startDistance = 5 + Math.random() * 4 + (power - 1) * 1.5;
      const endDistance = 15 + Math.random() * 14 + (power - 1) * 8;
      const color = BURST_COLORS[Math.floor(Math.random() * BURST_COLORS.length)];

      return {
        x1: Math.cos(angle) * startDistance,
        y1: Math.sin(angle) * startDistance,
        x2: Math.cos(angle) * endDistance,
        y2: Math.sin(angle) * endDistance,
        color,
        delay: Math.random() * 80,
        width: 2.2 + Math.random() * 2.4 + (power - 1) * 0.55,
      };
    }),
  };
}

function getDotPosition(beatIndex, beatCount, radius = 42) {
  const angle = -Math.PI / 2 + ((Math.PI * 2) / Math.max(1, beatCount)) * beatIndex;
  return {
    x: Math.cos(angle) * radius,
    y: Math.sin(angle) * radius,
  };
}

function describeArc(start, end, beatCount) {
  const startPosition = getDotPosition(start.beatIndex, beatCount, 33);
  const endPosition = getDotPosition(end.beatIndex, beatCount, 33);
  const diff = (end.beatIndex - start.beatIndex + beatCount) % beatCount;
  const largeArc = diff > beatCount / 2 ? 1 : 0;

  return [
    `M ${50 + startPosition.x} ${50 + startPosition.y}`,
    `A 33 33 0 ${largeArc} 1 ${50 + endPosition.x} ${50 + endPosition.y}`,
  ].join(' ');
}

function MeasureGlyph({ beatCount, hintEnabled, measure, songTime }) {
  const hitDots = measure.dots
    .filter((dot) => dot.hit)
    .sort((a, b) => a.hitOrder - b.hitOrder);

  return (
    <svg className="measure-glyph" viewBox="0 0 100 100" aria-hidden="true">
      <circle className="beat-guide" cx="50" cy="50" r="33" />
      {hitDots.slice(1).map((dot) => {
        const previous = measure.dots.find((item) => item.hitOrder === dot.hitOrder - 1);
        if (!previous || dot.beatIndex !== previous.beatIndex + 1) return null;
        return (
          <path
            className="beat-link"
            d={describeArc(previous, dot, beatCount)}
            key={`${previous.id}-${dot.id}`}
          />
        );
      })}
      {Array.from({ length: beatCount }, (_, beatIndex) => {
        const dot = measure.dots.find((item) => item.beatIndex === beatIndex);
        const { x, y } = getDotPosition(beatIndex, beatCount, 33);
        const beatProgress = beatIndex / Math.max(1, beatCount);
        const beatTime = dot?.time ?? measure.startTime + (measure.endTime - measure.startTime) * beatProgress;
        const shouldHint = hintEnabled && !dot?.hit && Math.abs(beatTime - songTime) <= HINT_PULSE_WINDOW;
        return (
          <circle
            className={`beat-dot ${dot ? 'active' : 'empty'} ${dot?.hit ? 'hit' : ''} ${
              dot?.missed ? 'missed' : ''
            } ${shouldHint ? 'hint' : ''}`}
            cx={50 + x}
            cy={50 + y}
            key={`${measure.id}-${beatIndex}`}
            r="5.5"
          />
        );
      })}
      {hitDots.map((dot) => {
        const { x, y } = getDotPosition(dot.beatIndex, beatCount, 33);
        const cx = 50 + x;
        const cy = 50 + y;
        const burst = dot.burst ?? DEFAULT_BURST;
        const isGood = dot.hitJudgement === 'Good';
        const intensity = burst.intensity ?? 1;
        return (
          <g
            className={`hit-burst combo-intensity-${intensity} ${isGood ? 'good' : 'perfect'}`}
            key={`burst-${dot.id}`}
          >
            {isGood ? (
              <>
                <circle
                  className="good-burst-core"
                  cx={cx}
                  cy={cy}
                  r="4"
                  style={{ '--good-core-scale': 1.9 + intensity * 0.45 }}
                />
                <circle
                  className="good-burst-ring"
                  cx={cx}
                  cy={cy}
                  r="6"
                  style={{ '--good-ring-radius': 15 + intensity * 5 }}
                />
              </>
            ) : (
              <>
                <circle
                  className="burst-flash"
                  cx={cx}
                  cy={cy}
                  r="3.5"
                  style={{ '--flash-scale': burst.flashScale }}
                />
                <circle
                  className="burst-ring"
                  cx={cx}
                  cy={cy}
                  r="6"
                  style={{ '--ring-scale': burst.ringScale }}
                />
                {burst.sparks.map((spark, index) => {
                  return (
                    <line
                      className="burst-spark"
                      x1={cx + spark.x1}
                      x2={cx + spark.x2}
                      y1={cy + spark.y1}
                      y2={cy + spark.y2}
                      key={`${dot.id}-spark-${index}`}
                      style={{
                        '--spark-delay': `${spark.delay}ms`,
                        stroke: spark.color,
                        strokeWidth: spark.width,
                      }}
                    />
                  );
                })}
              </>
            )}
          </g>
        );
      })}
    </svg>
  );
}

function getTimeSignature(midi) {
  const events = midi.header.timeSignatures;

  if (!events.length) {
    return { beatsPerMeasure: 4, beatUnit: 4 };
  }

  const durationBySignature = new Map();
  events.forEach((event, index) => {
    const signature = event.timeSignature ?? [4, 4];
    const key = `${signature[0] || 4}/${signature[1] || 4}`;
    const nextTicks = events[index + 1]?.ticks ?? midi.durationTicks;
    const durationTicks = Math.max(0, nextTicks - event.ticks);
    durationBySignature.set(key, (durationBySignature.get(key) ?? 0) + durationTicks);
  });

  const [signatureKey] = [...durationBySignature.entries()].sort((a, b) => b[1] - a[1])[0];
  const signature = signatureKey.split('/').map(Number);
  const beatsPerMeasure = Math.max(1, signature[0] || 4);
  const beatUnit = Math.max(1, signature[1] || 4);
  return { beatsPerMeasure, beatUnit };
}

function buildMeasuresFromGrid({
  title,
  sourceNoteCount,
  songNotes,
  duration,
  beatsPerMeasure,
  measureCount,
  beatTimeAt,
  getMeasureBpm = () => null,
  candidates,
}) {
  const candidateBySlot = new Map();

  candidates.forEach((candidate) => {
    const key = `${candidate.measureIndex}:${candidate.beatIndex}`;
    const previous = candidateBySlot.get(key);
    if (
      !previous ||
      candidate.midi > previous.midi ||
      (candidate.midi === previous.midi && candidate.velocity > previous.velocity)
    ) {
      candidateBySlot.set(key, candidate);
    }
  });

  const countInMeasure = {
    id: 'count-in-measure',
    index: 0,
    number: 0,
    startTime: 0,
    endTime: PREROLL_SECONDS,
    beatCount: GAME_BOX_SLOTS,
    bpm: null,
    tempoChange: null,
    state: 'waiting',
    dots: [],
    countIn: true,
  };

  const measures = Array.from({ length: measureCount }, (_, measureIndex) => {
    const bpm = getMeasureBpm(measureIndex);
    const previousBpm = measureIndex > 0 ? getMeasureBpm(measureIndex - 1) : bpm;
    const tempoChange =
      typeof bpm === 'number' && typeof previousBpm === 'number' && Math.abs(bpm - previousBpm) >= 0.1
        ? bpm > previousBpm
          ? 'faster'
          : 'slower'
        : null;
    const dots = Array.from({ length: beatsPerMeasure }, (_, beatIndex) => {
      const candidate = candidateBySlot.get(`${measureIndex}:${beatIndex}`);
      if (!candidate) return null;
      return {
        id: `dot-${measureIndex}-${beatIndex}`,
        beatIndex,
        time: beatTimeAt(measureIndex, beatIndex),
        midi: candidate.midi,
        hit: false,
        missed: false,
      };
    }).filter(Boolean);

    return {
      id: `measure-${measureIndex}`,
      index: measureIndex + 1,
      number: measureIndex + 1,
      startTime: beatTimeAt(measureIndex, 0),
      endTime: beatTimeAt(measureIndex + 1, 0),
      beatCount: beatsPerMeasure,
      bpm,
      tempoChange,
      state: 'waiting',
      dots,
    };
  });

  return {
    title,
    measures: [countInMeasure, ...measures],
    songNotes,
    duration,
    beatsPerMeasure,
    sourceNoteCount,
    gameNoteCount: measures.reduce((sum, measure) => sum + measure.dots.length, 0),
  };
}

function buildFallbackSong() {
  const bpm = 96;
  const secondsPerBeat = 60 / bpm;
  const beatsPerMeasure = 4;
  const measureCount = 16;
  const pattern = [
    [0, 1, 2, 3],
    [0, 2],
    [1, 3],
    [0, 1, 3],
  ];
  const candidates = [];
  const songNotes = [];
  const beatTimeAt = (measureIndex, beatIndex) =>
    PREROLL_SECONDS + (measureIndex * beatsPerMeasure + beatIndex) * secondsPerBeat;
  const getMeasureBpm = () => bpm;

  for (let measureIndex = 0; measureIndex < measureCount; measureIndex += 1) {
    pattern[measureIndex % pattern.length].forEach((beatIndex) => {
      const midi = 60 + ((measureIndex + beatIndex) % 8);
      const note = {
        id: `demo-note-${measureIndex}-${beatIndex}`,
        midi,
        time: beatTimeAt(measureIndex, beatIndex),
        duration: 0.22,
        velocity: 0.55,
      };
      candidates.push({ ...note, measureIndex, beatIndex });
      songNotes.push(note);
    });
  }

  return buildMeasuresFromGrid({
    title: 'Demo Rhythm',
    sourceNoteCount: songNotes.length,
    songNotes,
    duration: DEFAULT_SONG_LENGTH,
    beatsPerMeasure,
    measureCount,
    beatTimeAt,
    getMeasureBpm,
    candidates,
  });
}

function getTempoAtTick(midi, ticks) {
  const tempos = midi.header.tempos;
  if (!tempos.length) return 120;

  return tempos.reduce((current, tempo) => (tempo.ticks <= ticks ? tempo.bpm : current), tempos[0].bpm);
}

function getDominantTempo(midi) {
  const tempos = midi.header.tempos;
  if (!tempos.length) return REFERENCE_BPM;

  const durationByTempo = new Map();
  tempos.forEach((tempo, index) => {
    const nextTicks = tempos[index + 1]?.ticks ?? midi.durationTicks;
    const durationTicks = Math.max(0, nextTicks - tempo.ticks);
    const bpm = Math.round(tempo.bpm * 10) / 10;
    durationByTempo.set(bpm, (durationByTempo.get(bpm) ?? 0) + durationTicks);
  });

  return [...durationByTempo.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? REFERENCE_BPM;
}

function pickMelodyCandidates(slotMap) {
  const melody = [];
  let previous = null;

  [...slotMap.entries()]
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .forEach(([globalSlot, slotNotes]) => {
      const sorted = slotNotes
        .map((candidate) => {
          const melodicLeap = previous ? Math.abs(candidate.midi - previous.midi) : 0;
          const continuity = previous ? Math.max(0, 1 - melodicLeap / 18) : 0.5;
          const sameTrack = previous && candidate.trackIndex === previous.trackIndex ? 0.18 : 0;
          const pitchScore = Math.min(1, Math.max(0, (candidate.midi - 54) / 38));
          const durationScore = Math.min(1, candidate.duration / 0.35);
          const velocityScore = candidate.velocity || 0.5;
          const ornamentPenalty = candidate.duration < 0.05 ? 0.45 : 0;
          const hugeLeapPenalty = melodicLeap > 19 ? 0.5 : 0;

          return {
            ...candidate,
            globalSlot: Number(globalSlot),
            melodyScore:
              pitchScore * 0.34 +
              continuity * 0.34 +
              durationScore * 0.14 +
              velocityScore * 0.12 +
              sameTrack -
              ornamentPenalty -
              hugeLeapPenalty,
          };
        })
        .sort((a, b) => b.melodyScore - a.melodyScore || b.midi - a.midi);

      const selected = sorted[0];
      if (!selected) return;
      melody.push(selected);
      previous = selected;
    });

  return melody;
}

function pruneDenseMelody(candidates, boxSlots) {
  const byMeasure = new Map();

  candidates.forEach((candidate, index) => {
    const group = byMeasure.get(candidate.measureIndex) ?? [];
    const previous = candidates[index - 1];
    const next = candidates[index + 1];
    const melodicChange = Math.max(
      previous ? Math.abs(candidate.midi - previous.midi) : 0,
      next ? Math.abs(candidate.midi - next.midi) : 0,
    );
    const importance =
      (candidate.beatIndex === 0 ? 2.5 : 0) +
      (candidate.beatIndex === boxSlots - 1 ? 0.6 : 0) +
      Math.min(2, melodicChange / 7) +
      Math.min(1.2, (candidate.duration ?? 0) / 0.45) +
      (candidate.velocity ?? 0.5) * 0.8 +
      (candidate.melodyScore ?? 0);

    group.push({ ...candidate, importance });
    byMeasure.set(candidate.measureIndex, group);
  });

  let denseRun = 0;

  return [...byMeasure.entries()]
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .flatMap(([, group]) => {
      const isFull = group.length >= boxSlots;
      denseRun = isFull ? denseRun + 1 : 0;

      if (!isFull || denseRun <= 6 || denseRun % 4 !== 0) {
        return group.sort((a, b) => a.beatIndex - b.beatIndex);
      }

      return group
        .sort((a, b) => b.importance - a.importance)
        .slice(0, Math.max(1, boxSlots - 1))
        .sort((a, b) => a.beatIndex - b.beatIndex);
    })
    .sort((a, b) => a.measureIndex - b.measureIndex || a.beatIndex - b.beatIndex);
}

function chooseMusicalGrid({ beatsPerMeasure, midi, notes, normalizedBeatTicks }) {
  const subdivisionCandidates = [1, 2, 3, 4, 6, 8];
  const eligibleNoteCount = Math.max(1, notes.filter((note) => note.midi >= MELODY_MIN_MIDI).length);
  const scoredSubdivisions = subdivisionCandidates.map((subdivision) => {
    const slotDurationTicks = normalizedBeatTicks / subdivision;
    const slotsPerMeasure = beatsPerMeasure * subdivision;
    const boxesPerMeasure = Math.max(1, Math.ceil(slotsPerMeasure / GAME_BOX_SLOTS));
    const boxSlots = Math.ceil(slotsPerMeasure / boxesPerMeasure);
    const boxDurationTicks = slotDurationTicks * boxSlots;
    const measureCount = Math.max(1, Math.ceil(midi.durationTicks / boxDurationTicks));
    const averageBoxSeconds = midi.duration / measureCount;
    const slotKeys = new Set();
    let capturedNotes = 0;
    let totalError = 0;

    notes.forEach((note) => {
      if (note.midi < MELODY_MIN_MIDI) return;
      const globalSlot = Math.round(note.ticks / slotDurationTicks);
      const quantizedTicks = globalSlot * slotDurationTicks;
      const distance = Math.abs(note.ticks - quantizedTicks);
      if (distance > slotDurationTicks * 0.32) return;
      slotKeys.add(globalSlot);
      capturedNotes += 1;
      totalError += distance / slotDurationTicks;
    });

    const averageError = totalError / Math.max(1, slotKeys.size);
    const coverageRatio = capturedNotes / eligibleNoteCount;
    const fillRatio = slotKeys.size / Math.max(1, Math.ceil(midi.durationTicks / slotDurationTicks));
    const shortBoxPenalty = averageBoxSeconds < 0.42 ? (0.42 - averageBoxSeconds) * 35 : 0;
    const unreadableBoxPenalty = averageBoxSeconds < 0.28 ? (0.28 - averageBoxSeconds) * 95 : 0;
    const longBoxPenalty = averageBoxSeconds > 1.9 ? (averageBoxSeconds - 1.9) * 8 : 0;
    const sparsePenalty = coverageRatio < 0.62 ? (0.62 - coverageRatio) * 38 : 0;
    const score =
      coverageRatio * 42 +
      Math.log2(slotKeys.size + 1) * 1.4 -
      averageError * 18 -
      Math.abs(fillRatio - 0.46) * 4 -
      Math.abs(averageBoxSeconds - 0.72) * 3.2 -
      shortBoxPenalty -
      unreadableBoxPenalty -
      longBoxPenalty -
      sparsePenalty -
      subdivision * 0.65;

    return {
      averageBoxSeconds,
      capturedNotes,
      coverageRatio,
      score,
      slotsPerMeasure,
      subdivision,
    };
  });
  const selected = scoredSubdivisions.sort((a, b) => b.score - a.score)[0];
  const boxesPerMeasure = Math.max(1, Math.ceil(selected.slotsPerMeasure / GAME_BOX_SLOTS));
  const boxSlots = Math.ceil(selected.slotsPerMeasure / boxesPerMeasure);
  const slotDurationTicks = normalizedBeatTicks / selected.subdivision;
  const boxDurationTicks = slotDurationTicks * boxSlots;
  const notesBySlot = new Map();

  notes.forEach((note) => {
    if (note.midi < MELODY_MIN_MIDI) return;

    const globalSlot = Math.round(note.ticks / slotDurationTicks);
    const quantizedTicks = globalSlot * slotDurationTicks;
    const distance = Math.abs(note.ticks - quantizedTicks);
    if (distance > slotDurationTicks * 0.32) return;

    const slotNotes = notesBySlot.get(globalSlot) ?? [];
    slotNotes.push({
      duration: note.duration,
      id: `game-${note.trackIndex}-${note.noteIndex}-${note.ticks}`,
      globalSlot,
      midi: note.midi,
      noteIndex: note.noteIndex,
      ticks: note.ticks,
      trackIndex: note.trackIndex,
      velocity: note.velocity || 0.6,
      distance,
    });
    notesBySlot.set(globalSlot, slotNotes);
  });

  const candidates = pickMelodyCandidates(notesBySlot).map((candidate) => {
    const quantizedTicks = candidate.globalSlot * slotDurationTicks;
    return {
      duration: candidate.duration,
      id: candidate.id,
      measureIndex: Math.floor(candidate.globalSlot / boxSlots),
      beatIndex: candidate.globalSlot % boxSlots,
      melodyScore: candidate.melodyScore,
      midi: candidate.midi,
      velocity: candidate.velocity,
      time: midi.header.ticksToSeconds(quantizedTicks) + PREROLL_SECONDS,
      distance: candidate.distance,
    };
  });

  return {
    boxDurationTicks,
    boxSlots,
    candidates: pruneDenseMelody(candidates, boxSlots),
    slotDurationTicks,
    subdivision: selected.subdivision,
  };
}

function convertMidiToSong(midi, fileName) {
  const { beatsPerMeasure, beatUnit } = getTimeSignature(midi);
  const ppq = midi.header.ppq;
  const dominantBpm = getDominantTempo(midi);
  const beatMultiplier = dominantBpm > MAX_NATIVE_BPM ? Math.max(1, Math.round(dominantBpm / REFERENCE_BPM)) : 1;
  const normalizedBeatTicks = ppq * (4 / beatUnit) * beatMultiplier;
  const playableTracks = midi.tracks.filter((track) => track.channel !== 9);

  const songNotes = midi.tracks
    .flatMap((track, trackIndex) =>
      track.notes.map((note, noteIndex) => ({
        id: `midi-${trackIndex}-${noteIndex}`,
        midi: note.midi,
        time: midi.header.ticksToSeconds(note.ticks) + PREROLL_SECONDS,
        duration: Math.max(0.05, Math.min(note.duration, 2.4)),
        velocity: note.velocity || 0.6,
      })),
    )
    .filter((note) => Number.isFinite(note.time) && Number.isFinite(note.midi))
    .sort((a, b) => a.time - b.time || a.midi - b.midi);

  if (!songNotes.length) {
    throw new Error('No playable notes found in this MIDI file.');
  }

  const playableNotes = playableTracks.flatMap((track, trackIndex) =>
    track.notes
      .filter((note) => Number.isFinite(note.ticks) && Number.isFinite(note.midi))
      .map((note, noteIndex) => ({
        duration: note.duration,
        midi: note.midi,
        noteIndex,
        ticks: note.ticks,
        trackIndex,
        velocity: note.velocity,
      })),
  );
  const grid = chooseMusicalGrid({
    beatsPerMeasure,
    midi,
    notes: playableNotes,
    normalizedBeatTicks,
  });

  if (!grid.candidates.length) {
    throw new Error('No readable rhythm grid found in this MIDI file.');
  }

  const lastTick = Math.max(
    midi.durationTicks,
    ...grid.candidates.map((candidate) => (candidate.measureIndex + 1) * grid.boxDurationTicks),
  );
  const measureCount = Math.max(1, Math.ceil(lastTick / grid.boxDurationTicks));
  const beatTimeAt = (measureIndex, beatIndex) =>
    midi.header.ticksToSeconds(
      measureIndex * grid.boxDurationTicks + beatIndex * grid.slotDurationTicks,
    ) + PREROLL_SECONDS;
  const getMeasureBpm = (measureIndex) =>
    getTempoAtTick(midi, measureIndex * grid.boxDurationTicks) / beatMultiplier;
  const lastSongNote = songNotes.reduce((max, note) => Math.max(max, note.time + note.duration), 0);

  return buildMeasuresFromGrid({
    title: fileName.replace(/\.(mid|midi)$/i, '') || midi.name || 'Loaded MIDI',
    sourceNoteCount: songNotes.length,
    songNotes,
    duration: Math.max(lastSongNote + 1.25, beatTimeAt(measureCount, 0) + 0.6),
    beatsPerMeasure: grid.boxSlots,
    measureCount,
    beatTimeAt,
    getMeasureBpm,
    candidates: grid.candidates,
  });
}

function createToneEngine() {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return null;

  const context = new AudioContext();
  const master = context.createGain();
  master.gain.value = 0.32;
  master.connect(context.destination);
  const scheduledNodes = new Set();
  const scheduledNoteIds = new Set();

  const playTone = (frequency, start, duration, type = 'sine', gain = 0.3) => {
    const oscillator = context.createOscillator();
    const envelope = context.createGain();
    const safeStart = Math.max(context.currentTime + 0.002, start);
    const safeDuration = Math.max(0.04, duration);

    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, safeStart);
    envelope.gain.setValueAtTime(0.001, safeStart);
    envelope.gain.exponentialRampToValueAtTime(gain, safeStart + 0.01);
    envelope.gain.exponentialRampToValueAtTime(0.001, safeStart + safeDuration);
    oscillator.connect(envelope);
    envelope.connect(master);
    oscillator.start(safeStart);
    oscillator.stop(safeStart + safeDuration + 0.04);
    scheduledNodes.add(oscillator);
    oscillator.addEventListener('ended', () => scheduledNodes.delete(oscillator));
  };

  const playHitSlap = (pitchStep = 0) => {
    const now = context.currentTime;
    const start = now + 0.002;
    const pitchRatio = 2 ** (pitchStep / 12);

    const bodyOscillator = context.createOscillator();
    const bodyGain = context.createGain();
    bodyOscillator.type = 'triangle';
    bodyOscillator.frequency.setValueAtTime(1320 * pitchRatio, start);
    bodyOscillator.frequency.exponentialRampToValueAtTime(420 * pitchRatio, start + 0.055);
    bodyGain.gain.setValueAtTime(0.001, start);
    bodyGain.gain.exponentialRampToValueAtTime(0.22, start + 0.004);
    bodyGain.gain.exponentialRampToValueAtTime(0.001, start + 0.07);
    bodyOscillator.connect(bodyGain);
    bodyGain.connect(master);
    bodyOscillator.start(start);
    bodyOscillator.stop(start + 0.09);
    scheduledNodes.add(bodyOscillator);
    bodyOscillator.addEventListener('ended', () => scheduledNodes.delete(bodyOscillator));

    const clickOscillator = context.createOscillator();
    const clickGain = context.createGain();
    clickOscillator.type = 'square';
    clickOscillator.frequency.setValueAtTime(2400 * pitchRatio, start);
    clickGain.gain.setValueAtTime(0.001, start);
    clickGain.gain.exponentialRampToValueAtTime(0.12, start + 0.002);
    clickGain.gain.exponentialRampToValueAtTime(0.001, start + 0.018);
    clickOscillator.connect(clickGain);
    clickGain.connect(master);
    clickOscillator.start(start);
    clickOscillator.stop(start + 0.026);
    scheduledNodes.add(clickOscillator);
    clickOscillator.addEventListener('ended', () => scheduledNodes.delete(clickOscillator));

    const noiseLength = Math.floor(context.sampleRate * 0.045);
    const noiseBuffer = context.createBuffer(1, noiseLength, context.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let index = 0; index < noiseLength; index += 1) {
      const decay = 1 - index / noiseLength;
      data[index] = (Math.random() * 2 - 1) * decay;
    }

    const noiseSource = context.createBufferSource();
    const noiseFilter = context.createBiquadFilter();
    const noiseGain = context.createGain();
    noiseSource.buffer = noiseBuffer;
    noiseFilter.type = 'bandpass';
    noiseFilter.frequency.setValueAtTime(1850 * pitchRatio, start);
    noiseFilter.Q.value = 1.7;
    noiseGain.gain.setValueAtTime(0.001, start);
    noiseGain.gain.exponentialRampToValueAtTime(0.16, start + 0.003);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, start + 0.048);
    noiseSource.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(master);
    noiseSource.start(start);
    noiseSource.stop(start + 0.052);
    scheduledNodes.add(noiseSource);
    noiseSource.addEventListener('ended', () => scheduledNodes.delete(noiseSource));
  };

  const scheduleSongWindow = (songNotes, audioStart, songOffset) => {
    const windowEnd = songOffset + AUDIO_LOOKAHEAD_SECONDS;

    songNotes.forEach((note) => {
      if (scheduledNoteIds.has(note.id)) return;
      if (note.time < songOffset - 0.05 || note.time > windowEnd) return;

      const start = audioStart + note.time - songOffset;
      if (start + note.duration < context.currentTime) return;
      const gain = Math.min(0.18, 0.025 + note.velocity * 0.09);
      scheduledNoteIds.add(note.id);
      playTone(midiToFrequency(note.midi), start, note.duration, 'triangle', gain);
    });
  };

  const stopSong = () => {
    scheduledNodes.forEach((node) => {
      try {
        node.stop(context.currentTime + 0.01);
      } catch {
        // Already stopped nodes can be ignored.
      }
    });
    scheduledNodes.clear();
  };

  const resetSongSchedule = () => {
    scheduledNoteIds.clear();
  };

  const hit = (pitchStep = 0) => {
    playHitSlap(pitchStep);
  };

  return { context, scheduleSongWindow, stopSong, resetSongSchedule, hit };
}

function App() {
  const fallbackSong = useMemo(buildFallbackSong, []);
  const [song, setSong] = useState(fallbackSong);
  const [measures, setMeasures] = useState(() => cloneMeasures(fallbackSong.measures));
  const [gameState, setGameState] = useState('idle');
  const [songTime, setSongTime] = useState(0);
  const [score, setScore] = useState(0);
  const [combo, setCombo] = useState(0);
  const [maxCombo, setMaxCombo] = useState(0);
  const [judgement, setJudgement] = useState('Ready');
  const [comboBurst, setComboBurst] = useState({ combo: 0, id: 0, judgement: 'Ready' });
  const [attempts, setAttempts] = useState(0);
  const [successfulHits, setSuccessfulHits] = useState(0);
  const [tapFlash, setTapFlash] = useState(false);
  const [hintEnabled, setHintEnabled] = useState(false);
  const [flowDirection, setFlowDirection] = useState('horizontal');
  const [stripSize, setStripSize] = useState({ width: 0, height: 0 });
  const [loadError, setLoadError] = useState('');
  const engineRef = useRef(null);
  const measureStripRef = useRef(null);
  const startTimeRef = useRef(0);
  const pauseOffsetRef = useRef(0);
  const rafRef = useRef(0);
  const songTimeRef = useRef(0);

  const getLiveSongTime = useCallback(() => {
    const audioNow = engineRef.current?.context.currentTime;
    if (typeof audioNow === 'number' && gameState === 'playing') {
      return audioNow - startTimeRef.current;
    }
    return songTimeRef.current;
  }, [gameState]);

  const resetScore = useCallback((nextMeasures, status = 'Ready') => {
    cancelAnimationFrame(rafRef.current);
    engineRef.current?.stopSong();
    setMeasures(cloneMeasures(nextMeasures));
    setGameState('idle');
    setSongTime(0);
    songTimeRef.current = 0;
    setScore(0);
    setCombo(0);
    setMaxCombo(0);
    setJudgement(status);
    setComboBurst({ combo: 0, id: 0, judgement: status });
    setAttempts(0);
    setSuccessfulHits(0);
    pauseOffsetRef.current = 0;
  }, []);

  const resetGame = useCallback(() => {
    resetScore(song.measures);
  }, [resetScore, song.measures]);

  const handleMidiFile = useCallback(
    async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;

      try {
        const buffer = await file.arrayBuffer();
        const midi = new Midi(buffer);
        const nextSong = convertMidiToSong(midi, file.name);
        setSong(nextSong);
        setLoadError('');
        resetScore(nextSong.measures, 'Loaded');
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : 'Could not read this MIDI file.');
        setJudgement('Load failed');
      } finally {
        event.target.value = '';
      }
    },
    [resetScore],
  );

  const startGame = useCallback(async () => {
    if (!engineRef.current) engineRef.current = createToneEngine();
    if (engineRef.current?.context.state === 'suspended') {
      await engineRef.current.context.resume();
    }

    const now = engineRef.current?.context.currentTime ?? performance.now() / 1000;
    startTimeRef.current = now - pauseOffsetRef.current;
    engineRef.current?.stopSong();
    engineRef.current?.resetSongSchedule();
    engineRef.current?.scheduleSongWindow(song.songNotes, now, pauseOffsetRef.current);
    setGameState('playing');
    setJudgement(pauseOffsetRef.current ? 'Resume' : 'Go');
  }, [song.songNotes]);

  const pauseGame = useCallback(() => {
    pauseOffsetRef.current = getLiveSongTime();
    engineRef.current?.stopSong();
    setGameState('paused');
    setJudgement('Paused');
  }, [getLiveSongTime]);

  const seekTo = useCallback(
    (nextTime) => {
      const clampedTime = Math.max(0, Math.min(song.duration, nextTime));
      const audioNow = engineRef.current?.context.currentTime ?? performance.now() / 1000;

      pauseOffsetRef.current = clampedTime;
      songTimeRef.current = clampedTime;
      setSongTime(clampedTime);
      engineRef.current?.stopSong();
      engineRef.current?.resetSongSchedule();

      if (gameState === 'playing') {
        startTimeRef.current = audioNow - clampedTime;
        engineRef.current?.scheduleSongWindow(song.songNotes, audioNow, clampedTime);
      } else if (gameState === 'ended') {
        setGameState('paused');
        setJudgement('Seek');
      }
    },
    [gameState, song.duration, song.songNotes],
  );

  const handleProgressPointer = useCallback(
    (event) => {
      const rect = event.currentTarget.getBoundingClientRect();
      const ratio = rect.width ? (event.clientX - rect.left) / rect.width : 0;
      seekTo(ratio * song.duration);
    },
    [seekTo, song.duration],
  );

  const hitRhythm = useCallback(() => {
    if (gameState !== 'playing') return;

    const hitTime = getLiveSongTime();
    setTapFlash(true);
    window.setTimeout(() => setTapFlash(false), 80);

    if (hitTime < PREROLL_SECONDS - JUDGEMENTS[JUDGEMENTS.length - 1].window) return;

    const target = measures
      .flatMap((measure, measureIndex) =>
          measure.dots
          .filter((dot) => !dot.hit && !dot.missed)
          .map((dot) => ({
            dot,
            measureIndex,
            delta: Math.abs(dot.time - hitTime),
          })),
      )
      .sort((a, b) => a.delta - b.delta)[0];
    const judgementResult =
      target && target.delta <= JUDGEMENTS[JUDGEMENTS.length - 1].window
        ? JUDGEMENTS.find((item) => target.delta <= item.window)
        : null;
    const result = judgementResult ? { ...judgementResult, id: target.dot.id } : { name: 'Miss', score: 0 };
    const hitCombo = result.id ? combo + 1 : 0;
    const hitMeasureDotCount = result.id ? measures[target.measureIndex]?.dots.length ?? 2 : 2;

    setMeasures((current) => {
      if (!judgementResult) {
        const currentMeasureIndex = current.findIndex(
          (measure) => hitTime >= measure.startTime && hitTime < measure.endTime,
        );
        if (currentMeasureIndex === -1) return current;
        return current.map((item, index) => (index === currentMeasureIndex ? { ...item, state: 'failed' } : item));
      }

      return current.map((item, index) => {
        if (index !== target.measureIndex) return item;

        const hitCount = item.dots.filter((dot) => dot.hit).length;
        const dots = item.dots.map((dot) =>
          dot.id === target.dot.id
            ? {
                ...dot,
                hit: true,
                hitOrder: hitCount + 1,
                missed: false,
                burst: createHitBurst(getComboIntensity(hitCombo)),
                hitJudgement: result.name,
              }
            : dot,
        );
        const finished = dots.length > 0 && dots.every((dot) => dot.hit);
        const failed = dots.some((dot) => dot.missed);
        const state = finished ? 'cleared' : failed ? 'failed' : item.state;
        return { ...item, dots, state };
      });
    });

    setJudgement(result.name);
    setAttempts((value) => value + 1);

    if (result.id) {
      engineRef.current?.hit((hitMeasureDotCount - 2) * 4);
      setSuccessfulHits((value) => value + 1);
      setScore((value) => value + result.score + combo * 6);
      setCombo((value) => {
        const next = value + 1;
        setMaxCombo((max) => Math.max(max, next));
        setComboBurst((burst) => ({ combo: next, id: burst.id + 1, judgement: result.name }));
        return next;
      });
    } else {
      setCombo(0);
      setComboBurst((burst) => ({ combo: 0, id: burst.id + 1, judgement: 'Miss' }));
    }
  }, [combo, gameState, getLiveSongTime, measures]);

  useEffect(() => {
    if (gameState !== 'playing') return undefined;

    const frame = () => {
      const audioNow = engineRef.current?.context.currentTime ?? performance.now() / 1000;
      const nextTime = audioNow - startTimeRef.current;
      songTimeRef.current = nextTime;
      setSongTime(nextTime);
      engineRef.current?.scheduleSongWindow(song.songNotes, audioNow, nextTime);

      setMeasures((current) => {
        let missedDots = 0;
        const nextMeasures = current.map((measure) => {
          if (measure.state === 'cleared') return measure;

          const dots = measure.dots.map((dot) => {
            if (dot.hit || dot.missed || nextTime - dot.time <= JUDGEMENTS[JUDGEMENTS.length - 1].window) {
              return dot;
            }
            missedDots += 1;
            return { ...dot, missed: true };
          });

          if (!dots.length) {
            return nextTime > measure.endTime ? { ...measure, state: 'cleared' } : measure;
          }

          if (dots.every((dot) => dot.hit)) return { ...measure, dots, state: 'cleared' };
          if (dots.some((dot) => dot.missed)) return { ...measure, dots, state: 'failed' };
          return { ...measure, dots };
        });

        if (missedDots > 0) {
          setAttempts((value) => value + missedDots);
          setCombo(0);
          setJudgement('Miss');
          setComboBurst((burst) => ({ combo: 0, id: burst.id + 1, judgement: 'Miss' }));
        }

        return nextMeasures;
      });

      if (nextTime >= song.duration) {
        engineRef.current?.stopSong();
        setGameState('ended');
        setJudgement('Cleared');
        pauseOffsetRef.current = 0;
        return;
      }

      rafRef.current = requestAnimationFrame(frame);
    };

    rafRef.current = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(rafRef.current);
  }, [gameState, song.duration, song.songNotes]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
      if (['Tab', 'Escape', 'F5'].includes(event.key)) return;
      event.preventDefault();
      hitRhythm();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [hitRhythm]);

  useEffect(() => () => engineRef.current?.stopSong(), []);

  useEffect(() => {
    if (!measureStripRef.current) return undefined;

    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setStripSize({ width, height });
    });
    observer.observe(measureStripRef.current);

    return () => observer.disconnect();
  }, []);

  const currentMeasureIndex = Math.max(
    0,
    Math.min(
      measures.length - 1,
      measures.findIndex((measure) => songTime >= measure.startTime && songTime < measure.endTime),
    ),
  );
  const displayStart = currentMeasureIndex - EXIT_TRAIL_MEASURES;
  const visibleWindowLength = EXIT_TRAIL_MEASURES + 1 + FUTURE_PREVIEW_MEASURES;
  const visibleMeasures = Array.from({ length: visibleWindowLength }, (_, slotIndex) => {
    const measureIndex = displayStart + slotIndex;
    const measure = measureIndex >= 0 && measureIndex < measures.length ? measures[measureIndex] : null;
    return {
      measure,
      measureIndex,
      slotOffset: measureIndex - currentMeasureIndex,
    };
  }).filter(
    (item) =>
      item.measure &&
      (item.slotOffset >= 0 || item.measure.state === 'cleared' || item.measure.state === 'failed'),
  );
  const progress = Math.min(100, (songTime / song.duration) * 100);
  const playableMeasureCount = measures.filter((measure) => !measure.countIn).length;
  const clearedMeasures = measures.filter((measure) => !measure.countIn && measure.state === 'cleared').length;
  const accuracy = attempts ? Math.round((successfulHits / attempts) * 100) : 100;
  const horizontalBoxSize =
    stripSize.width > 0
      ? Math.max(
          54,
          Math.min(
            195,
            (stripSize.width - STRIP_EDGE_PADDING * 2) /
              (1 + FUTURE_PREVIEW_MEASURES * PREVIEW_SLOT_SCALE),
          ),
        )
      : 120;
  const horizontalSlotGap = horizontalBoxSize * PREVIEW_SLOT_SCALE;
  const horizontalTargetLeft =
    stripSize.width > 0 ? STRIP_EDGE_PADDING + horizontalBoxSize / 2 : 0;
  const verticalBoxSize =
    stripSize.height > 0
      ? Math.max(
          62,
          Math.min(
            195,
            stripSize.width * 0.45,
            (stripSize.height - STRIP_EDGE_PADDING * 2) /
              (1 + FUTURE_PREVIEW_MEASURES * PREVIEW_SLOT_SCALE),
          ),
        )
      : 120;
  const verticalSlotGap = verticalBoxSize * PREVIEW_SLOT_SCALE;
  const verticalTargetTop =
    stripSize.height > 0 ? stripSize.height - STRIP_EDGE_PADDING - verticalBoxSize / 2 : 0;

  return (
    <main className={`shell ${flowDirection}-flow`}>
      <section className={`game ${flowDirection}-flow`}>
        <div className="stage">
          <header className="topbar">
            <div>
              <p className="eyebrow">Rusher</p>
              <h1>{song.title}</h1>
            </div>
            <div className="controls">
              <label className="file-button" aria-label="Choose MIDI file">
                <FileMusic size={18} />
                <input type="file" accept=".mid,.midi,audio/midi,audio/x-midi" onChange={handleMidiFile} />
              </label>
              {gameState === 'playing' ? (
                <button type="button" onClick={pauseGame} aria-label="Pause">
                  <Pause size={18} />
                </button>
              ) : (
                <button type="button" onClick={startGame} aria-label="Play">
                  <Play size={18} />
                </button>
              )}
              <button type="button" onClick={resetGame} aria-label="Restart">
                <RotateCcw size={18} />
              </button>
              <button
                type="button"
                className={hintEnabled ? 'active' : ''}
                onClick={() => setHintEnabled((value) => !value)}
                aria-label="Toggle hint"
              >
                H
              </button>
              <button
                type="button"
                className={flowDirection === 'vertical' ? 'active' : ''}
                onClick={() => setFlowDirection((value) => (value === 'horizontal' ? 'vertical' : 'horizontal'))}
                aria-label="Toggle box flow"
                title={flowDirection === 'horizontal' ? 'Horizontal flow' : 'Vertical flow'}
              >
                {flowDirection === 'horizontal' ? <ArrowLeftRight size={18} /> : <ArrowDownUp size={18} />}
              </button>
            </div>
          </header>

          <button
            ref={measureStripRef}
            type="button"
            className={`measure-strip ${flowDirection} ${tapFlash ? 'tap' : ''}`}
            onPointerDown={hitRhythm}
            style={{
              '--target-left': flowDirection === 'horizontal' ? `${horizontalTargetLeft}px` : '50%',
              '--target-top': flowDirection === 'vertical' ? `${verticalTargetTop}px` : `${VERTICAL_TARGET_POSITION}%`,
              '--horizontal-box-size': `${horizontalBoxSize}px`,
              '--vertical-box-size': `${verticalBoxSize}px`,
            }}
          >
            {attempts > 0 ? (
              <span className={`combo-overlay ${comboBurst.judgement.toLowerCase()}`} key={comboBurst.id}>
                <span>{comboBurst.judgement}</span>
                <strong>{comboBurst.combo}</strong>
              </span>
            ) : null}
            {visibleMeasures.map(({ measure, slotOffset }) =>
                <span
                  className={`measure-box ${slotOffset === 0 ? 'current' : ''} ${measure.state} ${
                    slotOffset < 0 && measure.state === 'cleared' ? 'exit-up' : ''
                  } ${slotOffset < 0 && measure.state === 'failed' ? 'exit-down' : ''} ${
                    measure.tempoChange ? `tempo-${measure.tempoChange}` : ''
                  }`}
                  key={measure.id}
                  style={{
                    '--slot-left':
                      flowDirection === 'horizontal'
                        ? `${horizontalTargetLeft + slotOffset * horizontalSlotGap}px`
                        : '50%',
                    '--slot-top':
                      flowDirection === 'vertical'
                        ? `${verticalTargetTop - slotOffset * verticalSlotGap}px`
                        : '50%',
                  }}
                >
                  <span className="measure-number">{measure.countIn ? 'IN' : measure.number}</span>
                  <MeasureGlyph
                    beatCount={measure.beatCount ?? song.beatsPerMeasure}
                    hintEnabled={hintEnabled}
                    measure={measure}
                    songTime={songTime}
                  />
                </span>
            )}
          </button>

          <button
            type="button"
            className="progress"
            onPointerDown={handleProgressPointer}
            aria-label="Seek song"
          >
            <span style={{ width: `${progress}%` }} />
          </button>
        </div>

        <aside className="hud">
          <div className="status">
            <Volume2 size={18} />
            <span>{judgement}</span>
          </div>
          <dl>
            <div>
              <dt>Score</dt>
              <dd>{score.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Combo</dt>
              <dd>{combo}</dd>
            </div>
            <div>
              <dt>Max</dt>
              <dd>{maxCombo}</dd>
            </div>
            <div>
              <dt>Bars</dt>
              <dd>
                {clearedMeasures}/{playableMeasureCount}
              </dd>
            </div>
            <div>
              <dt>Accuracy</dt>
              <dd>{accuracy}%</dd>
            </div>
            <div>
              <dt>Notes</dt>
              <dd>{song.gameNoteCount}</dd>
            </div>
          </dl>
          {loadError ? <p className="error">{loadError}</p> : null}
          <div className="meter">
            <span style={{ height: `${Math.min(100, 28 + combo * 2)}%` }} />
          </div>
        </aside>
      </section>
    </main>
  );
}

export default App;
