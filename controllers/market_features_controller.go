package controllers

import (
	"context"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"prophet-trader/services"
)

const (
	maxFeatureSymbols  = 25
	maxEarningsSymbols = 30
	maxEarningsDays    = 30
	featureConcurrency = 6
	featureLookback    = 100 * 24 * time.Hour // ~70 trading sessions
)

var symbolPattern = regexp.MustCompile(`^[A-Z][A-Z0-9.\-]{0,5}$`)

type optionExpirationService interface {
	GetOptionExpirations(ctx context.Context, underlying string, minDTE, maxDTE int) ([]services.OptionExpiration, error)
}

var (
	earningsCalendarOnce sync.Once
	earningsCalendar     *services.EarningsCalendar
)

func sharedEarningsCalendar() *services.EarningsCalendar {
	earningsCalendarOnce.Do(func() { earningsCalendar = services.NewEarningsCalendar(nil) })
	return earningsCalendar
}

// parseSymbolList validates, upper-cases and de-duplicates a comma-separated symbol list.
func parseSymbolList(raw string, limit int) ([]string, string) {
	seen := map[string]bool{}
	var symbols []string
	for _, part := range strings.Split(raw, ",") {
		symbol := strings.ToUpper(strings.TrimSpace(part))
		if symbol == "" {
			continue
		}
		if !symbolPattern.MatchString(symbol) {
			return nil, "invalid symbol " + strconv.Quote(symbol)
		}
		if !seen[symbol] {
			seen[symbol] = true
			symbols = append(symbols, symbol)
		}
	}
	if len(symbols) == 0 {
		return nil, "symbols is required (comma-separated)"
	}
	if len(symbols) > limit {
		return nil, "at most " + strconv.Itoa(limit) + " symbols per call"
	}
	return symbols, ""
}

// HandleGetDailyFeatures returns arithmetic facts about COMPLETED daily bars for several symbols in
// one call. GET /api/v1/market/daily-features?symbols=SPY,QQQ
func (oc *OrderController) HandleGetDailyFeatures(c *gin.Context) {
	symbols, problem := parseSymbolList(c.Query("symbols"), maxFeatureSymbols)
	if problem != "" {
		c.JSON(400, gin.H{"error": problem})
		return
	}
	if oc.dataService == nil {
		c.JSON(503, gin.H{"error": "market data is unavailable in inert mode"})
		return
	}
	loc, err := time.LoadLocation("America/New_York")
	if err != nil {
		c.JSON(500, gin.H{"error": "trading timezone is unavailable"})
		return
	}
	now := time.Now()
	ctx, cancel := context.WithTimeout(c.Request.Context(), 45*time.Second)
	defer cancel()

	features := make([]services.DailyFeatures, len(symbols))
	sem := make(chan struct{}, featureConcurrency)
	var wg sync.WaitGroup
	for i, symbol := range symbols {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int, symbol string) {
			defer wg.Done()
			defer func() { <-sem }()
			bars, feed, fetchErr := historicalBarsWithFeed(ctx, oc.dataService, symbol, now.Add(-featureLookback), now, "1Day")
			if fetchErr != nil {
				features[i] = services.DailyFeatures{Symbol: symbol, Feed: feed, Error: "daily bars unavailable for this symbol"}
				return
			}
			features[i] = services.ComputeDailyFeatures(symbol, services.CompletedDailyBars(bars, now, loc), loc)
			features[i].Feed = feed
		}(i, symbol)
	}
	wg.Wait()

	c.JSON(200, gin.H{
		"status":   "available",
		"as_of":    now.UTC().Format(time.RFC3339),
		"basis":    "completed daily bars only; the session still forming is excluded; arithmetic facts, not signals. Each symbol states its feed (sip = consolidated market, iex = IEX only, whose highs, lows and volume can differ).",
		"count":    len(features),
		"features": features,
	})
}

// GetOptionExpirations lists listed expiries in a DTE window.
// GET /api/v1/options/expirations/:symbol?min_dte=14&max_dte=60
func (oc *OrderController) GetOptionExpirations(c *gin.Context) {
	symbol := strings.ToUpper(strings.TrimSpace(c.Param("symbol")))
	if !symbolPattern.MatchString(symbol) {
		c.JSON(400, gin.H{"error": "valid underlying symbol required"})
		return
	}
	minDTE, maxDTE := 1, 60
	if raw := c.Query("min_dte"); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil {
			c.JSON(400, gin.H{"error": "min_dte must be an integer"})
			return
		}
		minDTE = value
	}
	if raw := c.Query("max_dte"); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil {
			c.JSON(400, gin.H{"error": "max_dte must be an integer"})
			return
		}
		maxDTE = value
	}
	provider, ok := oc.tradingService.(optionExpirationService)
	if oc.tradingService == nil || !ok {
		c.JSON(503, gin.H{"error": "options expirations are unavailable"})
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 30*time.Second)
	defer cancel()
	expirations, err := provider.GetOptionExpirations(ctx, symbol, minDTE, maxDTE)
	if err != nil {
		if strings.Contains(err.Error(), "invalid DTE window") {
			c.JSON(400, gin.H{"error": err.Error()})
			return
		}
		oc.logger.WithFields(oc.auditIdentityFields()).WithError(err).Warn("Failed to list option expirations")
		c.JSON(503, gin.H{"status": "unavailable", "category": "provider_unavailable", "endpoint": "options_expirations", "error": "option expirations are unavailable"})
		return
	}
	c.JSON(200, gin.H{
		"status": "available", "symbol": symbol, "min_dte": minDTE, "max_dte": maxDTE,
		"count": len(expirations), "expirations": expirations,
		"note": "Dates with listed call contracts. Pass one as `expiration` to the options chain.",
	})
}

// HandleGetEarnings reports scheduled earnings dates from a public calendar.
// GET /api/v1/market/earnings?symbols=AAPL,MSFT&days=21
func (oc *OrderController) HandleGetEarnings(c *gin.Context) {
	symbols, problem := parseSymbolList(c.Query("symbols"), maxEarningsSymbols)
	if problem != "" {
		c.JSON(400, gin.H{"error": problem})
		return
	}
	days := 21
	if raw := c.Query("days"); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value < 1 || value > maxEarningsDays {
			c.JSON(400, gin.H{"error": "days must be an integer from 1 to " + strconv.Itoa(maxEarningsDays)})
			return
		}
		days = value
	}
	loc, err := time.LoadLocation("America/New_York")
	if err != nil {
		c.JSON(500, gin.H{"error": "trading timezone is unavailable"})
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 40*time.Second)
	defer cancel()
	from := time.Now().In(loc)
	c.JSON(200, sharedEarningsCalendar().Lookup(ctx, symbols, from, days))
}
