const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const matchArchive = require('./matchArchive');

const COLOR_ORDER = ['W', 'U', 'B', 'R', 'G', 'C'];

const ARENA_MATCH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const COLOR_COMBO_NAMES = {
  C: 'Colorless',
  W: 'Mono-White', U: 'Mono-Blue', B: 'Mono-Black', R: 'Mono-Red', G: 'Mono-Green',
  WU: 'Azorius', WB: 'Orzhov', WR: 'Boros', WG: 'Selesnya', UB: 'Dimir',
  UR: 'Izzet', UG: 'Simic', BR: 'Rakdos', BG: 'Golgari', RG: 'Gruul',
  WUB: 'Esper', WUR: 'Jeskai', WUG: 'Bant', WBR: 'Mardu', WBG: 'Abzan',
  WRG: 'Naya', UBR: 'Grixis', UBG: 'Sultai', URG: 'Temur', BRG: 'Jund',
  WUBR: 'Yore-Tiller', WUBG: 'Witch-Maw', WURG: 'Ink-Treader',
  WBRG: 'Dune-Brood', UBRG: 'Glint-Eye',
  WUBRG: 'Five-Color'
};

function nameFromColors(colors) {
  if (!Array.isArray(colors) || colors.length === 0) {
    return 'Unknown Deck';
  }
  const named = COLOR_COMBO_NAMES[colors.join('')];
  return named ? `${named} Deck` : 'Unknown Deck';
}

function winRateFrom(wins, losses) {
  const decided = wins + losses;
  return decided > 0 ? Math.round((wins / decided) * 100) : 0;
}

function colorsFromManaCost(manaCost) {
  if (!manaCost) {
    return [];
  }
  const symbols = manaCost.toUpperCase().match(/[WUBRG]/g) || [];
  return COLOR_ORDER.filter(color => symbols.includes(color));
}

class DataStore {
  static dataDirectory() {
    if (process.type === 'browser' || process.type === undefined) {
      return path.join(app.getPath('userData'), 'data');
    }
    return path.join(require('os').homedir(), '.mtg-arena-tracker', 'data');
  }

  static cardsFilePath() {
    return path.join(DataStore.dataDirectory(), 'cards.json');
  }

  constructor() {
    this.dataDir = DataStore.dataDirectory();

    this.dataFile = path.join(this.dataDir, 'matches.json');
    this.cardsFile = DataStore.cardsFilePath();

    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }

    this.data = this.loadData();
    this.cards = this.loadCards();
    this.onMatchesRetired = null;

