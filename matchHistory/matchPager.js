const MATCHES_PER_PAGE = 5;

let matchHistoryPage = 1;
let matchHistoryMatches = [];

function describeMatchHistory(storedCount, playedCount) {
    return playedCount > storedCount
        ? `Your last ${storedCount} matches, out of ${playedCount} played`
        : `All your recorded matches: ${storedCount}`;
}

function renderMatchHistory(matches) {
    matchHistoryMatches = matches;
    showMatchHistoryPage(matchHistoryPage);
}

function showMatchHistoryPage(page) {
    const container = document.getElementById('all-matches');
    const pageCount = Math.max(1, Math.ceil(matchHistoryMatches.length / MATCHES_PER_PAGE));
    matchHistoryPage = Math.min(Math.max(1, page), pageCount);

    const first = (matchHistoryPage - 1) * MATCHES_PER_PAGE;
    const shown = matchHistoryMatches.slice(first, first + MATCHES_PER_PAGE);

    container.innerHTML = `
        ${pageCount > 1 ? renderMatchPager(pageCount, first, shown.length) : ''}
        <div class="match-list">
            ${shown.map(match => renderMatchItem(match)).join('')}
        </div>
    `;
}

function renderMatchPager(pageCount, first, shownCount) {
    const page = matchHistoryPage;
    const button = (target, label, { disabled = false, current = false } = {}) => `
        <button class="match-pager-button${current ? ' current' : ''}"
            ${disabled || current ? 'disabled' : `onclick="showMatchHistoryPage(${target})"`}>${label}</button>
    `;

    const numbers = matchPagerPages(page, pageCount).map(entry => entry === null
        ? '<span class="match-pager-gap">…</span>'
        : button(entry, entry, { current: entry === page })
    ).join('');

    return `
        <nav class="match-pager">
            ${button(page - 1, '‹ Prev', { disabled: page === 1 })}
            ${numbers}
            ${button(page + 1, 'Next ›', { disabled: page === pageCount })}
            <span class="match-pager-range">${first + 1}–${first + shownCount} of ${matchHistoryMatches.length}</span>
        </nav>
    `;
}

function matchPagerPages(page, pageCount) {
    const pages = [];
    for (let number = 1; number <= pageCount; number++) {
        if (number === 1 || number === pageCount || Math.abs(number - page) <= 2) {
            pages.push(number);
        } else if (pages[pages.length - 1] !== null) {
            pages.push(null);
        }
    }
    return pages;
}
