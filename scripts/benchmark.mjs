import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { advance, alignment, basis, centerOfMassY, diagnostics, drift, inertia, launch, mass, rotate, STEP, unit } from '../web/physics.mjs';

const distance = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));
const maxBelow = (actual, limit, name) => assert.ok(actual <= limit, name + ': ' + actual + ' > ' + limit);
const limits = {
  geometryAbsolute: 1e-12,
  principalAngularVelocityAbsoluteRadPerS: 1e-13,
  principalBasisVectorDistance: 1e-7,
  symmetricFinestAngularVelocityAbsoluteRadPerS: 1e-8,
  symmetricFinestBasisVectorDistance: 1e-7,
  minimumOrder: 3.8,
  coarsestRelativeEnergy: 2e-5,
  coarsestRelativeWorldMomentumVector: 2e-5,
  defaultStepRelativeEnergy: 1e-7,
  defaultStepRelativeWorldMomentumVector: 1e-7,
};

// Independent inertia calculation by exact 2-point Gaussian quadrature of
// mass, first moments and quadratic second moments in the three input prisms.
// This specification uses millimeters and absolute y bounds from the foot.
function geometryCheck() {
  const nodes = [];
  for (const [width, low, high, depth] of [[50, 0, 18, 22], [24, 18, 83, 18], [180, 83, 109, 22]]) {
    const m = 2700 * 1e-9 * width * (high - low) * depth / 8;
    for (const i of [-1, 1]) for (const j of [-1, 1]) for (const k of [-1, 1]) {
      const mm = [i * width / (2 * Math.sqrt(3)),
        (low + high) / 2 + j * (high - low) / (2 * Math.sqrt(3)), k * depth / (2 * Math.sqrt(3))];
      nodes.push({ p: mm.map(v => v / 1000), m });
    }
  }
  const total = nodes.reduce((sum, n) => sum + n.m, 0);
  const center = basis.map((_, j) => nodes.reduce((sum, n) => sum + n.m * n.p[j], 0) / total);
  const tensor = basis.map((_, j) => basis.map((__, k) => nodes.reduce((sum, n) => {
    const p = n.p.map((x, i) => x - center[i]);
    return sum + n.m * ((j === k ? p.reduce((s, v) => s + v * v, 0) : 0) - p[j] * p[k]);
  }, 0)));
  maxBelow(Math.abs(total - mass), limits.geometryAbsolute, 'mass kg');
  maxBelow(distance(center, [0, centerOfMassY, 0]), limits.geometryAbsolute, 'center m');
  let maxTensorError = 0;
  tensor.forEach((row, j) => row.forEach((v, k) => {
    maxTensorError = Math.max(maxTensorError, Math.abs(v - (j === k ? inertia[j] : 0)));
  }));
  maxBelow(maxTensorError, limits.geometryAbsolute, 'full tensor kg m²');
  return { massKg: mass, centerFromFootM: centerOfMassY, momentsKgM2: inertia, maxTensorErrorKgM2: maxTensorError };
}

// Rodrigues' rotation formula is independent of the solver's quaternion ODE
// and quaternion-to-vector mapping. Its inputs are world/body unit axes.
function rodrigues(v, [x, y, z], angle) {
  const [a, b, c] = v, ct = Math.cos(angle), st = Math.sin(angle);
  const along = (a*x + b*y + c*z) * (1 - ct);
  return [ct*a + st*(y*c-z*b) + x*along, ct*b + st*(z*a-x*c) + y*along,
    ct*c + st*(x*b-y*a) + z*along];
}

