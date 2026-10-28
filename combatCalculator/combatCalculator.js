const COMBAT_MAX_CREATURES = 5;
const COMBAT_MAX_STAT = 99;
const COMBAT_MAX_KEYWORD_VALUE = 20;

const combatState = {
    attackers: [],
    defenders: [],
    selectedDefenderId: null,
    openMenuId: null,
    nextId: 1
};

let combatResult = null;
let combatPointer = null;
let combatBoardReady = false;

function loadCombatCalculator() {
    if (!combatBoardReady) {
        combatBoardReady = true;

        const board = document.getElementById('combat-board');
        new ResizeObserver(() => drawCombatArrows()).observe(board);

        board.addEventListener('mousemove', (e) => {
            if (combatState.selectedDefenderId === null) return;
            const rect = board.getBoundingClientRect();
            combatPointer = { x: e.clientX - rect.left, y: e.clientY - rect.top };
            drawCombatArrows();
        });

        board.addEventListener('mouseleave', () => {
            combatPointer = null;
            drawCombatArrows();
        });

        document.addEventListener('click', (e) => {
            if (!e.target.closest('.combat-kw')) {
                closeCombatKeywordMenu();
            }
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && currentPage === 'calculator') {
                closeCombatKeywordMenu();
                selectCombatDefender(null);
            }
        });

        renderCombatBoard();
    }

    drawCombatArrows();
}

function combatCreatures(side) {
    return side === 'attacker' ? combatState.attackers : combatState.defenders;
}

function findCombatCreature(id) {
    return combatState.attackers.find(c => c.id === id) || combatState.defenders.find(c => c.id === id);
}

function combatSide(id) {
    return combatState.attackers.some(c => c.id === id) ? 'attacker' : 'defender';
}

function combatLabel(side, index) {
    return `${side === 'attacker' ? 'A' : 'D'}${index + 1}`;
}

function clampCombatNumber(value, min, max) {
    const number = parseInt(value, 10);
    return Number.isNaN(number) ? null : Math.min(max, Math.max(min, number));
}

function addCombatCreature(side) {
    const creatures = combatCreatures(side);
    if (creatures.length >= COMBAT_MAX_CREATURES) {
        return;
    }

    creatures.push({ id: combatState.nextId++, power: 1, toughness: 1, keywords: {}, blocking: null });
    renderCombatRow(side);
    updateCombatResults();
}

function removeCombatCreature(id) {
    combatState.attackers = combatState.attackers.filter(c => c.id !== id);
    combatState.defenders = combatState.defenders.filter(c => c.id !== id);
    combatState.defenders.forEach(defender => {
        if (defender.blocking === id) defender.blocking = null;
    });
    if (combatState.selectedDefenderId === id) {
        combatState.selectedDefenderId = null;
    }
    if (combatState.openMenuId === id) {
        combatState.openMenuId = null;
    }

    renderCombatBoard();
}

function resetCombat() {
    combatState.attackers = [];
    combatState.defenders = [];
    combatState.selectedDefenderId = null;
    combatState.openMenuId = null;
    combatState.nextId = 1;
    combatPointer = null;

    renderCombatBoard();
}

function onCombatCardClick(event, id) {
    if (event.target.closest('input, button, label, .combat-kw')) {
        return;
    }

    if (combatSide(id) === 'defender') {
        if (combatState.selectedDefenderId === id) {
            findCombatCreature(id).blocking = null;
            selectCombatDefender(null);
        } else {
            selectCombatDefender(id);
        }
        return;
    }

    const defender = combatState.defenders.find(d => d.id === combatState.selectedDefenderId);
    if (defender) {
        defender.blocking = id;
        selectCombatDefender(null);
    }
}

function onCombatBoardClick(event) {
    if (!event.target.closest('.combat-creature')) {
        selectCombatDefender(null);
    }
}

function selectCombatDefender(id) {
    combatState.selectedDefenderId = id;
    if (id === null) {
        combatPointer = null;
    }
    updateCombatResults();
}

function setCombatStat(id, stat, input) {
    const value = clampCombatNumber(input.value, stat === 'power' ? 0 : 1, COMBAT_MAX_STAT);
    if (value === null) {
        return;
    }

    findCombatCreature(id)[stat] = value;
    updateCombatResults();
}

function commitCombatStat(id, stat, input) {
    input.value = findCombatCreature(id)[stat];
}

