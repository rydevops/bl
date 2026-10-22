import test from 'node:test';
import assert from 'node:assert/strict';
import { B, I, ITEMS, itemName, TOOL_TIERS } from '../src/core/blocks.js';
import { Inventory, makeStack } from '../src/core/inventory.js';
import { RECIPES, matchRecipe, CraftGrid, recipeLayout, recipeNeeds } from '../src/core/crafting.js';
import { breakTime, canHarvest, dropFor, dropsFor, toolWear } from '../src/core/mining.js';

const P = B.PLANKS, S = I.STICK, C = B.COBBLE;

test('inventory: add merges stacks, respects 64 cap, fills hotbar first', () => {
  const inv = new Inventory();
  assert.equal(inv.add(B.DIRT, 10), 0);
  assert.equal(inv.add(B.DIRT, 60), 0);
  assert.equal(inv.get(0).n, 64);
  assert.equal(inv.get(1).n, 6);
  assert.equal(inv.count(B.DIRT), 70);
  assert.equal(inv.add(B.STONE, 1), 0);
  assert.equal(inv.get(2).id, B.STONE);
});

test('inventory: tools never stack and carry damage; full inventory returns the leftover', () => {
  const inv = new Inventory();
  inv.add(I.WOODEN_PICKAXE, 1);
  inv.add(I.WOODEN_PICKAXE, 1);
  assert.equal(inv.get(0).n, 1);
  assert.equal(inv.get(1).n, 1);
  const full = new Inventory(2);
  assert.equal(full.add(B.DIRT, 64 * 2 + 5), 5);
  assert.equal(full.canFit(B.DIRT, 1), false);
  assert.equal(full.canFit(B.STONE, 1), false);
  assert.equal(inv.add(999, 1), 1, 'unknown items are rejected');
});

test('inventory: remove, has, JSON round trip', () => {
  const inv = new Inventory();
  inv.add(B.LOG, 70);
  assert.equal(inv.remove(B.LOG, 66), 66);
  assert.equal(inv.count(B.LOG), 4);
  assert.equal(inv.remove(B.LOG, 10), 4);
  assert.ok(!inv.has(B.LOG));
  inv.add(I.STONE_AXE, 1, 12);
  inv.add(B.SAND, 3);
  const back = Inventory.fromJSON(JSON.parse(JSON.stringify(inv.toJSON())));
  assert.deepEqual(back.slots, inv.slots);
  assert.equal(back.get(0).d, 12);
});

test('crafting: every recipe matches its own layout and produces the right output', () => {
  for (const r of RECIPES) {
    const m = matchRecipe(recipeLayout(r));
    assert.equal(m, r, `recipe ${r.id} matches itself`);
    assert.ok(ITEMS[r.out.id] || r.out.id < 100, 'output exists');
  }
});

test('crafting: wooden pickaxe and axe patterns, anywhere in the grid, axe mirrored', () => {
  const pick = RECIPES.find((r) => r.id === 'wooden_pickaxe');
  const axe = RECIPES.find((r) => r.id === 'wooden_axe');
  assert.equal(matchRecipe([P, P, P, 0, S, 0, 0, S, 0]), pick);
  assert.equal(matchRecipe([P, P, 0, P, S, 0, 0, S, 0]), axe);
  assert.equal(matchRecipe([0, P, P, 0, S, P, 0, S, 0]), axe, 'mirrored axe');
  assert.equal(matchRecipe([0, P, P, 0, P, S, 0, 0, S]), axe, 'shifted right in the grid');
  assert.equal(matchRecipe([0, 0, 0, P, P, 0, P, S, 0]), null, 'an axe missing its lower handle is not an axe');
  assert.equal(matchRecipe([P, P, P, 0, S, 0, 0, 0, S]), null, 'wrong shape');
  assert.equal(matchRecipe([P, P, P, 0, 0, 0, 0, S, 0]), null);
  assert.equal(matchRecipe([C, C, C, 0, S, 0, 0, S, 0]), RECIPES.find((r) => r.id === 'stone_pickaxe'));
  assert.equal(matchRecipe([0, 0, 0, 0, 0, 0, 0, 0, 0]), null);
});

test('crafting: planks from a log (any cell) and sticks from two stacked planks', () => {
  for (let cell = 0; cell < 9; cell++) {
    const ids = new Array(9).fill(0); ids[cell] = B.LOG;
    assert.equal(matchRecipe(ids).id, 'planks');
  }
  assert.equal(matchRecipe([B.LOG, B.LOG, 0, 0, 0, 0, 0, 0, 0]), null, 'two logs is not a recipe');
  assert.equal(matchRecipe([P, 0, 0, P, 0, 0, 0, 0, 0]).id, 'sticks');
  assert.equal(matchRecipe([0, P, 0, 0, P, 0, 0, 0, 0]).id, 'sticks');
  assert.equal(matchRecipe([P, P, 0, 0, 0, 0, 0, 0, 0]), null, 'side by side is not sticks');
});

