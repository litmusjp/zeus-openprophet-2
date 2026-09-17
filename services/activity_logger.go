package services

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/sirupsen/logrus"
)

// ActivityLogger logs all AI trading activities to files and database
type ActivityLogger struct {
	logger     *logrus.Logger
	logDir     string
	currentLog *DailyActivityLog
}

// DailyActivityLog represents a day's worth of trading activity
type DailyActivityLog struct {
	Date              string              `json:"date"`
	SessionStart      time.Time           `json:"session_start"`
	SessionEnd        time.Time           `json:"session_end,omitempty"`
	Summary           SessionSummary      `json:"summary"`
	Activities        []Activity          `json:"activities"`
	PositionsOpened   []PositionActivity  `json:"positions_opened"`
	PositionsClosed   []PositionActivity  `json:"positions_closed"`
	MarketIntelligence []IntelligenceNote `json:"market_intelligence"`
	Decisions         []DecisionLog       `json:"decisions"`
}

// SessionSummary provides high-level stats for the session
type SessionSummary struct {
	TotalTrades       int     `json:"total_trades"`
	PositionsOpened   int     `json:"positions_opened"`
	PositionsClosed   int     `json:"positions_closed"`
	WinningTrades     int     `json:"winning_trades"`
	LosingTrades      int     `json:"losing_trades"`
	TotalPnL          float64 `json:"total_pnl"`
	TotalPnLPercent   float64 `json:"total_pnl_percent"`
	LargestWin        float64 `json:"largest_win"`
	LargestLoss       float64 `json:"largest_loss"`
	StartingCapital   float64 `json:"starting_capital"`
	EndingCapital     float64 `json:"ending_capital"`
	CapitalDeployed   float64 `json:"capital_deployed"`
	ActivePositions   int     `json:"active_positions"`
	StocksAnalyzed    int     `json:"stocks_analyzed"`
	NewsArticlesRead  int     `json:"news_articles_read"`
	WebSearches       int     `json:"web_searches"`
}

// Activity represents a single action taken by the AI
type Activity struct {
	Timestamp   time.Time              `json:"timestamp"`
	Type        string                 `json:"type"` // POSITION_OPENED, POSITION_CLOSED, ANALYSIS, INTELLIGENCE, DECISION
	Action      string                 `json:"action"`
	Symbol      string                 `json:"symbol,omitempty"`
	Details     map[string]interface{} `json:"details"`
	Reasoning   string                 `json:"reasoning,omitempty"`
}

// PositionActivity represents opening or closing a position
type PositionActivity struct {
	Timestamp        time.Time `json:"timestamp"`
	Symbol           string    `json:"symbol"`
	Side             string    `json:"side"`
	Quantity         float64   `json:"quantity"`
	EntryPrice       float64   `json:"entry_price"`
	ExitPrice        float64   `json:"exit_price,omitempty"`
	AllocationDollar float64   `json:"allocation_dollars"`
	StopLoss         float64   `json:"stop_loss"`
	TakeProfit       float64   `json:"take_profit"`
	PnL              float64   `json:"pnl,omitempty"`
	PnLPercent       float64   `json:"pnl_percent,omitempty"`
	HoldDays         int       `json:"hold_days,omitempty"`
	Reasoning        string    `json:"reasoning"`
	Tags             []string  `json:"tags,omitempty"`
	Conviction       int       `json:"conviction"`
}

// IntelligenceNote represents market intelligence gathered
type IntelligenceNote struct {
	Timestamp time.Time `json:"timestamp"`
	Source    string    `json:"source"` // NEWS, WEBSEARCH, MARKET_DATA, ANALYSIS
	Topic     string    `json:"topic"`
	Summary   string    `json:"summary"`
	Symbols   []string  `json:"symbols,omitempty"`
}

// DecisionLog represents a trading decision (buy, sell, hold, pass)
type DecisionLog struct {
	Timestamp   time.Time              `json:"timestamp"`
	Action      string                 `json:"action"` // BUY, SELL, HOLD, PASS
	Symbol      string                 `json:"symbol"`
	Reasoning   string                 `json:"reasoning"`
	Conviction  int                    `json:"conviction"`
	MarketData  map[string]interface{} `json:"market_data,omitempty"`
}

// NewActivityLogger creates a new activity logger
func NewActivityLogger(logDir string) *ActivityLogger {
	logger := logrus.New()
	logger.SetFormatter(&logrus.JSONFormatter{})

	// Ensure log directory exists
	if err := os.MkdirAll(logDir, 0755); err != nil {
		logger.WithError(err).Error("Failed to create activity log directory")
	}

	return &ActivityLogger{
		logger: logger,
		logDir: logDir,
	}
}

