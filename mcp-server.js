#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import { checkPermissions } from './permissions.js';
import { enforcePermissions as verifyPermissions } from './mcp-permission-guard.js';
import { assertManagerToolAllowed, assertAgentToolAllowed, isAgentToolAllowed, filterManagerTools } from './manager-safety-policy.js';
import { authorizeAndUpdateHeartbeatPhase } from './mcp-heartbeat-guard.js';
import { readNewsSummaryFile } from './news_summary.js';
import { safeDecisionFilenameComponent } from './mcp-decision-filename.js';
import { futureHistoricalBarsError } from './historical-bars-time.js';
import { normalizeOptionLimitPrice } from './option-price.js';
import { sessionFields, openingGateDecision, parseMinOpeningMinutes } from './session-clock.js';
import { ordersFrom, isOptionExitOrder, buildPostCancelCheck, unverifiedPostCancelCheck } from './cancel-check.js';

// Configuration
const EXECUTION_MODE = process.env.OPENPROPHET_EXECUTION_MODE || 'paper';
const EXECUTION_START_ENABLED = EXECUTION_MODE === 'paper' || EXECUTION_MODE === 'enabled';
const TRADING_BOT_URL = EXECUTION_START_ENABLED ? (process.env.TRADING_BOT_URL || 'http://127.0.0.1:4534') : '';
const TRADING_BOT_TOKEN = EXECUTION_START_ENABLED ? (process.env.TRADING_BOT_TOKEN || '') : '';
const TRADING_BOT_OPERATOR_TOKEN = EXECUTION_START_ENABLED ? (process.env.TRADING_BOT_OPERATOR_TOKEN || '') : '';
const OPENPROPHET_ACCOUNT_ID = EXECUTION_START_ENABLED ? (process.env.OPENPROPHET_ACCOUNT_ID || 'default') : 'inert';
const OPENPROPHET_ROLE = EXECUTION_START_ENABLED ? (process.env.OPENPROPHET_ROLE || 'agent') : 'agent';
const HEARTBEAT_INTERVALS_FORCED = process.env.OPENPROPHET_HEARTBEAT_INTERVALS_FORCED === 'true';
const SESSION_CONTEXT_ACCOUNT_ID = OPENPROPHET_ROLE === 'manager' ? '__manager__' : OPENPROPHET_ACCOUNT_ID;
const OPENPROPHET_SANDBOX_ID = EXECUTION_START_ENABLED ? (process.env.OPENPROPHET_SANDBOX_ID || `sbx_${OPENPROPHET_ACCOUNT_ID}`) : 'inert';
const OPENPROPHET_PROCESS_NONCE = EXECUTION_START_ENABLED ? (process.env.OPENPROPHET_PROCESS_NONCE || process.env.TRADING_BOT_PROCESS_NONCE || '') : '';
const SANDBOX_DATA_DIR = path.join(process.cwd(), 'data', 'sandboxes', OPENPROPHET_SANDBOX_ID);
const SUMMARIES_DIR = path.join(SANDBOX_DATA_DIR, 'news_summaries');
const DECISIONS_DIR = path.join(SANDBOX_DATA_DIR, 'decisive_actions');

function filterToolsForCurrentAuthority(tools) {
  const cadenceMutations = new Set(['set_heartbeat', 'apply_heartbeat_profile', 'update_heartbeat_phase']);
  return tools.filter(({ name }) => {
    if (name === 'update_permissions' && OPENPROPHET_ROLE !== 'operator') return false;
    if (!isAgentToolAllowed(OPENPROPHET_ROLE, name)) return false;
    if (HEARTBEAT_INTERVALS_FORCED && OPENPROPHET_ROLE !== 'operator' && cadenceMutations.has(name)) return false;
    return true;
  });
}

function unavailableProvider() {
  throw new Error('AI provider is unavailable in inert mode');
}

function unavailableBrokerClient() {
  return new Proxy({}, { get: () => unavailableProvider });
}

// Resolve mode before any provider credential, provider construction, or data-directory side effect.
let model = null;
let storeTrade;
let findSimilarTrades;
let getTradeStats;
let getEmbeddingCount;
if (EXECUTION_START_ENABLED) {
  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });

  ({ storeTrade, findSimilarTrades, getTradeStats, getEmbeddingCount } = await import('./vectorDB.js'));
}

// Ensure directories exist
if (EXECUTION_START_ENABLED) {
  await fs.mkdir(SUMMARIES_DIR, { recursive: true });
  await fs.mkdir(DECISIONS_DIR, { recursive: true });
}

// Inert startup is terminal: no MCP server loop or stdio transport is needed.
if (!EXECUTION_START_ENABLED) {
  console.error('OpenProphet MCP unavailable: execution mode is inert');
  process.exit(0);
}

// Helper to call trading bot API - resolves correct port per sandbox
async function getTradingBotUrl() {
  try {
    const resp = await agentAxios.get(`${AGENT_URL}/api/health`, { timeout: 3000 });
    const sandboxes = resp.data.sandboxes || [];
    const sandbox = sandboxes.find(s => s.sandboxId === OPENPROPHET_SANDBOX_ID);
    if (sandbox && sandbox.port) {
      return `http://127.0.0.1:${sandbox.port}`;
    }
  } catch {}
  return TRADING_BOT_URL;
}

let _tradingBotUrl = TRADING_BOT_URL;
let _lastPortCheck = 0;

