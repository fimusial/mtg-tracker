// run:
// node test-combat.js ./combatEngine.js

const assert = require('assert');
require(process.argv[2]);
const { resolveCombat } = globalThis.CombatEngine;

let nextId = 1;
const A = (p, t, keywords = {}) => ({ id: nextId++, power: p, toughness: t, keywords });
const D = (p, t, keywords = {}, blocking = null) => ({ id: nextId++, power: p, toughness: t, keywords, blocking });
const block = (d, a) => { d.blocking = a.id; return d; };

let passed = 0;
function test(name, fn) {
    try {
        fn();
        passed++;
    } catch (e) {
        console.log(`FAIL: ${name}\n  ${e.message}`);
        process.exitCode = 1;
    }
}
const run = (attackers, defenders = []) => resolveCombat({ attackers, defenders });
const dead = (r, c) => Boolean(r.creatures[c.id].fate);

test('unblocked attacker hits player', () => {
    const a = A(3, 3);
    const r = run([a]);
    assert.strictEqual(r.legal, true);
    assert.strictEqual(r.player.damage, 3);
    assert.strictEqual(r.player.lifeChange, -3);
});

test('2/2 trade', () => {
    const a = A(2, 2), d = block(D(2, 2), a);
    const r = run([a], [d]);
    assert.ok(dead(r, a) && dead(r, d));
    assert.strictEqual(r.player.damage, 0);
    assert.strictEqual(r.creatures[a.id].damage, 2);
});

test('first strike kills blocker first', () => {
    const a = A(2, 2, { 'first-strike': true }), d = block(D(2, 2), a);
    const r = run([a], [d]);
    assert.ok(!dead(r, a) && dead(r, d));
    assert.strictEqual(r.creatures[a.id].damage, 0);
});

test('first-strike blocker kills attacker first', () => {
    const a = A(3, 2), d = block(D(2, 3, { 'first-strike': true }), a);
    const r = run([a], [d]);
    assert.ok(dead(r, a) && !dead(r, d));
    assert.strictEqual(r.creatures[d.id].damage, 0);
});

test('double strike unblocked deals twice', () => {
    const a = A(2, 2, { 'double-strike': true });
    assert.strictEqual(run([a]).player.damage, 4);
});

test('double strike trample over 2/2', () => {
    const a = A(3, 3, { 'double-strike': true, trample: true }), d = block(D(2, 2), a);
    const r = run([a], [d]);
    assert.strictEqual(r.player.damage, 4); // 1 + 3 (702.19d)
    assert.ok(dead(r, d) && !dead(r, a));
});

test('double strike without trample: second hit does nothing after blocker died', () => {
    const a = A(3, 3, { 'double-strike': true }), d = block(D(2, 2), a);
    const r = run([a], [d]);
    assert.strictEqual(r.player.damage, 0);
    assert.strictEqual(r.creatures[d.id].damage, 3);
});

test('double strike 2/2 vs 3/3 finishes it in regular step, both die', () => {
    const a = A(2, 2, { 'double-strike': true }), d = block(D(3, 3), a);
    const r = run([a], [d]);
    assert.ok(dead(r, a) && dead(r, d));
    assert.strictEqual(r.creatures[d.id].damage, 4);
});

test('double strike vs first strike blocker', () => {
    const a = A(2, 3, { 'double-strike': true }), d = block(D(2, 4, { 'first-strike': true }), a);
    const r = run([a], [d]);
    // step 1: both deal 2. step 2: attacker deals 2 more (4 total => blocker dies), blocker does not strike again
    assert.ok(dead(r, d) && !dead(r, a));
    assert.strictEqual(r.creatures[a.id].damage, 2);
});

test('deathtouch trample divides 1 per blocker', () => {
    const a = A(5, 5, { deathtouch: true, trample: true });
    const d1 = block(D(3, 3), a), d2 = block(D(3, 3), a);
    const r = run([a], [d1, d2]);
    assert.strictEqual(r.player.damage, 3);
    assert.ok(dead(r, d1) && dead(r, d2) && dead(r, a));
});

test('lifelink attacker gains life even when blocked', () => {
    const a = A(3, 3, { lifelink: true }), d = block(D(2, 2), a);
    const r = run([a], [d]);
    assert.strictEqual(r.attackingPlayer.lifeGained, 3);
});

