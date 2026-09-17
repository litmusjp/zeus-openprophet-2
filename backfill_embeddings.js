#!/usr/bin/env node
// backfill_embeddings.js - Embed all existing decision logs

import { storeTrade, getEmbeddingCount, clearAllEmbeddings } from './vectorDB.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DECISIONS_DIR = path.join(__dirname, 'decisive_actions');

/**
 * Parse decision filename to extract metadata
 * Format: YYYY-MM-DDTHH-MM-SS-MMMZ_ACTION.json
 */
function parseFilename(filename) {
  const match = filename.match(/^(\d{4}-\d{2}-\d{2})T[\d-]+Z_(.+)\.json$/);
  if (!match) return null;

  return {
    date: match[1], // YYYY-MM-DD
    action: match[2].replace(/_/g, ' '), // e.g., "BUY_SPY" -> "BUY SPY"
  };
}

/**
 * Extract trade info from decision JSON
 */
function extractTradeInfo(decision, filename) {
  const parsed = parseFilename(filename);
  if (!parsed) return null;

  // Determine symbol from action or market_data
  let symbol = 'UNKNOWN';
  if (decision.symbol) {
    symbol = decision.symbol;
  } else if (decision.market_data?.symbols) {
    symbol = Array.isArray(decision.market_data.symbols)
      ? decision.market_data.symbols[0]
      : decision.market_data.symbols;
  } else if (decision.market_data?.symbol) {
    symbol = decision.market_data.symbol;
  } else if (parsed.action.includes('SPY')) {
    symbol = 'SPY';
  } else if (parsed.action.includes('QQQ')) {
    symbol = 'QQQ';
  } else if (parsed.action.includes('NVDA')) {
    symbol = 'NVDA';
  }

  // Determine strategy (SCALP vs SWING)
  let strategy = 'UNKNOWN';
  const reasoningLower = decision.reasoning?.toLowerCase() || '';
  if (reasoningLower.includes('scalp') || reasoningLower.includes('2 dte') || reasoningLower.includes('intraday')) {
    strategy = 'SCALP';
  } else if (reasoningLower.includes('swing') || reasoningLower.includes('51 dte') || reasoningLower.includes('114 dte')) {
    strategy = 'SWING';
  } else if (reasoningLower.includes('hold')) {
    strategy = 'HOLD';
  }

  // Extract result if available
  let result_pct = null;
  let result_dollars = null;
  if (decision.market_data?.gain_pct) {
    result_pct = decision.market_data.gain_pct;
  }
  if (decision.market_data?.gain_dollars) {
    result_dollars = decision.market_data.gain_dollars;
  }

  // Extract market context
  let market_context = '';
  if (decision.market_data) {
    const md = decision.market_data;
    const contextParts = [];
    if (md.market_status) contextParts.push(`Market: ${md.market_status}`);
    if (md.portfolio_value) contextParts.push(`Portfolio: $${md.portfolio_value}`);
    if (md.positions) contextParts.push(`Positions: ${md.positions}`);
    if (md.time) contextParts.push(`Time: ${md.time}`);
    market_context = contextParts.join(', ');
  }

  return {
    id: filename.replace('.json', ''),
    decision_file: filename,
    symbol,
    action: decision.action || parsed.action,
    strategy,
    result_pct,
    result_dollars,
    date: parsed.date,
    reasoning: decision.reasoning || '',
    market_context,
  };
}

/**
 * Backfill all decision logs
 */
async function backfillAll(options = {}) {
  try {
    console.log('🚀 Starting embedding backfill...\n');

    // Option to clear existing embeddings
    if (options.clear) {
      console.log('🗑️  Clearing existing embeddings...');
      clearAllEmbeddings();
    }

    // Read all decision files
    const files = await fs.readdir(DECISIONS_DIR);
    const jsonFiles = files.filter(f => f.endsWith('.json'));

    console.log(`📂 Found ${jsonFiles.length} decision files\n`);

    let processed = 0;
    let skipped = 0;
    let errors = 0;

    for (const filename of jsonFiles) {
      try {
        const filePath = path.join(DECISIONS_DIR, filename);
        const content = await fs.readFile(filePath, 'utf-8');
        const decision = JSON.parse(content);

        // Extract trade info
        const tradeInfo = extractTradeInfo(decision, filename);
        if (!tradeInfo) {
          console.log(`⏭️  Skipped: ${filename} (invalid format)`);
          skipped++;
          continue;
        }

        // Skip if no reasoning (nothing to embed)
        if (!tradeInfo.reasoning || tradeInfo.reasoning.length < 10) {
          console.log(`⏭️  Skipped: ${filename} (no reasoning)`);
          skipped++;
          continue;
        }

        // Store with embedding
        await storeTrade(tradeInfo);
        processed++;

        // Brief pause between embeddings to avoid CPU spike
        await new Promise(resolve => setTimeout(resolve, 100));

      } catch (error) {
        console.error(`❌ Error processing ${filename}:`, error.message);
        errors++;
      }
    }

    console.log('\n✅ Backfill complete!');
    console.log(`   Processed: ${processed}`);
    console.log(`   Skipped: ${skipped}`);
    console.log(`   Errors: ${errors}`);
    console.log(`   Total embeddings: ${getEmbeddingCount()}`);

  } catch (error) {
    console.error('❌ Backfill failed:', error.message);
    throw error;
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const options = {
    clear: args.includes('--clear'), // Add --clear flag to wipe and re-index
  };

  backfillAll(options)
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Fatal error:', error);
      process.exit(1);
    });
}

export { backfillAll };
