package controllers

import (
	"github.com/gin-gonic/gin"

	"prophet-trader/services"
)

// HandleGetProviderAttempts handles GET /api/v1/diagnostics/provider-attempts. It returns the cumulative number of provider HTTP
// attempts this trading backend has made through the shared provider call point (option chain pages, expiration probes, news,
// AlphaDesk), retries included. Read-only diagnostics so a research job can budget its own calls; it changes nothing.
func HandleGetProviderAttempts(c *gin.Context) {
	c.JSON(200, gin.H{
		"provider_attempts": services.ProviderAttemptCount(),
		"scope":             "this trading backend process; every attempt through the shared provider call point, retries included; traffic from other callers of this backend is counted too",
	})
}
