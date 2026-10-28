const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');

const BULK_DATA_URL = 'https://api.scryfall.com/bulk-data';
const COLOR_ORDER = ['W', 'U', 'B', 'R', 'G', 'C'];
const UPDATE_INTERVAL_HOURS = 24;
const REQUEST_TIMEOUT_MS = 60000;
const MAX_REDIRECTS = 5;

function removeQueryStringFromUri(uri) {
  const query = uri.indexOf('?');
  return query === -1 ? uri : uri.slice(0, query);
}

function extractScryfallUri(card) {
  const uri = typeof card.scryfall_uri === 'string' ? card.scryfall_uri : '';
  if (!uri) {
    return '';
  }

  return removeQueryStringFromUri(uri);
}

function extractColors(card, isLand) {
  if (isLand && Array.isArray(card.produced_mana))
  {
    return COLOR_ORDER.filter(color => card.produced_mana.includes(color));
  }

  const colors = Array.isArray(card.colors)
    ? card.colors
    : (card.card_faces || []).reduce((all, face) => all.concat(face.colors || []), []);

  return COLOR_ORDER.filter(color => colors.includes(color));
}

class CardUpdater {
  constructor(cardsFile) {
    this.cardsFile = cardsFile;
    this.cardsData = { cards: {}, lastUpdated: null };
  }

  needsUpdate() {
    try {
      if (!fs.existsSync(this.cardsFile)) {
        console.log('[CardUpdater] cards.json does not exist, update needed');
        return true;
      }

      const content = fs.readFileSync(this.cardsFile, 'utf8');
      const data = JSON.parse(content);

      if (!data.lastUpdated) {
        console.log('[CardUpdater] No lastUpdated timestamp, update needed');
        return true;
      }

      const lastUpdate = new Date(data.lastUpdated);
      const now = new Date();
      const hoursSinceUpdate = (now - lastUpdate) / (1000 * 60 * 60);

      if (hoursSinceUpdate >= UPDATE_INTERVAL_HOURS) {
        console.log(`[CardUpdater] Last update was ${hoursSinceUpdate.toFixed(1)} hours ago, update needed`);
        return true;
      }

      console.log(`[CardUpdater] Last update was ${hoursSinceUpdate.toFixed(1)} hours ago, skipping update`);
      return false;
    } catch (error) {
      console.error('[CardUpdater] Error checking update status:', error.message);
      return true;
    }
  }

  request(url, redirectsLeft = MAX_REDIRECTS) {
    return new Promise((resolve, reject) => {
      const options = {
        headers: {
          'User-Agent': 'MTG-Arena-Tracker/1.0',
          'Accept': 'application/json'
        }
      };

      const req = https.get(url, options, (res) => {
        const { statusCode, headers } = res;

        if (statusCode >= 300 && statusCode < 400 && headers.location) {
          res.resume();

          if (redirectsLeft === 0) {
            reject(new Error(`Too many redirects for ${url}`));
            return;
          }

          const target = new URL(headers.location, url).toString();
          this.request(target, redirectsLeft - 1).then(resolve, reject);
          return;
        }

        if (statusCode !== 200) {
          res.resume();
          reject(new Error(`Request for ${url} failed with status ${statusCode}`));
          return;
        }

        resolve(res);
      });

      req.on('error', reject);

      req.setTimeout(REQUEST_TIMEOUT_MS, () => {
        req.destroy(new Error(`No data for ${REQUEST_TIMEOUT_MS / 1000}s, aborting request for ${url}`));
      });
    });
  }