// StartSession initializes a new trading session for the day
func (al *ActivityLogger) StartSession(ctx context.Context, startingCapital float64) error {
	date := time.Now().Format("2006-01-02")

	al.currentLog = &DailyActivityLog{
		Date:         date,
		SessionStart: time.Now(),
		Summary: SessionSummary{
			StartingCapital: startingCapital,
		},
		Activities:        make([]Activity, 0),
		PositionsOpened:   make([]PositionActivity, 0),
		PositionsClosed:   make([]PositionActivity, 0),
		MarketIntelligence: make([]IntelligenceNote, 0),
		Decisions:         make([]DecisionLog, 0),
	}

	al.logger.WithFields(logrus.Fields{
		"date":             date,
		"starting_capital": startingCapital,
	}).Info("Trading session started")

	return al.saveLog()
}

// EndSession closes the current trading session
func (al *ActivityLogger) EndSession(ctx context.Context, endingCapital float64, activePositions int) error {
	if al.currentLog == nil {
		return fmt.Errorf("no active session")
	}

	al.currentLog.SessionEnd = time.Now()
	al.currentLog.Summary.EndingCapital = endingCapital
	al.currentLog.Summary.ActivePositions = activePositions

	// Calculate total P&L
	if al.currentLog.Summary.StartingCapital > 0 {
		al.currentLog.Summary.TotalPnL = endingCapital - al.currentLog.Summary.StartingCapital
		al.currentLog.Summary.TotalPnLPercent = (al.currentLog.Summary.TotalPnL / al.currentLog.Summary.StartingCapital) * 100
	}

	al.logger.WithFields(logrus.Fields{
		"ending_capital": endingCapital,
		"total_pnl":      al.currentLog.Summary.TotalPnL,
		"pnl_percent":    al.currentLog.Summary.TotalPnLPercent,
	}).Info("Trading session ended")

	return al.saveLog()
}

// LogActivity logs a general activity
func (al *ActivityLogger) LogActivity(activityType, action, symbol, reasoning string, details map[string]interface{}) error {
	if al.currentLog == nil {
		return fmt.Errorf("no active session - call StartSession first")
	}

	activity := Activity{
		Timestamp: time.Now(),
		Type:      activityType,
		Action:    action,
		Symbol:    symbol,
		Details:   details,
		Reasoning: reasoning,
	}

	al.currentLog.Activities = append(al.currentLog.Activities, activity)

	al.logger.WithFields(logrus.Fields{
		"type":   activityType,
		"action": action,
		"symbol": symbol,
	}).Info("Activity logged")

	return al.saveLog()
}

// LogPositionOpened logs when a new position is opened
func (al *ActivityLogger) LogPositionOpened(symbol, side string, quantity, entryPrice, allocation, stopLoss, takeProfit float64, conviction int, reasoning string, tags []string) error {
	if al.currentLog == nil {
		return fmt.Errorf("no active session")
	}

	position := PositionActivity{
		Timestamp:        time.Now(),
		Symbol:           symbol,
		Side:             side,
		Quantity:         quantity,
		EntryPrice:       entryPrice,
		AllocationDollar: allocation,
		StopLoss:         stopLoss,
		TakeProfit:       takeProfit,
		Conviction:       conviction,
		Reasoning:        reasoning,
		Tags:             tags,
	}

	al.currentLog.PositionsOpened = append(al.currentLog.PositionsOpened, position)
	al.currentLog.Summary.PositionsOpened++
	al.currentLog.Summary.TotalTrades++
	al.currentLog.Summary.CapitalDeployed += allocation

	al.logger.WithFields(logrus.Fields{
		"symbol":     symbol,
		"allocation": allocation,
		"conviction": conviction,
	}).Info("Position opened logged")

	return al.saveLog()
}

