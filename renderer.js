const { ipcRenderer } = require('electron');

const RECENT_MATCH_COUNT = 3;

let currentPage = 'dashboard';
let matches = [];
let decks = [];
let stats = {};
let currentLogPath = '';
let cardDbUpdateOngoing = false;

function showPage(page) {
    currentPage = page;

    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.remove('active');
        if (item.textContent.toLowerCase().includes(page)) {
            item.classList.add('active');
        }
    });

    document.querySelectorAll('.page').forEach(p => {
        p.classList.remove('active');
    });
    document.getElementById(`page-${page}`).classList.add('active');

    if (page === 'dashboard') loadDashboard();
    if (page === 'matches') loadMatches();
    if (page === 'decks') loadDecks();
    if (page === 'formats') loadFormats();
    if (page === 'calculator') loadCombatCalculator();
    if (page === 'settings') loadSettings();
}

function minimizeWindow() {
    ipcRenderer.send('minimize-window');
}

function maximizeWindow() {
    ipcRenderer.send('maximize-window');
}

function closeWindow() {
    ipcRenderer.send('close-window');
}

async function loadDashboard() {
    const stats = await ipcRenderer.invoke('get-stats');
    const inventory = await ipcRenderer.invoke('get-inventory');

    document.getElementById('stat-total').textContent = stats.total || 0;
    document.getElementById('stat-wins').textContent = stats.wins || 0;
    document.getElementById('stat-losses').textContent = stats.losses || 0;
    document.getElementById('stat-winrate').textContent = `${stats.winRate || 0}%`;

    const inventoryContainer = document.getElementById('inventory-widget');
    if (inventoryContainer) {
        inventoryContainer.innerHTML = renderInventory(inventory);
    }

    const recentContainer = document.getElementById('recent-matches');
    const matches = await ipcRenderer.invoke('get-matches');
    const recent = matches.slice(0, RECENT_MATCH_COUNT);

    if (recent.length === 0) {
        recentContainer.innerHTML = `
            <div class="empty-state">
                <div class="icon">📝</div>
                <p>No matches yet. Your matches will appear here automatically.</p>
            </div>
        `;
    } else {
        recentContainer.innerHTML = recent.map(match => renderMatchItem(match)).join('');
    }
}

async function loadMatches() {
    const matches = await ipcRenderer.invoke('get-matches');
    const stats = await ipcRenderer.invoke('get-stats');
    const container = document.getElementById('all-matches');

    document.getElementById('matches-count').textContent =
        describeMatchHistory(matches.length, stats.total || 0);

    if (matches.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="icon">📝</div>
                <p>No matches recorded yet.</p>
            </div>
        `;
    } else {
        renderMatchHistory(matches);
    }
}

async function loadDecks() {
    const stats = await ipcRenderer.invoke('get-stats');

    renderDeckGrid({
        container: document.getElementById('decks-list'),
        decks: Object.values(stats.decks || {}).filter(deck => deck.total > 0),
        onClick: 'showDeckDetails',
        hint: 'Click to view deck list',
        emptyIcon: '🎴',
        emptyText: 'No decks recorded yet. Decks are automatically detected from your matches.'
    });
}

function renderDeckGrid({ container, decks, onClick, hint, emptyIcon, emptyText }) {
    if (!container) {
        return;
    }

    if (decks.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="icon">${emptyIcon}</div>
                <p>${emptyText}</p>
            </div>
        `;
        return;
    }

    container.innerHTML = `
        <div class="format-grid">
            ${decks
                .sort((a, b) => b.total - a.total)
                .map(deck => {
                    const winRate = deck.winRate || 0;
                    return `
                        <div class="format-card deck-card" onclick="${onClick}('${deck.id}')" style="cursor: pointer;">
                            <h4>
                                <span class="format-name">${deck.name}${renderManaSymbols(deck.colors)}</span>
                                <span class="format-badge">${deck.total} matches</span>
                            </h4>
                            <div class="format-stats">
                                <div class="mini-stat">
                                    <span class="number">${deck.wins}</span>
                                    <span class="label">Wins</span>
                                </div>
                                <div class="mini-stat">
                                    <span class="number">${deck.losses}</span>
                                    <span class="label">Losses</span>
                                </div>
                                <div class="mini-stat">
                                    <span class="number" style="color: ${winRate >= 50 ? 'var(--success)' : 'var(--danger)'}">${winRate}%</span>
                                    <span class="label">Win Rate</span>
                                </div>
                            </div>
                            <div class="winrate-bar">
                                <div class="fill" style="width: ${winRate}%"></div>
                            </div>
                            <div class="deck-hint">
                                ${hint}
                            </div>
                        </div>
                    `;
                }).join('')}
        </div>
    `;
}

