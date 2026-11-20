import test from 'node:test';
import assert from 'node:assert/strict';
import { commandFor } from '../src/worker.mjs';

// RCON commands omit the leading slash used in-game.
test('MaffyWorld case IDs deliver the exact keys', () => {
  const expected = [
    [11, 'donate'], [12, 'money'],
    [13, 'tokens'], [14, 'items']
  ];
  for (const [productId, crateKey] of expected) {
    assert.equal(commandFor({}, productId, 'Steve_123', 1), 'cases givekey Steve_123 ' + crateKey + ' 1');
    assert.equal(commandFor({}, productId, 'Alex', 7), 'cases givekey Alex ' + crateKey + ' 7');
  }
});
test('Invalid inputs cannot inject delivery commands', () => {
  assert.equal(commandFor({}, 11, 'Steve;op', 1), null);
  assert.equal(commandFor({}, 11, 'Steve', 0), null);
  assert.equal(commandFor({}, 11, 'Steve', 51), null);
  assert.equal(commandFor({}, 11, 'Steve', 1.5), null);
  assert.equal(commandFor({}, 11, 'Steve', '1'), null);
  assert.equal(commandFor({}, 999, 'Steve', 1), null);
});
test('Runtime templates cannot override verified crate keys', () => {
  const env = { DELIVERY_COMMANDS_JSON: '{"11":"lp user {nickname} parent add owner"}' };
  assert.equal(commandFor(env, 11, 'Steve', 2), 'cases givekey Steve donate 2');
});
test('Rank delivery keeps using configured templates', () => {
  const env = { DELIVERY_COMMANDS_JSON: '{"1":"lp user {nickname} parent add sergeant"}' };
  assert.equal(commandFor(env, 1, 'Steve', 1), 'lp user Steve parent add sergeant');
  assert.equal(commandFor({}, 1, 'Steve', 1), null);
});