// LogPositionClosed logs when a position is closed
func (al *ActivityLogger) LogPositionClosed(symbol, side string, quantity, entryPrice, exitPrice, allocation float64, holdDays int, reasoning string, tags []string) error {
	if al.currentLog == nil {
		return fmt.Errorf("no active session")
	}

	pnl := 0.0
	pnlPercent := 0.0

	if side == "buy" {
		pnl = (exitPrice - entryPrice) * quantity
		if entryPrice > 0 {
			pnlPercent = ((exitPrice - entryPrice) / entryPrice) * 100
		}
	} else {
		pnl = (entryPrice - exitPrice) * quantity
		if entryPrice > 0 {
			pnlPercent = ((entryPrice - exitPrice) / entryPrice) * 100
		}
	}

	position := PositionActivity{
		Timestamp:        time.Now(),
		Symbol:           symbol,
		Side:             side,
		Quantity:         quantity,
		EntryPrice:       entryPrice,
		ExitPrice:        exitPrice,
		AllocationDollar: allocation,
		PnL:              pnl,
		PnLPercent:       pnlPercent,
		HoldDays:         holdDays,
		Reasoning:        reasoning,
		Tags:             tags,
	}

	al.currentLog.PositionsClosed = append(al.currentLog.PositionsClosed, position)
	al.currentLog.Summary.PositionsClosed++

	// Update win/loss stats
	if pnl > 0 {
		al.currentLog.Summary.WinningTrades++
		if pnl > al.currentLog.Summary.LargestWin {
			al.currentLog.Summary.LargestWin = pnl
		}
	} else {
		al.currentLog.Summary.LosingTrades++
		if pnl < al.currentLog.Summary.LargestLoss {
			al.currentLog.Summary.LargestLoss = pnl
		}
	}

	al.logger.WithFields(logrus.Fields{
		"symbol":      symbol,
		"pnl":         pnl,
		"pnl_percent": pnlPercent,
		"hold_days":   holdDays,
	}).Info("Position closed logged")

	return al.saveLog()
}

// LogIntelligence logs market intelligence gathering
func (al *ActivityLogger) LogIntelligence(source, topic, summary string, symbols []string) error {
	if al.currentLog == nil {
		return fmt.Errorf("no active session")
	}

	intel := IntelligenceNote{
		Timestamp: time.Now(),
		Source:    source,
		Topic:     topic,
		Summary:   summary,
		Symbols:   symbols,
	}

	al.currentLog.MarketIntelligence = append(al.currentLog.MarketIntelligence, intel)

	// Update stats
	if source == "NEWS" {
		al.currentLog.Summary.NewsArticlesRead++
	} else if source == "WEBSEARCH" {
		al.currentLog.Summary.WebSearches++
	}

	return al.saveLog()
}

// LogDecision logs a trading decision
func (al *ActivityLogger) LogDecision(action, symbol, reasoning string, conviction int, marketData map[string]interface{}) error {
	if al.currentLog == nil {
		return fmt.Errorf("no active session")
	}

	decision := DecisionLog{
		Timestamp:  time.Now(),
		Action:     action,
		Symbol:     symbol,
		Reasoning:  reasoning,
		Conviction: conviction,
		MarketData: marketData,
	}

	al.currentLog.Decisions = append(al.currentLog.Decisions, decision)

	return al.saveLog()
}

// LogStocksAnalyzed updates the count of stocks analyzed
func (al *ActivityLogger) LogStocksAnalyzed(count int) error {
	if al.currentLog == nil {
		return fmt.Errorf("no active session")
	}

	al.currentLog.Summary.StocksAnalyzed += count

	return al.saveLog()
}

// GetCurrentLog returns the current session's log
func (al *ActivityLogger) GetCurrentLog() (*DailyActivityLog, error) {
	if al.currentLog == nil {
		return nil, fmt.Errorf("no active session")
	}
	return al.currentLog, nil
}

// GetLogForDate retrieves the log for a specific date
func (al *ActivityLogger) GetLogForDate(date string) (*DailyActivityLog, error) {
	filename := filepath.Join(al.logDir, fmt.Sprintf("activity_%s.json", date))

	data, err := os.ReadFile(filename)
	if err != nil {
		return nil, fmt.Errorf("log not found for date %s: %w", date, err)
	}

	var log DailyActivityLog
	if err := json.Unmarshal(data, &log); err != nil {
		return nil, fmt.Errorf("failed to parse log: %w", err)
	}

	return &log, nil
}

// ListAvailableLogs returns a list of all available log dates
func (al *ActivityLogger) ListAvailableLogs() ([]string, error) {
	files, err := os.ReadDir(al.logDir)
	if err != nil {
		return nil, err
	}

	dates := make([]string, 0)
	for _, file := range files {
		if !file.IsDir() && filepath.Ext(file.Name()) == ".json" {
			// Extract date from filename (activity_2025-11-17.json)
			name := file.Name()
			if len(name) > 19 && name[:9] == "activity_" {
				date := name[9 : len(name)-5]
				dates = append(dates, date)
			}
		}
	}

	return dates, nil
}

// saveLog saves the current log to disk
func (al *ActivityLogger) saveLog() error {
	if al.currentLog == nil {
		return fmt.Errorf("no active log to save")
	}

	filename := filepath.Join(al.logDir, fmt.Sprintf("activity_%s.json", al.currentLog.Date))

	data, err := json.MarshalIndent(al.currentLog, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal log: %w", err)
	}

	if err := os.WriteFile(filename, data, 0644); err != nil {
		return fmt.Errorf("failed to write log file: %w", err)
	}

	return nil
}
