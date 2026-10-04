package controllers

import (
	"net/http"
	"prophet-trader/services"

	"github.com/gin-gonic/gin"
)

// ActivityController handles activity logging endpoints
type ActivityController struct {
	activityLogger *services.ActivityLogger
}

// NewActivityController creates a new activity controller
func NewActivityController(activityLogger *services.ActivityLogger) *ActivityController {
	return &ActivityController{
		activityLogger: activityLogger,
	}
}

// HandleGetCurrentActivity returns the current day's activity log
func (ac *ActivityController) HandleGetCurrentActivity(c *gin.Context) {
	log, err := ac.activityLogger.GetCurrentLog()
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, log)
}

// HandleGetActivityByDate returns activity log for a specific date
func (ac *ActivityController) HandleGetActivityByDate(c *gin.Context) {
	date := c.Param("date")

	log, err := ac.activityLogger.GetLogForDate(date)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, log)
}

// HandleListActivityLogs returns list of available activity log dates
func (ac *ActivityController) HandleListActivityLogs(c *gin.Context) {
	dates, err := ac.activityLogger.ListAvailableLogs()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"dates": dates,
		"count": len(dates),
	})
}

// HandleStartSession starts a new trading session
func (ac *ActivityController) HandleStartSession(c *gin.Context) {
	var req struct {
		StartingCapital float64 `json:"starting_capital" binding:"required"`
	}

	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request"})
		return
	}

	if err := ac.activityLogger.StartSession(c.Request.Context(), req.StartingCapital); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "Session started"})
}

// HandleEndSession ends the current trading session
func (ac *ActivityController) HandleEndSession(c *gin.Context) {
	var req struct {
		EndingCapital   float64 `json:"ending_capital" binding:"required"`
		ActivePositions int     `json:"active_positions"`
	}

	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request"})
		return
	}

	if err := ac.activityLogger.EndSession(c.Request.Context(), req.EndingCapital, req.ActivePositions); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "Session ended"})
}

// HandleLogActivity logs a general activity
func (ac *ActivityController) HandleLogActivity(c *gin.Context) {
	var req struct {
		Type      string                 `json:"type" binding:"required"`
		Action    string                 `json:"action" binding:"required"`
		Symbol    string                 `json:"symbol"`
		Reasoning string                 `json:"reasoning"`
		Details   map[string]interface{} `json:"details"`
	}

	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request"})
		return
	}

	if err := ac.activityLogger.LogActivity(req.Type, req.Action, req.Symbol, req.Reasoning, req.Details); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "Activity logged"})
}