async function showDeckDetails(deckId) {
    const deck = await ipcRenderer.invoke('get-deck', deckId);
    if (!deck) {
        alert('Deck not found');
        return;
    }

    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
        <div class="modal-content" style="max-width: 800px; max-height: 90vh; overflow-y: auto;">
            <div class="modal-header">
                <h2>${deck.name}${renderManaSymbols(deck.colors)}</h2>
                <div style="display: flex; gap: 10px;">
                    <button class="btn btn-primary" onclick="exportDeckToClipboard('${deckId}')">📋 Copy</button>
                    <button class="btn btn-secondary" onclick="closeDeckModal()">✕</button>
                </div>
            </div>
            <div class="modal-body">
                <div class="deck-info">
                    <p><strong>Format:</strong> ${deck.format || 'Unknown'}</p>
                    <p><strong>Last Used:</strong> ${new Date(deck.lastUsed).toLocaleDateString()}</p>
                </div>

                <div class="deck-lists">
                    <div class="deck-section">
                        <h3>Main Deck (${deck.mainDeck?.length || 0} cards)</h3>
                        <div class="card-list">
                            ${renderCardList(deck.mainDeck)}
                        </div>
                    </div>

                    ${deck.sideboard?.length > 0 ? `
                    <div class="deck-section">
                        <h3>Sideboard (${deck.sideboard.length} cards)</h3>
                        <div class="card-list">
                            ${renderCardList(deck.sideboard)}
                        </div>
                    </div>
                    ` : ''}

                    ${deck.commandZone?.length > 0 ? `
                    <div class="deck-section">
                        <h3>Command Zone (${deck.commandZone.length} cards)</h3>
                        <div class="card-list">
                            ${renderCardList(deck.commandZone)}
                        </div>
                    </div>
                    ` : ''}
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeDeckModal();
    });
}

async function showOpponentDeckDetails(matchId) {
    const deck = await ipcRenderer.invoke('get-match-opponent-deck', matchId);
    if (!deck) {
        alert('Deck not found');
        return;
    }

    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
        <div class="modal-content" style="max-width: 800px; max-height: 90vh; overflow-y: auto;">
            <div class="modal-header">
                <h2>${deck.name}${renderManaSymbols(deck.colors)}</h2>
                <div style="display: flex; gap: 10px;">
                    <button class="btn btn-primary" onclick="exportOpponentDeckToClipboard('${matchId}')">📋 Copy</button>
                    <button class="btn btn-secondary" onclick="closeDeckModal()">✕</button>
                </div>
            </div>
            <div class="modal-body">
                <div class="deck-info">
                    <p><strong>Format:</strong> ${deck.format || 'Unknown'}</p>
                </div>

                <div class="deck-lists">
                    <div class="deck-section">
                        <h3>Seen Cards (${deck.cards.length} cards)</h3>
                        <div class="card-list">
                            ${renderCardList(deck.cards)}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeDeckModal();
    });
}

function renderCardName(card) {
    if (!card.scryfallUri) {
        return card.name;
    }

    return `<a class="card-link" href="${escapeHtml(card.scryfallUri)}"`
        + ` target="_blank" rel="noopener noreferrer"`
        + ` title="View on Scryfall">${card.name}</a>`;
}

function renderCardList(cards) {
    if (!cards || cards.length === 0) {
        return '<p class="empty">No cards</p>';
    }

    const cardCounts = {};
    cards.forEach(card => {
        const cardId = typeof card === 'number' ? card : card.cardId;
        const cardName = typeof card === 'object' && card.name ? card.name : `Card ${cardId}`;
        const manaCost = typeof card === 'object' && card.manaCost ? card.manaCost : '';
        const scryfallUri = typeof card === 'object' && card.scryfallUri ? card.scryfallUri : '';
        if (!cardCounts[cardId]) {
            cardCounts[cardId] = { count: 0, name: cardName, manaCost: manaCost, scryfallUri: scryfallUri };
        }
        cardCounts[cardId].count++;
    });

    return `
        <ul class="card-list-items">
            ${Object.entries(cardCounts).map(([cardId, data]) => {
                return `<li>${data.count}x ${renderCardName(data)}${renderManaCost(data.manaCost)}</li>`;
            }).join('')}
        </ul>
    `;
}