    this.backfillColors();
    if (this.retireOldMatches().length > 0) {
      this.saveData();
    }
  }

  deckIdOf(match) {
    return match.deckId || this.deckIdFromName(match.deckName || 'Unknown Deck');
  }

  retireOldMatches() {
    const retired = matchArchive.retireOldMatches(this.data, match => this.deckIdOf(match));
    if (retired.length > 0) {
      console.log(`[DataStore] Retired ${retired.length} old match(es) from the history`);
      if (this.onMatchesRetired) {
        this.onMatchesRetired(retired);
      }
    }
    return retired;
  }

  loadCards() {
    try {
      if (fs.existsSync(this.cardsFile)) {
        const content = fs.readFileSync(this.cardsFile, 'utf8');
        const cardsData = JSON.parse(content);
        const cards = cardsData.cards || {};
        const cardCount = Object.keys(cards).length;
        console.log(`[DataStore] Loaded ${cardCount} cards from database`);
        if (cardsData.lastUpdated) {
          console.log(`[DataStore] Card database last updated: ${cardsData.lastUpdated}`);
        }
        return cards;
      }
    } catch (error) {
      console.error('[DataStore] Error loading cards database:', error);
    }
    console.log('[DataStore] No card database found, card names will not be available');
    return {};
  }

  reloadCards() {
    this.cards = this.loadCards();
    return this.cards;
  }

  getCardName(cardId) {
    const card = this.cards[cardId];
    return card ? card.name : `Card ${cardId}`;
  }

  getCardManaCost(cardId) {
    const card = this.cards[cardId];
    return card && card.manaCost ? card.manaCost : '';
  }

  getCardScryfallUri(cardId) {
    const card = this.cards[cardId];
    return card && card.scryfallUri ? card.scryfallUri : '';
  }

  getCardInfo(cardId) {
    return this.cards[cardId] || { name: `Card ${cardId}`, manaCost: '?', type: 'Unknown' };
  }

  getCardColors(cardId) {
    const card = this.cards[cardId];
    if (!card) {
      return [];
    }
    if (Array.isArray(card.colors)) {
      return card.colors;
    }
    return colorsFromManaCost(card.manaCost);
  }

  getDeckColors(...cardLists) {
    const found = new Set();
    for (const cardList of cardLists) {
      if (!Array.isArray(cardList)) {
        continue;
      }
      for (const cardId of cardList) {
        for (const color of this.getCardColors(cardId)) {
          found.add(color);
        }
      }
    }
    return COLOR_ORDER.filter(color => found.has(color));
  }

  resolveDeckColors(matchData) {
    const fromParser = matchData.deckInfo?.colors || matchData.deckColors;
    if (Array.isArray(fromParser) && fromParser.length > 0) {
      return fromParser;
    }

    const playerDeck = matchData.playerDeck;
    const derived = this.getDeckColors(
      playerDeck?.deckCards,
      playerDeck?.sideboardCards,
      playerDeck?.commandZoneCards
    );
    if (derived.length > 0) {
      return derived;
    }

    const deckId = matchData.deckId || matchData.deckInfo?.deckId;
    const knownDeck = deckId ? this.data.decks[deckId] : null;
    return knownDeck?.colors && Array.isArray(knownDeck.colors) ? knownDeck.colors : [];
  }

  resolveOpponentDeck(parsed) {
    if (!parsed || !Array.isArray(parsed.cards) || parsed.cards.length === 0) {
      return null;
    }

    const fromCards = this.getDeckColors(parsed.cards);
    const fromGame = Array.isArray(parsed.colors) ? parsed.colors : [];
    const colors = COLOR_ORDER.filter(color =>
      fromCards.includes(color) || fromGame.includes(color)
    );

    return {
      name: nameFromColors(colors),
      colors: colors,
      cards: parsed.cards
    };
  }

  backfillColors() {
    let changed = 0;

    for (const deck of Object.values(this.data.decks || {})) {
      if (Array.isArray(deck.colors) && deck.colors.length > 0) {
        continue;
      }
      const colors = this.getDeckColors(deck.mainDeck, deck.sideboard, deck.commandZone);
      if (colors.length > 0) {
        deck.colors = colors;
        changed++;
      }
    }

    for (const match of this.data.matches || []) {
      if (Array.isArray(match.deckColors) && match.deckColors.length > 0) {
        continue;
      }
      const deck = match.deckId ? this.data.decks[match.deckId] : null;
      if (deck?.colors?.length > 0) {
        match.deckColors = deck.colors;
        changed++;
      }
    }

    if (changed > 0) {
      console.log(`[DataStore] Filled in colors for ${changed} saved record(s)`);
      this.saveData();
    }
  }

  loadData() {
    try {
      if (fs.existsSync(this.dataFile)) {
        const content = fs.readFileSync(this.dataFile, 'utf8');
        return JSON.parse(content);
      }
    } catch (error) {
      console.error('Error loading data:', error);
    }

    return {
      matches: [],
      decks: {},
      inventory: {
        gems: 0,
        gold: 0,
        totalVaultProgress: 0,
        wildCardCommons: 0,
        wildCardUnCommons: 0,
        wildCardRares: 0,
        wildCardMythics: 0,
        boosters: [],
        lastUpdated: null
      }
    };
  }

  saveData() {
    try {
      fs.writeFileSync(this.dataFile, JSON.stringify(this.data, null, 2));
    } catch (error) {
      console.error('Error saving data:', error);
    }
  }

  updateInventory(inventoryData) {
    this.data.inventory = {
      ...this.data.inventory,
      ...inventoryData,
      lastUpdated: new Date().toISOString()
    };
    this.saveData();
    console.log('[DataStore] Inventory updated:', inventoryData);
  }

  getInventory() {
    return this.data.inventory;
  }

  addDeck(deckData) {
    const deckId = deckData.id || deckData.deckId ||
      this.deckIdFromName(deckData.name || deckData.deckName);

    const existingDeck = this.data.decks[deckId];

    if (existingDeck) {
      this.data.decks[deckId] = {
        ...existingDeck,
        id: deckId,
        name: deckData.name || deckData.deckName || existingDeck.name,
        format: deckData.format || existingDeck.format,

        mainDeck: (deckData.mainDeck && deckData.mainDeck.length > 0)
          ? deckData.mainDeck
          : existingDeck.mainDeck,
        sideboard: (deckData.sideboard && deckData.sideboard.length > 0)
          ? deckData.sideboard
          : existingDeck.sideboard,
        commandZone: (deckData.commandZone && deckData.commandZone.length > 0)
          ? deckData.commandZone
          : existingDeck.commandZone,
        lastUsed: deckData.timestamp || new Date().toISOString()
      };
      const updatedDeck = this.data.decks[deckId];
      updatedDeck.colors = (deckData.colors && deckData.colors.length > 0)
        ? deckData.colors
        : this.getDeckColors(updatedDeck.mainDeck, updatedDeck.sideboard, updatedDeck.commandZone);
      console.log(`[DataStore] Updated existing deck: ${deckId}`);
    } else {
      this.data.decks[deckId] = {
        id: deckId,
        name: deckData.name || deckData.deckName || 'Unknown Deck',
        format: deckData.format || 'Unknown',
        mainDeck: deckData.mainDeck || [],
        sideboard: deckData.sideboard || [],
        commandZone: deckData.commandZone || [],
        colors: (deckData.colors && deckData.colors.length > 0)
          ? deckData.colors
          : this.getDeckColors(deckData.mainDeck, deckData.sideboard, deckData.commandZone),
        lastUsed: deckData.timestamp || new Date().toISOString()
      };
      console.log(`[DataStore] Created new deck: ${deckId} - ${this.data.decks[deckId].name}`);
    }

    this.saveData();
    return this.data.decks[deckId];
  }

  getDeck(deckId) {
    return this.data.decks[deckId];
  }

  deckIdFromName(deckName) {
    return 'deck_' + (deckName || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '_');
  }

  renameDeck(oldName, newName) {
    const oldId = this.deckIdFromName(oldName);
    const newId = this.deckIdFromName(newName);
    if (oldId === newId) {
      return;
    }

    const oldDeck = this.data.decks[oldId];
    if (oldDeck) {
      const newDeck = this.data.decks[newId];
      if (newDeck) {
        if (!newDeck.mainDeck?.length && oldDeck.mainDeck?.length) {
          newDeck.mainDeck = oldDeck.mainDeck;
          newDeck.sideboard = oldDeck.sideboard;
          newDeck.commandZone = oldDeck.commandZone;
        }
        if (!newDeck.colors?.length && oldDeck.colors?.length) {
          newDeck.colors = oldDeck.colors;
        }
      } else {
        this.data.decks[newId] = { ...oldDeck, id: newId, name: newName };
      }
      delete this.data.decks[oldId];
    }

    let renamed = 0;
    for (const match of this.data.matches) {
      if (match.deckId === oldId || match.deckName === oldName) {
        match.deckId = newId;
        match.deckName = newName;
        renamed++;
      }
    }
    const archiveRenamed = matchArchive.renameRetiredDeck(this.data.archive, oldId, newId, newName);

    if (oldDeck || renamed > 0 || archiveRenamed) {
      console.log(`[DataStore] Renamed deck "${oldName}" to "${newName}" (${renamed} match(es) updated)`);
      this.saveData();
    }
  }

  addMatch(matchData) {
    if (matchArchive.isRetired(this.data, matchData.matchId)) {
      return null;
    }

    if (matchData.deckNameKey && matchData.deckName) {
      this.renameDeck(matchData.deckNameKey, matchData.deckName);
    }

    const matchId = matchData.matchId || 'unknown';
    const matchDate = new Date(matchData.timestamp || Date.now()).toDateString();
    const existingMatchIndex = this.data.matches.findIndex(m => {
      if (m.matchId !== matchId) {
        return false;
      }
      if (ARENA_MATCH_ID.test(matchId)) {
        return true;
      }
      if (new Date(m.timestamp).toDateString() !== matchDate) {
        return false;
      }

      return matchId !== 'unknown' || m.result === matchData.result;
    });

    const deckColors = this.resolveDeckColors(matchData);
    const opponentDeck = this.resolveOpponentDeck(matchData.opponentDeck);

    if (existingMatchIndex >= 0) {
      const existingMatch = this.data.matches[existingMatchIndex];
      const deckName = matchData.deckName || existingMatch.deckName;

      const deckId = deckName !== existingMatch.deckName
        ? this.deckIdFromName(deckName)
        : (matchData.deckId || existingMatch.deckId);
      const updatedMatch = {
        ...existingMatch,
        result: matchData.result || existingMatch.result,
        format: matchData.format || existingMatch.format,
        opponentName: matchData.opponentName || existingMatch.opponentName,
        deckName: deckName,
        deckId: deckId,
        gamesPlayed: matchData.gamesPlayed || existingMatch.gamesPlayed,
        deckColors: deckColors.length > 0 ? deckColors : (existingMatch.deckColors || []),
        opponentDeck: opponentDeck || existingMatch.opponentDeck || null,
        timestamp: matchData.timestamp || existingMatch.timestamp
      };
      this.data.matches[existingMatchIndex] = updatedMatch;

      if (matchData.playerDeck?.deckCards?.length) {
        this.addDeck({
          id: deckId,
          name: deckName,
          format: updatedMatch.format,
          mainDeck: matchData.playerDeck.deckCards,
          sideboard: matchData.playerDeck.sideboardCards,
          commandZone: matchData.playerDeck.commandZoneCards,
          colors: deckColors,
          timestamp: updatedMatch.timestamp
        });
      }

      this.saveData();
      console.log(`[DataStore] Updated existing match: ${matchData.matchId} (${deckName})`);
      return updatedMatch;
    }

    const match = {
      id: this.generateId(),
      matchId: matchData.matchId || 'unknown',
      result: matchData.result || 'unknown',
      format: matchData.format || 'Unknown',
      gamesPlayed: matchData.gamesPlayed || 1,
      deckId: matchData.deckId || matchData.deckInfo?.deckId || null,
      deckName: matchData.deckName || matchData.deckInfo?.deckName || 'Unknown Deck',
      deckColors: deckColors,
      opponentDeck: opponentDeck,
      opponentName: matchData.opponentName || null,
      opponentRank: matchData.opponentRank || null,
      timestamp: matchData.timestamp || new Date().toISOString(),
      raw: matchData.raw || null
    };

    this.data.matches.push(match);
    console.log(`[DataStore] Added match: ${match.matchId} - ${match.result} (${match.format})`);

    const deckName = match.deckName;
    if (deckName && deckName !== 'Unknown Deck') {
      const deckId = this.deckIdFromName(deckName);
      match.deckId = deckId;

      if (!this.data.decks[deckId]) {
        this.data.decks[deckId] = {
          id: deckId,
          name: deckName,
          format: match.format || 'Unknown',
          mainDeck: matchData.playerDeck?.deckCards || [],
          sideboard: matchData.playerDeck?.sideboardCards || [],
          commandZone: matchData.playerDeck?.commandZoneCards || [],
          colors: deckColors,
          lastUsed: match.timestamp
        };
        console.log(`[DataStore] Created new deck: ${deckId} - ${deckName}`);
      } else {
        this.data.decks[deckId].lastUsed = match.timestamp;
        if (matchData.playerDeck?.deckCards) {
          this.data.decks[deckId].mainDeck = matchData.playerDeck.deckCards;
        }
        if (deckColors.length > 0) {
          this.data.decks[deckId].colors = deckColors;
        }
        console.log(`[DataStore] Updated deck: ${deckId}`);
      }
    }

    this.retireOldMatches();
    this.saveData();
    return match;
  }

  deleteMatch(matchId) {
    this.data.matches = this.data.matches.filter(m => m.id !== matchId);
    this.saveData();
  }

  getMatch(id) {
    return this.data.matches.find(m => m.id === id);
  }

  getMatches() {
    return this.data.matches.sort((a, b) =>
      new Date(b.timestamp) - new Date(a.timestamp)
    );
  }

  getDecks() {
    return Object.values(this.data.decks).sort((a, b) =>
      new Date(b.lastUsed || 0) - new Date(a.lastUsed || 0)
    );
  }

  getStats() {
    const matches = this.data.matches;
    const retired = matchArchive.retiredStats(this.data.archive, this.data.decks);
    const total = retired.total + matches.length;
    const wins = retired.wins + matches.filter(m => m.result === 'win').length;
    const losses = retired.losses + matches.filter(m => m.result === 'loss').length;
    const draws = retired.draws + matches.filter(m => m.result === 'draw').length;

    const formatStats = retired.formats;
    matches.forEach(match => {
      const format = match.format || 'Unknown';
      if (!formatStats[format]) {
        formatStats[format] = { total: 0, wins: 0, losses: 0, draws: 0 };
      }
      formatStats[format].total++;
      if (match.result === 'win') formatStats[format].wins++;
      else if (match.result === 'loss') formatStats[format].losses++;
      else if (match.result === 'draw') formatStats[format].draws++;
    });

    Object.values(formatStats).forEach(stat => {
      stat.winRate = winRateFrom(stat.wins, stat.losses);
    });

    const deckStats = retired.decks;
    matches.forEach(match => {
      const deckName = match.deckName || 'Unknown Deck';

      const deckId = match.deckId || this.deckIdFromName(deckName);

      if (!deckStats[deckId]) {
        deckStats[deckId] = {
          id: deckId,
          name: deckName,
          colors: this.data.decks[deckId]?.colors || match.deckColors || [],
          total: 0,
          wins: 0,
          losses: 0,
          draws: 0
        };
      }
      deckStats[deckId].total++;
      if (match.result === 'win') deckStats[deckId].wins++;
      else if (match.result === 'loss') deckStats[deckId].losses++;
      else if (match.result === 'draw') deckStats[deckId].draws++;
    });

    Object.values(deckStats).forEach(stat => {
      stat.winRate = winRateFrom(stat.wins, stat.losses);
    });

    return {
      total,
      wins,
      losses,
      draws,
      winRate: winRateFrom(wins, losses),
      formats: formatStats,
      decks: deckStats
    };
  }

  clearAll() {
    this.data = {
      matches: [],
      decks: {}
    };
    this.saveData();
  }

  exportToFile(filePath) {
    const exportData = {
      ...this.data,
      exportDate: new Date().toISOString(),
      version: '1.0'
    };
    fs.writeFileSync(filePath, JSON.stringify(exportData, null, 2));
  }

  importFromFile(filePath) {
    const content = fs.readFileSync(filePath, 'utf8');
    const importData = JSON.parse(content);

    matchArchive.adoptArchive(this.data, importData.archive);

    if (importData.matches && Array.isArray(importData.matches)) {
      const existingIds = new Set(this.data.matches.map(m => m.id));
      const newMatches = importData.matches.filter(m =>
        !existingIds.has(m.id) && !matchArchive.isRetired(this.data, m.matchId));
      this.data.matches.push(...newMatches);
    }

    if (importData.decks) {
      this.data.decks = { ...this.data.decks, ...importData.decks };
    }

    this.retireOldMatches();
    this.saveData();
  }

  generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
  }
}

module.exports = DataStore;