test('lifelink blocker gains defending player life', () => {
    const a = A(2, 2), d = block(D(3, 3, { lifelink: true }), a);
    const r = run([a], [d]);
    assert.strictEqual(r.player.lifeGained, 3);
    assert.strictEqual(r.player.lifeChange, 3);
});

test('infect unblocked gives poison not life loss', () => {
    const a = A(2, 2, { infect: true });
    const r = run([a]);
    assert.strictEqual(r.player.poison, 2);
    assert.strictEqual(r.player.lifeChange, 0);
    assert.strictEqual(r.player.damage, 2);
});

test('infect kills via -1/-1 counters', () => {
    const a = A(3, 3, { infect: true }), d = block(D(1, 2), a);
    const r = run([a], [d]);
    assert.ok(dead(r, d));
    assert.strictEqual(r.creatures[d.id].fate.kind, 'dies');
    assert.strictEqual(r.creatures[d.id].minusCounters, 3);
});

test('wither on indestructible: survives if toughness stays positive', () => {
    const a = A(2, 2, { wither: true }), d = block(D(1, 3, { indestructible: true }), a);
    const r = run([a], [d]);
    assert.ok(!dead(r, d));
    assert.strictEqual(r.creatures[d.id].toughness, 1);
    assert.strictEqual(r.creatures[d.id].power, -1);
});

test('wither kills indestructible at 0 toughness', () => {
    const a = A(3, 3, { wither: true }), d = block(D(1, 3, { indestructible: true }), a);
    const r = run([a], [d]);
    assert.ok(dead(r, d));
});

test('wither first strike shrinks blocker power before it strikes back', () => {
    const a = A(2, 3, { wither: true, 'first-strike': true }), d = block(D(3, 4), a);
    const r = run([a], [d]);
    // blocker becomes 1/2 then deals 1
    assert.strictEqual(r.creatures[a.id].damage, 1);
    assert.ok(!dead(r, a) && !dead(r, d));
});

test('flying blocked by ground creature is illegal', () => {
    const a = A(2, 2, { flying: true }), d = block(D(2, 2), a);
    const r = run([a], [d]);
    assert.strictEqual(r.legal, false);
    assert.deepStrictEqual(r.problems[0].defenderIds, [d.id]);
});

test('flying blocked by reach is legal', () => {
    const a = A(2, 2, { flying: true }), d = block(D(2, 2, { reach: true }), a);
    assert.strictEqual(run([a], [d]).legal, true);
});

test('flying blocked by flyer is legal; flyer can block ground', () => {
    const a = A(2, 2, { flying: true }), d = block(D(2, 2, { flying: true }), a);
    const b = A(1, 1), e = block(D(1, 1, { flying: true }), b);
    assert.strictEqual(run([a, b], [d, e]).legal, true);
});

test('menace single blocker illegal, two legal', () => {
    const a = A(3, 3, { menace: true }), d1 = block(D(2, 2), a);
    assert.strictEqual(run([a], [d1]).legal, false);
    const d2 = block(D(2, 2), a);
    const r = run([a], [d1, d2]);
    assert.strictEqual(r.legal, true);
    assert.ok(dead(r, a));
});

test('skulk uses power after battle cry', () => {
    const a = A(2, 2, { skulk: true }), cry = A(1, 1, { 'battle-cry': true });
    const d = block(D(3, 3), a);
    assert.strictEqual(run([a], [d]).legal, false);
    const r = run([a, cry], [d]);
    assert.strictEqual(r.legal, true);
    assert.strictEqual(r.creatures[a.id].power, 3);
    assert.strictEqual(r.creatures[cry.id].power, 1);
});

test('shadow both ways', () => {
    const a = A(2, 2, { shadow: true }), d = block(D(2, 2), a);
    assert.strictEqual(run([a], [d]).legal, false);
    const b = A(2, 2), e = block(D(2, 2, { shadow: true }), b);
    assert.strictEqual(run([b], [e]).legal, false);
    const c = A(2, 2, { shadow: true }), f = block(D(2, 2, { shadow: true }), c);
    assert.strictEqual(run([c], [f]).legal, true);
});

test('horsemanship', () => {
    const a = A(2, 2, { horsemanship: true }), d = block(D(2, 2), a);
    assert.strictEqual(run([a], [d]).legal, false);
    d.keywords = { horsemanship: true };
    assert.strictEqual(run([a], [d]).legal, true);
});