function toggleCombatKeywordMenu(id) {
    const wasOpen = combatState.openMenuId === id;
    closeCombatKeywordMenu();
    if (wasOpen) {
        return;
    }

    const card = document.getElementById(`combat-card-${id}`);
    const board = document.getElementById('combat-board').getBoundingClientRect();
    const rect = card.getBoundingClientRect();
    card.classList.toggle('menu-right', rect.left + rect.width / 2 > board.left + board.width / 2);
    card.classList.add('menu-open');
    combatState.openMenuId = id;
}

function closeCombatKeywordMenu() {
    if (combatState.openMenuId === null) {
        return;
    }

    const card = document.getElementById(`combat-card-${combatState.openMenuId}`);
    if (card) {
        card.classList.remove('menu-open');
    }
    combatState.openMenuId = null;
}

function setCombatKeyword(id, keywordId, checked) {
    const creature = findCombatCreature(id);
    const valueInput = document.getElementById(`combat-kw-${id}-${keywordId}`);

    if (checked) {
        creature.keywords[keywordId] = valueInput
            ? clampCombatNumber(valueInput.value, 1, COMBAT_MAX_KEYWORD_VALUE) || 1
            : true;
    } else {
        delete creature.keywords[keywordId];
    }
    if (valueInput) {
        valueInput.disabled = !checked;
    }

    document.getElementById(`combat-chips-${id}`).innerHTML = renderCombatChips(creature);
    updateCombatResults();
}

function setCombatKeywordValue(id, keywordId, input) {
    const value = clampCombatNumber(input.value, 1, COMBAT_MAX_KEYWORD_VALUE);
    const creature = findCombatCreature(id);
    if (value === null || !creature.keywords[keywordId]) {
        return;
    }

    creature.keywords[keywordId] = value;
    document.getElementById(`combat-chips-${id}`).innerHTML = renderCombatChips(creature);
    updateCombatResults();
}

function commitCombatKeywordValue(id, keywordId, input) {
    input.value = findCombatCreature(id).keywords[keywordId] || 1;
}

function renderCombatBoard() {
    renderCombatRow('attacker');
    renderCombatRow('defender');
    updateCombatResults();
}

function renderCombatRow(side) {
    const creatures = combatCreatures(side);
    const row = document.getElementById(side === 'attacker' ? 'combat-attackers' : 'combat-defenders');

    if (creatures.some(c => c.id === combatState.openMenuId)) {
        combatState.openMenuId = null;
    }

    row.innerHTML = creatures.length === 0
        ? `<div class="combat-empty">Use + to add ${side === 'attacker' ? 'an attacker' : 'a defender'}</div>`
        : creatures.map((creature, index) => renderCombatCard(creature, side, index)).join('');

    document.getElementById(`combat-add-${side}`).disabled = creatures.length >= COMBAT_MAX_CREATURES;
    document.getElementById(`combat-count-${side}`).textContent = `${creatures.length}/${COMBAT_MAX_CREATURES}`;
}

function renderCombatCard(creature, side, index) {
    const label = combatLabel(side, index);
    const options = CombatEngine.keywordsFor(side)
        .map(keyword => renderCombatKeywordOption(creature, keyword))
        .join('');

    return `
        <div class="combat-creature ${side}" id="combat-card-${creature.id}" onclick="onCombatCardClick(event, ${creature.id})">
            <div class="combat-creature-header">
                <span class="combat-creature-label">${label}</span>
                <button class="combat-remove" title="Remove ${label}" onclick="removeCombatCreature(${creature.id})">✕</button>
            </div>
            <div class="combat-pt">
                <input type="number" min="0" max="${COMBAT_MAX_STAT}" value="${creature.power}" title="Power"
                       oninput="setCombatStat(${creature.id}, 'power', this)" onchange="commitCombatStat(${creature.id}, 'power', this)">
                <span class="combat-pt-slash">/</span>
                <input type="number" min="1" max="${COMBAT_MAX_STAT}" value="${creature.toughness}" title="Toughness"
                       oninput="setCombatStat(${creature.id}, 'toughness', this)" onchange="commitCombatStat(${creature.id}, 'toughness', this)">
                <span class="combat-damage" id="combat-damage-${creature.id}"></span>
            </div>
            <div class="combat-kw">
                <button class="combat-kw-toggle" onclick="toggleCombatKeywordMenu(${creature.id})">
                    <span>Keywords</span><span class="combat-kw-caret">▾</span>
                </button>
                <div class="combat-kw-menu">${options}</div>
            </div>
            <div class="combat-kw-chips" id="combat-chips-${creature.id}">${renderCombatChips(creature)}</div>
            <div class="combat-status" id="combat-status-${creature.id}"></div>
        </div>
    `;
}

