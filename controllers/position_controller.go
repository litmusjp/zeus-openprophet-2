package controllers

import (
	"errors"
	"net/http"
	"prophet-trader/services"

	"github.com/gin-gonic/gin"
)

// PositionManagementController handles managed position operations
type PositionManagementController struct {
	positionManager *services.PositionManager
}

// NewPositionManagementController creates a new position management controller
func NewPositionManagementController(positionManager *services.PositionManager) *PositionManagementController {
	return &PositionManagementController{
		positionManager: positionManager,
	}
}

// HandlePlaceManagedPosition handles placing a new managed position
// POST /api/v1/positions/managed
func (pmc *PositionManagementController) HandlePlaceManagedPosition(c *gin.Context) {
	var req services.PlaceManagedPositionRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"error":   "Invalid request",
			"details": err.Error(),
		})
		return
	}

	position, err := pmc.positionManager.PlaceManagedPosition(c.Request.Context(), &req)
	if err != nil {
		var requestErr *services.ManagedRequestError
		if errors.As(err, &requestErr) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_managed_position_request", "category": "invalid_request", "details": requestErr.Error(), "retryable": false})
			return
		}
		var availabilityErr *services.ManagedAvailabilityError
		if errors.As(err, &availabilityErr) {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "managed_position_unavailable", "category": "market_data_unavailable", "details": availabilityErr.Error(), "retryable": true})
			return
		}
		if services.IsSubmissionUncertain(err) {
			c.JSON(http.StatusConflict, gin.H{"error": "managed_submission_uncertain", "category": "submission_uncertain", "details": err.Error(), "retryable": false})
			return
		}
		var marketClosed *services.MarketClosedError
		if errors.As(err, &marketClosed) {
			body := gin.H{"status": "market_closed", "error": "market_closed", "category": "market_closed", "client_order_id": req.ClientOrderID, "details": marketClosed.Error(), "retryable": false}
			if !marketClosed.NextOpen.IsZero() {
				body["next_eligible_at"] = marketClosed.NextOpen
			}
			c.JSON(http.StatusConflict, body)
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": "managed_position_failed", "category": "internal_error", "details": err.Error(), "retryable": false,
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"message":  "Managed position created successfully",
		"position": position,
	})
}

// HandleGetManagedPosition retrieves a specific managed position
// GET /api/v1/positions/managed/:id
func (pmc *PositionManagementController) HandleGetManagedPosition(c *gin.Context) {
	positionID := c.Param("id")
	if positionID == "" {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "position ID required",
		})
		return
	}

	position, err := pmc.positionManager.GetManagedPosition(positionID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{
			"error":   "Position not found",
			"details": err.Error(),
		})
		return
	}

	c.JSON(http.StatusOK, position)
}

// HandleListManagedPositions lists all managed positions
// GET /api/v1/positions/managed?status=ACTIVE
func (pmc *PositionManagementController) HandleListManagedPositions(c *gin.Context) {
	status := c.Query("status")

	positions := pmc.positionManager.ListManagedPositions(status)

	c.JSON(http.StatusOK, gin.H{
		"count":     len(positions),
		"positions": positions,
	})
}

// HandleCloseManagedPosition manually closes a managed position
// DELETE /api/v1/positions/managed/:id
func (pmc *PositionManagementController) HandleCloseManagedPosition(c *gin.Context) {
	positionID := c.Param("id")
	if positionID == "" {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "position ID required",
		})
		return
	}

	capability, capErr := pmc.positionManager.OperatorPositionCloseCapability(c.GetHeader("X-OpenProphet-Operator-Token"))
	if capErr != nil {
		c.JSON(http.StatusForbidden, gin.H{"error": capErr.Error()})
		return
	}
	if err := pmc.positionManager.CloseManagedPositionWithCapability(c.Request.Context(), positionID, capability); err != nil {
		var notFound *services.ManagedPositionNotFoundError
		if errors.As(err, &notFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "managed_position_not_found", "category": "not_found", "position_id": notFound.PositionID, "retryable": false})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{
			"error":   "Failed to close position",
			"details": err.Error(),
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"message": "Position closed successfully",
	})
}