function formatTradingBotFailure(endpoint, status, responseDetail, attempts = 0, retryable = false) {
  const detail = {
    endpoint,
    tool: endpoint.replace(/^\//, '').split('/')[0] || 'trading_bot',
    status: status || null,
    category: status ? 'upstream_http' : 'transport',
    attempts,
    retryable,
  };
  if (responseDetail && typeof responseDetail === 'object' && !Array.isArray(responseDetail)) {
    Object.assign(detail, responseDetail);
    detail.http_status = status || null;
  }

  const summary = {};
  const source = responseDetail && typeof responseDetail === 'object' && !Array.isArray(responseDetail)
    ? responseDetail : null;
  if (source) {
    const addLiteral = (key, maxLength) => {
      if (typeof source[key] === 'string' && source[key] && source[key].length <= maxLength) summary[key] = source[key];
    };
    addLiteral('assessment_decision', 32);
    addLiteral('assessment_id', 80);
    addLiteral('assessment_category', 80);
    addLiteral('assessment_stage', 80);
    addLiteral('assessment_reason', 180);
    if (Array.isArray(source.failed_check_codes)) {
      const codes = source.failed_check_codes.filter(value => typeof value === 'string' && value && value.length <= 100).slice(0, 12);
      if (codes.length) summary.failed_check_codes = codes;
    }
    if (Array.isArray(source.assessment_checks)) {
      const failed = source.assessment_checks.filter(check => check && typeof check === 'object' && check.passed === false)
        .slice(0, 12).map(check => ({
          ...(typeof check.code === 'string' && check.code && check.code.length <= 100 ? { code: check.code } : {}),
          ...(typeof check.reason === 'string' && check.reason && check.reason.length <= 120 ? { reason: check.reason } : {}),
        })).filter(check => Object.keys(check).length);
      if (failed.length) summary.failed_checks = failed;
    }
  }
  let prefix = '';
  if (Object.keys(summary).length) {
    const wireLength = () => JSON.stringify(JSON.stringify(summary)).length;
    while (wireLength() > 1000 && summary.failed_checks?.length) summary.failed_checks.pop();
    while (wireLength() > 1000 && summary.failed_check_codes?.length > 1) summary.failed_check_codes.pop();
    if (wireLength() > 1000) delete summary.assessment_reason;
    if (wireLength() > 1000) delete summary.assessment_stage;
    if (wireLength() > 1000) delete summary.assessment_category;
    if (wireLength() > 1000 && summary.failed_check_codes?.length) delete summary.failed_check_codes;
    if (wireLength() > 1000 && summary.assessment_id) delete summary.assessment_id;
    if (wireLength() > 1000 && summary.assessment_decision) delete summary.assessment_decision;
    const encoded = JSON.stringify(summary);
    prefix = `Assessment diagnostic summary: ${encoded}\n`;
  }
  if (status === 404 && /^\/options\/position\/[^/]+$/.test(endpoint)) {
    prefix += 'Single options-position lookup: no open position found; this is not confirmation of a successful closure.\n';
  }
  return { diagnostics: detail, message: `${prefix}Trading bot request failed: ${JSON.stringify(detail)}` };
}

async function callTradingBot(endpoint, method = 'GET', data = null, options = {}) {
  const safe = method === 'GET' || endpoint === '/options/assessment' || endpoint === '/options/trade-assessment';
  const budgetMs = endpoint === '/options/order' ? 15000 : endpoint === '/options/trade-assessment' ? 6000 : method === 'GET' ? 8000 : 3000;
  const maxAttempts = safe ? 3 : 1;
  const started = Date.now();
  let attempt = 0;
  let lastError;
  while (attempt < maxAttempts && Date.now() - started < budgetMs) {
    attempt += 1;
    try {
    // Refresh port every 30 seconds
    const now = Date.now();
    if (now - _lastPortCheck > 30000) {
      _tradingBotUrl = await getTradingBotUrl();
      _lastPortCheck = now;
    }
    const config = {
      method,
      url: `${_tradingBotUrl}/api/v1${endpoint}`,
      timeout: Math.max(1, budgetMs - (Date.now() - started)),
      headers: {
        'Content-Type': 'application/json',
        'X-OpenProphet-Sandbox-ID': OPENPROPHET_SANDBOX_ID,
        'X-OpenProphet-Account-ID': OPENPROPHET_ACCOUNT_ID,
        'X-OpenProphet-Process-Nonce': OPENPROPHET_PROCESS_NONCE,
      },
    };
    if (TRADING_BOT_TOKEN) {
      config.headers.Authorization = `Bearer ${TRADING_BOT_TOKEN}`;
    }
    if (method === 'DELETE' && (endpoint.startsWith('/orders/') || endpoint.startsWith('/positions/managed/'))) {
      if (!TRADING_BOT_OPERATOR_TOKEN) throw new Error('operator authorization is unavailable');
      config.headers['X-OpenProphet-Operator-Token'] = TRADING_BOT_OPERATOR_TOKEN;
    }
    if (data) {
      config.data = data;
    }
      const response = await axios(config);
      return response.data;
    } catch (error) {
      lastError = error;
      const status = error?.response?.status || 0;
      if (options.returnAvailability && status === 503 && error?.response?.data?.category) {
        // A provider throttle (Alpaca news maps its 429 to 503 rate_limited) gets the same bounded GET retry as a raw 429.
        if (method === 'GET' && error.response.data.category === 'rate_limited' && attempt < maxAttempts
          && Date.now() - started + 1000 * attempt < budgetMs) {
          await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
          continue;
        }
        return { ...error.response.data, http_status: 503 };
      }
      if (options.returnValidation && [400, 422].includes(status) && error?.response?.data) return error.response.data;
      const retryable = safe && (!status || [500, 502, 503, 504].includes(status) || (method === 'GET' && status === 429));
      if (!retryable || attempt >= maxAttempts) break;
      const waitMs = status === 429 ? 1000 * attempt : Math.min(100 * (2 ** (attempt - 1)), 750);
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
  }
  const status = lastError?.response?.status || 0;
  const retryable = safe && (!status || [500, 502, 503, 504].includes(status) || (method === 'GET' && status === 429));
  const responseDetail = lastError?.response?.data;
  const formatted = formatTradingBotFailure(endpoint, status, responseDetail, attempt, retryable);
  const err = new Error(formatted.message);
  err.diagnostics = formatted.diagnostics;
  throw err;
}

// Automatic memory is only for broker-confirmed fills; explicit store_trade_setup remains available.
async function autoStoreSetup(args, action) {
	if (typeof args.thesis !== 'string' || !args.thesis.trim()) return;
	if (args.opening_entry !== true && args.position_intent && !isOpeningIntent(args.position_intent)) return;
	const status = String(args.execution_status || args.status || '').toLowerCase();
	const filledQty = Number(args.filled_qty ?? args.FilledQty ?? 0);
	const confirmed = args.execution_confirmed === true && filledQty > 0 && ['filled', 'partially_filled', 'canceled', 'rejected', 'expired', 'done_for_day', 'replaced'].includes(status);
	if (!confirmed || ['planned_for_next_session', 'submit_failed', 'rejected_before_submission', 'submission_uncertain', 'test', 'validation'].includes(status)) return;

  try {
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const id = `${dateStr}-${args.symbol}-${action}-${now.getTime()}`;
    const trade = {
      id,
      decision_file: `manual_${id}.json`,
      symbol: args.symbol,
      action,
      strategy: args.strategy || 'auto',
      result_pct: null,
      result_dollars: null,
      date: dateStr,
      reasoning: args.thesis,
      market_context: args.market_context || '',
	      provenance: 'broker_confirmed_fill',
	      status,
    };

    await storeTrade(trade);
  } catch (error) {
    console.error('Failed to auto-store trade setup:', error.message);
  }
}

// Only OPENING trades should seed the entry-recall corpus; closing/exit orders would
// pollute find_similar_setups (used as pre-entry research). Options carry an explicit intent;
// default to opening when unknown.
function isOpeningIntent(positionIntent) {
  if (typeof positionIntent !== 'string' || !positionIntent) return true;
  return positionIntent.includes('open');
}

// Build an order tool response, nudging the agent if no thesis was captured to memory.
function orderResponse(data, args) {
  let text = JSON.stringify(data, null, 2);
  if (typeof args.thesis !== 'string' || !args.thesis.trim()) {
    text += '\n\n⚠ No `thesis` provided — this trade was NOT captured to your trade-memory. Pass a `thesis` next time so find_similar_setups can recall it.';
  }
  return { content: [{ type: 'text', text }] };
}

// Create MCP server
const server = new Server(
  {
    name: 'openprophet',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: filterToolsForCurrentAuthority(filterManagerTools(OPENPROPHET_ROLE, [
      {
        name: 'get_account',
        description: 'Get trading account information including cash, buying power, and portfolio value',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'get_positions',
        description: 'Get all open positions in the trading account',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'get_orders',
        description: 'Get orders with an optional status filter. Defaults to all so planned intents and unresolved states remain visible.',
        inputSchema: {
          type: 'object',
          properties: {
            status: {
              type: 'string',
              description: 'Defaults to all. active/open aggregate broker working statuses (new, accepted, pending and partial); planned intents and uncertain submissions remain separate application records. complete=false means broker history is unavailable.',
              enum: ['all', 'active', 'planned_for_next_session', 'accepted', 'new', 'pending_new', 'open', 'filled', 'partially_filled', 'canceled', 'cancelled', 'rejected', 'expired', 'done_for_day', 'replaced', 'submit_failed', 'submission_uncertain', 'risk_blocked', 'rejected_before_submission', 'planned_intent_not_broker_visible', 'market_closed', 'unavailable'],
            },
          },
        },
      },
      {
        name: 'place_buy_order',
        description: 'Place a buy order for a stock. OCC option symbols are rejected; use place_options_order for options.',
        inputSchema: {
          type: 'object',
          properties: {
            client_order_id: {
              type: 'string',
              description: 'Stable client order ID. Reuse the same ID only after reconciling an uncertain submission.',
            },
            symbol: {
              type: 'string',
              description: 'Stock symbol (e.g., AAPL, TSLA)',
            },
            quantity: {
              type: 'number',
              description: 'Number of shares to buy',
            },
            order_type: {
              type: 'string',
              description: 'Order type (market, limit)',
              enum: ['market', 'limit'],
            },
            limit_price: {
              type: 'number',
              description: 'Limit price (required for limit orders)',
            },
            thesis: {
              type: 'string',
              description: 'Your one-paragraph rationale for this trade — captured to the trade-memory for future recall.',
            },
            strategy: {
              type: 'string',
              description: 'Trading strategy for this setup',
            },
            market_context: {
              type: 'string',
              description: 'Relevant market context for this setup',
            },
          },
          required: ['client_order_id', 'symbol', 'quantity', 'order_type'],
        },
      },
      {
        name: 'place_sell_order',
        description: 'Place a sell order for a stock. OCC option symbols are rejected; use place_options_order for options.',
        inputSchema: {
          type: 'object',
          properties: {
            client_order_id: {
              type: 'string',
              description: 'Stable client order ID. Reuse the same ID only after reconciling an uncertain submission.',
            },
            symbol: {
              type: 'string',
              description: 'Stock symbol (e.g., AAPL, TSLA)',
            },
            quantity: {
              type: 'number',
              description: 'Number of shares to sell',
            },
            order_type: {
              type: 'string',
              description: 'Order type (market, limit)',
              enum: ['market', 'limit'],
            },
            limit_price: {
              type: 'number',
              description: 'Limit price (required for limit orders)',
            },
            thesis: {
              type: 'string',
              description: 'Your one-paragraph rationale for this trade — captured to the trade-memory for future recall.',
            },
            strategy: {
              type: 'string',
              description: 'Trading strategy for this setup',
            },
            market_context: {
              type: 'string',
              description: 'Relevant market context for this setup',
            },
          },
          required: ['client_order_id', 'symbol', 'quantity', 'order_type'],
        },
      },
      {
        name: 'place_managed_position',
        description: 'Open a managed position with exactly one executable protection leg: one stop loss OR one take profit OR one supported partial-exit leg. A trailing stop is a modifier on the required stop-loss leg, not a second executable leg; it requires a positive trailing_percent. Durable OCO is unavailable; stop loss and take profit must never be sent concurrently. Positive filled quantity is required for execution confirmation.',
        inputSchema: {
          type: 'object',
          properties: {
            client_order_id: {
              type: 'string',
              description: 'Required stable identity for this managed entry; reuse it when reconciling an uncertain submission.',
            },
            symbol: {
              type: 'string',
              description: 'Stock symbol (e.g., BE, NXT, GOOGL)',
            },
            side: {
              type: 'string',
              description: 'Position side',
              enum: ['buy', 'sell'],
            },
            strategy: {
              type: 'string',
              description: 'Trading strategy type',
              enum: ['SWING_TRADE', 'LONG_TERM', 'DAY_TRADE'],
            },
            allocation_dollars: {
              type: 'number',
              description: 'Dollar amount to allocate to this position',
            },
            entry_strategy: {
              type: 'string',
              description: 'Entry order type',
              enum: ['market', 'limit'],
            },
            entry_price: {
              type: 'number',
              description: 'Entry price (required for limit orders)',
            },
            stop_loss_percent: {
              type: 'number',
              description: 'Stop loss as % from entry (e.g., 15 for -15%)',
            },
            stop_loss_price: {
              type: 'number',
              description: 'Absolute stop loss price',
            },
            take_profit_percent: {
              type: 'number',
              description: 'Take profit as % from entry (e.g., 25 for +25%)',
            },
            take_profit_price: {
              type: 'number',
              description: 'Absolute take profit price',
            },
            trailing_stop: {
              type: 'boolean',
              description: 'Enable trailing stop as a modifier on the required stop-loss leg',
            },
            trailing_percent: {
              type: 'number',
              description: 'Trailing stop percentage',
              minimum: 0,
              exclusiveMinimum: 0,
            },
            partial_exit: {
              type: 'object',
              description: 'Partial profit taking configuration',
              properties: {
                enabled: {
                  type: 'boolean',
                  description: 'Enable partial exits',
                },
                percent: {
                  type: 'number',
                  description: 'Percentage of position to exit (e.g., 50 for 50%)',
                },
                target_percent: {
                  type: 'number',
                  description: 'Profit % to trigger partial exit (e.g., 20 for +20%)',
                },
              },
            },
            notes: {
              type: 'string',
              description: 'Notes about this position',
            },
            tags: {
              type: 'array',
              description: 'Tags for categorization',
              items: {
                type: 'string',
              },
            },
            thesis: {
              type: 'string',
              description: 'Your one-paragraph rationale for this trade — captured to the trade-memory for future recall.',
            },
            market_context: {
              type: 'string',
              description: 'Relevant market context for this setup',
            },
          },
          oneOf: [
            { required: ['stop_loss_price'], not: { anyOf: [{ required: ['stop_loss_percent'] }, { required: ['take_profit_price'] }, { required: ['take_profit_percent'] }, { required: ['partial_exit'] }] } },
            { required: ['stop_loss_percent'], not: { anyOf: [{ required: ['stop_loss_price'] }, { required: ['take_profit_price'] }, { required: ['take_profit_percent'] }, { required: ['partial_exit'] }] } },
            { required: ['take_profit_price'], not: { anyOf: [{ required: ['stop_loss_price'] }, { required: ['stop_loss_percent'] }, { required: ['take_profit_percent'] }, { required: ['partial_exit'] }, { required: ['trailing_stop'] }] } },
            { required: ['take_profit_percent'], not: { anyOf: [{ required: ['stop_loss_price'] }, { required: ['stop_loss_percent'] }, { required: ['take_profit_price'] }, { required: ['partial_exit'] }, { required: ['trailing_stop'] }] } },
            { required: ['partial_exit'], not: { anyOf: [{ required: ['stop_loss_price'] }, { required: ['stop_loss_percent'] }, { required: ['take_profit_price'] }, { required: ['take_profit_percent'] }, { required: ['trailing_stop'] }] } },
          ],
          allOf: [
            { if: { properties: { trailing_stop: { const: true } }, required: ['trailing_stop'] }, then: { required: ['trailing_percent'] } },
          ],
          required: ['client_order_id', 'symbol', 'side', 'allocation_dollars'],
        },
      },
      {
        name: 'get_managed_positions',
        description: 'List managed positions with optional status filter. By default, returns only ACTIVE positions for token efficiency. Use status="" or status="ALL" to get all positions.',
        inputSchema: {
          type: 'object',
          properties: {
            status: {
              type: 'string',
              description: 'Filter by status. Leave empty or use "ALL" for all positions. Use PENDING, ACTIVE, PARTIAL, CLOSED, or STOPPED_OUT for specific statuses. Defaults to ACTIVE only.',
              enum: ['PENDING', 'ACTIVE', 'PARTIAL', 'CLOSED', 'STOPPED_OUT', 'ALL', ''],
            },
          },
        },
      },
      {
        name: 'get_managed_position',
        description: 'Get details of a specific managed position by ID',
        inputSchema: {
          type: 'object',
          properties: {
            position_id: {
              type: 'string',
              description: 'Position ID',
            },
          },
          required: ['position_id'],
        },
      },
      {
        name: 'close_managed_position',
        description: 'Manually close a managed position (cancels all orders and exits at market)',
        inputSchema: {
          type: 'object',
          properties: {
            position_id: {
              type: 'string',
              description: 'Position ID to close',
            },
          },
          required: ['position_id'],
        },
      },
      {
        name: 'cancel_order',
        description: 'Cancel a broker-visible open order by ID. Planned application intents and pre-submission failures are not broker orders; cancel_order is not a general retry or cleanup tool.',
        inputSchema: {
          type: 'object',
          properties: {
            order_id: {
              type: 'string',
              description: 'Order ID to cancel',
            },
          },
          required: ['order_id'],
        },
      },
      {
        name: 'get_quote',
        description: 'Get quote data for a stock symbol: IEX bid/ask (can be sparse or very wide for single stocks), the last trade price, spread %, and a quote_flag (ok, wide, stale, one_sided). When quote_flag is not ok, judge price from last_trade or the latest completed bar, not the bid/ask midpoint. It also returns a session block: today\'s daily_open (once today\'s bar exists), the previous_close with its date, the last trade price, and change_from_open_pct and change_from_previous_close_pct, with the bars feed. Unknown values are omitted, never estimated. It is context for where the stock stands (AlphaDesk measures price action against today\'s open), not a gate and not a prediction of an AlphaDesk result.',
        inputSchema: {
          type: 'object',
          properties: {
            symbol: {
              type: 'string',
              description: 'Stock symbol (e.g., AAPL, GOOGL, TSLA)',
            },
          },
          required: ['symbol'],
        },
      },
      {
        name: 'get_latest_bar',
        description: 'Get the single most recent bar (a recent minute bar from the IEX feed, still forming) for a stock symbol. It is not a completed daily bar; use get_historical_bars with timeframe 1Day for completed-bar strategy evidence.',
        inputSchema: {
          type: 'object',
          properties: {
            symbol: {
              type: 'string',
              description: 'Stock symbol (e.g., AAPL, GOOGL, TSLA)',
            },
          },
          required: ['symbol'],
        },
      },
      {
        name: 'get_historical_bars',
        description: 'Get historical price bars. Date-only start/end use America/New_York trading dates; end includes that date. You may also pass RFC3339 timestamps for exact bounds. Timestamp offsets are honored exactly: use UTC Z for UTC clock values (for example 2026-10-28T13:30:00Z), not 2026-10-28T13:30:00-04:00. Today is capped at now; malformed or inverted ranges are rejected. Each bar carries complete (false while still forming; a daily bar completes at the 16:00 New York close). The response states its feed: sip is consolidated market data (preferred, used when the account may read it), iex is IEX-only data whose highs, lows and volume can differ from the real market.',
        inputSchema: {
          type: 'object',
          properties: {
            symbol: {
              type: 'string',
              description: 'Stock symbol (e.g., AAPL, GOOGL, TSLA)',
            },
            start_date: {
              type: 'string',
              description: 'YYYY-MM-DD New York trading date or RFC3339 timestamp with exact offset; UTC times should end in Z (default: 30 days ago)',
            },
            end_date: {
              type: 'string',
              description: 'Inclusive YYYY-MM-DD New York trading date or RFC3339 timestamp (default: now)',
            },
            timeframe: {
              type: 'string',
              description: 'Bar timeframe: 1Min, 5Min, 15Min, 1Hour, 1Day (default: 1Day)',
              enum: ['1Min', '5Min', '15Min', '1Hour', '1Day'],
            },
          },
          required: ['symbol'],
        },
      },
      {
        name: 'get_news',
        description: 'Get latest headlines from the Google News RSS feed (broad, not symbol-specific). For company news use get_alpaca_news first; keep this for wider discovery and verification.',
        inputSchema: {
          type: 'object',
          properties: {
            limit: {
              type: 'number',
              description: 'Number of news items to return (default: 20)',
            },
          },
        },
      },
      {
        name: 'get_alpaca_news',
        description: 'Company news from Alpaca (Benzinga and other providers), symbol-tagged, for up to 30 symbols over the last 1-72 hours (default 36, the window AlphaDesk reads). Leave symbols out to read the newest market-wide headlines, which can surface companies you were not watching. Use this FIRST when you research company news; the Google/MarketWatch tools stay available for verification, the original announcement, wider discovery, or when this is empty or unavailable. Results are sorted by updated_at: created_at is the article time, and updated_at or fetched_at never marks a new event. Each article keeps id, source, symbols, url, created_at and updated_at. Check has_more and pass next_page_token as page_token for the next page; a capped page is not the whole window. status is available, empty (a real empty result) or unavailable (a failure, with a category). A symbol tag does not make an article a company-specific event.',
        inputSchema: {
          type: 'object',
          properties: {
            symbols: {
              type: 'array',
              items: { type: 'string' },
              description: 'Up to 30 ticker symbols, e.g. ["AAPL","NVDA"]. Optional: omit it for the newest market-wide headlines.',
            },
            hours: {
              type: 'number',
              description: 'Look-back window in hours, 1-72 (default 36)',
            },
            limit: {
              type: 'number',
              description: 'Articles per page, 1-50 (default 20)',
            },
            page_token: {
              type: 'string',
              description: 'next_page_token from a previous result, to fetch the next page',
            },
          },
          required: [],
        },
      },
      {
        name: 'get_news_by_topic',
        description: 'Get news for a specific topic (WORLD, NATION, BUSINESS, TECHNOLOGY, ENTERTAINMENT, SPORTS, SCIENCE, HEALTH)',
        inputSchema: {
          type: 'object',
          properties: {
            topic: {
              type: 'string',
              description: 'News topic',
              enum: ['WORLD', 'NATION', 'BUSINESS', 'TECHNOLOGY', 'ENTERTAINMENT', 'SPORTS', 'SCIENCE', 'HEALTH'],
            },
          },
          required: ['topic'],
        },
      },
      {
        name: 'search_news',
        description: 'Search Google News by keyword or stock symbol. For company news use get_alpaca_news first; keep this for wider discovery, verification and original-announcement checks.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search query (e.g., Tesla, NVDA, Federal Reserve)',
            },
            limit: {
              type: 'number',
              description: 'Number of results (default: 20)',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'get_market_news',
        description: 'Get market news, optionally filtered by stock symbols',
        inputSchema: {
          type: 'object',
          properties: {
            symbols: {
              type: 'string',
              description: 'Comma-separated stock symbols (e.g., TSLA,NVDA,AAPL)',
            },
          },
        },
      },
      {
        name: 'aggregate_and_summarize_news',
        description: 'Aggregate news from multiple sources and create an AI-powered summary using Gemini. Saves summary to a file.',
        inputSchema: {
          type: 'object',
          properties: {
            topics: {
              type: 'array',
              items: { type: 'string' },
              description: 'News topics to aggregate (BUSINESS, TECHNOLOGY, etc.)',
            },
            symbols: {
              type: 'array',
              items: { type: 'string' },
              description: 'Stock symbols to search for (e.g., ["TSLA", "NVDA"])',
            },
            max_articles: {
              type: 'number',
              description: 'Maximum articles per source (default: 10)',
            },
          },
        },
      },
      {
        name: 'list_news_summaries',
        description: 'List all saved news summaries',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'get_news_summary',
        description: 'Get a specific news summary by filename',
        inputSchema: {
          type: 'object',
          properties: {
            filename: {
              type: 'string',
              description: 'Summary filename',
            },
          },
          required: ['filename'],
        },
      },
      {
        name: 'get_marketwatch_topstories',
        description: 'Get MarketWatch top stories',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'get_marketwatch_realtime',
        description: 'Get MarketWatch real-time headlines',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'get_marketwatch_bulletins',
        description: 'Get MarketWatch breaking news bulletins',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'get_marketwatch_marketpulse',
        description: 'Get MarketWatch market pulse (brief up-to-the-minute market updates)',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'get_marketwatch_all',
        description: 'Get all MarketWatch news feeds aggregated',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      // ── Economic Intelligence Feeds (free, no API key) ──────────────────
      {
        name: 'get_treasury_data',
        description: 'Get US Treasury data: national debt levels and average interest rates on government securities. No API key required. Updated daily.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'get_global_events',
        description: 'Get global news events from GDELT (Global Database of Events, Language, and Tone). Searches 100+ languages, updates every 15 minutes. No API key required.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query (e.g., "tariff china", "federal reserve"). Leave empty for broad market coverage.' },
          },
        },
      },
      {
        name: 'get_economic_indicators',
        description: 'Get key economic indicators from BLS: CPI, Core CPI, Unemployment Rate, Nonfarm Payrolls, PPI. No API key required.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'get_market_snapshot',
        description: 'Get broad market snapshot from Yahoo Finance: indexes (SPY, QQQ, DIA, IWM), bonds, commodities (Gold, Oil), crypto (BTC, ETH), VIX. Includes 5-day history. No API key required.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'get_defense_contracts',
        description: 'Get recent US defense/military contracts from USAspending.gov. Useful for defense sector signals. No API key required.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'get_global_trade_flows',
        description: 'Get global trade flow data from UN Comtrade for strategic commodities: crude, gas, gold, semiconductors. No API key required. Data lags 1-2 months.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'get_quick_market_intelligence',
        description: 'Get AI-powered quick market intelligence (Gemini-cleaned news from MarketWatch - 15 articles max, very fast)',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'analyze_stocks',
        description: 'Analyze multiple stocks with comprehensive technical indicators, news, and AI-powered recommendations. Returns RSI, trend, volatility, support/resistance, catalysts, and trade recommendations for each stock.',
        inputSchema: {
          type: 'object',
          properties: {
            symbols: {
              type: 'array',
              items: { type: 'string' },
              description: 'Array of stock symbols to analyze (e.g., ["CLRB", "PLUG", "BE", "NVDA"])',
            },
          },
          required: ['symbols'],
        },
      },
      {
        name: 'get_cleaned_news',
        description: 'Get AI-powered cleaned and aggregated news from multiple sources (Google News + MarketWatch)',
        inputSchema: {
          type: 'object',
          properties: {
            include_google: {
              type: 'boolean',
              description: 'Include Google News feeds',
            },
            include_marketwatch: {
              type: 'boolean',
              description: 'Include MarketWatch feeds',
            },
            google_topics: {
              type: 'array',
              items: { type: 'string' },
              description: 'Google News topics to include (BUSINESS, TECHNOLOGY, etc.)',
            },
            symbols: {
              type: 'array',
              items: { type: 'string' },
              description: 'Stock symbols to search for',
            },
            max_articles_per_source: {
              type: 'number',
              description: 'Maximum articles per source (default 10)',
            },
          },
        },
      },
      {
        name: 'log_decision',
        description: 'Log a trading decision with reasoning to decisive_actions/ folder',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              description: 'The action taken (BUY, SELL, HOLD, PASS)',
            },
            symbol: {
              type: 'string',
              description: 'Stock symbol (optional)',
            },
            reasoning: {
              type: 'string',
              description: 'Detailed reasoning for the decision',
            },
            market_data: {
              type: 'object',
              description: 'Relevant market data that influenced the decision',
            },
          },
          required: ['action', 'reasoning'],
        },
      },
      {
        name: 'log_activity',
        description: 'Log AI trading activity to the daily activity log (positions, intelligence, decisions)',
        inputSchema: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              description: 'Activity type: ANALYSIS, INTELLIGENCE, DECISION, POSITION_CHECK',
            },
            action: {
              type: 'string',
              description: 'Action description (e.g., "Analyzed 10 stocks", "Gathered market intelligence")',
            },
            symbol: {
              type: 'string',
              description: 'Stock symbol if applicable',
            },
            reasoning: {
              type: 'string',
              description: 'Reasoning or notes for this activity',
            },
            details: {
              type: 'object',
              description: 'Additional details as key-value pairs',
            },
          },
          required: ['type', 'action'],
        },
      },
      {
        name: 'get_activity_log',
        description: 'Get the current day\'s activity log showing all AI trading activities',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'place_options_order',
        description: 'Place one single-leg OCC options order (openings: 1-10 contracts). Agent tool does not expose atomic multi-leg execution; never simulate a spread with sequential single-leg orders. Reconcile option positions first; long entries use buy_to_open and reductions use sell_to_close on the same OCC contract for the broker-reconciled remaining quantity. Supply exact-contract timestamped bid/ask and sizes from the chain; missing evidence blocks entry. Managed-position tools are equities-only and do not provide broker-held option stops or OCO. AlphaDesk assessment applies only to new exposure; FAIL/UNAVAILABLE blocks openings but not reducing a long. Backend controls still apply. Accepted/new/open acknowledge only; positive filled quantity confirms execution.',
        inputSchema: {
          type: 'object',
          properties: {
            client_order_id: {
              type: 'string',
              description: 'Generate a stable client_order_id for every NEW intent before assessment and pass that exact value as client_reference. After PASS, submit the unchanged proposal with this same ID. Reuse it with immutable fields ONLY for an eligible persisted planned retry after reconciliation; uncertain submission must never be blindly retried.',
            },
            symbol: {
              type: 'string',
              description: 'Options symbol in OCC format (e.g., TSLA251219C00400000 for TSLA Dec 19 2025 $400 Call)',
            },
            underlying: {
              type: 'string',
              description: 'Underlying stock symbol (e.g., TSLA)',
            },
            quantity: {
              type: 'number',
              description: 'Number of contracts to trade',
            },
            side: {
              type: 'string',
              description: 'Order side',
              enum: ['buy', 'sell'],
            },
            position_intent: {
              type: 'string',
              description: 'Position intent (required; never infer from side)',
              enum: ['buy_to_open', 'buy_to_close', 'sell_to_open', 'sell_to_close'],
            },
            order_type: {
              type: 'string',
              description: 'Order type',
              enum: ['market', 'limit'],
            },
            limit_price: {
              type: 'number',
              description: 'Limit price per contract (required for limit orders)',
            },
            thesis: {
              type: 'string',
              description: 'Your one-paragraph rationale for this trade — captured to the trade-memory for future recall.',
            },
            strategy: {
              type: 'string',
              description: 'Trading strategy for this setup',
            },
            market_context: {
              type: 'string',
              description: 'Relevant market context for this setup',
            },
            market_scanner_features: {
              type: 'object',
              description: 'Provider-owned scanner features for the exact trade, if available; do not invent values or turn a missing score into a zero score.',
            },
          },
          required: ['client_order_id', 'symbol', 'underlying', 'quantity', 'side', 'position_intent', 'order_type'],
        },
      },
      {
        name: 'withdraw_planned_intent',
        description: 'Withdraw a durable local planned-for-next-session intent by its stable client order ID. This never calls the broker and is separate from cancel_order.',
        inputSchema: {
          type: 'object',
          properties: {
            client_order_id: {
              type: 'string',
              description: 'Stable client order ID of the local planned intent to withdraw',
            },
          },
          required: ['client_order_id'],
        },
      },
      {
        name: 'get_options_assessment_policy',
        description: 'Read authenticated AlphaDesk policy metadata. Returns POLICY_ONLY metadata, never PASS or execution authority; does not assess or place trades. Position size is governed by OP2 account limits, not by this tool.',
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'assess_options_trade',
        description: 'Assess your exact proposed options trade using standalone AlphaDesk market evidence, without a scanner/watchlist or caller-supplied score. Generate one stable client_order_id before assessment and pass the same stable client_order_id as optional client_reference; after PASS reuse it for the unchanged order proposal. Returns PASS/FAIL/UNAVAILABLE, score, criteria and remediation. PASS is not broker/account authorization; on FAIL or UNAVAILABLE skip this proposal and continue other work. No orders or approvals.',
        annotations: { readOnlyHint: true, destructiveHint: false },
        inputSchema: {
          type: 'object', additionalProperties: false,
          properties: {
            legs: { type: 'array', minItems: 1, maxItems: 2, items: {
              type: 'object', additionalProperties: false,
              properties: { symbol: {type:'string',pattern:'^[A-Z0-9]{1,6}[0-9]{6}[CP][0-9]{8}$'},
                side: {type:'string',enum:['buy','sell']},ratio_quantity: {type:'integer',minimum:1,maximum:10} },
              required:['symbol','side'] } },
            quantity: {type:'integer',minimum:1,maximum:10},
            limit_price: {type:'number',exclusiveMinimum:0},
            client_reference: {type:'string',maxLength:128,description:'Optional stable client_order_id for the exact later order; reuse the same value when submitting unchanged legs, quantity and limit price.'},
          }, required: ['legs','quantity','limit_price'],
        },
      },
      {
        name: 'assess_options_strategy',
        description: 'Request deterministic AlphaDesk assessment for the exact proposed options trade. Provide the exact broker-derived option chain and quote/Greeks/max-loss evidence for every leg; client-supplied or fabricated evidence is not sufficient. Assessment-only and not broker authorization.',
        inputSchema: {
          type: 'object', properties: {
            symbol: {type:'string'}, underlying: {type:'string'}, quantity: {type:'number'}, side: {type:'string', enum:['buy','sell']}, position_intent: {type:'string', enum:['buy_to_open','buy_to_close','sell_to_open','sell_to_close']}, order_type: {type:'string', enum:['market','limit']}, time_in_force: {type:'string', enum:['day']}, limit_price: {type:'number'}, strategy_type: {type:'string'}, legs: {type:'array', description:'Required exact broker-derived chain legs, including per-leg contract symbols, sides, quantities, prices, and quote evidence.'}, max_loss: {type:'number', description:'Required broker-derived maximum loss.'}, greeks: {type:'object', description:'Required broker-derived Greeks.'}, market_evidence_at: {type:'string'}, observed_at: {type:'string'}, expires_at: {type:'string'}, market_scanner_features: {type:'object'},
          }, required: ['symbol','underlying','quantity','side','position_intent','order_type','time_in_force'],
        },
      },
      {
        name: 'get_options_positions',
        description: 'Get broker-reconciled open options positions and remaining quantities by exact OCC contract. Use this before any option reduction; close the same contract with sell_to_close for the actual remaining quantity. Managed-position tools are equities-only.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'get_options_position',
        description: 'Get the broker-reconciled position and remaining quantity for this exact OCC symbol. A 404 means no open position was found, not successful closure; reconcile broker-confirmed exit fills and all options positions to confirm zero remaining contracts. Use the result to size a same-contract sell_to_close; managed-position tools are equities-only.',
        inputSchema: {
          type: 'object',
          properties: {
            symbol: {
              type: 'string',
              description: 'Options symbol in OCC format',
            },
          },
          required: ['symbol'],
        },
      },
      {
        name: 'get_options_chain',
        description: 'Get options contracts with indicative/testing_only provider data. LatestTradeSize is one trade, not daily Volume; unknown Volume and OpenInterest are omitted and OpenInterestPresent is false. PAPER_ADVISORY_OP2 assessment still requires exact fresh OCC bid/ask/depth and strategy/risk checks.',
        inputSchema: {
          type: 'object',
          properties: {
            symbol: {
              type: 'string',
              description: 'Underlying stock symbol (e.g., SPY, TSLA, AAPL)',
            },
            expiration: {
              type: 'string',
              description: 'Expiration date in YYYY-MM-DD format (optional, defaults to next Friday)',
            },
            delta_min: {
              type: 'number',
              description: 'Minimum delta (absolute value, e.g., 0.4 for ATM options)',
            },
            delta_max: {
              type: 'number',
              description: 'Maximum delta (absolute value, e.g., 0.6 for ATM options)',
            },
            min_bid: {
              type: 'number',
              description: 'Minimum bid price to filter out illiquid options (e.g., 0.1)',
            },
            max_cost: {
              type: 'number',
              description: 'Optional ceiling on the cost of ONE contract in dollars (ask x 100). Normally omit it. Never derive it from AlphaDesk policy figures or treat it as a position budget: a position may hold several contracts.',
            },
            type: {
              type: 'string',
              description: 'Filter by option type: "call" or "put"',
              enum: ['call', 'put'],
            },
          },
          required: ['symbol'],
        },
      },
      {
        name: 'get_daily_features',
        description: 'Arithmetic facts about COMPLETED daily bars for up to 25 symbols in one call: last and prior-session OHLCV, SMA20 and its 5-session slope, last close vs SMA20, prior 10/20-session high and low (excluding the last bar), prior 20-session average volume and the last-volume ratio, and the last five completed bars. It also returns ready-made signed distances so you do not compute them by hand: low_vs_low_prior_20_sessions_pct (last low vs the prior 20-session low; negative means it undercut), close_vs_high_prior_10_sessions_pct and close_vs_high_prior_20_sessions_pct (last close vs those prior highs; positive means above), and the flags undercut_prior_session_low and close_above_open (strictly greater). A field is omitted when its history is missing. The session still forming is excluded. Facts only, not signals. Each symbol states its feed (sip = consolidated, preferred; iex = IEX-only, whose highs, lows and volume can differ). A symbol that fails carries its own error without failing the batch.',
        inputSchema: {
          type: 'object',
          properties: {
            symbols: {
              type: 'array',
              items: { type: 'string' },
              description: 'Up to 25 ticker symbols, e.g. ["SPY","QQQ","XLK"]',
            },
          },
          required: ['symbols'],
        },
      },
      {
        name: 'get_option_expirations',
        description: 'List the expiration dates that actually have listed call contracts for an underlying within a days-to-expiry window (default 1-60, maximum span 90). Use it to choose an expiry, then pass that date as expiration to get_options_chain. If some dates could not be verified the list is still returned with complete=false and an unchecked list: those dates are unknown, not absent, so choose only a confirmed date. An error means no date could be verified.',
        inputSchema: {
          type: 'object',
          properties: {
            symbol: { type: 'string', description: 'Underlying symbol (e.g., SPY)' },
            min_dte: { type: 'number', description: 'Minimum calendar days to expiry (default 1)' },
            max_dte: { type: 'number', description: 'Maximum calendar days to expiry (default 60)' },
          },
          required: ['symbol'],
        },
      },
      {
        name: 'get_earnings_dates',
        description: 'Scheduled earnings dates from a public calendar (not broker-verified) for up to 30 symbols over the next 1-30 days (default 21). Status scheduled gives the date and timing; none_found_in_window means the whole window was read and no report was listed; unknown means part of the window could not be read, so no date proves nothing. ETFs normally have none.',
        inputSchema: {
          type: 'object',
          properties: {
            symbols: {
              type: 'array',
              items: { type: 'string' },
              description: 'Up to 30 ticker symbols',
            },
            days: { type: 'number', description: 'Days ahead to check, 1-30 (default 21)' },
          },
          required: ['symbols'],
        },
      },
      {
        name: 'wait',
        description: 'Wait for a specified duration during the current trading beat. Maximum 30 seconds; for longer observation, finish the current beat and rely on the existing next heartbeat.',
        inputSchema: {
          type: 'object',
          properties: {
            seconds: {
              type: 'integer',
              description: 'Finite integer number of seconds to wait (1-30)',
              minimum: 1,
              maximum: 30,
            },
            reason: {
              type: 'string',
              description: 'Optional reason for waiting (e.g., "Monitoring position momentum")',
            },
          },
          required: ['seconds'],
        },
      },
      {
        name: 'get_datetime',
        description: 'Get the current date and time in a specified timezone. Defaults to America/New_York (US Eastern). Returns time, date, day of week, market status, and whether markets are likely open. Use iso_utc as the canonical UTC clock when supplying timestamp bounds.',
        inputSchema: {
          type: 'object',
          properties: {
            timezone: {
              type: 'string',
              description: 'IANA timezone (e.g., "America/New_York", "America/Los_Angeles", "UTC"). Defaults to America/New_York.',
            },
          },
        },
      },
      {
        name: 'find_similar_setups',
        description: 'Find historically similar trading setups using AI vector similarity search. Query with natural language (e.g., "SPY gap up scalp") to find past trades with similar setups, reasoning, and market context. Returns similar trades with results, reasoning, and similarity scores.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Natural language query describing the setup (e.g., "SPY gap up momentum scalp", "NVDA earnings breakout swing")',
            },
            limit: {
              type: 'number',
              description: 'Number of similar trades to return (default: 5)',
            },
            symbol: {
              type: 'string',
              description: 'Optional: Filter by symbol (e.g., "SPY", "NVDA")',
            },
            strategy: {
              type: 'string',
              description: 'Optional: Filter by strategy ("SCALP", "SWING", "HOLD")',
            },
            action: {
              type: 'string',
              description: 'Optional: Filter by action (e.g., "BUY", "SELL")',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'store_trade_setup',
        description: 'Store a completed trade with AI embeddings for future similarity search. Use this after closing a trade to add it to the historical database with reasoning and market context.',
        inputSchema: {
          type: 'object',
          properties: {
            symbol: {
              type: 'string',
              description: 'Stock symbol (e.g., "SPY", "NVDA")',
            },
            action: {
              type: 'string',
              description: 'Trade action (e.g., "BUY", "SELL", "HOLD")',
            },
            strategy: {
              type: 'string',
              description: 'Strategy type ("SCALP", "SWING", "HOLD")',
            },
            result_pct: {
              type: 'number',
              description: 'Result percentage (e.g., 26.5 for +26.5%, -15.6 for -15.6%)',
            },
            result_dollars: {
              type: 'number',
              description: 'Result in dollars (e.g., 1920 for +$1920, -960 for -$960)',
            },
            reasoning: {
              type: 'string',
              description: 'Detailed trade reasoning and thesis',
            },
            market_context: {
              type: 'string',
              description: 'Market conditions, catalysts, and context',
            },
          },
          required: ['symbol', 'action', 'strategy', 'reasoning', 'market_context'],
        },
      },
      {
        name: 'get_trade_stats',
        description: 'Get statistics for trades matching filters (win rate, profit factor, avg result, best/worst). Useful for analyzing performance by symbol, strategy, or action.',
        inputSchema: {
          type: 'object',
          properties: {
            symbol: {
              type: 'string',
              description: 'Optional: Filter by symbol (e.g., "SPY")',
            },
            strategy: {
              type: 'string',
              description: 'Optional: Filter by strategy ("SCALP", "SWING")',
            },
            action: {
              type: 'string',
              description: 'Optional: Filter by action (e.g., "BUY")',
            },
          },
        },
      },
      // ── Agent Self-Modification Tools ──────────────────────────
      {
        name: 'update_agent_prompt',
        description: 'Update the active agent\'s custom system prompt. Use this when the user asks you to change your trading behavior, persona, or rules. The new prompt replaces the existing custom prompt.',
        inputSchema: {
          type: 'object',
          properties: {
            prompt: {
              type: 'string',
              description: 'The new system prompt text',
            },
          },
          required: ['prompt'],
        },
      },
      {
        name: 'update_strategy_rules',
        description: 'Create a new trading strategy with the given rules and assign it to the current agent. Existing strategies are NEVER modified — a new one is always created so the operator can review it on the Agents page. ONLY use this when the user EXPLICITLY asks you to change trading rules.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Name for the new strategy (e.g., "Conservative Options v2")' },
            rules: { type: 'string', description: 'The trading rules in markdown format' },
          },
          required: ['name', 'rules'],
        },
      },
      {
        name: 'get_agent_config',
        description: 'Get the current agent configuration including active agent, strategy, model, heartbeat settings, and permissions. Useful for understanding your current setup before making changes.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'set_heartbeat',
        description: 'Override the agent heartbeat interval after the initial Settings-controlled warm-up, unless the operator has enabled the forced-interval guardrail. Settings remain priority for the first two completed market sessions. Use force=true only for an urgent, strongly justified market condition.',
        inputSchema: {
          type: 'object',
          properties: {
            seconds: { type: 'number', description: 'New heartbeat interval in seconds (30-14400; maximum 4 hours)' },
            force: { type: 'boolean', description: 'Allow an early override before two completed market sessions; requires a meaningful urgent reason' },
            reason: { type: 'string', description: 'Reason for the override (logged to terminal)' },
          },
          required: ['seconds'],
        },
      },
      {
        name: 'update_permissions',
        description: 'Update agent trading permissions/guardrails. Use this when the user asks to change risk limits, enable/disable trading types, etc.',
        inputSchema: {
          type: 'object',
          properties: {
            allowLiveTrading: { type: 'boolean', description: 'Legacy live-order capability; live execution remains prohibited' },
            allowPaperTrading: { type: 'boolean', description: 'Allow placing paper orders subject to all other safeguards' },
            allowOptions: { type: 'boolean', description: 'Allow options trading' },
            allowStocks: { type: 'boolean', description: 'Allow stock trading' },
            allow0DTE: { type: 'boolean', description: 'Allow 0DTE options' },
            maxPositionPct: { type: 'number', description: 'Max position size as % of portfolio' },
            maxDeployedPct: { type: 'number', description: 'Max total deployed capital %' },
            maxDailyLoss: { type: 'number', description: 'Max daily loss % before auto-pause' },
            maxOpenPositions: { type: 'number', description: 'Max simultaneous positions' },
          },
        },
      },
      {
        name: 'set_session_mode',
        description: 'Set session mode: "continuous" keeps conversation context across heartbeats (default), "fresh" starts a new session each heartbeat (better for long_horizon mode). Use fresh for long horizon strategies where each beat should be independent.',
        inputSchema: {
          type: 'object',
          properties: {
            mode: { type: 'string', description: 'Session mode: "continuous" or "fresh"' },
          },
          required: ['mode'],
        },
      },
      {
        name: 'get_heartbeat_profiles',
        description: 'List available heartbeat profiles/skills. These are predefined heartbeat configurations for different trading styles: active (high-frequency), passive (low-frequency), long_horizon (weekly/monthly check-ins), earnings_season (heightened vigilance), overnight (minimal overnight checks), scalp (rapid-fire).',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'apply_heartbeat_profile',
        description: 'Apply a heartbeat profile to change your heartbeat intervals based on trading style. Use get_heartbeat_profiles to see available options.',
        inputSchema: {
          type: 'object',
          properties: {
            profile: { 
              type: 'string', 
              description: 'Profile key: active, passive, long_horizon, earnings_season, overnight, scalp',
            },
          },
          required: ['profile'],
        },
      },
      {
        name: 'get_heartbeat_phases',
        description: 'Get the current heartbeat phase time ranges (in minutes from midnight ET). This shows when each phase (pre_market, market_open, midday, market_close, after_hours, closed) is active.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'update_heartbeat_phase',
        description: 'Operator-only raw phase-range update. Rejected when heartbeat intervals are forced; agents may read phases but must not mutate them.',
        inputSchema: {
          type: 'object',
          properties: {
            phase: { 
              type: 'string', 
              description: 'Phase name: pre_market, market_open, midday, market_close, after_hours',
            },
            start: { 
              type: 'number', 
              description: 'Start minute from midnight ET (e.g., 240 = 4:00 AM ET)',
            },
            end: { 
              type: 'number', 
              description: 'End minute from midnight ET (e.g., 570 = 9:30 AM ET)',
            },
          },
          required: ['phase'],
        },
      },
      {
        name: 'list_sandboxes',
        description: 'List all OpenProphet sandboxes/accounts with their IDs, names, assigned agents, models, and runtime status. Use this before assigning or inspecting a sandbox.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'get_session_context',
        description: 'Retrieve compact prior chat, strategy, decision, and tool-event context for the current account. Use for continuity and learning; verify live state before trading.',
        inputSchema: {
          type: 'object',
          properties: {
            sessions: { type: 'number', description: 'Number of recent sessions (default 5, max 20)' },
            messages: { type: 'number', description: 'Messages per session (default 8, max 20)' },
          },
        },
      },
      {
        name: 'create_agent',
        description: 'Create a new agent persona. The agent will appear in the UI and can be assigned to any sandbox/account. Returns the new agent ID.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Agent name (e.g., "BluechipTrader")' },
            description: { type: 'string', description: 'Short description of the agent personality' },
            model: { type: 'string', description: 'Model ID (e.g., "anthropic/claude-sonnet-4-6")' },
            strategyId: { type: 'string', description: 'Strategy ID to use (optional, can assign later)' },
            customSystemPrompt: { type: 'string', description: 'Custom system prompt for this agent' },
          },
          required: ['name'],
        },
      },
      {
        name: 'create_strategy',
        description: 'Create a new trading strategy with rules. The strategy will appear in the UI and can be assigned to any agent. Returns the new strategy ID.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Strategy name (e.g., "BluechipSteady")' },
            description: { type: 'string', description: 'Short description of the strategy' },
            customRules: { type: 'string', description: 'The trading rules in markdown format' },
          },
          required: ['name', 'customRules'],
        },
      },
      {
        name: 'assign_agent_to_sandbox',
        description: 'Assign an agent to a specific sandbox/account. Use after creating an agent to activate it on an account.',
        inputSchema: {
          type: 'object',
          properties: {
            agentId: { type: 'string', description: 'Agent ID to assign' },
            sandboxId: { type: 'string', description: 'Sandbox ID (e.g., "sbx_6edbf348"). If not provided, uses current sandbox.' },
          },
          required: ['agentId'],
        },
      },
    ])),
  };
});