test('crafting grid: craft consumes one of each ingredient', () => {
  const g = new CraftGrid();
  g.slots[4] = makeStack(B.LOG, 3);
  assert.deepEqual(g.output(), { id: B.PLANKS, n: 4, d: 0 });
  const out = g.craft();
  assert.equal(out.n, 4);
  assert.equal(g.slots[4].n, 2);
  g.craft(); g.craft();
  assert.equal(g.slots[4], null);
  assert.equal(g.craft(), null);
});

test('crafting: recipe auto-fill lays out ingredients, can add sets, refuses when unaffordable', () => {
  const inv = new Inventory();
  const g = new CraftGrid();
  const pick = RECIPES.find((r) => r.id === 'wooden_pickaxe');
  inv.add(P, 2); inv.add(S, 2);
  assert.equal(g.autoFill(pick, inv), false, 'needs 3 planks');
  assert.equal(inv.count(P), 2, 'inventory untouched on failure');
  inv.add(P, 1);
  assert.equal(g.autoFill(pick, inv), true);
  assert.equal(g.recipe(), pick);
  assert.equal(inv.count(P), 0); assert.equal(inv.count(S), 0);
  // switching recipes returns the old ingredients first
  inv.add(B.LOG, 1);
  assert.equal(g.autoFill(RECIPES.find((r) => r.id === 'planks'), inv), true);
  assert.equal(inv.count(P), 3); assert.equal(inv.count(S), 2);
  assert.equal(g.recipe().id, 'planks');
  // second tap adds another set
  inv.add(B.LOG, 2);
  assert.equal(g.autoFill(RECIPES.find((r) => r.id === 'planks'), inv), true);
  assert.equal(g.count(B.LOG), 2);
  assert.deepEqual(recipeNeeds(pick), { [P]: 3, [S]: 2 });
});

test('crafting: clearTo returns the grid to the inventory', () => {
  const inv = new Inventory();
  const g = new CraftGrid();
  g.slots[0] = makeStack(B.DIRT, 5); g.slots[8] = makeStack(S, 2);
  assert.ok(g.clearTo(inv));
  assert.ok(g.isEmpty());
  assert.equal(inv.count(B.DIRT), 5); assert.equal(inv.count(S), 2);
});

test('mining: break times follow tool type and tier', () => {
  const hand = 0;
  assert.equal(breakTime(B.DIRT, hand), 0.5 * 1.5);
  assert.ok(Math.abs(breakTime(B.LOG, hand) - 3) < 1e-9);
  assert.ok(Math.abs(breakTime(B.LOG, I.WOODEN_AXE) - 1.5) < 1e-9);
  assert.ok(Math.abs(breakTime(B.LOG, I.STONE_AXE) - 0.75) < 1e-9);
  assert.ok(Math.abs(breakTime(B.LOG, I.WOODEN_PICKAXE) - 3) < 1e-9, 'wrong tool is no faster');
  assert.ok(Math.abs(breakTime(B.STONE, hand) - 7.5) < 1e-9);
  assert.ok(Math.abs(breakTime(B.STONE, I.WOODEN_PICKAXE) - 1.125) < 1e-9);
  assert.ok(Math.abs(breakTime(B.STONE, I.STONE_PICKAXE) - 0.5625) < 1e-9);
  assert.equal(breakTime(B.WATER, hand), Infinity);
  assert.equal(breakTime(B.AIR, hand), Infinity);
});

test('mining: stone needs a pickaxe to drop; drops map correctly', () => {
  assert.ok(!canHarvest(B.STONE, 0));
  assert.ok(!canHarvest(B.STONE, I.WOODEN_AXE));
  assert.ok(canHarvest(B.STONE, I.WOODEN_PICKAXE));
  assert.equal(dropFor(B.STONE, 0), null);
  assert.deepEqual(dropFor(B.STONE, I.WOODEN_PICKAXE), { id: B.COBBLE, n: 1 });
  assert.deepEqual(dropFor(B.GRASS, 0), { id: B.DIRT, n: 1 });
  assert.deepEqual(dropFor(B.LOG, 0), { id: B.LOG, n: 1 });
  assert.equal(dropFor(B.LEAVES, 0), null, 'leaves never drop themselves');
  assert.equal(dropFor(B.WATER, 0), null);
  assert.equal(toolWear(B.STONE, I.WOODEN_PICKAXE), 1);
  assert.equal(toolWear(B.STONE, 0), 0);
  assert.equal(TOOL_TIERS.stone.durability > TOOL_TIERS.wood.durability, true);
  assert.equal(itemName(I.STONE_AXE), 'Stone Axe');
});