function principalChecks() {
  const spin = 6, duration = 8;
  const errors = basis.map((_, axis) => {
    const start = launch(axis, spin, 0);
    let state = start;
    let maxBasisDistance = 0, maxAngularVelocityError = 0;
    // Explicit initial basis in the laboratory, independent of launch().
    const frames = [
      [[0,1,0],[-1,0,0],[0,0,1]],
      [[1,0,0],[0,1,0],[0,0,1]],
      [[1,0,0],[0,0,-1],[0,1,0]],
    ];
    for (let tick = 0; tick <= duration / STEP; tick++) {
      for (let i = 0; i < 3; i++) {
        const exact = rodrigues(frames[axis][i], [0,1,0], spin * tick * STEP);
        maxBasisDistance = Math.max(maxBasisDistance, distance(exact, rotate(state.slice(3), basis[i])));
      }
      const expectedW = basis[axis].map(k => spin * k);
      maxAngularVelocityError = Math.max(maxAngularVelocityError, distance(state.slice(0,3), expectedW));
      if (tick < duration / STEP) state = advance(state);
    }
    maxBelow(maxBasisDistance, limits.principalBasisVectorDistance, 'principal attitude');
    maxBelow(maxAngularVelocityError, limits.principalAngularVelocityAbsoluteRadPerS, 'principal omega');
    return { axis: 'XYZ'[axis], maxBasisDistance, maxAngularVelocityErrorRadPerS: maxAngularVelocityError };
  });
  return { seconds: duration, dtS: STEP, spinRadPerS: spin, runs: errors };
}

function symmetricChecks() {
  const moments = [0.002, 0.002, 0.003], [A,,C] = moments;
  const initialW = [1.4, -0.9, 3.1], [a,b,c] = initialW;
  const L = [A*a, A*b, C*c], length = Math.hypot(...L), direction = L.map(v => v / length);
  const duration = 6;
  const runs = [1/30, 1/60, 1/120, STEP].map(dt => {
    let state = [...initialW, 1, 0, 0, 0];
    let maxW = 0, maxAttitude = 0;
    for (let tick = 1; tick <= Math.round(duration / dt); tick++) {
      state = advance(state, dt, moments);
      const time = tick * dt, alpha = (C/A - 1) * c * time;
      const exactW = [a*Math.cos(alpha) - b*Math.sin(alpha), a*Math.sin(alpha) + b*Math.cos(alpha), c];
      maxW = Math.max(maxW, distance(exactW, state.slice(0,3)));
      for (const e of basis) {
        const exact = rodrigues(rodrigues(e, [0,0,1], -alpha), direction, length / A * time);
        maxAttitude = Math.max(maxAttitude, distance(exact, rotate(state.slice(3), e)));
      }
    }
    return { dtS: dt, maxAngularVelocityErrorRadPerS: maxW, maxBasisDistance: maxAttitude };
  });
  const orders = runs.slice(1).map((r,i) => ({
    bodyRate: Math.log2(runs[i].maxAngularVelocityErrorRadPerS / r.maxAngularVelocityErrorRadPerS),
    orientation: Math.log2(runs[i].maxBasisDistance / r.maxBasisDistance),
  }));
  for (const { bodyRate, orientation } of orders) assert.ok(Math.min(bodyRate, orientation) > limits.minimumOrder);
  maxBelow(runs.at(-1).maxAngularVelocityErrorRadPerS, limits.symmetricFinestAngularVelocityAbsoluteRadPerS, 'symmetric omega');
  maxBelow(runs.at(-1).maxBasisDistance, limits.symmetricFinestBasisVectorDistance, 'symmetric attitude');
  return { seconds: duration, momentsKgM2: moments, initialOmegaRadPerS: initialW, runs, orders };
}

