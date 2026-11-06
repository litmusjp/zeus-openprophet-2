package controllers

import (
	"context"
	"errors"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"

	"prophet-trader/services"
)

const (
	maxAlpacaNewsSymbols = 30
	defaultNewsHours     = 36 // AlphaDesk reads the previous 36 hours
	maxNewsHours         = 72
)

type alpacaNewsService interface {
	GetAlpacaNews(ctx context.Context, req services.AlpacaNewsRequest) (services.AlpacaNewsResult, error)
}

// HandleGetAlpacaNews returns one bounded page of Alpaca symbol-tagged news for this account.
// GET /api/v1/news/alpaca?symbols=AAPL,NVDA&hours=36&limit=20&page_token=...
func (oc *OrderController) HandleGetAlpacaNews(c *gin.Context) {
	symbols, problem := parseSymbolList(c.Query("symbols"), maxAlpacaNewsSymbols)
	if problem != "" {
		c.JSON(400, gin.H{"error": problem})
		return
	}
	hours := defaultNewsHours
	if raw := c.Query("hours"); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value < 1 || value > maxNewsHours {
			c.JSON(400, gin.H{"error": "hours must be an integer from 1 to " + strconv.Itoa(maxNewsHours)})
			return
		}
		hours = value
	}
	limit := 20
	if raw := c.Query("limit"); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value < 1 || value > 50 {
			c.JSON(400, gin.H{"error": "limit must be an integer from 1 to 50"})
			return
		}
		limit = value
	}
	provider, ok := oc.tradingService.(alpacaNewsService)
	if oc.tradingService == nil || !ok {
		c.JSON(503, gin.H{"status": "unavailable", "category": "provider_unavailable", "endpoint": "alpaca_news", "error": "Alpaca news is unavailable"})
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 12*time.Second)
	defer cancel()
	end := time.Now().UTC()
	result, err := provider.GetAlpacaNews(ctx, services.AlpacaNewsRequest{
		Symbols: symbols, Start: end.Add(-time.Duration(hours) * time.Hour), End: end, Limit: limit, PageToken: c.Query("page_token"),
	})
	if err != nil {
		var newsErr *services.AlpacaNewsError
		category := "provider_unavailable"
		if errors.As(err, &newsErr) {
			category = newsErr.Category
		}
		oc.logger.WithFields(oc.auditIdentityFields()).WithError(err).Warn("Failed to read Alpaca news")
		c.JSON(503, gin.H{"status": "unavailable", "category": category, "endpoint": "alpaca_news", "error": "Alpaca news is unavailable (" + category + ")"})
		return
	}
	c.JSON(200, result)
}