function renderCombatKeywordOption(creature, keyword) {
    const value = creature.keywords[keyword.id];
    const checked = value !== undefined;
    const valueInput = keyword.hasValue
        ? `<input type="number" class="combat-kw-value" id="combat-kw-${creature.id}-${keyword.id}"
                  min="1" max="${COMBAT_MAX_KEYWORD_VALUE}" value="${checked ? value : 1}" title="N" ${checked ? '' : 'disabled'}
                  oninput="setCombatKeywordValue(${creature.id}, '${keyword.id}', this)"
                  onchange="commitCombatKeywordValue(${creature.id}, '${keyword.id}', this)">`
        : '';

    return `
        <div class="combat-kw-option" title="${escapeHtml(`${keyword.text} (rule ${keyword.rule})`)}">
            <label>
                <input type="checkbox" ${checked ? 'checked' : ''} onchange="setCombatKeyword(${creature.id}, '${keyword.id}', this.checked)">
                <span>${keyword.name}${keyword.hasValue ? ' N' : ''}</span>
            </label>
            ${valueInput}
        </div>
    `;
}

function renderCombatChips(creature) {
    return CombatEngine.KEYWORDS
        .filter(keyword => creature.keywords[keyword.id] !== undefined)
        .map(keyword => {
            const name = keyword.short || keyword.name;
            const text = keyword.hasValue ? `${name} ${creature.keywords[keyword.id]}` : name;
            return `<span class="combat-chip" title="${escapeHtml(keyword.text)}">${text}</span>`;
        })
        .join('');
}

function updateCombatResults() {
    const withLabels = side => combatCreatures(side).map((creature, index) => ({ ...creature, label: combatLabel(side, index) }));
    combatResult = CombatEngine.resolveCombat({
        attackers: withLabels('attacker'),
        defenders: withLabels('defender')
    });

    combatState.attackers.forEach(creature => updateCombatCard(creature, 'attacker'));
    combatState.defenders.forEach(creature => updateCombatCard(creature, 'defender'));
    renderCombatPlayers();
    renderCombatLog();
    drawCombatArrows();
}

function updateCombatCard(creature, side) {
    const card = document.getElementById(`combat-card-${creature.id}`);
    const info = combatResult.creatures[creature.id];
    const problems = combatResult.problems.filter(problem => side === 'attacker'
        ? problem.attackerId === creature.id && problem.kind !== 'block'
        : problem.defenderIds.includes(creature.id));
    const legal = combatResult.legal;

    card.classList.toggle('selected', combatState.selectedDefenderId === creature.id);
    card.classList.toggle('illegal', problems.length > 0);
    card.classList.toggle('dead', legal && info.fate !== null);

    const damage = document.getElementById(`combat-damage-${creature.id}`);
    damage.textContent = legal && info.damage > 0 ? `−${info.damage}` : '';
    damage.title = info.minusCounters > 0
        ? `${info.damage} damage dealt (${info.minusCounters} as −1/−1 counters)`
        : `${info.damage} damage dealt`;

    const pills = [];
    if (problems.length > 0) {
        const warning = {
            attack: "Can't attack",
            block: "Can't block",
            menace: side === 'attacker' ? 'Needs 2+ blockers' : "Can't block alone"
        }[problems[0].kind];
        pills.push(`<span class="combat-pill bad" title="${escapeHtml(problems.map(p => p.text).join('\n'))}">⚠ ${warning}</span>`);
    } else if (legal) {
        if (info.fate) {
            const fateText = {
                destroyed: info.fate.reason === 'deathtouch' ? 'Destroyed (deathtouch)' : 'Destroyed',
                dies: 'Dies (0 toughness)',
                sacrificed: 'Sacrificed (decayed)'
            }[info.fate.kind];
            pills.push(`<span class="combat-pill bad">☠ ${fateText}</span>`);
        } else if (!info.inCombat) {
            pills.push('<span class="combat-pill muted">Not blocking</span>');
        } else if (side === 'attacker' && !info.blocked) {
            pills.push('<span class="combat-pill muted">Unblocked</span>');
        } else {
            pills.push('<span class="combat-pill good">Survives</span>');
        }

        if (info.damageToPlayer > 0) {
            pills.push(`<span class="combat-pill hit" title="Combat damage dealt to the defending player">⚔ ${info.damageToPlayer} to player</span>`);
        }
        if (info.prevented > 0) {
            pills.push(`<span class="combat-pill muted" title="Damage prevented by protection">🛡 ${info.prevented} prevented</span>`);
        }
        if (info.changed) {
            pills.push(`<span class="combat-pill muted" title="${escapeHtml(info.modifiers.join('\n'))}">→ ${info.power}/${info.toughness}</span>`);
        }
    }

    document.getElementById(`combat-status-${creature.id}`).innerHTML = pills.join('');
}