function rotorRun(axis, dt, spin = 6, nudge = 0.04) {
  const duration = 24, steps = Math.round(duration / dt);
  let state = launch(axis, spin, nudge);
  const initial = diagnostics(state), direction = unit(initial.momentum);
  let maxEnergy = 0, maxMomentum = 0, firstReversal = null;
  let minAlignment = alignment(state, axis, direction), maxAlignment = minAlignment;
  for (let tick = 1; tick <= steps; tick++) {
    state = advance(state, dt);
    const d = drift(diagnostics(state), initial);
    maxEnergy = Math.max(maxEnergy, d.energy); maxMomentum = Math.max(maxMomentum, d.momentum);
    const value = alignment(state, axis, direction);
    minAlignment = Math.min(minAlignment, value); maxAlignment = Math.max(maxAlignment, value);
    if (firstReversal === null && value < 0) firstReversal = tick * dt;
  }
  maxBelow(maxEnergy, dt === STEP ? limits.defaultStepRelativeEnergy : limits.coarsestRelativeEnergy, 'relative energy');
  maxBelow(maxMomentum, dt === STEP ? limits.defaultStepRelativeWorldMomentumVector : limits.coarsestRelativeWorldMomentumVector, 'relative world vector');
  return { axis: 'XYZ'[axis], dtS: dt, seconds: duration, steps, spinRadPerS: spin, nudgeFraction: nudge,
    initialEnergyJ: initial.energy, initialWorldMomentumKgM2PerS: initial.momentum,
    maxRelativeEnergyDrift: maxEnergy, maxRelativeWorldMomentumVectorDrift: maxMomentum,
    minAlignment, maxAlignment, firstNegativeAlignmentSampleS: firstReversal };
}

const geometry = geometryCheck();
const principal = principalChecks(), symmetricTop = symmetricChecks();
const rotor = [1/60, 1/120, STEP].flatMap(dt => basis.map((_, i) => rotorRun(i, dt)));
const rangeCorners = [2,10].flatMap(spin => [0,0.12].flatMap(nudge => basis.map((_, i) => rotorRun(i, STEP, spin, nudge))));
for (const run of rotor) {
  if (run.axis === 'Y') assert.ok(run.minAlignment < -0.99 && run.firstNegativeAlignmentSampleS < 1.4);
  else assert.ok(run.minAlignment > 0.99 && run.firstNegativeAlignmentSampleS === null);
}
for (let i = 0; i < 3; i++) {
  assert.ok(rotor[i + 6].maxRelativeWorldMomentumVectorDrift < rotor[i].maxRelativeWorldMomentumVectorDrift / 100);
}
const report = { model: 'Three-block rotor; uniform density 2700 kg/m³', method: 'Coupled RK4; normalize quaternion after each step',
  measurement: 'Max over every completed step. World momentum error is ||L(t)-L(0)|| / ||L(0)||. Alignment is signed cosine. First crossing is bracketed within one dt before its sample.',
  limits, geometry, principal, symmetricTop, rotor, rangeCorners };
function compareReport(actual, saved, path = 'report') {
  if (typeof actual === 'number') {
    assert.equal(typeof saved, 'number', path);
    // Allow roundoff differences between JS math libraries on ARM and x64.
    const tolerance = 3e-13 + 1e-6 * Math.abs(actual);
    maxBelow(Math.abs(saved - actual), tolerance, path);
  } else if (actual !== null && typeof actual === 'object') {
    assert.deepEqual(Object.keys(saved), Object.keys(actual), path);
    for (const key of Object.keys(actual)) compareReport(actual[key], saved[key], path + '.' + key);
  } else {
    assert.equal(saved, actual, path);
  }
}
if (process.argv.includes('--check-evidence')) {
  compareReport(report, JSON.parse(readFileSync(new URL('../web/benchmark.json', import.meta.url))));
  console.log('PASS checked-in numerical evidence matches the recomputed report within rounding tolerance.');
}
if (process.argv.includes('--write')) {
  writeFileSync(new URL('../web/benchmark.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
}
console.log('PASS geometry, 3 principal solutions, 4 symmetric-top resolutions, 9 triaxial runs, 12 control-range corners.');
console.table(rotor.map(r => ({ axis:r.axis, step:'1/'+Math.round(1/r.dtS), energy:r.maxRelativeEnergyDrift.toExponential(3),
  worldMomentum:r.maxRelativeWorldMomentumVectorDrift.toExponential(3), firstNegativeS:r.firstNegativeAlignmentSampleS })));
console.log('Symmetric-top observed orders (angular velocity, attitude):', symmetricTop.orders);
