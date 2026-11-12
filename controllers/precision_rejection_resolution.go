package controllers

import (
	"context"
	"crypto/subtle"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"prophet-trader/interfaces"
	"prophet-trader/services"
)

// An operator-only, evidence-checked resolution for the specific submission_uncertain records that were created
// before OP2 recognised Alpaca's two-decimal limit price validation (HTTP 422 / 42210000) as a definite rejection.
// It never submits anything to the broker, never deletes or replays, and refuses unless every check holds.

// PrecisionResolutionRefusedError reports why a record was left unchanged.
type PrecisionResolutionRefusedError struct{ Reason string }

func (e *PrecisionResolutionRefusedError) Error() string {
	return "precision rejection resolution refused: " + e.Reason
}

// ResolvePrecisionRejectionWithCapability marks one uncertain, never-acknowledged order as rejected when the stored
// failure evidence is the exact precision validation and the broker confirms it has no such order.
func (oc *OrderController) ResolvePrecisionRejectionWithCapability(ctx context.Context, clientOrderID, capability string) (*interfaces.Order, error) {
	configured := strings.TrimSpace(configuredOperatorToken())
	provided := strings.TrimSpace(capability)
	if configured == "" || provided == "" || subtle.ConstantTimeCompare([]byte(configured), []byte(provided)) != 1 {
		return nil, fmt.Errorf("precision rejection resolution rejected: operator authorization is required")
	}
	clientOrderID = strings.TrimSpace(clientOrderID)
	if clientOrderID == "" {
		return nil, fmt.Errorf("client_order_id is required")
	}
	if oc.storageService == nil || oc.tradingService == nil {
		return nil, &PrecisionResolutionRefusedError{Reason: "storage or broker service unavailable"}
	}
	order, err := oc.storageService.GetOrderByClientOrderID(clientOrderID)
	if err != nil {
		return nil, fmt.Errorf("order lookup failed: %w", err)
	}
	if order == nil {
		return nil, &services.PlannedIntentNotFoundError{ClientOrderID: clientOrderID}
	}
	refuse := func(reason string) (*interfaces.Order, error) {
		return nil, &PrecisionResolutionRefusedError{Reason: reason}
	}
	// The record must belong to this trading backend's own account, sandbox and PAPER identity.
	reader, ok := oc.storageService.(durableIdentityReader)
	if !ok {
		return refuse("durable identity unavailable")
	}
	identity := reader.DurableIdentity()
	if identity.BrokerAccountID == "" || identity.TenantID == "" || identity.SandboxID == "" || identity.PaperLive != "paper" ||
		order.BrokerAccountID != identity.BrokerAccountID || order.TenantID != identity.TenantID ||
		order.SandboxID != identity.SandboxID || !strings.EqualFold(order.PaperLive, "paper") {
		return refuse("record identity does not match this PAPER account and sandbox")
	}
	if order.Status != "submission_uncertain" {
		return refuse(fmt.Sprintf("status is %q, not submission_uncertain", order.Status))
	}
	if strings.TrimSpace(order.ID) != "" {
		return refuse("a broker order ID is recorded")
	}
	if order.FilledQty != 0 {
		return refuse("a filled quantity is recorded")
	}
	if !services.HasPrecisionRejectionEvidence(order) {
		return refuse("stored failure evidence is not the two-decimal limit price validation (HTTP 422, code 42210000)")
	}
	brokerOrder, brokerErr := oc.tradingService.GetOrderByClientOrderID(ctx, clientOrderID)
	if brokerErr == nil && brokerOrder != nil {
		return refuse("the broker has an order with this client_order_id")
	}
	if brokerErr == nil || !services.IsOrderNotFound(brokerErr) {
		return refuse("the broker lookup did not confirm that no such order exists")
	}
	if err := services.MarkPrecisionRejected(order, "operator"); err != nil {
		return refuse(err.Error())
	}
	if err := oc.storageService.SaveOrder(order); err != nil {
		return nil, fmt.Errorf("precision rejection resolution persistence failed: %w", err)
	}
	return order, nil
}

// HandleResolvePrecisionRejection serves POST /orders/resolve-precision-rejection with {"client_order_id": "..."}.
func (oc *OrderController) HandleResolvePrecisionRejection(c *gin.Context) {
	var body struct {
		ClientOrderID string `json:"client_order_id"`
	}
	if err := c.ShouldBindJSON(&body); err != nil || strings.TrimSpace(body.ClientOrderID) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"status": "validation_error", "error": "client_order_id is required"})
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 15*time.Second)
	defer cancel()
	order, err := oc.ResolvePrecisionRejectionWithCapability(ctx, body.ClientOrderID, c.GetHeader("X-OpenProphet-Operator-Token"))
	if err != nil {
		var refused *PrecisionResolutionRefusedError
		var notFound *services.PlannedIntentNotFoundError
		switch {
		case strings.Contains(err.Error(), "authorization"):
			c.JSON(http.StatusForbidden, gin.H{"status": "forbidden", "error": err.Error()})
		case errors.As(err, &notFound):
			c.JSON(http.StatusNotFound, gin.H{"status": "not_found", "error": "order_not_found", "client_order_id": body.ClientOrderID})
		case errors.As(err, &refused):
			c.JSON(http.StatusConflict, gin.H{"status": "refused", "error": refused.Error(), "client_order_id": body.ClientOrderID})
		case strings.Contains(err.Error(), "client_order_id is required"):
			c.JSON(http.StatusBadRequest, gin.H{"status": "validation_error", "error": err.Error()})
		default:
			c.JSON(http.StatusInternalServerError, gin.H{"status": "error", "error": err.Error()})
		}
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "rejected", "client_order_id": order.ClientOrderID, "order": order})
}
