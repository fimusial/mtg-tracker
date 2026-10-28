// The match history keeps only the latest matches. Older ones are retired: they
// leave the history (and their courses are deleted) but stay counted - overall,
// per format and per deck - so totals and win rates cover every match ever played.
// The counts live in matches.json as `archive`.

// How many of the latest matches the history keeps.
const MATCH_HISTORY_LIMIT = 100;

// How many ids of retired matches are remembered, so that a log still holding a
// retired match cannot bring it back and have it counted twice.
const RETIRED_IDS_KEPT = 500;

const ARENA_MATCH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COUNT_KEYS = ['total', 'wins', 'losses', 'draws'];

function emptyCounts() {
  return { total: 0, wins: 0, losses: 0, draws: 0 };
}

function emptyArchive() {
  return { ...emptyCounts(), formats: {}, decks: {}, matchIds: [] };
}

function countResult(counts, result) {
  counts.total++;
  if (result === 'win') counts.wins++;
  else if (result === 'loss') counts.losses++;
  else if (result === 'draw') counts.draws++;
}

function addCounts(target, source) {
  for (const key of COUNT_KEYS) {
    target[key] = (target[key] || 0) + (source[key] || 0);
  }
}

const matchTime = match => new Date(match.timestamp).getTime() || 0;

function retireOldMatches(data, deckIdOf, limit = MATCH_HISTORY_LIMIT) {
  if (!Array.isArray(data.matches) || data.matches.length <= limit) {
    return [];
  }

  const newestFirst = data.matches.slice().sort((a, b) => matchTime(b) - matchTime(a));
  const retired = newestFirst.slice(limit).reverse();
  data.matches = newestFirst.slice(0, limit);

  const archive = data.archive || (data.archive = emptyArchive());
  for (const match of retired) {
    countResult(archive, match.result);

    const format = match.format || 'Unknown';
    archive.formats[format] = archive.formats[format] || emptyCounts();
    countResult(archive.formats[format], match.result);

    const deckId = deckIdOf(match);
    const deck = archive.decks[deckId] || (archive.decks[deckId] = { id: deckId, ...emptyCounts() });
    deck.name = match.deckName || deck.name || 'Unknown Deck';
    if (Array.isArray(match.deckColors) && match.deckColors.length > 0) {
      deck.colors = match.deckColors;
    }
    countResult(deck, match.result);

    if (ARENA_MATCH_ID.test(match.matchId || '')) {
      archive.matchIds.push(match.matchId);
    }
  }
  archive.matchIds = archive.matchIds.slice(-RETIRED_IDS_KEPT);

  return retired;
}

function isRetired(data, matchId) {
  return ARENA_MATCH_ID.test(matchId || '') && Boolean(data.archive?.matchIds?.includes(matchId));
}

function retiredStats(archive, decks) {
  const source = archive || emptyArchive();

  const formats = {};
  for (const [format, counts] of Object.entries(source.formats || {})) {
    formats[format] = { ...emptyCounts() };
    addCounts(formats[format], counts);
  }

  const deckStats = {};
  for (const [deckId, deck] of Object.entries(source.decks || {})) {
    deckStats[deckId] = {
      id: deckId,
      name: decks?.[deckId]?.name || deck.name || 'Unknown Deck',
      colors: decks?.[deckId]?.colors || deck.colors || [],
      ...emptyCounts()
    };
    addCounts(deckStats[deckId], deck);
  }

  const totals = emptyCounts();
  addCounts(totals, source);
  return { ...totals, formats, decks: deckStats };
}

function renameRetiredDeck(archive, oldId, newId, newName) {
  const old = archive?.decks?.[oldId];
  if (!old || oldId === newId) {
    return false;
  }
  const target = archive.decks[newId] || (archive.decks[newId] = { id: newId, ...emptyCounts(), colors: old.colors });
  addCounts(target, old);
  target.name = newName;
  delete archive.decks[oldId];
  return true;
}

function adoptArchive(data, imported) {
  if (!imported || !(imported.total > 0) || data.archive?.total > 0) {
    return false;
  }
  const archive = emptyArchive();
  addCounts(archive, imported);
  for (const [format, counts] of Object.entries(imported.formats || {})) {
    archive.formats[format] = emptyCounts();
    addCounts(archive.formats[format], counts);
  }
  for (const [deckId, deck] of Object.entries(imported.decks || {})) {
    archive.decks[deckId] = { id: deckId, name: deck.name, colors: deck.colors, ...emptyCounts() };
    addCounts(archive.decks[deckId], deck);
  }
  archive.matchIds = (imported.matchIds || []).filter(matchId => ARENA_MATCH_ID.test(matchId)).slice(-RETIRED_IDS_KEPT);
  data.archive = archive;
  return true;
}

module.exports = {
  MATCH_HISTORY_LIMIT,
  retireOldMatches,
  isRetired,
  retiredStats,
  renameRetiredDeck,
  adoptArchive
};