test('decayed cannot block; decayed attacker sacrificed', () => {
    const a = A(2, 2), d = block(D(2, 2, { decayed: true }), a);
    assert.strictEqual(run([a], [d]).legal, false);
    const b = A(2, 2, { decayed: true });
    const r = run([b]);
    assert.strictEqual(r.player.damage, 2);
    assert.strictEqual(r.creatures[b.id].fate.kind, 'sacrificed');
});

test('defender cannot attack', () => {
    const a = A(0, 4, { defender: true });
    const r = run([a]);
    assert.strictEqual(r.legal, false);
    assert.strictEqual(r.problems[0].attackerId, a.id);
});

test('protection attacker cannot be blocked', () => {
    const a = A(2, 2, { protection: true }), d = block(D(2, 2), a);
    assert.strictEqual(run([a], [d]).legal, false);
});

test('protection blocker vs 6/6 trample (702.19b example)', () => {
    const a = A(6, 6, { trample: true }), d = block(D(2, 2, { protection: true }), a);
    const r = run([a], [d]);
    assert.strictEqual(r.player.damage, 4);
    assert.ok(!dead(r, d));
    assert.strictEqual(r.creatures[d.id].prevented, 2);
    assert.strictEqual(r.creatures[a.id].damage, 2);
});

test('protection blocker prevents lifelink gain', () => {
    const a = A(3, 3, { lifelink: true }), d = block(D(1, 1, { protection: true }), a);
    const r = run([a], [d]);
    assert.strictEqual(r.attackingPlayer.lifeGained, 0);
});

test('flanking kills 1/1 blocker before damage; attacker deals no damage', () => {
    const a = A(2, 2, { flanking: true }), d = block(D(1, 1), a);
    const r = run([a], [d]);
    assert.ok(dead(r, d));
    assert.strictEqual(r.creatures[d.id].fate.kind, 'dies');
    assert.strictEqual(r.player.damage, 0);
    assert.strictEqual(r.creatures[a.id].damage, 0);
});

test('flanking does not affect blockers with flanking', () => {
    const a = A(2, 2, { flanking: true }), d = block(D(1, 1, { flanking: true }), a);
    const r = run([a], [d]);
    assert.strictEqual(r.creatures[d.id].toughness, 1);
    assert.strictEqual(r.creatures[a.id].damage, 1);
});

test('flanking vs bushido blocker', () => {
    const a = A(2, 2, { flanking: true }), d = block(D(1, 1, { bushido: 1 }), a);
    const r = run([a], [d]);
    // 1/1 +1/+1 -1/-1 = 1/1, takes 2 → dies, deals 1
    assert.ok(dead(r, d) && !dead(r, a));
    assert.strictEqual(r.creatures[a.id].damage, 1);
});

test('bushido attacker only when blocked', () => {
    const a = A(2, 2, { bushido: 1 }), d = block(D(3, 3), a);
    const r = run([a], [d]);
    assert.ok(dead(r, a) && dead(r, d));
    const b = A(2, 2, { bushido: 2 });
    assert.strictEqual(run([b]).player.damage, 2);
});

test('rampage counts blockers beyond the first', () => {
    const a = A(3, 3, { rampage: 2 });
    const ds = [block(D(1, 1), a), block(D(1, 1), a), block(D(1, 1), a)];
    const r = run([a], ds);
    assert.strictEqual(r.creatures[a.id].power, 7);
    assert.ok(ds.every(d => dead(r, d)));
    assert.ok(!dead(r, a));
});

test('afflict when blocked', () => {
    const a = A(2, 2, { afflict: 2 }), d = block(D(4, 4), a);
    const r = run([a], [d]);
    assert.strictEqual(r.player.lifeChange, -2);
    assert.strictEqual(r.player.damage, 0);
});

test('toxic and double strike', () => {
    const a = A(1, 1, { toxic: 2, 'double-strike': true });
    const r = run([a]);
    assert.strictEqual(r.player.damage, 2);
    assert.strictEqual(r.player.poison, 4);
});

test('poisonous and infect stack', () => {
    const a = A(2, 2, { poisonous: 1, infect: true });
    const r = run([a]);
    assert.strictEqual(r.player.poison, 3);
});

test('toxic does nothing when blocked', () => {
    const a = A(2, 2, { toxic: 1 }), d = block(D(1, 1), a);
    assert.strictEqual(run([a], [d]).player.poison, 0);
});

