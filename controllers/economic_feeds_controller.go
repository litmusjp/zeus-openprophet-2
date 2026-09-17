package controllers

import (
	"net/http"
	"prophet-trader/services"

	"github.com/gin-gonic/gin"
)

// EconomicFeedsController handles economic intelligence feed requests
type EconomicFeedsController struct {
	feedsService *services.EconomicFeedsService
}

// NewEconomicFeedsController creates a new economic feeds controller
func NewEconomicFeedsController(feedsService *services.EconomicFeedsService) *EconomicFeedsController {
	return &EconomicFeedsController{
		feedsService: feedsService,
	}
}

// HandleGetTreasury fetches US Treasury data (debt, interest rates)
// GET /api/v1/feeds/treasury
func (c *EconomicFeedsController) HandleGetTreasury(ctx *gin.Context) {
	data, err := c.feedsService.GetTreasuryBriefing()
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{
			"error":   "Failed to fetch Treasury data",
			"details": err.Error(),
		})
		return
	}
	ctx.JSON(http.StatusOK, data)
}

// HandleGetGDELT fetches global news events from GDELT
// GET /api/v1/feeds/gdelt?q=tariff+economy
func (c *EconomicFeedsController) HandleGetGDELT(ctx *gin.Context) {
	query := ctx.DefaultQuery("q", "")
	data, err := c.feedsService.GetGDELTBriefing(query)
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{
			"error":   "Failed to fetch GDELT data",
			"details": err.Error(),
		})
		return
	}
	ctx.JSON(http.StatusOK, data)
}

// HandleGetBLS fetches economic indicators from BLS (CPI, unemployment, payrolls)
// GET /api/v1/feeds/bls
func (c *EconomicFeedsController) HandleGetBLS(ctx *gin.Context) {
	data, err := c.feedsService.GetBLSBriefing()
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{
			"error":   "Failed to fetch BLS data",
			"details": err.Error(),
		})
		return
	}
	ctx.JSON(http.StatusOK, data)
}

// HandleGetYFinance fetches broad market snapshot from Yahoo Finance
// GET /api/v1/feeds/yfinance
func (c *EconomicFeedsController) HandleGetYFinance(ctx *gin.Context) {
	data, err := c.feedsService.GetYFinanceBriefing()
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{
			"error":   "Failed to fetch Yahoo Finance data",
			"details": err.Error(),
		})
		return
	}
	ctx.JSON(http.StatusOK, data)
}

// HandleGetUSASpending fetches defense contract data from USAspending
// GET /api/v1/feeds/usaspending
func (c *EconomicFeedsController) HandleGetUSASpending(ctx *gin.Context) {
	data, err := c.feedsService.GetUSASpendingBriefing()
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{
			"error":   "Failed to fetch USAspending data",
			"details": err.Error(),
		})
		return
	}
	ctx.JSON(http.StatusOK, data)
}

// HandleGetComtrade fetches global trade flow data from UN Comtrade
// GET /api/v1/feeds/comtrade
func (c *EconomicFeedsController) HandleGetComtrade(ctx *gin.Context) {
	data, err := c.feedsService.GetComtradeBriefing()
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{
			"error":   "Failed to fetch Comtrade data",
			"details": err.Error(),
		})
		return
	}
	ctx.JSON(http.StatusOK, data)
}