function closeDeckModal() {
    const modal = document.querySelector('.modal-overlay');
    if (modal) modal.remove();
}

function formatExportCardList(cards) {
    if (!cards || cards.length === 0) return '';

    const groups = {};
    for (const card of cards) {
        groups[card.name] = {
            count: (groups[card.name]?.count || 0) + 1,
            scryfallUri: card.scryfallUri
        }
    }

    return Object.entries(groups)
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([_, entry]) => `${entry.count}x ${entry.scryfallUri}`)
        .join('\n');
}

async function exportDeckToClipboard(deckId) {
    const deck = await ipcRenderer.invoke('get-deck', deckId);
    if (!deck) {
        alert('Deck not found');
        return;
    }

    let exportText = `Name: ${deck.name}\n\n`;

    if (deck.commandZone?.length > 0) {
        exportText += 'Commander\n';
        exportText += formatExportCardList(deck.commandZone) + '\n\n';
    }

    exportText += 'Deck\n';
    exportText += formatExportCardList(deck.mainDeck) + '\n';

    if (deck.sideboard?.length > 0) {
        exportText += '\nSideboard\n';
        exportText += formatExportCardList(deck.sideboard) + '\n';
    }

    await navigator.clipboard.writeText(exportText);
}

async function exportOpponentDeckToClipboard(matchId) {
    const deck = await ipcRenderer.invoke('get-match-opponent-deck', matchId);
    if (!deck) {
        alert('Deck not found');
        return;
    }

    let exportText = `Name: ${deck.name}\n\n`;
    exportText += 'Deck\n';
    exportText += formatExportCardList(deck.cards) + '\n';

    await navigator.clipboard.writeText(exportText);
}

async function loadFormats() {
    const stats = await ipcRenderer.invoke('get-stats');

    const formatTable = document.getElementById('stats-formats-table');
    const formatTbody = formatTable.querySelector('tbody');
    const formats = stats.formats || {};

    if (Object.keys(formats).length === 0) {
        formatTbody.innerHTML = `
            <tr><td colspan="6" style="text-align: center; padding: 30px; color: var(--text-muted);">No data available</td></tr>
        `;
    } else {
        formatTbody.innerHTML = Object.entries(formats)
            .sort((a, b) => b[1].total - a[1].total)
            .map(([format, data]) => {
                const winRate = data.winRate || 0;
                return `
                    <tr>
                        <td><strong>${format}</strong></td>
                        <td>${data.total}</td>
                        <td class="positive">${data.wins}</td>
                        <td class="negative">${data.losses}</td>
                        <td>${data.draws}</td>
                        <td class="${winRate >= 50 ? 'positive' : 'negative'}">${winRate}%</td>
                    </tr>
                `;
            }).join('');
    }

    document.getElementById('formats-grid').innerHTML = renderFormatCards(formats);
}

function renderFormatCards(formats) {
    const entries = Object.entries(formats || {});

    if (entries.length === 0) {
        return `
            <div class="empty-state" style="grid-column: 1 / -1;">
                <div class="icon">🎮</div>
                <p>No matches recorded yet. Start playing MTG Arena!</p>
            </div>
        `;
    }

    return entries
        .sort((a, b) => b[1].total - a[1].total)
        .map(([format, data]) => {
            const winRate = data.winRate || 0;
            return `
                <div class="format-card">
                    <h4>
                        <span class="format-name">${format}</span>
                        <span class="format-badge">${data.total} matches</span>
                    </h4>
                    <div class="format-stats">
                        <div class="mini-stat">
                            <span class="number">${data.wins}</span>
                            <span class="label">Wins</span>
                        </div>
                        <div class="mini-stat">
                            <span class="number">${data.losses}</span>
                            <span class="label">Losses</span>
                        </div>
                        <div class="mini-stat">
                            <span class="number">${winRate}%</span>
                            <span class="label">Win Rate</span>
                        </div>
                    </div>
                    <div class="winrate-bar">
                        <div class="fill" style="width: ${winRate}%"></div>
                    </div>
                </div>
            `;
        }).join('');
}

const ZOOM_MIN = 80;
const ZOOM_MAX = 150;

function clampZoomPercent(percent) {
    const value = Math.round(Number(percent) || 100);
    return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value));
}

function showZoomValue(percent) {
    const zoom = clampZoomPercent(percent);
    const label = document.getElementById('setting-zoom-value');
    if (label) {
        label.textContent = `${zoom}%`;
    }
    return zoom;
}