function renderCombatPlayers() {
    const box = document.getElementById('combat-player');
    const gained = document.getElementById('combat-attacking-player');

    if (!combatResult.legal) {
        box.className = 'combat-player illegal';
        box.innerHTML = `
            <div class="combat-player-title">⚠ Illegal declaration</div>
            <ul class="combat-problems">
                ${combatResult.problems.map(problem => `<li>${escapeHtml(problem.text)}</li>`).join('')}
            </ul>
        `;
        gained.innerHTML = '';
        return;
    }

    const player = combatResult.player;
    const signed = CombatEngine.signed;
    const effects = [];
    if (player.lifeChange !== 0 || player.afflict > 0 || player.lifeGained > 0) {
        const breakdown = [
            player.lifeLost > 0 ? `${signed(-player.lifeLost)} from combat damage` : '',
            player.afflict > 0 ? `${signed(-player.afflict)} from afflict` : '',
            player.lifeGained > 0 ? `${signed(player.lifeGained)} from lifelink` : ''
        ].filter(Boolean).join('\n');
        effects.push(`<span class="combat-pill ${player.lifeChange > 0 ? 'good' : 'bad'}" title="${breakdown}">Life ${signed(player.lifeChange)}</span>`);
    }
    if (player.poison > 0) {
        effects.push(`<span class="combat-pill poison" title="Poison counters from infect, toxic and poisonous">☣ ${player.poison} poison</span>`);
    }

    box.className = `combat-player${player.damage > 0 ? ' hit' : ''}`;
    box.innerHTML = `
        <div class="combat-player-title">Defending player</div>
        <div class="combat-player-damage">${player.damage}</div>
        <div class="combat-player-caption">combat damage taken</div>
        ${effects.length ? `<div class="combat-player-effects">${effects.join('')}</div>` : ''}
    `;

    const lifeGained = combatResult.attackingPlayer.lifeGained;
    gained.innerHTML = lifeGained > 0
        ? `<span class="combat-pill good" title="Life gained from lifelink">Attacking player gains ${lifeGained} life</span>`
        : '';
}

function renderCombatLog() {
    const body = document.getElementById('combat-log-body');

    if (!combatResult.legal) {
        body.innerHTML = '<p class="combat-log-empty">Fix the illegal declaration to see how combat plays out.</p>';
    } else if (combatResult.log.length === 0) {
        body.innerHTML = '<p class="combat-log-empty">Add attackers to see how combat plays out.</p>';
    } else {
        body.innerHTML = combatResult.log.map(step => `
            <div class="combat-log-step">
                <h4>${step.title}</h4>
                <ul>${step.events.map(event => `<li>${escapeHtml(event)}</li>`).join('')}</ul>
            </div>
        `).join('');
    }
}

function drawCombatArrows() {
    const svg = document.getElementById('combat-arrows');
    const board = document.getElementById('combat-board');
    if (!svg || !board || board.offsetParent === null) {
        return;
    }

    const origin = board.getBoundingClientRect();
    const illegal = new Set((combatResult ? combatResult.problems : []).flatMap(problem => problem.defenderIds));
    const paths = [];

    const cardRect = id => document.getElementById(`combat-card-${id}`).getBoundingClientRect();
    const topCenter = rect => ({ x: rect.left + rect.width / 2 - origin.left, y: rect.top - origin.top });

    combatState.attackers.forEach(attacker => {
        const blockers = combatState.defenders.filter(defender => defender.blocking === attacker.id);
        if (blockers.length === 0) {
            return;
        }

        const target = cardRect(attacker.id);
        blockers.forEach((defender, i) => {
            const end = {
                x: target.left + target.width * (i + 1) / (blockers.length + 1) - origin.left,
                y: target.bottom - origin.top
            };
            paths.push(combatArrowPath(topCenter(cardRect(defender.id)), end, illegal.has(defender.id) ? 'illegal' : ''));
        });
    });

    if (combatState.selectedDefenderId !== null && combatPointer) {
        const start = topCenter(cardRect(combatState.selectedDefenderId));
        if (combatPointer.y < start.y - 10) {
            paths.push(combatArrowPath(start, combatPointer, 'pending'));
        }
    }

    svg.innerHTML = paths.join('');
}

function combatArrowPath(start, end, type) {
    const bend = Math.max(20, (start.y - end.y) / 2);
    return `<path class="combat-arrow ${type}"
                  d="M ${start.x} ${start.y} C ${start.x} ${start.y - bend}, ${end.x} ${end.y + bend}, ${end.x} ${end.y}"></path>`;
}
