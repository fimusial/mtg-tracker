// The course of a match: a modal with everything both players did, turn by turn,
// opened by clicking a match card. Relies on renderer.js for ipcRenderer and the
// shared card, mana and date helpers.

const COURSE_TAGS = {
    setup: 'start',
    land: 'land',
    cast: 'cast',
    ability: 'ability',
    attack: 'attack',
    block: 'block',
    damage: 'damage',
    life: 'life',
    destroy: 'destroy',
    sacrifice: 'sacrifice',
    exile: 'exile',
    return: 'return',
    move: 'move',
    discard: 'discard',
    mill: 'mill',
    draw: 'draw',
    counter: 'counter',
    effect: 'effect',
    token: 'token',
    countered: 'countered',
    tap: 'tap',
    untap: 'untap',
    gap: 'gap',
    result: 'result'
};

document.addEventListener('click', (e) => {
    const item = e.target.closest('.match-item[data-match-id]');
    if (item && !e.target.closest('.deck-link, a, button')) {
        showMatchCourse(item.dataset.matchId);
    }
});

async function showMatchCourse(matchId) {
    const data = await ipcRenderer.invoke('get-match-course', matchId);
    if (!data) {
        alert('Match not found');
        return;
    }

    const { match, course, cards } = data;
    const context = courseContext(course, cards);
    const result = ['win', 'loss', 'draw'].includes(match.result) ? match.result : null;

    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
        <div class="modal-content course-modal">
            <div class="modal-header">
                <h2>Match Course${result ? ` <span class="match-badge ${result}">${result}</span>` : ''}</h2>
                <div style="display: flex; gap: 10px;">
                    ${course ? `<button class="btn btn-primary" onclick="exportMatchCourseToClipboard('${matchId}')">📋 Copy</button>` : ''}
                    <button class="btn btn-secondary" onclick="closeDeckModal()">✕</button>
                </div>
            </div>
            <div class="modal-body">
                ${renderCourseSummary(match, course, context)}
                ${course ? renderCourse(course, context) : `
                    <div class="empty-state">
                        <div class="icon">📜</div>
                        <p>The course of this match is not available.<br>
                        MTG Arena's log no longer holds this match.</p>
                    </div>
                `}
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    const onKeyDown = (e) => {
        if (!modal.isConnected) {
            document.removeEventListener('keydown', onKeyDown);
        } else if (e.key === 'Escape') {
            modal.remove();
        }
    };
    document.addEventListener('keydown', onKeyDown);

    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeDeckModal();
    });
}

function courseContext(course, cards) {
    const names = new Map((course?.players || []).map(player => [player.seat, player.name]));
    return { names, localSeat: course?.localSeat ?? null, cards: cards || {} };
}

function renderCourseSummary(match, course, context) {
    const opponentDeck = match.opponentDeck || { name: 'Unknown Deck', colors: [] };
    const played = new Date(course?.games?.[0]?.startedAt || match.timestamp);
    const time = played.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const minutes = courseMinutes(course?.games?.[0]?.startedAt, course?.games?.[course.games.length - 1]?.endedAt);

    let players = '';
    if (course?.players?.length) {
        const ordered = course.players.slice().sort((a, b) =>
            (a.seat === context.localSeat ? -1 : 0) - (b.seat === context.localSeat ? -1 : 0));
        players = ordered
            .map(player => `${renderCoursePlayer(player.seat, context)}${player.seat === context.localSeat ? ' (you)' : ''}`)
            .join(' vs ');
    } else if (match.opponentName) {
        players = `You vs ${escapeHtml(match.opponentName)}`;
    }

    return `
        <div class="deck-info course-summary">
            ${players ? `<p><strong>Players:</strong> ${players}</p>` : ''}
            <p><strong>Decks:</strong> ${escapeHtml(match.deckName || 'Unknown Deck')}${renderManaSymbols(match.deckColors)}
                <span class="course-versus">V.S.</span>
                ${escapeHtml(opponentDeck.name)}${renderManaSymbols(opponentDeck.colors)}</p>
            <p><strong>Format:</strong> ${escapeHtml(match.format || 'Unknown')}</p>
            <p><strong>Played:</strong> ${formatMatchDate(played)} ${time}${minutes ? ` · ${minutes} min` : ''}</p>
        </div>
    `;
}

