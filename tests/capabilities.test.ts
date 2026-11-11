import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkRequiredHulls, deviceCapabilities, worldCapabilities } from '../src/lib/capabilities.ts';

test('capabilities: negotiated eight/nine-buffer boundary and strict opt-in', () => {
  for (const limit of [8, 9, 10]) {
    const caps = deviceCapabilities({ limits: { maxStorageBuffersPerShaderStage: limit } });
    assert.equal(caps.standardHullCollisions, limit >= 9);
    assert.equal(caps.maxStorageBuffersPerShaderStage, limit);
    assert.ok(Object.isFrozen(caps));
    assert.doesNotThrow(() => checkRequiredHulls(caps));
    assert.doesNotThrow(() => checkRequiredHulls(caps, false));
    if (limit < 9) assert.throws(() => checkRequiredHulls(caps, true), /requireHulls/);
    else assert.doesNotThrow(() => checkRequiredHulls(caps, true));
  }
});

test('capabilities: backend snapshots never advertise future shapes or native hulls in SDF', () => {
  const device = deviceCapabilities({ limits: { maxStorageBuffersPerShaderStage: 9 } });
  const standard = worldCapabilities(device, 'standard', true);
  const sdf = worldCapabilities(device, 'sdf', true);
  const custom = worldCapabilities(device, 'custom', true);
  assert.equal(standard.hullCollisions, 'native');
  assert.equal(worldCapabilities(device, 'standard', false).hullCollisions, 'box-fallback');
  assert.equal(sdf.hullCollisions, 'explicit-sdf-field');
  assert.equal(sdf.sdfFields, true);
  assert.equal(custom.hullCollisions, 'unknown');
  assert.equal(custom.boxes, false);
  for (const caps of [standard, sdf, custom]) {
    assert.ok(Object.isFrozen(caps));
    assert.equal(caps.capsules, false);
    assert.equal(caps.compounds, false);
    assert.equal(caps.sensors, caps.backend === 'standard');
  }
  assert.equal(standard.backend, 'standard');
});

test('sensor capability excludes custom shaders and proof overrides', () => {
  const device = deviceCapabilities({ limits: { maxStorageBuffersPerShaderStage: 8 } });
  assert.equal(worldCapabilities(device, 'standard', false, true).sensors, false);
  assert.equal(worldCapabilities(device, 'standard', false, false, false, true, false).sensors, false);
});