async function commitZoom(percent) {
    const zoom = showZoomValue(percent);
    const slider = document.getElementById('setting-zoom');
    if (slider) {
        slider.value = zoom;
    }

    await ipcRenderer.invoke('set-zoom', zoom / 100);
    await saveSettings();
}

async function loadSettings() {
    await loadCardDbStatus();

    const settings = await ipcRenderer.invoke('get-settings');
    document.getElementById('setting-minimize').checked = settings.minimizeToTray !== false;
    document.getElementById('setting-notifications').checked = settings.showNotifications !== false;

    const zoom = clampZoomPercent((settings.zoomFactor || 1) * 100);
    document.getElementById('setting-zoom').value = zoom;
    showZoomValue(zoom);
    
    const logPath = await ipcRenderer.invoke('get-log-path');
    currentLogPath = logPath;
}

async function loadCardDbStatus() {
    try {
        const statusEl = document.getElementById('card-db-status');
        const detailsEl = document.getElementById('card-db-details');
        if (cardDbUpdateOngoing) {
            statusEl.textContent = '📥 Downloading card database...';
            statusEl.style.color = 'var(--primary)';
            detailsEl.textContent = 'This may take 30-60 seconds. Please wait...';
            return;
        }

        const status = await ipcRenderer.invoke('get-card-db-status');
        const lastUpdateEl = document.getElementById('card-db-last-update');

        if (!status) {
            statusEl.textContent = 'Unable to check card database';
            statusEl.style.color = 'var(--danger)';
            return;
        }

        if (status.exists) {
            const cardCount = status.cardCount || 0;
            if (cardCount > 0) {
                statusEl.textContent = `✅ Card database ready (${cardCount.toLocaleString()} cards)`;
                statusEl.style.color = 'var(--success)';
                detailsEl.textContent = `Source: ${status.source || 'unknown'}`;
            } else {
                statusEl.textContent = '⚠️ Card database is empty';
                statusEl.style.color = 'var(--warning)';
                detailsEl.textContent = 'Card names may not display correctly';
            }

            if (status.lastUpdated) {
                const date = new Date(status.lastUpdated);
                lastUpdateEl.textContent = date.toLocaleString();
            } else {
                lastUpdateEl.textContent = 'Unknown';
            }
        } else {
            statusEl.textContent = '❌ Card database not found';
            statusEl.style.color = 'var(--danger)';
            detailsEl.textContent = 'Click "Update Now" to download card data';
            lastUpdateEl.textContent = 'Never';
        }
    } catch (error) {
        console.error('Error loading card database status:', error);
        const statusEl = document.getElementById('card-db-status');
        if (statusEl) {
            statusEl.textContent = 'Error checking card database';
            statusEl.style.color = 'var(--danger)';
        }
    }
}

async function updateCardDatabase() {
    if (cardDbUpdateOngoing) {
        return;
    }

    cardDbUpdateOngoing = true;
    const buttonEl = document.getElementById('update-card-database-button');
    const statusEl = document.getElementById('card-db-status');
    const detailsEl = document.getElementById('card-db-details');

    buttonEl.disabled = true;
    statusEl.textContent = '📥 Downloading card database...';
    statusEl.style.color = 'var(--primary)';
    detailsEl.textContent = 'This may take 30-60 seconds. Please wait...';

    try {
        const result = await ipcRenderer.invoke('update-card-db');
        cardDbUpdateOngoing = false;
        buttonEl.disabled = false;

        if (result.success) {
            if (result.updated) {
                statusEl.textContent = `✅ Updated! (${result.cardCount?.toLocaleString() || '0'} cards)`;
                statusEl.style.color = 'var(--success)';
            } else {
                statusEl.textContent = '✅ Already up to date';
                statusEl.style.color = 'var(--success)';
            }

            setTimeout(loadCardDbStatus, 1000);
        } else {
            statusEl.textContent = '❌ Update failed';
            statusEl.style.color = 'var(--danger)';
            detailsEl.textContent = result.error || 'Unknown error';
        }
    } catch (error) {
        statusEl.textContent = '❌ Update failed';
        statusEl.style.color = 'var(--danger)';
        detailsEl.textContent = error.message;
    }
}