function renderCourse(course, context) {
    const games = course.games.map(game => {
        const sections = courseSections(game.lines).map(section => `
            <section class="course-section">
                ${section.turn ? renderCourseTurn(section.turn, context) : ''}
                ${collapseCourseLines(section.lines).map(({ line, count }) => renderCourseLine(line, context, count)).join('')}
            </section>
        `).join('');

        return `
            <div class="course-game">
                <div class="course-game-header">
                    <h3>Game ${game.number}</h3>
                    <span class="course-game-meta">${renderCourseGameMeta(game, context)}</span>
                </div>
                ${sections}
            </div>
        `;
    }).join('');

    return `
        <div class="course-log">
            ${games}
            ${course.complete ? '' : '<p class="course-incomplete">The log ends before this match did.</p>'}
        </div>
    `;
}

function courseSections(lines) {
    const sections = [{ turn: null, lines: [] }];
    for (const line of lines) {
        if (line.kind === 'turn') {
            sections.push({ turn: line, lines: [] });
        } else {
            sections[sections.length - 1].lines.push(line);
        }
    }
    return sections.filter(section => section.turn || section.lines.length > 0);
}

function collapseCourseLines(lines) {
    const collapsed = [];
    let previousKey = null;
    for (const line of lines) {
        const key = JSON.stringify([line.kind, line.seat, line.parts]);
        if (key === previousKey) {
            collapsed[collapsed.length - 1].count++;
        } else {
            collapsed.push({ line, count: 1 });
            previousKey = key;
        }
    }
    return collapsed;
}

function renderCourseGameMeta(game, context) {
    const parts = [];
    const result = game.result;
    if (result?.draw) {
        parts.push('Draw');
    } else if (result && result.winner !== undefined && result.winner !== null) {
        parts.push(`${renderCoursePlayer(result.winner, context)} won`);
    }
    const minutes = courseMinutes(game.startedAt, game.endedAt);
    if (minutes) {
        parts.push(`${minutes} min`);
    }
    return parts.join(' · ');
}

