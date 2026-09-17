#!/usr/bin/env node

/**
 * Loads seed trading knowledge into the vector database
 * Run this to populate the DB with foundational trading principles
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MCP_SERVER_URL = process.env.MCP_SERVER_URL || 'http://localhost:4534';

// Helper to call MCP through the trading bot
async function storeTrade(tradeData) {
  try {
    // The MCP tool store_trade_setup is implemented in vectorDB.js
    // We'll directly import and call it
    const { storeTrade } = await import('../vectorDB.js');

    // Generate ID from data
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const id = `seed_${dateStr}-${tradeData.symbol}-${tradeData.action}-${now.getTime()}`;

    const trade = {
      id,
      decision_file: `seed_${id}.json`,
      symbol: tradeData.symbol,
      action: tradeData.action,
      strategy: tradeData.strategy,
      result_pct: tradeData.result_pct || null,
      result_dollars: tradeData.result_dollars || null,
      date: dateStr,
      reasoning: tradeData.reasoning,
      market_context: tradeData.market_context
    };

    await storeTrade(trade);
    return true;
  } catch (error) {
    console.error(`Error storing trade for ${tradeData.symbol}:`, error.message);
    return false;
  }
}

async function loadSeedData() {
  console.log('Loading seed data into vector database...\n');

  // Load trading principles
  const principlesPath = path.join(__dirname, 'trading_principles.json');
  const principles = JSON.parse(fs.readFileSync(principlesPath, 'utf-8'));

  console.log(`Loading ${principles.length} trading principles...`);
  let principlesLoaded = 0;
  for (const principle of principles) {
    const success = await storeTrade(principle);
    if (success) {
      principlesLoaded++;
      process.stdout.write(`\rPrinciples loaded: ${principlesLoaded}/${principles.length}`);
    }
  }
  console.log('\n');

  // Load knowledge base (if it exists and you want to use it)
  const knowledgeBasePath = path.join(__dirname, 'trade_knowledge_base.json');
  if (fs.existsSync(knowledgeBasePath)) {
    const knowledgeBase = JSON.parse(fs.readFileSync(knowledgeBasePath, 'utf-8'));
    console.log(`\nLoading ${knowledgeBase.length} trade examples...`);
    let examplesLoaded = 0;
    for (const example of knowledgeBase) {
      const success = await storeTrade(example);
      if (success) {
        examplesLoaded++;
        process.stdout.write(`\rExamples loaded: ${examplesLoaded}/${knowledgeBase.length}`);
      }
    }
    console.log('\n');
  }

  console.log('\n✅ Seed data loaded successfully!');
  console.log('\nYou can now query the vector DB with:');
  console.log('  mcp__prophet__find_similar_setups(query="market is flat")');
  console.log('  mcp__prophet__find_similar_setups(query="what delta for swing trade")');
  console.log('  mcp__prophet__find_similar_setups(query="low VIX environment")');
}

loadSeedData().catch(console.error);