function renderInventory(inventory) {
    if (!inventory || !inventory.lastUpdated) {
        return '<div class="inventory-empty">No inventory data yet</div>';
    }

    const vaultPercent = Math.round((inventory.totalVaultProgress || 0) / 10);

    return `
        <div class="inventory-widget">
            <div class="inventory-section">
                <div class="inventory-item currency">
                    <span class="label">💎 Gems</span>
                    <span class="value">${inventory.gems?.toLocaleString() || 0}</span>
                </div>
                <div class="inventory-item currency">
                    <span class="label">🪙 Gold</span>
                    <span class="value">${inventory.gold?.toLocaleString() || 0}</span>
                </div>
            </div>
            <div class="inventory-section">
                <div class="inventory-item wildcards">
                    <span class="label">🃏 Wildcards</span>
                    <span class="value">
                        <span class="wc-common" title="Common" style="color: #ffffff; text-shadow: 0 0 2px #000;">${inventory.wildCardCommons || 0}</span> /
                        <span class="wc-uncommon" title="Uncommon" style="color: #c0c0c0;">${inventory.wildCardUnCommons || 0}</span> /
                        <span class="wc-rare" title="Rare" style="color: #ffd700; text-shadow: 0 0 2px #000;">${inventory.wildCardRares || 0}</span> /
                        <span class="wc-mythic" title="Mythic" style="color: #ff4500;">${inventory.wildCardMythics || 0}</span>
                    </span>
                </div>
            </div>
            <div class="inventory-section">
                <div class="inventory-item vault">
                    <span class="label">📦 Vault</span>
                    <span class="value">${vaultPercent}%</span>
                    <div class="progress-bar">
                        <div class="fill" style="width: ${vaultPercent}%"></div>
                    </div>
                </div>
                <div class="inventory-item packs">
                    <span class="label">📦 Packs</span>
                    <span class="value">${(inventory.boosters || []).reduce((sum, b) => sum + (b.Count || 0), 0)}</span>
                </div>
            </div>
        </div>
    `;
}

const MANA_SYMBOL_PATH = 'images/mana';

const MANA_SYMBOL_FILES = new Set([
    '0', '1', '10', '11', '12', '13', '14', '15', '16', '17', '18', '19',
    '2', '20', '2b', '2g', '2r', '2u', '2w', '3', '4', '5', '6', '7', '8',
    '9', 'b', 'bg', 'bgp', 'bp', 'br', 'brp', 'c', 'cb', 'cg', 'cr', 'cu',
    'cw', 'g', 'gp', 'gu', 'gup', 'gw', 'gwp', 'inverteds', 'r', 'rg',
    'rgp', 'rp', 'rw', 'rwp', 's', 'u', 'ub', 'ubp', 'up', 'ur', 'urp',
    'w', 'wb', 'wbp', 'wp', 'wu', 'wup', 'x'
]);

const MANA_COLOR_NAMES = {
    W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green'
};

function manaSymbolFile(token) {
    const key = String(token).replace(/[{}\/]/g, '').toLowerCase();
    return MANA_SYMBOL_FILES.has(key) ? `${MANA_SYMBOL_PATH}/${key}.svg` : null;
}

function renderManaSymbols(colors) {
    if (!Array.isArray(colors) || colors.length === 0) {
        return '';
    }

    const symbols = colors
        .map(color => {
            const file = manaSymbolFile(color);
            if (!file) {
                return '';
            }
            const name = MANA_COLOR_NAMES[color] || color;
            return `<img class="mana-symbol" src="${file}" alt="${name}" title="${name}">`;
        })
        .filter(Boolean)
        .join('');

    return symbols ? `<span class="mana-symbols">${symbols}</span>` : '';
}

function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char]);
}

function renderManaCost(manaCost) {
    if (!manaCost) {
        return '';
    }

    const parts = (manaCost.match(/\{[^}]+\}|\/\//g) || []).map(token => {
        if (token === '//') {
            return '<span class="mana-split">//</span>';
        }

        const file = manaSymbolFile(token);
        if (file) {
            const label = escapeHtml(token);
            return `<img class="mana-symbol" src="${file}" alt="${label}" title="${label}">`;
        }

        return `<span class="mana-text">${escapeHtml(token)}</span>`;
    });

    return parts.length ? `<span class="card-cost">${parts.join('')}</span>` : '';
}

function formatMatchDate(date) {
    const today = new Date();
    const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);

    if (date.toDateString() === today.toDateString()) return 'Today';
    if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return date.toLocaleDateString();
}