// ── Permission Enforcement ──────────────────────────────────────────
const AGENT_URL = EXECUTION_START_ENABLED ? (process.env.AGENT_URL || 'http://localhost:3737') : '';
// Match the agent API's server-owned fallback while retaining fail-closed
// behavior when neither credential is configured.
const AGENT_AUTH_TOKEN = EXECUTION_START_ENABLED ? (process.env.AGENT_AUTH_TOKEN || process.env.TRADING_BOT_TOKEN || '') : '';
const OPERATOR_TOKEN = EXECUTION_START_ENABLED ? (process.env.OPERATOR_TOKEN || '') : '';
const AGENT_QUERY = { sandboxId: OPENPROPHET_SANDBOX_ID };
const agentAxios = EXECUTION_START_ENABLED ? axios.create({
  headers: AGENT_AUTH_TOKEN ? {
    Authorization: `Bearer ${AGENT_AUTH_TOKEN}`,
    ...(OPERATOR_TOKEN ? { 'X-OpenProphet-Operator-Token': OPERATOR_TOKEN } : {}),
  } : {},
}) : unavailableBrokerClient();
// Trusted cap state, read from the agent server at the moment of an options opening (never from a flag fixed when this process
// started): the server reconciles and reports whether the running backend holds the saved entry spread cap, with the backend's
// revision of that cap. Anything other than 'in_sync' with a whole-number revision, including an unreachable server or an unknown
// answer, gives null and refuses the opening; 'not_applicable' (no cap can be in force for this sandbox) gives undefined and the
// order carries no revision. The order carries the revision and the backend refuses it if the cap changed after
// this confirmation. Exits, cancels and reads never call this.
async function capSyncRevision() {
  try {
    const resp = await agentAxios.get(`${AGENT_URL}/api/option-spread-cap/sync`, { timeout: 8000, params: AGENT_QUERY });
    if (resp?.data?.state === 'not_applicable') return undefined; // no cap can be in force for this sandbox (no standalone AlphaDesk assessment)
    return resp?.data?.state === 'in_sync' && Number.isSafeInteger(resp?.data?.revision) ? resp.data.revision : null;
  } catch {
    return null;
  }
}
async function enforcePermissions(toolName, args) {
  const perms = await verifyPermissions({
    toolName,
    args,
    enabled: EXECUTION_START_ENABLED,
    authToken: AGENT_AUTH_TOKEN,
    getPermissions: async () => {
      const resp = await agentAxios.get(`${AGENT_URL}/api/permissions`, { timeout: 3000, params: AGENT_QUERY });
      return resp.data;
    },
  });

  // Delegate the actual policy decision to the pure, unit-tested checker.
  checkPermissions(toolName, args, perms);
}

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    // Enforce the role boundary before permission lookup or any backend/action side effect.
    assertManagerToolAllowed(OPENPROPHET_ROLE, name);
    assertAgentToolAllowed(OPENPROPHET_ROLE, name);
    // Enforce permissions before executing any tool
    await enforcePermissions(name, args);

    switch (name) {
      case 'get_account': {
        const data = await callTradingBot('/account');
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(data, null, 2),
            },
          ],
        };
      }

      case 'get_positions': {
        const data = await callTradingBot('/positions');
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(data, null, 2),
            },
          ],
        };
      }

      case 'get_orders': {
        const status = args?.status || 'all';
        const data = await callTradingBot(`/orders?status=${encodeURIComponent(status)}`);
        const rawOrders = Array.isArray(data) ? data : (Array.isArray(data?.orders) ? data.orders : []);
        const orders = rawOrders.map((order) => ({
          ...order,
          client_order_id: order.client_order_id || order.ClientOrderID,
          order_id: order.order_id || order.ID,
          status: order.status || order.Status,
          asset_class: order.asset_class || order.AssetClass,
          underlying: order.underlying || order.Underlying,
          position_intent: order.position_intent || order.PositionIntent,
          next_eligible_at: order.next_eligible_at || order.NextEligibleAt,
        }));
        const response = Array.isArray(data) ? orders : { ...data, orders };
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(response, null, 2),
            },
          ],
        };
      }

      case 'place_buy_order': {
        if (typeof process !== 'undefined' && process.env.OPENPROPHET_OPENINGS_BLOCKED === '1') return { content: [{ type: 'text', text: JSON.stringify({ error: 'Daily loss limit reached earlier this session; new openings are blocked until the next session. Closing and reducing orders are not affected.', code: 'DAILY_LOSS_LIMIT_REACHED', category: 'local_validation', execution_confirmed: false, filled_qty: 0 }) }], isError: true };
        // Transform quantity to qty for API compatibility
        const requestData = {
          symbol: args.symbol,
          qty: args.quantity,
          type: args.order_type,
          ...(args.client_order_id && { client_order_id: args.client_order_id }),
          ...(args.limit_price && { limit_price: args.limit_price })
        };
        const data = await callTradingBot('/orders/buy', 'POST', requestData);
	        void autoStoreSetup({ ...args, ...data }, 'buy');
        return orderResponse(data, args);
      }

      case 'place_sell_order': {
        // Transform quantity to qty for API compatibility
        const requestData = {
          symbol: args.symbol,
          qty: args.quantity,
          type: args.order_type,
          ...(args.client_order_id && { client_order_id: args.client_order_id }),
          ...(args.limit_price && { limit_price: args.limit_price })
        };
        const data = await callTradingBot('/orders/sell', 'POST', requestData);
        // Sells are position exits in this system, not entry setups — not auto-captured to
        // trade-memory (outcomes are recorded via store_trade_setup with the realized result).
        return orderResponse(data, args);
      }

      case 'place_managed_position': {
        if (typeof process !== 'undefined' && process.env.OPENPROPHET_OPENINGS_BLOCKED === '1') return { content: [{ type: 'text', text: JSON.stringify({ error: 'Daily loss limit reached earlier this session; new openings are blocked until the next session. Closing and reducing orders are not affected.', code: 'DAILY_LOSS_LIMIT_REACHED', category: 'local_validation', execution_confirmed: false, filled_qty: 0 }) }], isError: true };
        const { thesis, market_context, ...requestData } = args;
        const data = await callTradingBot('/positions/managed', 'POST', requestData);
        void autoStoreSetup({ ...args, ...data, opening_entry: true }, args.side || 'buy');
        return orderResponse(data, args);
      }

      case 'get_managed_positions': {
        // Default to ACTIVE positions only for token efficiency
        // Use status="ALL" or status="" to get all positions
        let endpoint;
        if (args.status === 'ALL' || args.status === '') {
          endpoint = '/positions/managed';
        } else if (args.status) {
          endpoint = `/positions/managed?status=${encodeURIComponent(args.status)}`;
        } else {
          // Default: only ACTIVE positions
          endpoint = '/positions/managed?status=ACTIVE';
        }

        const data = await callTradingBot(endpoint);

        // Token-efficient summary format
        if (data.count === 0) {
          return {
            content: [{type: 'text', text: JSON.stringify({count: 0, positions: []})}],
          };
        }

        // For more than 10 positions, return compact summary
        if (data.count > 10) {
          const summary = {
            count: data.count,
            summary: `${data.count} positions found. Status breakdown: ` +
              `ACTIVE: ${data.positions.filter(p => p.status === 'ACTIVE').length}, ` +
              `PENDING: ${data.positions.filter(p => p.status === 'PENDING').length}, ` +
              `PARTIAL: ${data.positions.filter(p => p.status === 'PARTIAL').length}, ` +
              `CLOSED: ${data.positions.filter(p => p.status === 'CLOSED').length}`,
            note: 'Full position data available, use get_managed_position(id) for details'
          };
          return {
            content: [{type: 'text', text: JSON.stringify(summary, null, 2)}],
          };
        }

        // For <=10 positions, return full data
        return {
          content: [{type: 'text', text: JSON.stringify(data, null, 2)}],
        };
      }

      case 'get_managed_position': {
        const data = await callTradingBot(`/positions/managed/${args.position_id}`);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(data, null, 2),
            },
          ],
        };
      }

      case 'close_managed_position': {
        const data = await callTradingBot(`/positions/managed/${args.position_id}`, 'DELETE');
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(data, null, 2),
            },
          ],
        };
      }

      case 'cancel_order': {
        // Read-only look at the order first so a cancelled option exit can be followed up. Never blocks the cancel.
        // The pre-read is best effort and tightly bounded (1.5 s); on a miss or timeout the cancel runs with no advisory.
        let exitOrder = null;
        try {
          const preRead = callTradingBot('/orders?status=open');
          preRead.catch(() => {});
          let timer;
          let listed;
          try {
            listed = await Promise.race([preRead, new Promise(resolve => { timer = setTimeout(() => resolve(null), 1500); })]);
          } finally {
            clearTimeout(timer);
          }
          const before = listed ? ordersFrom(listed).find(o => o.id === String(args.order_id)) : null;
          if (before && isOptionExitOrder(before)) exitOrder = before;
        } catch { /* cancel proceeds unchanged */ }
        const data = await callTradingBot(`/orders/${args.order_id}`, 'DELETE');
        if (exitOrder && data && typeof data === 'object' && !Array.isArray(data)) {
          try {
            const [ordersAfter, positions] = await Promise.all([callTradingBot('/orders?status=all'), callTradingBot('/options/positions')]);
            data.post_cancel_check = buildPostCancelCheck({ order: exitOrder, ordersResponse: ordersAfter, positions });
          } catch (checkError) {
            data.post_cancel_check = unverifiedPostCancelCheck(exitOrder.symbol, checkError.message);
          }
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(data, null, 2),
            },
          ],
        };
      }

      case 'get_quote': {
        const data = await callTradingBot(`/market/quote/${args.symbol}`);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(data, null, 2),
            },
          ],
        };
      }

      case 'get_latest_bar': {
        const data = await callTradingBot(`/market/bar/${args.symbol}`);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(data, null, 2),
            },
          ],
        };
      }

      case 'get_historical_bars': {
        const diagnostic = futureHistoricalBarsError(args.start_date, new Date().toISOString());
        if (diagnostic) return diagnostic;
        let endpoint = `/market/bars/${args.symbol}`;
        const params = new URLSearchParams();
        if (args.start_date) params.append('start', args.start_date);
        if (args.end_date) params.append('end', args.end_date);
        if (args.timeframe) params.append('timeframe', args.timeframe);
        if (params.toString()) endpoint += `?${params.toString()}`;

        const data = await callTradingBot(endpoint);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(data, null, 2),
            },
          ],
        };
      }

      case 'get_news': {
        const limit = args.limit || 20;
        const data = await callTradingBot(`/news?limit=${limit}`);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(data, null, 2),
            },
          ],
        };
      }

      case 'get_alpaca_news': {
        const symbols = Array.isArray(args.symbols) ? args.symbols : [];
        const params = new URLSearchParams();
        if (symbols.length > 0) params.append('symbols', symbols.join(','));
        if (args.hours !== undefined) params.append('hours', args.hours);
        if (args.limit !== undefined) params.append('limit', args.limit);
        if (args.page_token) params.append('page_token', args.page_token);
        const data = await callTradingBot(`/news/alpaca?${params.toString()}`, 'GET', null, { returnAvailability: true });
        // compact JSON on purpose: keep a full page well under the runtime's inline output cap
        return { content: [{ type: 'text', text: JSON.stringify(data) }] };
      }

      case 'get_news_by_topic': {
        // Use compact mode to reduce token usage
        const data = await callTradingBot(`/news/topic/${args.topic}?compact=true`);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(data, null, 2),
            },
          ],
        };
      }

      case 'search_news': {
        const limit = args.limit || 20;
        const data = await callTradingBot(`/news/search?q=${encodeURIComponent(args.query)}&limit=${limit}`);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(data, null, 2),
            },
          ],
        };
      }

      case 'get_market_news': {
        const endpoint = args.symbols
          ? `/news/market?symbols=${encodeURIComponent(args.symbols)}`
          : '/news/market';
        const data = await callTradingBot(endpoint);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(data, null, 2),
            },
          ],
        };
      }

      case 'aggregate_and_summarize_news': {
        const { topics = [], symbols = [], max_articles = 10 } = args;
        const allNews = [];

        // Fetch news from topics
        for (const topic of topics) {
          try {
            const data = await callTradingBot(`/news/topic/${topic}`);
            const articles = data.news.slice(0, max_articles);
            allNews.push(...articles.map(a => ({ ...a, source_type: `topic:${topic}` })));
          } catch (error) {
            console.error(`Error fetching topic ${topic}:`, error.message);
          }
        }

        // Fetch news for symbols
        for (const symbol of symbols) {
          try {
            const data = await callTradingBot(`/news/search?q=${encodeURIComponent(symbol)}&limit=${max_articles}`);
            const articles = data.news.slice(0, max_articles);
            allNews.push(...articles.map(a => ({ ...a, source_type: `symbol:${symbol}` })));
          } catch (error) {
            console.error(`Error fetching symbol ${symbol}:`, error.message);
          }
        }

        if (allNews.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: 'No news articles found to summarize.',
              },
            ],
          };
        }

        // Prepare news for Gemini
        const newsText = allNews.map((article, i) =>
          `[${i + 1}] ${article.title}\nSource: ${article.source || 'Unknown'} (${article.source_type})\nPublished: ${article.pub_date}\nDescription: ${article.description?.replace(/<[^>]*>/g, '').substring(0, 200) || 'N/A'}\n`
        ).join('\n');

        // Generate summary with Gemini
        const prompt = `You are a financial news analyst. Below are ${allNews.length} news articles from various sources.

Please provide:
1. A concise executive summary (2-3 paragraphs)
2. Key market themes and trends identified
3. Notable stock mentions and sentiment
4. Any actionable insights for traders

News articles:
${newsText}

Provide a well-structured analysis that a trader could use to make informed decisions.`;

        if (!process.env.GEMINI_API_KEY) {
          return { content: [{ type: 'text', text: JSON.stringify({ status: 'unavailable', category: 'configuration_required', error: 'AI provider configuration is required', retryable: false }) }], isError: true };
        }
        let result;
        try {
          result = await model.generateContent(prompt);
        } catch {
          return { content: [{ type: 'text', text: JSON.stringify({ status: 'unavailable', category: 'provider_unavailable', error: 'AI provider is unavailable', retryable: true }) }], isError: true };
        }
        const summary = result.response.text();

        // Save summary to file
        const timestamp = new Date().toISOString().replace(/:/g, '-').split('.')[0];
        const filename = `news_summary_${timestamp}.md`;
        const filepath = path.join(SUMMARIES_DIR, filename);

        const fileContent = `# News Summary - ${new Date().toLocaleString()}

## Sources
- Topics: ${topics.join(', ') || 'None'}
- Symbols: ${symbols.join(', ') || 'None'}
- Total Articles: ${allNews.length}

---

${summary}

---

## Articles Analyzed

${allNews.map((article, i) =>
  `### [${i + 1}] ${article.title}
