// Combat resolution for the Combat Calculator page, following the Comprehensive Rules:
// the combat phase (506-511), damage (120), state-based actions (704) and every keyword
// ability from 702 whose effect on combat follows from power, toughness, keywords and
// blocks alone. Pure logic without DOM access; exposed as the global CombatEngine.
(function () {
    const BOTH = ['attacker', 'defender'];

    const KEYWORDS = [
        { id: 'afflict', name: 'Afflict', rule: '702.130', sides: ['attacker'], hasValue: true,
            text: 'Whenever this creature becomes blocked, the defending player loses N life.' },
        { id: 'battle-cry', name: 'Battle cry', rule: '702.91', sides: ['attacker'],
            text: 'Whenever this creature attacks, each other attacking creature gets +1/+0.' },
        { id: 'bushido', name: 'Bushido', rule: '702.45', sides: BOTH, hasValue: true,
            text: 'Whenever this creature blocks or becomes blocked, it gets +N/+N.' },
        { id: 'deathtouch', name: 'Deathtouch', rule: '702.2', sides: BOTH,
            text: 'Any damage it deals to a creature destroys it, and 1 damage counts as lethal when assigning damage.' },
        { id: 'decayed', name: 'Decayed', rule: '702.147', sides: BOTH,
            text: "This creature can't block. When it attacks, it is sacrificed at end of combat." },
        { id: 'defender', name: 'Defender', rule: '702.3', sides: ['attacker'],
            text: "This creature can't attack." },
        { id: 'double-strike', name: 'Double strike', rule: '702.4', sides: BOTH,
            text: 'Deals combat damage in both the first-strike and the regular combat damage step.' },
        { id: 'exalted', name: 'Exalted', rule: '702.83', sides: ['attacker'],
            text: 'Whenever a creature you control attacks alone, it gets +1/+1.' },
        { id: 'first-strike', name: 'First strike', rule: '702.7', sides: BOTH,
            text: 'Deals combat damage in an earlier step than creatures without first strike.' },
        { id: 'flanking', name: 'Flanking', rule: '702.25', sides: BOTH,
            text: 'Whenever this creature becomes blocked by a creature without flanking, the blocking creature gets -1/-1.' },
        { id: 'flying', name: 'Flying', rule: '702.9', sides: BOTH,
            text: "Can't be blocked except by creatures with flying and/or reach." },
        { id: 'horsemanship', name: 'Horsemanship', rule: '702.31', sides: BOTH,
            text: "Can't be blocked by creatures without horsemanship." },
        { id: 'indestructible', name: 'Indestructible', rule: '702.12', sides: BOTH,
            text: "Isn't destroyed by lethal damage or deathtouch, but still dies at 0 toughness." },
        { id: 'infect', name: 'Infect', rule: '702.90', sides: BOTH,
            text: 'Deals damage to creatures as -1/-1 counters and to players as poison counters.' },
        { id: 'lifelink', name: 'Lifelink', rule: '702.15', sides: BOTH,
            text: 'Damage dealt by this creature also causes its controller to gain that much life.' },
        { id: 'melee', name: 'Melee', rule: '702.121', sides: ['attacker'],
            text: 'Whenever this creature attacks, it gets +1/+1 for each opponent attacked (one in a two-player game).' },
        { id: 'menace', name: 'Menace', rule: '702.111', sides: ['attacker'],
            text: "Can't be blocked except by two or more creatures." },
        { id: 'poisonous', name: 'Poisonous', rule: '702.70', sides: ['attacker'], hasValue: true,
            text: 'Whenever this creature deals combat damage to a player, that player gets N poison counters.' },
        { id: 'protection', name: 'Protection from everything', short: 'Protection', rule: '702.16j', sides: BOTH,
            text: "Can't be blocked by creatures, and all damage dealt to it is prevented. Works the same in combat as protection from creatures." },
        { id: 'rampage', name: 'Rampage', rule: '702.23', sides: ['attacker'], hasValue: true,
            text: 'Whenever this creature becomes blocked, it gets +N/+N for each creature blocking it beyond the first.' },
        { id: 'reach', name: 'Reach', rule: '702.17', sides: ['defender'],
            text: 'Can block creatures with flying.' },
        { id: 'shadow', name: 'Shadow', rule: '702.28', sides: BOTH,
            text: 'Can block or be blocked by only creatures with shadow.' },
        { id: 'skulk', name: 'Skulk', rule: '702.118', sides: ['attacker'],
            text: "Can't be blocked by creatures with greater power." },
        { id: 'toxic', name: 'Toxic', rule: '702.164', sides: ['attacker'], hasValue: true,
            text: 'Combat damage it deals to a player also gives that player N poison counters.' },
        { id: 'training', name: 'Training', rule: '702.149', sides: ['attacker'],
            text: 'Whenever this creature attacks with another creature with greater power, it gets a +1/+1 counter.' },
        { id: 'trample', name: 'Trample', rule: '702.19', sides: ['attacker'],
            text: 'Damage beyond lethal damage to its blockers can be assigned to the player.' },
        { id: 'wither', name: 'Wither', rule: '702.80', sides: BOTH,
            text: 'Deals damage to creatures in the form of -1/-1 counters.' }
    ];

    function keywordsFor(side) {
        return KEYWORDS.filter(keyword => keyword.sides.includes(side));
    }

    function toInt(value) {
        const number = Math.trunc(Number(value));
        return Number.isFinite(number) ? number : 0;
    }

    function has(creature, keyword) {
        return Boolean(creature.keywords[keyword]);
    }

    // The N of keywords like "toxic N"; 1 for keywords without a number.
    function amountOf(creature, keyword) {
        return has(creature, keyword) ? Math.max(1, toInt(creature.keywords[keyword])) : 0;
    }

    function power(creature) {
        return creature.basePower + creature.powerBonus - creature.minusCounters;
    }

    function toughness(creature) {
        return creature.baseToughness + creature.toughnessBonus - creature.minusCounters;
    }

    function modify(creature, powerChange, toughnessChange, description) {
        creature.powerBonus += powerChange;
        creature.toughnessBonus += toughnessChange;
        creature.modifiers.push(description);
    }

    function signed(number) {
        return number < 0 ? `−${-number}` : `+${number}`;
    }

    function plural(count, word) {
        return `${count} ${word}${count === 1 ? '' : 's'}`;
    }

    function labels(creatures) {
        const names = creatures.map(creature => creature.label);
        return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names.join('');
    }

    function createCreature(source, side, index) {
        return {
            id: source.id,
            label: source.label || `${side === 'attacker' ? 'A' : 'D'}${index + 1}`,
            side,
            keywords: source.keywords || {},
            basePower: toInt(source.power),
            baseToughness: toInt(source.toughness),
            powerBonus: 0,
            toughnessBonus: 0,
            minusCounters: 0,
            markedDamage: 0,
            damageTaken: 0,
            prevented: 0,
            deathtouched: false,
            onBattlefield: true,
            fate: null,
            modifiers: [],
            blockers: [],
            blocking: null,
            blocked: false,
            damageToPlayer: 0
        };
    }

    function resolveCombat(input) {
        const attackers = (input.attackers || []).map((source, i) => createCreature(source, 'attacker', i));
        const defenders = (input.defenders || []).map((source, i) => createCreature(source, 'defender', i));
        const creatures = attackers.concat(defenders);
        const ctx = {
            creatures,
            log: [],
            player: { damage: 0, lifeLost: 0, afflict: 0, lifeGained: 0, poison: 0 },
            attackingPlayer: { lifeGained: 0 }
        };

        // 509.1a: each blocking creature blocks exactly one attacking creature.
        const attackersById = new Map(attackers.map(attacker => [attacker.id, attacker]));
        defenders.forEach((defender, i) => {
            const attacker = attackersById.get(input.defenders[i].blocking);
            if (attacker) {
                defender.blocking = attacker;
                attacker.blockers.push(defender);
            }
        });
        // 509.1h
        attackers.forEach(attacker => {
            attacker.blocked = attacker.blockers.length > 0;
        });

        if (attackers.length > 0) {
            declareAttackers(attackers, ctx);
        }

        const problems = findIllegalDeclarations(attackers, defenders);
        if (problems.length === 0 && attackers.length > 0) {
            declareBlockers(attackers, defenders, ctx);
            combatDamage(ctx);
            endOfCombat(attackers, ctx);
        }

        return summarize(ctx, problems);
    }

    function startStep(ctx, title) {
        const step = { title, events: [] };
        ctx.log.push(step);
        return step.events;
    }

    function declareAttackers(attackers, ctx) {
        const events = startStep(ctx, 'Declare attackers step');
        events.push(`${labels(attackers)} attack${attackers.length === 1 ? 's' : ''}.`);

        // Attack triggers check their conditions as attackers are declared (508.1m), so
        // training compares powers from before any of these triggers resolved.
        const declaredPower = new Map(attackers.map(attacker => [attacker, power(attacker)]));

        attackers.forEach(attacker => {
            if (has(attacker, 'exalted') && attackers.length === 1) {
                modify(attacker, 1, 1, 'Exalted: +1/+1');
                events.push(`${attacker.label} attacks alone, so exalted gives it +1/+1.`);
            }

            if (has(attacker, 'battle-cry')) {
                const others = attackers.filter(other => other !== attacker);
                others.forEach(other => modify(other, 1, 0, `Battle cry (${attacker.label}): +1/+0`));
                events.push(others.length > 0
                    ? `${attacker.label}'s battle cry gives ${labels(others)} +1/+0.`
                    : `${attacker.label}'s battle cry has no other attacking creatures to affect.`);
            }

            if (has(attacker, 'melee')) {
                modify(attacker, 1, 1, 'Melee: +1/+1');
                events.push(`${attacker.label}'s melee gives it +1/+1 (one opponent attacked).`);
            }

            if (has(attacker, 'training')
                && attackers.some(other => other !== attacker && declaredPower.get(other) > declaredPower.get(attacker))) {
                modify(attacker, 1, 1, 'Training: +1/+1 counter');
                events.push(`${attacker.label} trains and gets a +1/+1 counter.`);
            }
        });
    }

    // Restrictions on attacking and blocking (508.1c, 509.1b). Any broken restriction makes
    // the whole declaration illegal, and the game would rewind it (509.1).
    function findIllegalDeclarations(attackers, defenders) {
        const problems = [];

        attackers.forEach(attacker => {
            if (has(attacker, 'defender')) {
                problems.push({
                    kind: 'attack',
                    text: `${attacker.label} has defender and can't attack (702.3b).`,
                    attackerId: attacker.id,
                    defenderIds: []
                });
            }
        });

        defenders.forEach(defender => {
            if (!defender.blocking) {
                return;
            }
            const reason = blockRestriction(defender.blocking, defender);
            if (reason) {
                problems.push({
                    kind: 'block',
                    text: `${defender.label} can't block ${defender.blocking.label}: ${reason}`,
                    attackerId: defender.blocking.id,
                    defenderIds: [defender.id]
                });
            }
        });

        attackers.forEach(attacker => {
            if (has(attacker, 'menace') && attacker.blockers.length === 1) {
                problems.push({
                    kind: 'menace',
                    text: `${attacker.label} has menace and can't be blocked except by two or more creatures (702.111b).`,
                    attackerId: attacker.id,
                    defenderIds: attacker.blockers.map(blocker => blocker.id)
                });
            }
        });

        return problems;
    }

    function blockRestriction(attacker, defender) {
        if (has(defender, 'decayed')) {
            return `${defender.label} has decayed, so it can't block (702.147a).`;
        }
        if (has(attacker, 'protection')) {
            return `${attacker.label} has protection from everything, so creatures can't block it (702.16j).`;
        }
        if (has(attacker, 'flying') && !has(defender, 'flying') && !has(defender, 'reach')) {
            return `${attacker.label} has flying, so only creatures with flying or reach can block it (702.9b).`;
        }
        if (has(attacker, 'shadow') && !has(defender, 'shadow')) {
            return `${attacker.label} has shadow, so only creatures with shadow can block it (702.28b).`;
        }
        if (!has(attacker, 'shadow') && has(defender, 'shadow')) {
            return `${defender.label} has shadow, so it can block only creatures with shadow (702.28b).`;
        }
        if (has(attacker, 'horsemanship') && !has(defender, 'horsemanship')) {
            return `${attacker.label} has horsemanship, so only creatures with horsemanship can block it (702.31b).`;
        }
        if (has(attacker, 'skulk') && power(defender) > power(attacker)) {
            return `${attacker.label} has skulk and ${defender.label}'s power (${power(defender)}) is greater than its power (${power(attacker)}) (702.118b).`;
        }
        return null;
    }

    function declareBlockers(attackers, defenders, ctx) {
        const events = startStep(ctx, 'Declare blockers step');

        attackers.forEach(attacker => {
            events.push(attacker.blocked
                ? `${labels(attacker.blockers)} block${attacker.blockers.length === 1 ? 's' : ''} ${attacker.label}.`
                : `${attacker.label} is unblocked.`);
        });

        // Only the order of triggers controlled by the same player can matter here: the
        // defending player's bushido resolves before the attacking player's flanking (APNAP),
        // and rampage is assumed to resolve before flanking could kill one of its blockers.
        defenders.filter(defender => defender.blocking && has(defender, 'bushido')).forEach(defender => {
            const n = amountOf(defender, 'bushido');
            modify(defender, n, n, `Bushido ${n}: +${n}/+${n}`);
            events.push(`${defender.label}'s bushido ${n} gives it +${n}/+${n}.`);
        });

        attackers.filter(attacker => attacker.blocked).forEach(attacker => {
            if (has(attacker, 'bushido')) {
                const n = amountOf(attacker, 'bushido');
                modify(attacker, n, n, `Bushido ${n}: +${n}/+${n}`);
                events.push(`${attacker.label}'s bushido ${n} gives it +${n}/+${n}.`);
            }

            const extraBlockers = attacker.blockers.length - 1;
            if (has(attacker, 'rampage') && extraBlockers > 0) {
                const n = amountOf(attacker, 'rampage') * extraBlockers;
                modify(attacker, n, n, `Rampage ${amountOf(attacker, 'rampage')}: +${n}/+${n}`);
                events.push(`${attacker.label}'s rampage ${amountOf(attacker, 'rampage')} gives it +${n}/+${n} (${plural(extraBlockers, 'blocker')} beyond the first).`);
            }

            if (has(attacker, 'flanking')) {
                const affected = attacker.blockers.filter(blocker => !has(blocker, 'flanking'));
                affected.forEach(blocker => modify(blocker, -1, -1, `Flanking (${attacker.label}): −1/−1`));
                if (affected.length > 0) {
                    events.push(`${attacker.label}'s flanking gives ${labels(affected)} −1/−1.`);
                }
            }

            if (has(attacker, 'afflict')) {
                const n = amountOf(attacker, 'afflict');
                ctx.player.afflict += n;
                events.push(`${attacker.label}'s afflict ${n}: the defending player loses ${n} life.`);
            }
        });

        checkStateBasedActions(ctx, events);
    }

    function inCombat(creature) {
        return creature.onBattlefield && (creature.side === 'attacker' || creature.blocking !== null);
    }

    function hasFirstStrike(creature) {
        return has(creature, 'first-strike') || has(creature, 'double-strike');
    }

    // 510.4, 702.4b, 702.7b
    function combatDamage(ctx) {
        const combatants = ctx.creatures.filter(inCombat);

        if (combatants.some(hasFirstStrike)) {
            damageStep(ctx, 'First-strike combat damage step', combatants.filter(hasFirstStrike));
            damageStep(ctx, 'Regular combat damage step', ctx.creatures
                .filter(inCombat)
                .filter(creature => !has(creature, 'first-strike') || has(creature, 'double-strike')));
        } else {
            damageStep(ctx, 'Combat damage step', combatants);
        }
    }

    function damageStep(ctx, title, participants) {
        const events = startStep(ctx, title);
        const assignments = [];

        // 510.1: all combat damage is assigned first, then dealt simultaneously (510.2).
        participants.forEach(creature => {
            const amount = power(creature);
            if (amount <= 0) {
                events.push(`${creature.label} has ${amount} power and assigns no combat damage (510.1a).`);
                return;
            }

            if (creature.side === 'defender') {
                if (creature.blocking.onBattlefield) {
                    assignments.push({ source: creature, target: creature.blocking, amount });
                } else {
                    events.push(`${creature.label} is no longer blocking anything and assigns no combat damage (510.1d).`);
                }
                return;
            }

            if (!creature.blocked) {
                assignments.push({ source: creature, target: null, amount });
                return;
            }

            const blockers = creature.blockers.filter(blocker => blocker.onBattlefield);
            if (blockers.length === 0) {
                if (has(creature, 'trample')) {
                    events.push(`No creatures are blocking ${creature.label} anymore, so trample assigns all its damage to the player (702.19d).`);
                    assignments.push({ source: creature, target: null, amount });
                } else {
                    events.push(`${creature.label} stays blocked with no creatures blocking it, so it assigns no combat damage (510.1c).`);
                }
                return;
            }

            const plan = assignAttackerDamage(creature, blockers, amount);
            if (plan.note) {
                events.push(plan.note);
            }
            plan.assigned.forEach((damage, blocker) => {
                if (damage > 0) {
                    assignments.push({ source: creature, target: blocker, amount: damage });
                }
            });
            if (plan.toPlayer > 0) {
                assignments.push({ source: creature, target: null, amount: plan.toPlayer });
            }
        });

        assignments.forEach(assignment => events.push(dealDamage(assignment, ctx)));
        checkStateBasedActions(ctx, events);
    }

    // 510.1c lets the attacking player divide damage among the blockers however they like.
    // The calculator destroys as many blockers as it can (cheapest first); with trample it
    // assigns exactly lethal damage to every blocker and the rest to the player (702.19b).
    function assignAttackerDamage(attacker, blockers, amount) {
        const assigned = new Map(blockers.map(blocker => [blocker, 0]));
        let remaining = amount;

        if (has(attacker, 'trample')) {
            const lethal = blockers.map(blocker => lethalDamage(blocker, attacker));
            const needed = lethal.reduce((sum, damage) => sum + damage, 0);
            if (remaining >= needed) {
                blockers.forEach((blocker, i) => assigned.set(blocker, lethal[i]));
                const excess = remaining - needed;
                return {
                    assigned,
                    toPlayer: excess,
                    note: `${attacker.label} assigns lethal damage to ${labels(blockers)}`
                        + (excess > 0 ? ` and tramples over with the remaining ${excess} (702.19b).` : ' (702.19b).')
                };
            }
        }

        const killable = blockers
            .map((blocker, index) => ({ blocker, index, cost: killCost(blocker, attacker), killed: false }))
            .filter(option => Number.isFinite(option.cost))
            .sort((a, b) => a.cost - b.cost || power(b.blocker) - power(a.blocker) || a.index - b.index);

        killable.forEach(option => {
            if (option.cost <= remaining) {
                assigned.set(option.blocker, option.cost);
                remaining -= option.cost;
                option.killed = true;
            }
        });

        if (remaining > 0) {
            const closest = killable.find(option => !option.killed);
            const target = closest
                ? closest.blocker
                : blockers.find(blocker => !has(blocker, 'protection')) || blockers[0];
            assigned.set(target, assigned.get(target) + remaining);
        }

        return {
            assigned,
            toPlayer: 0,
            note: blockers.length > 1
                ? `${attacker.label} divides its damage to destroy as many blockers as possible (510.1c).`
                : null
        };
    }

    // Lethal damage for trample, counting damage already marked (702.19b) and deathtouch (702.2c).
    function lethalDamage(blocker, attacker) {
        const lethal = Math.max(0, toughness(blocker) - blocker.markedDamage);
        return has(attacker, 'deathtouch') ? Math.min(1, lethal) : lethal;
    }

    // Damage the attacker must assign to actually get rid of a blocker.
    function killCost(blocker, attacker) {
        if (has(blocker, 'protection')) {
            return Infinity;
        }
        if (has(blocker, 'indestructible')) {
            const givesCounters = has(attacker, 'wither') || has(attacker, 'infect');
            return givesCounters ? Math.max(1, toughness(blocker)) : Infinity;
        }
        if (has(attacker, 'deathtouch')) {
            return 1;
        }
        return Math.max(1, toughness(blocker) - blocker.markedDamage);
    }

    // 120.3, 120.4: prevention first, then the results of the damage that is dealt.
    function dealDamage({ source, target, amount }, ctx) {
        const notes = [];

        if (target === null) {
            ctx.player.damage += amount;
            source.damageToPlayer += amount;
            if (has(source, 'infect')) {
                ctx.player.poison += amount;
                notes.push(`infect: ${plural(amount, 'poison counter')}`);
            } else {
                ctx.player.lifeLost += amount;
            }
            if (has(source, 'toxic')) {
                const n = amountOf(source, 'toxic');
                ctx.player.poison += n;
                notes.push(`toxic ${n}: ${plural(n, 'poison counter')}`);
            }
            if (has(source, 'poisonous')) {
                const n = amountOf(source, 'poisonous');
                ctx.player.poison += n;
                notes.push(`poisonous ${n}: ${plural(n, 'poison counter')}`);
            }
        } else {
            if (has(target, 'protection')) {
                target.prevented += amount;
                return `${source.label} deals ${amount} damage to ${target.label}, but protection prevents it (702.16e).`;
            }
            if (has(source, 'wither') || has(source, 'infect')) {
                target.minusCounters += amount;
                notes.push(`as ${plural(amount, '−1/−1 counter')}`);
            } else {
                target.markedDamage += amount;
            }
            target.damageTaken += amount;
            if (has(source, 'deathtouch')) {
                target.deathtouched = true;
                notes.push('deathtouch');
            }
        }

        if (has(source, 'lifelink')) {
            const controller = source.side === 'attacker' ? ctx.attackingPlayer : ctx.player;
            controller.lifeGained += amount;
            notes.push(`lifelink: +${amount} life`);
        }

        const recipient = target === null ? 'the defending player' : target.label;
        return `${source.label} deals ${amount} damage to ${recipient}${notes.length ? ` (${notes.join('; ')})` : ''}.`;
    }

    // 704.5f-h, 702.12b
    function checkStateBasedActions(ctx, events) {
        ctx.creatures.forEach(creature => {
            if (!creature.onBattlefield) {
                return;
            }

            const currentToughness = toughness(creature);
            const indestructible = has(creature, 'indestructible');
            let fate = null;
            if (currentToughness <= 0) {
                fate = { kind: 'dies', reason: '0 toughness' };
            } else if (!indestructible && creature.markedDamage > 0 && creature.markedDamage >= currentToughness) {
                fate = { kind: 'destroyed', reason: 'lethal damage' };
            } else if (!indestructible && creature.deathtouched) {
                fate = { kind: 'destroyed', reason: 'deathtouch' };
            }
            creature.deathtouched = false;

            if (fate) {
                creature.onBattlefield = false;
                creature.fate = fate;
                events.push(fate.kind === 'dies'
                    ? `${creature.label} has ${currentToughness} toughness and is put into the graveyard (704.5f).`
                    : `${creature.label} is destroyed by ${fate.reason} (${fate.reason === 'deathtouch' ? '704.5h' : '704.5g'}).`);
            }
        });
    }

    function endOfCombat(attackers, ctx) {
        const decayed = attackers.filter(attacker => attacker.onBattlefield && has(attacker, 'decayed'));
        if (decayed.length === 0) {
            return;
        }

        const events = startStep(ctx, 'End of combat step');
        decayed.forEach(attacker => {
            attacker.onBattlefield = false;
            attacker.fate = { kind: 'sacrificed', reason: 'decayed' };
            events.push(`${attacker.label} is sacrificed because it has decayed (702.147a).`);
        });
    }

    function summarize(ctx, problems) {
        const creatures = {};
        ctx.creatures.forEach(creature => {
            const modifiers = creature.modifiers.slice();
            if (creature.minusCounters > 0) {
                modifiers.push(`${plural(creature.minusCounters, '−1/−1 counter')}`);
            }

            creatures[creature.id] = {
                power: power(creature),
                toughness: toughness(creature),
                changed: power(creature) !== creature.basePower || toughness(creature) !== creature.baseToughness,
                modifiers,
                damage: creature.damageTaken,
                minusCounters: creature.minusCounters,
                prevented: creature.prevented,
                damageToPlayer: creature.damageToPlayer,
                fate: creature.fate,
                inCombat: creature.side === 'attacker' || creature.blocking !== null,
                blocked: creature.blocked
            };
        });

        const player = ctx.player;
        return {
            legal: problems.length === 0,
            problems,
            creatures,
            player: {
                damage: player.damage,
                lifeLost: player.lifeLost,
                afflict: player.afflict,
                lifeGained: player.lifeGained,
                lifeChange: player.lifeGained - player.lifeLost - player.afflict,
                poison: player.poison
            },
            attackingPlayer: { lifeGained: ctx.attackingPlayer.lifeGained },
            log: ctx.log.filter(step => step.events.length > 0)
        };
    }

    globalThis.CombatEngine = { KEYWORDS, keywordsFor, resolveCombat, signed };
})();