function renderMatchItem(match) {
    const date = formatMatchDate(new Date(match.timestamp));
    const time = new Date(match.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const opponentText = match.opponentName ? `v.s. ${match.opponentName}` : '';
    const playerDeck = `${match.deckName || 'Unknown Deck'}${renderManaSymbols(match.deckColors)}`;
    const opponentDeck = match.opponentDeck || { name: 'Unknown Deck', colors: [] };

    return `
        <div class="match-item ${match.result}" data-match-id="${match.id}">
            <div class="match-badge ${match.result}">${match.result}</div>
            <div class="match-info">
                <h4>
                    <span class="matchup">
                        ${match.deckId
                            ? `<span class="deck-link" onclick="showDeckDetails('${match.deckId}')" title="View deck list">${playerDeck}</span>`
                            : `<span>${playerDeck}</span>`}
                        <span class="versus">V.S.</span>
                        <span class="opponent-side deck-link" onclick="showOpponentDeckDetails('${match.id}')" title="View cards seen">${opponentDeck.name}${renderManaSymbols(opponentDeck.colors)}</span>
                    </span>
                </h4>
                <p>${match.format || 'Unknown'} • ${match.gamesPlayed || 1} game${match.gamesPlayed !== 1 ? 's' : ''}${opponentText ? ' • ' + opponentText : ''}</p>
            </div>
            <div class="match-date">${date}<br>${time}</div>
        </div>
    `;
}

async function refreshCurrentDataPage()
{
    if (currentPage === 'dashboard') loadDashboard();
    if (currentPage === 'matches') loadMatches();
    if (currentPage === 'decks') loadDecks();
    if (currentPage === 'formats') loadFormats();
}

async function deleteMatch(matchId) {
    if (!confirm('Are you sure you want to delete this match?')) return;
    await ipcRenderer.invoke('delete-match', matchId);
    await refreshCurrentDataPage();
}

async function exportData() {
    const path = await ipcRenderer.invoke('export-data');
    if (path) {
        alert(`Data exported to: ${path}`);
    }
}

async function importData() {
    const success = await ipcRenderer.invoke('import-data');
    if (success) {
        alert('Data imported successfully!');
        refreshCurrentDataPage();
    } else {
        alert('Failed to import data.');
    }
}

async function clearAllData() {
    if (!confirm('WARNING: This will delete ALL your match data. This cannot be undone.\n\nAre you sure?')) return;
    if (!confirm('Are you absolutely sure? All your data will be permanently lost.')) return;

    await ipcRenderer.invoke('clear-data');
    alert('All data has been cleared.');
    refreshCurrentDataPage();
}

async function saveSettings() {
    const settings = {
        minimizeToTray: document.getElementById('setting-minimize').checked,
        showNotifications: document.getElementById('setting-notifications').checked,
        zoomFactor: clampZoomPercent(document.getElementById('setting-zoom').value) / 100
    };

    await ipcRenderer.invoke('save-settings', settings);
}

async function scanLogNow() {
    const result = await ipcRenderer.invoke('refresh-log');
    if (result.success) {
        alert(`Scan complete!\nFound ${result.eventsFound} events\nProcessed ${result.matchesProcessed || 0} matches\nRead ${result.bytesRead} bytes\n\nCheck the Matches tab to see results.`);
        refreshCurrentDataPage();
    } else {
        alert(`Error: ${result.error}`);
    }
}

async function testNotification() {
    const result = await ipcRenderer.invoke('test-notification');
    if (result.success) {
        let message = 'Test notification sent!';
        if (result.troubleshooting) {
            message += '\n\n' + result.troubleshooting;
        }
        alert(message);
    } else {
        alert(`Notification failed: ${result.error}`);
    }
}

function updateStatus(data) {
    document.getElementById('status-text').textContent = data.text;
    document.getElementsByClassName('dot')[0].className = `dot ${data.status}`;
}

ipcRenderer.on('update-status', (event, data) => {
    console.log('Status updated:', data);
    updateStatus(data);

    if (data.refresh) {
        refreshCurrentDataPage();
    }
});

ipcRenderer.on('deck-submitted', (event, data) => {
    console.log('Deck submitted:', data);
});

ipcRenderer.on('inventory-updated', (event, data) => {
    console.log('[Renderer] Inventory updated:', data);

    if (currentPage === 'dashboard') {
        const inventoryContainer = document.getElementById('inventory-widget');
        if (inventoryContainer) {
            inventoryContainer.innerHTML = renderInventory(data);
        }
    }
});

document.addEventListener('DOMContentLoaded', () => {
    refreshCurrentDataPage();
});