test('exalted only when attacking alone', () => {
    const a = A(2, 2, { exalted: true });
    assert.strictEqual(run([a]).player.damage, 3);
    assert.strictEqual(run([a, A(1, 1)]).player.damage, 3);
});

test('melee +1/+1', () => {
    assert.strictEqual(run([A(2, 2, { melee: true })]).player.damage, 3);
});

test('training needs another attacker with greater power', () => {
    const t = A(1, 1, { training: true });
    assert.strictEqual(run([t]).player.damage, 1);
    const r = run([t, A(3, 3)]);
    assert.strictEqual(r.creatures[t.id].power, 2);
    // battle cry from the bigger creature does not count towards training's check but stacks
    const r2 = run([t, A(1, 1, { 'battle-cry': true })]);
    assert.strictEqual(r2.creatures[t.id].power, 2); // only battle cry, training not triggered (1 is not > 1)
});

test('battle cry stacks and does not affect itself', () => {
    const a = A(1, 1, { 'battle-cry': true }), b = A(1, 1, { 'battle-cry': true }), c = A(1, 1);
    const r = run([a, b, c]);
    assert.strictEqual(r.creatures[a.id].power, 2);
    assert.strictEqual(r.creatures[c.id].power, 3);
    assert.strictEqual(r.player.damage, 7);
});

test('maximize kills when double blocked', () => {
    const a = A(4, 4);
    const big = block(D(3, 3), a), small = block(D(1, 1), a), mid = block(D(2, 2), a);
    const r = run([a], [big, small, mid]);
    assert.ok(dead(r, small) && dead(r, mid) && !dead(r, big));
    assert.strictEqual(r.creatures[big.id].damage, 1);
    assert.ok(dead(r, a));
});

test('trample without enough damage for all lethal: no player damage', () => {
    const a = A(3, 3, { trample: true });
    const d1 = block(D(2, 2), a), d2 = block(D(2, 2), a);
    const r = run([a], [d1, d2]);
    assert.strictEqual(r.player.damage, 0);
    assert.strictEqual([d1, d2].filter(d => dead(r, d)).length, 1);
});

test('trample over indestructible assigns lethal and tramples over', () => {
    const a = A(5, 5, { trample: true }), d = block(D(1, 3, { indestructible: true }), a);
    const r = run([a], [d]);
    assert.strictEqual(r.player.damage, 2);
    assert.ok(!dead(r, d));
});

test('deathtouch blocker vs indestructible attacker', () => {
    const a = A(2, 2, { indestructible: true }), d = block(D(1, 1, { deathtouch: true }), a);
    const r = run([a], [d]);
    assert.ok(!dead(r, a) && dead(r, d));
});

test('deathtouch 1/1 blocker kills big attacker', () => {
    const a = A(6, 6), d = block(D(1, 1, { deathtouch: true }), a);
    const r = run([a], [d]);
    assert.ok(dead(r, a) && dead(r, d));
    assert.strictEqual(r.creatures[a.id].fate.reason, 'deathtouch');
});

test('zero power attacker deals no damage', () => {
    const a = A(0, 3);
    assert.strictEqual(run([a]).player.damage, 0);
});

test('blocker whose attacker died in first strike step does not deal damage', () => {
    const a = A(2, 1), d = block(D(1, 1, { 'first-strike': true }), a), d2 = block(D(3, 3), a);
    const r = run([a], [d, d2]);
    // d (first strike) kills a in step 1, a never deals damage, d2 deals no damage in step 2
    assert.ok(dead(r, a));
    assert.ok(!dead(r, d) && !dead(r, d2));
    assert.strictEqual(r.creatures[d2.id].damage, 0);
});

test('indestructible not destroyed by lethal damage', () => {
    const a = A(5, 5), d = block(D(1, 2, { indestructible: true }), a);
    const r = run([a], [d]);
    assert.ok(!dead(r, d));
    assert.strictEqual(r.creatures[d.id].damage, 5);
});

test('no defenders and no attackers', () => {
    const r = run([], []);
    assert.strictEqual(r.legal, true);
    assert.strictEqual(r.player.damage, 0);
    assert.strictEqual(r.log.length, 0);
});

test('non-blocking defenders are unaffected', () => {
    const a = A(2, 2), d = D(5, 5);
    const r = run([a], [d]);
    assert.strictEqual(r.player.damage, 2);
    assert.strictEqual(r.creatures[d.id].inCombat, false);
});

console.log(`${passed} passed`);