- **Source**: ${article.source || 'Unknown'} (${article.source_type})
- **Published**: ${article.pub_date}
- **Link**: ${article.link}
`).join('\n')}
`;

        await fs.writeFile(filepath, fileContent, 'utf-8');

        return {
          content: [
            {
              type: 'text',
              text: `Summary generated and saved to: ${filename}\n\n${summary}`,
            },
          ],
        };
      }

      case 'list_news_summaries': {
        const files = await fs.readdir(SUMMARIES_DIR);
        const summaryFiles = files.filter(f => f.endsWith('.md'));
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ summaries: summaryFiles, count: summaryFiles.length }, null, 2),
            },
          ],
        };
      }

      case 'get_news_summary': {
        // Sanitize filename — prevent path traversal
        const safeName = path.basename(args.filename);
        const filepath = path.join(SUMMARIES_DIR, safeName);
        const summaryFile = await readNewsSummaryFile(fs, filepath, safeName);
        if (!summaryFile.found) {
          return { content: [{ type: 'text', text: JSON.stringify(summaryFile.result) }] };
        }
        const content = summaryFile.content;
        return {
          content: [
            {
              type: 'text',
              text: content,
            },
          ],
        };
      }

      case 'get_marketwatch_topstories': {
        const data = await callTradingBot('/news/marketwatch/topstories');
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(data, null, 2),
            },
          ],
        };
      }

      case 'get_marketwatch_realtime': {
        const data = await callTradingBot('/news/marketwatch/realtime');
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(data, null, 2),
            },
          ],
        };
      }

      case 'get_marketwatch_bulletins': {
        const data = await callTradingBot('/news/marketwatch/bulletins');
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(data, null, 2),
            },
          ],
        };
      }

      case 'get_marketwatch_marketpulse': {
        const data = await callTradingBot('/news/marketwatch/marketpulse');
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(data, null, 2),
            },
          ],
        };
      }

      case 'get_marketwatch_all': {
        const data = await callTradingBot('/news/marketwatch/all');
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(data, null, 2),
            },
          ],
        };
      }

      // ── Economic Intelligence Feeds ──────────────────────────────────────
      case 'get_treasury_data': {
        const data = await callTradingBot('/feeds/treasury', 'GET', null, { returnAvailability: true });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }
      case 'get_global_events': {
        let endpoint = '/feeds/gdelt';
        if (args.query) endpoint += `?q=${encodeURIComponent(args.query)}`;
        const data = await callTradingBot(endpoint, 'GET', null, { returnAvailability: true });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }
      case 'get_economic_indicators': {
        const data = await callTradingBot('/feeds/bls', 'GET', null, { returnAvailability: true });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }
      case 'get_market_snapshot': {
        const data = await callTradingBot('/feeds/yfinance', 'GET', null, { returnAvailability: true });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }
      case 'get_defense_contracts': {
        const data = await callTradingBot('/feeds/usaspending', 'GET', null, { returnAvailability: true });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }
      case 'get_global_trade_flows': {
        const data = await callTradingBot('/feeds/comtrade', 'GET', null, { returnAvailability: true });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }

      case 'get_quick_market_intelligence': {
        const data = await callTradingBot('/intelligence/quick-market', 'GET', null, { returnAvailability: true });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(data, null, 2),
            },
          ],
        };
      }

      case 'analyze_stocks': {
        const data = await callTradingBot('/intelligence/analyze-multiple', 'POST', args);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(data, null, 2),
            },
          ],
        };
      }

      case 'get_cleaned_news': {
        const requestBody = {
          include_google: args.include_google,
          include_marketwatch: args.include_marketwatch,
          google_topics: args.google_topics || [],
          symbols: args.symbols || [],
          max_articles_per_source: args.max_articles_per_source || 10,
        };
        const data = await callTradingBot('/intelligence/cleaned-news', 'POST', requestBody);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(data, null, 2),
            },
          ],
        };
      }

      case 'log_activity': {
        const data = await callTradingBot('/activity/log', 'POST', {
          type: args.type,
          action: args.action,
          symbol: args.symbol || '',
          reasoning: args.reasoning || '',
          details: args.details || {},
        });
        return {
          content: [
            {
              type: 'text',
              text: `Activity logged: ${args.action}`,
            },
          ],
        };
      }

      case 'get_activity_log': {
        const data = await callTradingBot('/activity/current');
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(data, null, 2),
            },
          ],
        };
      }

      case 'log_decision': {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `${timestamp}_${safeDecisionFilenameComponent(args.action)}${args.symbol ? '_' + safeDecisionFilenameComponent(args.symbol) : ''}.json`;
        const filepath = path.join(DECISIONS_DIR, filename);

        const decision = {
          timestamp: new Date().toISOString(),
          sandbox_id: OPENPROPHET_SANDBOX_ID,
          account_id: OPENPROPHET_ACCOUNT_ID,
          action: args.action,
          symbol: args.symbol || null,
          reasoning: args.reasoning,
          market_data: args.market_data || {},
        };

        await fs.writeFile(filepath, JSON.stringify(decision, null, 2));

        return {
          content: [
            {
              type: 'text',
              text: `Decision logged to ${filename}`,
            },
          ],
        };
      }

      case 'place_options_order': {
        // OP2's standalone AlphaDesk guard accepts 1-10 contracts per opening order; say so before calling the backend.
        if (isOpeningIntent(args.position_intent) && Number(args.quantity) > 10) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: `AlphaDesk-guarded openings are limited to 1-10 contracts per order. This proposal asked for ${args.quantity}. Re-size within your rules (see the sizing rule); do not split one intent into several orders.`, category: 'local_validation', max_quantity: 10, execution_confirmed: false, filled_qty: 0 }) }],
            isError: true,
          };
        }
        // Opening-range backstop. The minimum comes only from the harness environment (set for the news-catalyst
        // strategy from its own range length); it is never read from tool arguments. Reducing orders are unaffected.
        if (isOpeningIntent(args.position_intent)) {
          if (typeof process !== 'undefined' && process.env.OPENPROPHET_OPENINGS_BLOCKED === '1') return { content: [{ type: 'text', text: JSON.stringify({ error: 'Daily loss limit reached earlier this session; new openings are blocked until the next session. Closing and reducing orders are not affected.', code: 'DAILY_LOSS_LIMIT_REACHED', category: 'local_validation', execution_confirmed: false, filled_qty: 0 }) }], isError: true };
          const minOpening = parseMinOpeningMinutes(process.env.OPENPROPHET_MIN_OPENING_MINUTES);
          if (minOpening > 0) {
            let fields = sessionFields(null, null);
            try { const calendar = await callTradingBot('/calendar'); fields = sessionFields(calendar?.clock, calendar?.sessions); } catch { /* unavailable clock refuses the opening */ }
            const gate = openingGateDecision(minOpening, fields);
            if (!gate.allowed) {
              return {
                content: [{ type: 'text', text: JSON.stringify({ error: gate.message, code: 'OPENING_RANGE_NOT_COMPLETE', category: 'local_validation', minimum_minutes_after_open: minOpening, minutes_since_open: gate.minutes_since_open, execution_confirmed: false, filled_qty: 0 }) }],
                isError: true,
              };
            }
          }
        }
        if (args.limit_price !== undefined) {
          try { args.limit_price = normalizeOptionLimitPrice(args.limit_price, args.side); }
          catch (priceError) { return { content: [{ type: 'text', text: JSON.stringify({ error: priceError.message, category: 'local_validation', execution_confirmed: false, filled_qty: 0 }) }], isError: true }; }
        }
        // The cap confirmation is taken here, after every other local check, and travels with the order: the backend refuses the
        // opening if the enforced cap changed after this point (a concurrent save or a failed rollback).
        let capRevision;
        if (isOpeningIntent(args.position_intent)) {
          capRevision = await capSyncRevision();
          if (capRevision === null) return { content: [{ type: 'text', text: JSON.stringify({ error: 'OP2 cannot confirm that its entry spread cap matches the saved setting right now, so new options openings are refused until it is confirmed (checked at every opening). Closing and reducing orders are not affected.', code: 'OPTION_SPREAD_CAP_UNRESOLVED', category: 'local_validation', execution_confirmed: false, filled_qty: 0 }) }], isError: true };
        }
        const requestData = {
          ...(args.client_order_id && { client_order_id: args.client_order_id }),
          symbol: args.symbol,
          underlying: args.underlying,
          qty: args.quantity,
          side: args.side,
          type: args.order_type,
          position_intent: args.position_intent,
          ...(args.limit_price !== undefined && { limit_price: args.limit_price }),
          ...(args.market_scanner_features && { market_scanner_features: args.market_scanner_features }),
          ...(capRevision !== undefined && { cap_revision: capRevision })
        };
        const data = await callTradingBot('/options/order', 'POST', requestData);
        if (isOpeningIntent(args.position_intent)) void autoStoreSetup({ ...args, ...data }, args.side || 'buy');
        return orderResponse(data, args);
      }

      case 'withdraw_planned_intent': {
        const clientOrderID = String(args.client_order_id || '').trim();
        if (!clientOrderID) {
          return { content: [{ type: 'text', text: JSON.stringify({ status: 'validation_error', error: 'client_order_id is required' }) }] };
        }
        const data = await callTradingBot(`/orders/planned-intents/${encodeURIComponent(clientOrderID)}`, 'DELETE');
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }

      case 'get_options_assessment_policy': {
        const data = await callTradingBot('/options/assessment-policy');
        // AlphaDesk's standalone assessment no longer caps position size; do not hand agents a stale figure.
        const shown = data && typeof data === 'object' && !Array.isArray(data) ? { ...data } : data;
        if (shown && typeof shown === 'object') {
          for (const key of ['max_investment_per_candidate', 'maximum_contracts_per_candidate']) {
            if (key in shown) shown[key] = 'not_a_limit';
          }
          shown.position_size = 'Governed by OP2 account limits (max position, max deployed, open positions, daily loss), not by AlphaDesk.';
        }
        return { content: [{ type: 'text', text: JSON.stringify(shown, null, 2) }] };
      }

      case 'assess_options_trade': {
        if (args.limit_price !== undefined) {
          try { args.limit_price = normalizeOptionLimitPrice(args.limit_price, 'buy'); }
          catch (priceError) { return { content: [{ type: 'text', text: JSON.stringify({ error: priceError.message, category: 'local_validation', execution_confirmed: false, filled_qty: 0 }) }], isError: true }; }
        }
        const { legs, quantity, limit_price, client_reference } = args;
        const data = await callTradingBot('/options/trade-assessment', 'POST', {
          legs, quantity, limit_price, ...(client_reference === undefined ? {} : {client_reference}),
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }

      case 'assess_options_strategy': {
        if (args.limit_price !== undefined) {
          try { args.limit_price = normalizeOptionLimitPrice(args.limit_price, args.side); }
          catch (priceError) { return { content: [{ type: 'text', text: JSON.stringify({ error: priceError.message, category: 'local_validation', execution_confirmed: false, filled_qty: 0 }) }], isError: true }; }
        }
        const data = await callTradingBot('/options/assessment', 'POST', { symbol: args.symbol, underlying: args.underlying, qty: args.quantity, side: args.side, position_intent: args.position_intent, type: args.order_type, time_in_force: args.time_in_force, ...(args.limit_price !== undefined && {limit_price: args.limit_price}), ...(args.strategy_type && {strategy_type: args.strategy_type}), ...(args.legs && {legs: args.legs}), ...(args.max_loss !== undefined && {max_loss: args.max_loss}), ...(args.greeks && {greeks: args.greeks}), ...(args.market_evidence_at && {market_evidence_at: args.market_evidence_at}), ...(args.observed_at && {observed_at: args.observed_at}), ...(args.expires_at && {expires_at: args.expires_at}), ...(args.market_scanner_features && {market_scanner_features: args.market_scanner_features}) }, { returnValidation: true });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }

      case 'get_options_positions': {
        const data = await callTradingBot('/options/positions');
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(data, null, 2),
            },
          ],
        };
      }

      case 'get_options_position': {
        const data = await callTradingBot(`/options/position/${args.symbol}`);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(data, null, 2),
            },
          ],
        };
      }

      case 'get_options_chain': {
        let endpoint = `/options/chain/${args.symbol}`;
        const params = new URLSearchParams();

        if (args.expiration) params.append('expiration', args.expiration);
        if (args.delta_min !== undefined) params.append('delta_min', args.delta_min);
        if (args.delta_max !== undefined) params.append('delta_max', args.delta_max);
        if (args.min_bid !== undefined) params.append('min_bid', args.min_bid);
        if (args.max_cost !== undefined) params.append('max_cost', args.max_cost);
        if (args.type) params.append('type', args.type);

        if (params.toString()) endpoint += `?${params.toString()}`;

        const data = await callTradingBot(endpoint, 'GET', null, { returnAvailability: true });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(data, null, 2),
            },
          ],
        };
      }

      case 'get_daily_features': {
        const symbols = Array.isArray(args.symbols) ? args.symbols : [];
        // The backend takes at most 25 symbols per request. Longer lists are split into batches of 25 and merged here,
        // so an agent never meets that limit (Herald hit it 12 times on Nov 12-13).
        const unique = [];
        const seenSymbols = new Set();
        for (const raw of symbols) {
          const name = String(raw).trim();
          if (name && !seenSymbols.has(name.toUpperCase())) { seenSymbols.add(name.toUpperCase()); unique.push(name); }
        }
        if (unique.length > 25) {
          const parts = [];
          for (let start = 0; start < unique.length; start += 25) {
            const batch = unique.slice(start, start + 25);
            try { parts.push({ batch, data: await callTradingBot(`/market/daily-features?symbols=${encodeURIComponent(batch.join(','))}`) }); }
            catch (error) { parts.push({ batch, error: error.message }); }
          }
          const base = parts.find(part => Array.isArray(part.data?.features))?.data || {};
          const features = [];
          for (const part of parts) {
            if (Array.isArray(part.data?.features)) features.push(...part.data.features);
            else for (const symbol of part.batch) features.push({ symbol, error: `daily features batch failed: ${part.error || 'unreadable reply'}` });
          }
          return { content: [{ type: 'text', text: JSON.stringify({ ...base, features, count: features.length, batches: parts.length }) }] };
        }
        const data = await callTradingBot(`/market/daily-features?symbols=${encodeURIComponent(symbols.join(','))}`);
        // Compact JSON on purpose: a 25-symbol reply with indentation can exceed the runtime's inline
        // output cap (about 50 KB), which sends the agent to a helper to read a spilled file.
        return { content: [{ type: 'text', text: JSON.stringify(data) }] };
      }

      case 'get_option_expirations': {
        const params = new URLSearchParams();
        if (args.min_dte !== undefined) params.append('min_dte', args.min_dte);
        if (args.max_dte !== undefined) params.append('max_dte', args.max_dte);
        const query = params.toString();
        const data = await callTradingBot(`/options/expirations/${encodeURIComponent(args.symbol)}${query ? `?${query}` : ''}`, 'GET', null, { returnAvailability: true });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }

      case 'get_earnings_dates': {
        const symbols = Array.isArray(args.symbols) ? args.symbols : [];
        const params = new URLSearchParams({ symbols: symbols.join(',') });
        if (args.days !== undefined) params.append('days', args.days);
        const data = await callTradingBot(`/market/earnings?${params.toString()}`);
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }

      case 'wait': {
        if (!Number.isFinite(args.seconds) || !Number.isInteger(args.seconds) || args.seconds < 1 || args.seconds > 30) {
          return {
            content: [{
              type: 'text',
              text: 'Wait not performed: seconds must be a finite integer from 1 to 30. For longer observation, finish the current beat and rely on the existing next heartbeat.',
            }],
          };
        }
        const seconds = args.seconds;
        const reason = args.reason || 'Waiting';

        const startTime = Date.now();
        await new Promise(resolve => setTimeout(resolve, seconds * 1000));
        const actualDuration = ((Date.now() - startTime) / 1000).toFixed(1);

        return {
          content: [
            {
              type: 'text',
              text: `Waited ${actualDuration} seconds${reason ? ` - ${reason}` : ''}`,
            },
          ],
        };
      }

      case 'get_datetime': {
        const timezone = args.timezone || 'America/New_York';
        const now = new Date();
        let brokerClock = null;
        let brokerClockError = null;
        let sessionInfo = sessionFields(null, null);
        let sessionFieldsError = null;
        try {
          // The calendar response carries the broker clock plus today's broker session times.
          const calendar = await callTradingBot('/calendar');
          brokerClock = calendar?.clock || null;
          if (!brokerClock) throw new Error('calendar response had no clock');
          sessionInfo = sessionFields(brokerClock, calendar.sessions);
        } catch (calendarError) {
          sessionFieldsError = calendarError.message;
          try {
            brokerClock = await callTradingBot('/clock');
            sessionInfo = sessionFields(brokerClock, null);
          } catch (error) {
            brokerClockError = error.message;
          }
        }

        try {
          // Time formatting
          const timeString = now.toLocaleTimeString('en-US', {
            timeZone: timezone,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: true,
          });

          const time24 = now.toLocaleTimeString('en-US', {
            timeZone: timezone,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
          });

          // Date formatting
          const dateString = now.toLocaleDateString('en-US', {
            timeZone: timezone,
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
          });

          const isoDate = now.toLocaleDateString('en-CA', { timeZone: timezone }); // YYYY-MM-DD format

          const dayOfWeek = now.toLocaleDateString('en-US', {
            timeZone: timezone,
            weekday: 'long',
          });

          // Session status below comes from the broker clock. The local date is retained
          // only for human-readable context and must not authorize execution.
          const marketDayOfWeek = now.toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'long' });
          const marketDay = marketDayOfWeek !== 'Saturday' && marketDayOfWeek !== 'Sunday';

          // US market holidays (NYSE observed) — 2025-2027
          const marketHolidays = [
            // 2025
            '2025-01-01', '2025-01-20', '2025-02-17', '2025-04-18',
            '2025-05-26', '2025-06-19', '2025-07-04', '2025-09-01',
            '2025-11-27', '2025-12-25',
            // 2026
            '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03',
            '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07',
            '2026-11-26', '2026-12-25',
            // 2027
            '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26',
            '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06',
            '2027-11-25', '2027-12-24',
          ];
          const isHoliday = marketHolidays.includes(isoDate);

          // Market status is broker-authoritative. The local weekday/holiday values below
          // are retained only as context and never authorize an order.
          const brokerIsOpen = brokerClock?.is_open ?? brokerClock?.IsOpen;
          let marketStatus = 'BROKER_CLOCK_UNAVAILABLE';
          if (brokerClock) marketStatus = brokerIsOpen ? 'OPEN' : 'CLOSED';

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  time: timeString,
                  time_24h: time24,
                  date: dateString,
                  iso_date: isoDate,
                  day_of_week: dayOfWeek,
                  timezone: timezone,
                  iso: now.toISOString(),
                  iso_utc: now.toISOString(),
                  unix: Math.floor(now.getTime() / 1000),
                  is_weekday: marketDay,
                  local_is_market_holiday_estimate: isHoliday,
                  market_status: marketStatus,
                  markets_open_today: brokerClock ? Boolean(brokerIsOpen) : null,
                  market_status_source: brokerClock ? 'alpaca_clock' : 'unavailable',
                  session_time_et: sessionInfo.session_time_et,
                  session_open_et: sessionInfo.session_open_et,
                  session_close_et: sessionInfo.session_close_et,
                  minutes_since_open: sessionInfo.minutes_since_open,
                  minutes_to_close: sessionInfo.minutes_to_close,
                  session_fields_error: sessionFieldsError,
                  broker_clock: brokerClock,
                  broker_clock_error: brokerClockError,
                }, null, 2),
              },
            ],
          };
        } catch (error) {
          return {
            content: [{ type: 'text', text: `Error: Invalid timezone "${timezone}"` }],
            isError: true,
          };
        }
      }

      // Vector DB: Find similar trading setups
      case 'find_similar_setups': {
        const { query, limit = 5, symbol, strategy, action } = args;

        const filters = {};
        if (symbol) filters.symbol = symbol;
        if (strategy) filters.strategy = strategy;
        if (action) filters.action = action;

        const similarTrades = await findSimilarTrades(query, limit, filters);

        // Format results for display
        const formattedResults = similarTrades.map((trade, i) => {
          const resultStr = trade.result_pct !== null
            ? `${trade.result_pct > 0 ? '+' : ''}${trade.result_pct.toFixed(1)}% ($${trade.result_dollars > 0 ? '+' : ''}${trade.result_dollars})`
            : 'No result data';

          return `
${i + 1}. ${trade.symbol} ${trade.action} - ${trade.strategy}
   Date: ${trade.date}
   Result: ${resultStr}
   Similarity: ${(trade.similarity * 100).toFixed(1)}%

   Reasoning: ${trade.reasoning}

   Market Context: ${trade.market_context}
   `;
        }).join('\n---\n');

        const summary = `Found ${similarTrades.length} similar ${strategy ? strategy + ' ' : ''}trades${symbol ? ' for ' + symbol : ''}:\n\n${formattedResults}`;

        return {
          content: [{ type: 'text', text: summary }],
        };
      }

      // Vector DB: Store trade setup
      case 'store_trade_setup': {
        const { symbol, action, strategy, result_pct, result_dollars, reasoning, market_context } = args;

        const now = new Date();
        const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD
        const id = `${dateStr}-${symbol}-${action}-${now.getTime()}`;
        const decision_file = `manual_${id}.json`;

        const trade = {
          id,
          decision_file,
          symbol,
          action,
          strategy,
          result_pct: result_pct ?? null,
          result_dollars: result_dollars ?? null,
          date: dateStr,
          reasoning,
          market_context,
        };

        await storeTrade(trade);

        const totalEmbeddings = getEmbeddingCount();

        return {
          content: [{
            type: 'text',
            text: `✅ Stored trade: ${symbol} ${action} (${strategy})
Result: ${result_pct !== null ? (result_pct > 0 ? '+' : '') + result_pct.toFixed(1) + '%' : 'pending'}
Total embeddings in database: ${totalEmbeddings}

You can now use find_similar_setups to find trades similar to this one.`,
          }],
        };
      }

      // Vector DB: Get trade statistics
      case 'get_trade_stats': {
        const { symbol, strategy, action } = args;

        const filters = {};
        if (symbol) filters.symbol = symbol;
        if (strategy) filters.strategy = strategy;
        if (action) filters.action = action;

        const stats = getTradeStats(filters);

        const filterDesc = [];
        if (symbol) filterDesc.push(`Symbol: ${symbol}`);
        if (strategy) filterDesc.push(`Strategy: ${strategy}`);
        if (action) filterDesc.push(`Action: ${action}`);

        const filterStr = filterDesc.length > 0 ? ` (${filterDesc.join(', ')})` : '';

        const statsText = `
📊 Trade Statistics${filterStr}

Total Trades: ${stats.count} (${stats.resolved} resolved, ${stats.pending} pending)
Winners: ${stats.winners} (${stats.win_rate.toFixed(1)}% of resolved)
Losers: ${stats.losers}

Average Result: ${stats.avg_result_pct >= 0 ? '+' : ''}${stats.avg_result_pct.toFixed(1)}% ($${stats.avg_result_dollars >= 0 ? '+' : ''}${stats.avg_result_dollars.toFixed(0)})

Best Trade: +${stats.best_result_pct.toFixed(1)}% ($${stats.best_result_dollars > 0 ? '+' : ''}${stats.best_result_dollars.toFixed(0)})
Worst Trade: ${stats.worst_result_pct.toFixed(1)}% ($${stats.worst_result_dollars.toFixed(0)})
`;

        return {
          content: [{ type: 'text', text: statsText }],
        };
      }

      // ── Agent Self-Modification Tools ──────────────────────────
      case 'update_agent_prompt': {
        const { prompt } = args;
        const configResp2 = await agentAxios.get(`${AGENT_URL}/api/sandboxes/${OPENPROPHET_SANDBOX_ID}/config`);
        const agentId = configResp2.data?.agent?.id || 'default';
        await agentAxios.put(`${AGENT_URL}/api/agents/${agentId}`, {
          systemPromptTemplate: 'custom',
          customSystemPrompt: prompt,
        });
        await agentAxios.put(`${AGENT_URL}/api/sandboxes/${OPENPROPHET_SANDBOX_ID}/agent/overrides`, {
          systemPromptTemplate: null,
          customSystemPrompt: null,
        });
        return {
          content: [{ type: 'text', text: `Updated agent "${agentId}" prompt (${prompt.length} chars). Visible on Agents page. Takes effect next heartbeat.` }],
        };
      }

      case 'update_strategy_rules': {
        const { name: strategyName, rules } = args;
        const createResp = await agentAxios.post(`${AGENT_URL}/api/strategies`, {
          name: strategyName || 'Agent-Created Strategy',
          description: `Created by agent at ${new Date().toISOString()}`,
          customRules: rules,
        });
        const newStrategy = createResp.data.strategy;
        const configResp3 = await agentAxios.get(`${AGENT_URL}/api/sandboxes/${OPENPROPHET_SANDBOX_ID}/config`);
        const agentId3 = configResp3.data?.agent?.id || 'default';
        await agentAxios.put(`${AGENT_URL}/api/agents/${agentId3}`, { strategyId: newStrategy.id });
        await agentAxios.put(`${AGENT_URL}/api/sandboxes/${OPENPROPHET_SANDBOX_ID}/strategy-rules`, { rules: '' });
        return {
          content: [{ type: 'text', text: `Created new strategy "${strategyName}" (ID: ${newStrategy.id}) and assigned to agent "${agentId3}". Visible on Agents page. Existing strategies not modified.` }],
        };
      }

      case 'get_session_context': {
        const params = new URLSearchParams({
          accountId: SESSION_CONTEXT_ACCOUNT_ID,
          sessions: String(args?.sessions || 5),
          messages: String(args?.messages || 8),
        });
        const resp = await agentAxios.get(`${AGENT_URL}/api/chats/context?${params.toString()}`, { timeout: 5000 });
        return { content: [{ type: 'text', text: JSON.stringify(resp.data?.context || [], null, 2) }] };
      }

      case 'list_sandboxes': {
        const resp = await agentAxios.get(`${AGENT_URL}/api/sandboxes`);
        const sandboxes = Array.isArray(resp.data?.sandboxes) ? resp.data.sandboxes : [];
        const result = sandboxes.map(sandbox => ({
          sandboxId: sandbox.id,
          name: sandbox.name,
          accountId: sandbox.accountId,
          accountName: sandbox.accountName || sandbox.account?.name || sandbox.name || null,
          activeAgentId: sandbox.agent?.activeAgentId || sandbox.activeAgentId || null,
          agentName: sandbox.agent?.name || null,
          model: sandbox.agent?.model || null,
          running: Boolean(sandbox.runtime?.running),
          paused: Boolean(sandbox.runtime?.paused),
        }));
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'get_agent_config': {
        const [configResp, permResp, hbResp, sandboxResp] = await Promise.all([
          agentAxios.get(`${AGENT_URL}/api/config`),
          agentAxios.get(`${AGENT_URL}/api/permissions`, { params: AGENT_QUERY }),
          agentAxios.get(`${AGENT_URL}/api/heartbeat`, { params: AGENT_QUERY }),
          agentAxios.get(`${AGENT_URL}/api/sandboxes/${OPENPROPHET_SANDBOX_ID}/config`),
        ]);
        const config = configResp.data;
        const sandbox = sandboxResp.data.sandbox || config.sandboxes?.[OPENPROPHET_SANDBOX_ID] || null;
        const activeAgent = sandboxResp.data.agent || null;
        const activeModel = activeAgent?.model || sandbox?.agent?.model || config.activeModel;
        const result = {
          activeAgent: activeAgent ? {
            id: activeAgent.id,
            name: activeAgent.name,
            model: activeAgent.model,
            promptType: activeAgent.systemPromptTemplate,
            strategyId: activeAgent.strategyId ?? null,
            customStrategyRules: Boolean(activeAgent.customStrategyRules),
          } : null,
          activeModel,
          permissions: permResp.data,
          heartbeat: hbResp.data,
          sandboxId: OPENPROPHET_SANDBOX_ID,
          accountId: OPENPROPHET_ACCOUNT_ID,
          accountCount: config.accounts?.length || 0,
          strategyCount: config.strategies?.length || 0,
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'set_heartbeat': {
        const seconds = Math.min(Math.max(Number(args.seconds), 30), 14400);
        await agentAxios.post(`${AGENT_URL}/api/agent/heartbeat`, {
          seconds,
          force: Boolean(args.force),
          agentRequest: true,
          sandboxId: OPENPROPHET_SANDBOX_ID,
          reason: args.reason,
        });
        return {
          content: [{ type: 'text', text: `Heartbeat interval set to ${seconds}s. ${args.reason || ''}` }],
        };
      }

      case 'update_permissions': {
        if (OPENPROPHET_ROLE !== 'operator') {
          throw new Error('permission updates require the operator role');
        }
        if (!AGENT_AUTH_TOKEN) {
          throw new Error('operator authorization is unavailable');
        }
        await agentAxios.put(`${AGENT_URL}/api/permissions`, {
          ...args,
          sandboxId: OPENPROPHET_SANDBOX_ID,
        });
        return {
          content: [{ type: 'text', text: `Updated permissions: ${Object.keys(args).join(', ')}. Changes take effect immediately.` }],
        };
      }

      case 'get_heartbeat_profiles': {
        const resp = await agentAxios.get(`${AGENT_URL}/api/heartbeat/profiles`);
        const profiles = resp.data.profiles || {};
        let msg = 'Available heartbeat profiles:\n';
        for (const [key, p] of Object.entries(profiles)) {
          msg += `\n${key}: ${p.label}\n  ${p.description}\n  Phases: ${JSON.stringify(p.phases)}\n`;
        }
        return { content: [{ type: 'text', text: msg }] };
      }

      case 'apply_heartbeat_profile': {
        const { profile } = args;
        await agentAxios.post(`${AGENT_URL}/api/heartbeat/apply-profile`, {
          profile,
          sandboxId: OPENPROPHET_SANDBOX_ID,
          agentRequest: true,
        });
        return {
          content: [{ type: 'text', text: `Applied heartbeat profile "${profile}". Changes take effect on next heartbeat.` }],
        };
      }

      case 'get_heartbeat_phases': {
        const resp = await agentAxios.get(`${AGENT_URL}/api/heartbeat/phases`);
        const phases = resp.data.phases || {};
        let msg = 'Heartbeat phase time ranges (minutes from midnight ET):\n';
        for (const [key, p] of Object.entries(phases)) {
          msg += `\n${key}: ${p.label}\n  ${p.start !== null ? `${p.start}-${p.end}` : 'N/A (closed)'}\n`;
        }
        return { content: [{ type: 'text', text: msg }] };
      }

      case 'update_heartbeat_phase': {
        const { phase, start, end } = args;
        const authorization = await authorizeAndUpdateHeartbeatPhase({
          role: OPENPROPHET_ROLE,
          operatorToken: OPERATOR_TOKEN,
          getHeartbeatIntervalsForced: async () => {
            const resp = await agentAxios.get(`${AGENT_URL}/api/sandboxes/${OPENPROPHET_SANDBOX_ID}/config`);
            return resp.data?.sandbox?.heartbeat?.forceHeartbeatIntervals === true;
          },
          update: () => agentAxios.put(`${AGENT_URL}/api/heartbeat/phases`, {
            phase,
            start,
            end,
          }),
        });
        if (!authorization.ok) {
          return {
            content: [{ type: 'text', text: JSON.stringify(authorization) }],
            isError: true,
          };
        }
        return {
          content: [{ type: 'text', text: `Updated phase "${phase}" time range. Changes take effect immediately.` }],
        };
      }

      case 'set_session_mode': {
        const { mode } = args;
        if (mode !== 'continuous' && mode !== 'fresh') {
          return { content: [{ type: 'text', text: 'Invalid mode. Use "continuous" or "fresh".' }], isError: true };
        }
        await agentAxios.put(`${AGENT_URL}/api/sandboxes/${OPENPROPHET_SANDBOX_ID}/agent/overrides`, {
          sessionMode: mode,
        });
        const msg = mode === 'fresh' 
          ? 'Session mode set to "fresh" - each heartbeat will start with a fresh context. Good for long_horizon strategies.'
          : 'Session mode set to "continuous" - conversation context persists across heartbeats.';
        return { content: [{ type: 'text', text: msg }] };
      }

      case 'create_agent': {
        const { name: agentName, description, model, strategyId, customSystemPrompt } = args;
        const body = {
          name: agentName,
          description: description || '',
          model: model || 'anthropic/claude-sonnet-4-6',
          strategyId: strategyId || undefined,
          systemPromptTemplate: customSystemPrompt ? 'custom' : 'default',
          customSystemPrompt: customSystemPrompt || '',
        };
        const resp = await agentAxios.post(`${AGENT_URL}/api/agents`, body);
        const agent = resp.data.agent;
        return {
          content: [{ type: 'text', text: `Created agent "${agentName}" (ID: ${agent.id}). You can now assign it to a sandbox with assign_agent_to_sandbox.` }],
        };
      }

      case 'create_strategy': {
        const { name: stratName, description, customRules } = args;
        const body = {
          name: stratName,
          description: description || '',
          customRules: customRules,
        };
        const resp = await agentAxios.post(`${AGENT_URL}/api/strategies`, body);
        const strategy = resp.data.strategy;
        return {
          content: [{ type: 'text', text: `Created strategy "${stratName}" (ID: ${strategy.id}). Assign it to an agent by updating the agent's strategyId, or use the UI.` }],
        };
      }

      case 'assign_agent_to_sandbox': {
        const { agentId, sandboxId } = args;
        const targetSandbox = sandboxId || OPENPROPHET_SANDBOX_ID;
        await agentAxios.put(`${AGENT_URL}/api/sandboxes/${targetSandbox}/agent`, {
          activeAgentId: agentId,
        });
        return {
          content: [{ type: 'text', text: `Assigned agent "${agentId}" to sandbox "${targetSandbox}". The agent will take over on the next heartbeat.` }],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const diagnostics = error?.diagnostics;
    return {
      content: [
        {
          type: 'text',
          text: diagnostics ? JSON.stringify({ error: error.message, diagnostics }) : `Error: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('OpenProphet MCP Server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