function renderCourseTurn(turn, context) {
    const life = Object.entries(turn.life || {})
        .sort(([a], [b]) => (Number(a) === context.localSeat ? -1 : 0) - (Number(b) === context.localSeat ? -1 : 0))
        .map(([seat, total]) => `${renderCoursePlayer(Number(seat), context)} <span class="course-life">♥ ${total}</span>`)
        .join(' ');
    const time = turn.time
        ? new Date(turn.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : '';

    return `
        <div class="course-turn">
            <span class="course-turn-title">Turn ${turn.turn}</span>
            ${turn.seat !== null && turn.seat !== undefined ? renderCoursePlayer(turn.seat, context) : ''}
            <span class="course-turn-meta">${time ? `<span class="course-time">${time}</span>` : ''}${life}</span>
        </div>
    `;
}

function renderCourseLine(line, context, count = 1) {
    const owner = line.seat === null || line.seat === undefined || context.localSeat === null
        ? ''
        : line.seat === context.localSeat ? ' is-you' : ' is-opponent';
    const repeats = count > 1 ? ` <span class="course-count">${count}x</span>` : '';

    return `
        <div class="course-line course-kind-${escapeHtml(line.kind)}${owner}">
            <span class="course-tag">${COURSE_TAGS[line.kind] || escapeHtml(line.kind)}${repeats}</span>
            <span class="course-text">${(line.parts || []).map(part => renderCoursePart(part, context)).join('')}</span>
        </div>
    `;
}

function renderCoursePart(part, context) {
    if (typeof part === 'string') {
        return escapeHtml(part);
    }
    if (!part || typeof part !== 'object') {
        return '';
    }
    if (part.player !== undefined) {
        return renderCoursePlayer(part.player, context);
    }
    if (part.life !== undefined) {
        return ` <span class="course-life" title="Life total">♥ ${escapeHtml(part.life)}</span>`;
    }
    if (part.card !== undefined) {
        const card = context.cards[part.card];
        if (part.token) {
            const name = card?.scryfallUri ? renderCardName(card) : escapeHtml(part.token);
            return `<span class="course-token">${name} token${part.count ? 's' : ''}</span>`
                + (part.pt ? ` <span class="course-pt">${escapeHtml(part.pt)}</span>` : '');
        }
        if (!card) {
            return `Card ${escapeHtml(part.card)}`;
        }
        return `<span class="course-card">${renderCardName(card)}${renderManaCost(card.manaCost)}</span>`;
    }
    return '';
}

function renderCoursePlayer(seat, context) {
    const owner = context.localSeat === null ? '' : seat === context.localSeat ? ' is-you' : ' is-opponent';
    return `<span class="course-player${owner}">${escapeHtml(context.names.get(seat) || `Player ${seat}`)}</span>`;
}

function courseMinutes(from, to) {
    const ms = new Date(to) - new Date(from);
    return Number.isFinite(ms) && ms > 0 ? Math.max(1, Math.round(ms / 60000)) : null;
}

function coursePartText(part, context) {
    if (typeof part === 'string') {
        return part;
    }
    if (!part || typeof part !== 'object') {
        return '';
    }
    if (part.player !== undefined) {
        return context.names.get(part.player) || `Player ${part.player}`;
    }
    if (part.life !== undefined) {
        return ` (${part.life} life)`;
    }
    if (part.card !== undefined) {
        const card = context.cards[part.card];
        if (part.token) {
            const name = card?.scryfallUri ? card.name : part.token;
            return `${name} token${part.count ? 's' : ''}${part.pt ? ` ${part.pt}` : ''}`;
        }
        return card ? card.name : `Card ${part.card}`;
    }
    return '';
}

function courseToText(match, course, context) {
    const lineText = line => (line.parts || []).map(part => coursePartText(part, context)).join('');
    const nameOf = seat => context.names.get(seat) || `Player ${seat}`;
    const text = [];

    text.push(`Match Course: ${course.players.map(player => player.name).join(' vs ')} (${match.result})`);
    text.push(`${match.format || 'Unknown'} - ${new Date(match.timestamp).toLocaleString()}`);

    for (const game of course.games) {
        const winner = game.result?.winner;
        text.push('');
        text.push(`Game ${game.number}${game.result?.draw ? ' - draw' : winner !== undefined && winner !== null ? ` - ${nameOf(winner)} won` : ''}`);
        for (const { line, count } of collapseCourseLines(game.lines)) {
            if (line.kind === 'turn') {
                const life = Object.entries(line.life || {}).map(([seat, total]) => `${nameOf(Number(seat))} ${total}`).join(', ');
                text.push(`Turn ${line.turn} - ${nameOf(line.seat)}${life ? ` (life: ${life})` : ''}`);
            } else {
                text.push(`${line.turn > 0 ? '  ' : ''}${count > 1 ? `${count}x ` : ''}${lineText(line)}`);
            }
        }
    }

    return courseAscii(text.join('\n'));
}

function courseAscii(text) {
    return text
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^\x00-\x7f]/g, '?');
}

async function exportMatchCourseToClipboard(matchId) {
    const data = await ipcRenderer.invoke('get-match-course', matchId);
    if (!data?.course) {
        alert('Match course not found');
        return;
    }
    const context = courseContext(data.course, data.cards);
    await navigator.clipboard.writeText(courseToText(data.match, data.course, context));
}