  async fetchJSON(url) {
    const res = await this.request(url);

    return new Promise((resolve, reject) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse JSON: ${e.message}`));
        }
      });
      res.on('error', reject);
    });
  }

  async downloadCards() {
    console.log('[CardUpdater] Starting card database update...');

    try {
      console.log('[CardUpdater] Fetching bulk data info from Scryfall...');
      const bulkInfo = await this.fetchJSON(BULK_DATA_URL);

      const defaultCards = bulkInfo.data.find(d => d.type === 'default_cards');
      if (!defaultCards) {
        throw new Error('Could not find default_cards bulk data');
      }

      console.log(`[CardUpdater] Found default cards dataset: ${(defaultCards.compressed_size / 1024 / 1024).toFixed(1)} MB compressed`);
      console.log(`[CardUpdater] Last updated: ${defaultCards.updated_at}`);
      console.log(`[CardUpdater] Download URL: ${defaultCards.jsonl_download_uri}`);

      console.log('[CardUpdater] Downloading card data (this may take 30-60 seconds)...');
      console.log('[CardUpdater] Processing cards with Arena IDs only...');

      const cards = await this.downloadAndProcessCards(defaultCards.jsonl_download_uri);

      this.cardsData = {
        cards: cards,
        lastUpdated: new Date().toISOString(),
        source: 'scryfall',
        sourceUpdatedAt: defaultCards.updated_at
      };

      fs.mkdirSync(path.dirname(this.cardsFile), { recursive: true });
      const tempFile = this.cardsFile + '.tmp';
      fs.writeFileSync(tempFile, JSON.stringify(this.cardsData, null, 2));
      fs.renameSync(tempFile, this.cardsFile);

      const cardCount = Object.keys(cards).length;
      console.log(`[CardUpdater] Successfully saved ${cardCount} cards with Arena IDs to cards.json`);

      if (cardCount === 0) {
        console.warn('[CardUpdater] Warning: No cards with Arena IDs found!');
        return false;
      }

      return true;
    } catch (error) {
      console.error('[CardUpdater] Error updating cards:', error.message);

      if (fs.existsSync(this.cardsFile)) {
        console.log('[CardUpdater] Keeping existing cards.json');
        return false;
      }

      throw error;
    }
  }

  async downloadAndProcessCards(url) {
    const res = await this.request(url);

    return new Promise((resolve, reject) => {
      const cards = {};
      let processed = 0;
      let withArenaId = 0;

      res.on('error', (err) => {
        reject(new Error(`Stream error: ${err.message}`));
      });

      const contentEncoding = (res.headers['content-encoding'] || '').toLowerCase();
      const contentType = (res.headers['content-type'] || '').toLowerCase();
      const isGzip = contentEncoding.includes('gzip') ||
        contentType.includes('gzip') ||
        new URL(url).pathname.endsWith('.gz');

      let dataStream = res;

      if (isGzip) {
        console.log('[CardUpdater] Content is gzip compressed, decompressing...');
        const gunzip = zlib.createGunzip();
        gunzip.on('error', (err) => {
          reject(new Error(`Stream error: ${err.message}`));
        });
        res.pipe(gunzip);
        dataStream = gunzip;
      } else {
        console.log('[CardUpdater] Content is not compressed');
      }

      const lines = readline.createInterface({
        input: dataStream,
        crlfDelay: Infinity
      });

      lines.on('line', (line) => {
        const trimmed = line.trim();

        if (!trimmed) {
          return;
        }

        try {
          const card = JSON.parse(trimmed);
          processed++;

          if (card.arena_id) {
            withArenaId++;
            const cardType = card.type_line ? card.type_line.split('—')[0].trim() : 'Unknown';
            const isLand = /\bLand\b/.test(cardType);
            cards[card.arena_id] = {
              name: card.name,
              manaCost: card.mana_cost || '',
              type: cardType,
              colors: extractColors(card, isLand),
              scryfallUri: extractScryfallUri(card)
            };
          }

          if (processed % 1000 === 0) {
            console.log(`[CardUpdater] Processed ${processed} cards, found ${withArenaId} with Arena IDs...`);
          }
        } catch (e) {
        }
      });

      lines.on('close', () => {
        console.log(`[CardUpdater] Finished processing ${processed} cards, found ${withArenaId} with Arena IDs`);
        resolve(cards);
      });

      lines.on('error', (err) => {
        reject(new Error(`Stream error: ${err.message}`));
      });
    });
  }

  async update(options = {}) {
    if (options.force || this.needsUpdate()) {
      return await this.downloadCards();
    }
    return false;
  }

  loadCards() {
    try {
      if (fs.existsSync(this.cardsFile)) {
        const content = fs.readFileSync(this.cardsFile, 'utf8');
        const data = JSON.parse(content);
        this.cardsData = data;
        console.log(`[CardUpdater] Loaded ${Object.keys(data.cards || {}).length} cards from disk`);
        return data.cards || {};
      }
    } catch (error) {
      console.error('[CardUpdater] Error loading cards:', error.message);
    }
    return {};
  }
}

module.exports = CardUpdater;
