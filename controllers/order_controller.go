package controllers

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"os"
	"prophet-trader/interfaces"
	"prophet-trader/models"
	"prophet-trader/services"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/sirupsen/logrus"
	"gorm.io/gorm"
)

func newClientOrderID() (string, error) {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}

	return "op-" + hex.EncodeToString(bytes), nil
}

func applyOrderResult(order *interfaces.Order, result *interfaces.OrderResult) {
	if order == nil || result == nil {
		return
	}
	if result.OrderID != "" {
		order.ID = result.OrderID
	}
	order.Status = result.Status
	if result.FilledQty >= order.FilledQty {
		order.FilledQty = result.FilledQty
		if result.FilledAvgPrice != nil || result.FilledQty == 0 {
			order.FilledAvgPrice = result.FilledAvgPrice
		}
	}
	order.NextEligibleAt = result.NextEligibleAt
	order.BrokerAccountID = result.BrokerAccountID
	order.PaperLive = result.PaperLive
	order.TenantID = result.TenantID
	order.SandboxID = result.SandboxID
}

func validateBrokerResultForConsumer(result *interfaces.OrderResult, order *interfaces.Order) error {
	if order == nil {
		return fmt.Errorf("submitted order is required for broker-result validation")
	}
	if err := services.ValidateOrderResultIdentity(result, order.ClientOrderID, order.Symbol, order.Side, order.Qty, order.Type, order.TimeInForce, order.LimitPrice, order.StopPrice, order.PositionIntent, order.Purpose); err != nil {
		return err
	}
	return services.ValidateOrderResultIdentityForExecution(result, models.DurableIdentity{BrokerAccountID: order.BrokerAccountID, PaperLive: order.PaperLive, TenantID: order.TenantID, SandboxID: order.SandboxID})
}

func brokerOrderMatchesLocal(local, broker *interfaces.Order) bool {
	if local == nil || broker == nil || broker.ID == "" {
		return false
	}
	if local.ClientOrderID != "" && broker.ClientOrderID != local.ClientOrderID {
		return false
	}
	if local.Symbol != broker.Symbol || local.Side != broker.Side || local.Type != broker.Type || local.TimeInForce != broker.TimeInForce {
		return false
	}
	if local.Qty <= 0 || broker.Qty <= 0 || local.Qty != broker.Qty {
		return false
	}
	if local.AssetClass == "us_option" && (broker.AssetClass != "us_option" || local.PositionIntent != broker.PositionIntent) {
		return false
	}
	return broker.ID != ""
}

// OrderController handles trading operations
type OrderController struct {
	tradingService   interfaces.TradingService
	dataService      interfaces.DataService
	storageService   interfaces.StorageService
	logger           *logrus.Logger
	executionMu      sync.RWMutex
	executionBlocked bool
	optionsIntentMu  sync.Mutex
	submissionMu     sync.Mutex
}

// NewOrderController creates a new order controller
func NewOrderController(
	trading interfaces.TradingService,
	data interfaces.DataService,
	storage interfaces.StorageService,
) *OrderController {
	logger := logrus.New()
	logger.SetFormatter(&logrus.TextFormatter{
		FullTimestamp: true,
	})

	oc := &OrderController{
		tradingService: trading,
		dataService:    data,
		storageService: storage,
		logger:         logger,
	}
	if markerService, ok := trading.(interface{ SetSubmissionMarker(func(string) error) }); ok && storage != nil {
		markerService.SetSubmissionMarker(func(clientOrderID string) error {
			order, err := storage.GetOrderByClientOrderID(clientOrderID)
			if err != nil {
				return err
			}
			if order == nil {
				return fmt.Errorf("submission intent %q is not durable", clientOrderID)
			}
			order.SubmissionAttempted = true
			return storage.SaveOrder(order)
		})
	}
	return oc
}

func (oc *OrderController) SetExecutionBlocked(blocked bool) {
	oc.executionMu.Lock()
	oc.executionBlocked = blocked
	oc.executionMu.Unlock()
}

func (oc *OrderController) ExecutionBlocked() bool {
	oc.executionMu.RLock()
	defer oc.executionMu.RUnlock()
	return oc.executionBlocked
}

func (oc *OrderController) rejectIfExecutionBlocked(c *gin.Context) bool {
	if !oc.ExecutionBlocked() {
		return false
	}
	c.JSON(503, gin.H{"error": "trading execution is blocked while persisted order state is unresolved"})
	return true
}

// ReconcileOpenOrders repairs local orders whose submission result was ambiguous.
func (oc *OrderController) ReconcileOpenOrders(ctx context.Context) (reconciled int, skipped int) {
	if oc.tradingService == nil {
		oc.logger.Warn("Reconcile: trading service unavailable, skipping")
		return 0, 0
	}

	orders, err := oc.storageService.GetOrdersNeedingReconciliation()
	if err != nil {
		oc.logger.WithError(err).Error("Reconcile: failed to load orders needing reconciliation")
		return 0, 1
	}

	for _, order := range orders {
		var broker *interfaces.Order
		var brokerErr error
		if strings.TrimSpace(order.ClientOrderID) == "" {
			if strings.TrimSpace(order.ID) == "" {
				oc.logger.WithField("symbol", order.Symbol).Error("Reconcile: unresolved order has neither client nor broker identity")
				order.Status = "orphaned_unreconciled"
				if saveErr := oc.storageService.SaveOrder(order); saveErr != nil {
					oc.logger.WithError(saveErr).Error("Reconcile: failed to quarantine identity-less order")
				}
				skipped++
				continue
			}
			broker, brokerErr = oc.tradingService.GetOrder(ctx, order.ID)
		} else {
			broker, brokerErr = oc.tradingService.GetOrderByClientOrderID(ctx, order.ClientOrderID)
		}
		if brokerErr != nil {
			oc.logger.WithError(brokerErr).WithFields(logrus.Fields{"client_order_id": order.ClientOrderID, "order_id": order.ID}).
				Info("Reconcile: order not confirmed at broker, leaving as-is")
			skipped++
			continue
		}
		if broker == nil {
			oc.logger.WithField("client_order_id", order.ClientOrderID).
				Info("Reconcile: broker returned no order, leaving as-is")
			skipped++
			continue
		}
		if err := services.ValidateBrokerOrderState(broker, order.Qty); err != nil {
			oc.logger.WithError(err).WithField("client_order_id", order.ClientOrderID).Error("Reconcile: invalid broker order state")
			order.Status = "submission_uncertain"
			_ = oc.storageService.SaveOrder(order)
			skipped++
			continue
		}
		if !brokerOrderMatchesLocal(order, broker) {
			order.Status = "submission_uncertain"
			if saveErr := oc.storageService.SaveOrder(order); saveErr != nil {
				oc.logger.WithError(saveErr).WithField("client_order_id", order.ClientOrderID).Warn("Reconcile: failed to persist identity mismatch")
			}
			oc.logger.WithField("client_order_id", order.ClientOrderID).Warn("Reconcile: broker order identity mismatch; refusing to apply")
			skipped++
			continue
		}

		order.ID = broker.ID
		if order.ClientOrderID == "" {
			order.ClientOrderID = broker.ClientOrderID
		}
		order.Status = broker.Status
		order.FilledQty = broker.FilledQty
		order.FilledAvgPrice = broker.FilledAvgPrice
		order.FilledAt = broker.FilledAt
		order.CanceledAt = broker.CanceledAt
		if err := oc.storageService.SaveOrder(order); err != nil {
			oc.logger.WithError(err).WithField("client_order_id", order.ClientOrderID).
				Warn("Reconcile: failed to save confirmed broker order")
			skipped++
			continue
		}

		reconciled++
	}

	oc.logger.WithFields(logrus.Fields{
		"reconciled": reconciled,
		"skipped":    skipped,
		"total":      len(orders),
	}).Info("Reconcile: startup order reconciliation complete")

	return reconciled, skipped
}

// BuyRequest represents a buy order request
type BuyRequest struct {
	Symbol        string   `json:"symbol" binding:"required"`
	Qty           float64  `json:"qty" binding:"required,gt=0"`
	Type          string   `json:"type"`          // "market", "limit", "stop", "stop_limit"
	TimeInForce   string   `json:"time_in_force"` // "day", "gtc", "ioc", "fok"
	LimitPrice    *float64 `json:"limit_price,omitempty"`
	StopPrice     *float64 `json:"stop_price,omitempty"`
	ClientOrderID string   `json:"client_order_id,omitempty"`
}

// SellRequest represents a sell order request
type SellRequest struct {
	Symbol        string   `json:"symbol" binding:"required"`
	Qty           float64  `json:"qty" binding:"required,gt=0"`
	Type          string   `json:"type"`          // "market", "limit", "stop", "stop_limit"
	TimeInForce   string   `json:"time_in_force"` // "day", "gtc", "ioc", "fok"
	LimitPrice    *float64 `json:"limit_price,omitempty"`
	StopPrice     *float64 `json:"stop_price,omitempty"`
	ClientOrderID string   `json:"client_order_id,omitempty"`
}

func sameOrderPrice(left, right *float64) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return math.Abs(*left-*right) <= 1e-9
}

func orderRequestMatches(existing, requested *interfaces.Order) bool {
	return existing != nil && requested != nil &&
		existing.Symbol == requested.Symbol && existing.Side == requested.Side &&
		math.Abs(existing.Qty-requested.Qty) <= 1e-9 && existing.Type == requested.Type &&
		existing.TimeInForce == requested.TimeInForce && sameOrderPrice(existing.LimitPrice, requested.LimitPrice) &&
		sameOrderPrice(existing.StopPrice, requested.StopPrice) && existing.AssetClass == requested.AssetClass &&
		existing.Underlying == requested.Underlying && existing.PositionIntent == requested.PositionIntent &&
		existing.Purpose == requested.Purpose
}

func (oc *OrderController) prepareClientOrderID(ctx context.Context, clientOrderID string, requested *interfaces.Order) error {
	if strings.TrimSpace(clientOrderID) == "" {
		return fmt.Errorf("client order ID is required")
	}
	existing, err := oc.storageService.GetOrderByClientOrderID(clientOrderID)
	if err != nil {
		return fmt.Errorf("cannot verify client order identity: %w", err)
	}
	if existing == nil {
		return nil
	}
	if !orderRequestMatches(existing, requested) {
		return fmt.Errorf("client order ID %q is already bound to a different order request", clientOrderID)
	}
	brokerOrder, brokerErr := oc.tradingService.GetOrderByClientOrderID(ctx, clientOrderID)
	if brokerErr == nil && brokerOrder != nil {
		return fmt.Errorf("client order ID %q is already broker-visible; reconcile it before retrying", clientOrderID)
	}
	if brokerErr != nil && !services.IsOrderNotFound(brokerErr) {
		return &services.SubmissionUncertainError{Err: fmt.Errorf("client order identity %q could not be reconciled: %w", clientOrderID, brokerErr)}
	}
	status := strings.ToLower(existing.Status)
	if status != "planned_for_next_session" {
		return fmt.Errorf("client order ID %q is not retryable after broker submission attempt; reconcile the existing identity instead", clientOrderID)
	}
	if existing.ExpiresAt != nil && !existing.ExpiresAt.After(time.Now()) {
		return fmt.Errorf("client order ID %q planned intent has expired", clientOrderID)
	}
	return nil
}

func (oc *OrderController) persistPlannedOrder(order *interfaces.Order, closedErr *services.MarketClosedError) error {
	if closedErr == nil || closedErr.NextOpen.IsZero() {
		return fmt.Errorf("broker did not provide a next eligible session")
	}
	nextOpen := closedErr.NextOpen
	expires := nextOpen.Add(24 * time.Hour)
	if order.Purpose == "entry" && order.LimitPrice == nil && order.StopPrice == nil {
		order.Status = "rejected_before_submission"
		if saveErr := oc.storageService.SaveOrder(order); saveErr != nil {
			return &services.SubmissionUncertainError{Err: fmt.Errorf("unbounded market intent rejection persistence failed: %w", saveErr)}
		}
		return &services.PreSubmissionRejectionError{Err: fmt.Errorf("opening market intent cannot be planned without a bounded executable price")}
	}
	order.Status = "planned_for_next_session"
	order.NextEligibleAt = &nextOpen
	order.ExpiresAt = &expires
	return oc.storageService.SaveOrder(order)
}

func (oc *OrderController) plannedOrderResult(order *interfaces.Order, closedErr *services.MarketClosedError) *interfaces.OrderResult {
	return &interfaces.OrderResult{
		BrokerAccountID: order.BrokerAccountID,
		PaperLive:       order.PaperLive,
		TenantID:        order.TenantID,
		SandboxID:       order.SandboxID,
		Status:          "planned_for_next_session",
		Message:         closedErr.Error(),
		ClientOrderID:   order.ClientOrderID,
		Symbol:          order.Symbol,
		Side:            order.Side,
		Qty:             order.Qty,
		Type:            order.Type,
		TimeInForce:     order.TimeInForce,
		NextEligibleAt:  order.NextEligibleAt,
	}
}

func (oc *OrderController) refreshOrderRevision(order *interfaces.Order) error {
	if order == nil || strings.TrimSpace(order.ClientOrderID) == "" {
		return fmt.Errorf("order identity is required")
	}
	persisted, err := oc.storageService.GetOrderByClientOrderID(order.ClientOrderID)
	if err != nil {
		return err
	}
	if persisted == nil {
		return fmt.Errorf("order %q is not durable", order.ClientOrderID)
	}
	order.Revision = persisted.Revision
	order.SubmissionAttempted = persisted.SubmissionAttempted
	return nil
}

func (oc *OrderController) Buy(ctx context.Context, req BuyRequest) (*interfaces.OrderResult, error) {
	oc.submissionMu.Lock()
	defer oc.submissionMu.Unlock()
	if oc.ExecutionBlocked() {
		return nil, fmt.Errorf("execution is blocked pending startup/order reconciliation")
	}
	// Set defaults
	if req.Type == "" {
		req.Type = "market"
	}
	if req.TimeInForce == "" {
		req.TimeInForce = "day"
	}

	oc.logger.WithFields(logrus.Fields{
		"symbol": req.Symbol,
		"qty":    req.Qty,
		"type":   req.Type,
	}).Info("Processing buy order")

	clientOrderID := strings.TrimSpace(req.ClientOrderID)
	if clientOrderID == "" {
		return nil, fmt.Errorf("client_order_id is required; retries must reuse the original identity")
	}
	if err := oc.prepareClientOrderID(ctx, clientOrderID, &interfaces.Order{
		Symbol: req.Symbol, Qty: req.Qty, Side: "buy", Type: req.Type, TimeInForce: req.TimeInForce,
		LimitPrice: req.LimitPrice, StopPrice: req.StopPrice, Purpose: "entry",
	}); err != nil {
		return nil, err
	}
	order := &interfaces.Order{
		ClientOrderID: clientOrderID,
		Symbol:        req.Symbol,
		Qty:           req.Qty,
		Side:          "buy",
		Type:          req.Type,
		TimeInForce:   req.TimeInForce,
		LimitPrice:    req.LimitPrice,
		StopPrice:     req.StopPrice,
		Status:        "pending",
		Purpose:       "entry",
		SubmittedAt:   time.Now(),
	}
	if identityReader, ok := oc.storageService.(durableIdentityReader); ok {
		identity := identityReader.DurableIdentity()
		order.BrokerAccountID, order.PaperLive, order.TenantID, order.SandboxID = identity.BrokerAccountID, identity.PaperLive, identity.TenantID, identity.SandboxID
	}
	if existing, lookupErr := oc.storageService.GetOrderByClientOrderID(clientOrderID); lookupErr != nil {
		return nil, fmt.Errorf("cannot reload client order identity: %w", lookupErr)
	} else if existing != nil {
		order.Revision = existing.Revision
	}
	if err := oc.storageService.SaveOrder(order); err != nil {
		oc.logger.WithError(err).Error("Failed to persist buy order intent")
		return nil, err
	}

	result, err := oc.tradingService.PlaceOrder(ctx, order)
	if refreshErr := oc.refreshOrderRevision(order); refreshErr != nil {
		return nil, &services.SubmissionUncertainError{Err: fmt.Errorf("buy order state could not be reloaded after submission attempt: %w", refreshErr)}
	}
	if err != nil {
		var closedErr *services.MarketClosedError
		if errors.As(err, &closedErr) {
			if planErr := oc.persistPlannedOrder(order, closedErr); planErr != nil {
				return nil, &services.SubmissionUncertainError{Err: fmt.Errorf("closed-session intent persistence failed: %w", planErr)}
			}
			return oc.plannedOrderResult(order, closedErr), nil
		}
		if services.IsPreSubmissionRejection(err) {
			order.Status = "rejected_before_submission"
		} else {
			order.Status = "submit_failed"
		}
		if services.IsSubmissionUncertain(err) {
			order.Status = "submission_uncertain"
		}
		if saveErr := oc.storageService.SaveOrder(order); saveErr != nil {
			oc.logger.WithError(saveErr).Warn("Failed to record buy order submission failure")
		}
		oc.logger.WithError(err).Error("Failed to place buy order")
		return nil, err
	}

	if err := validateBrokerResultForConsumer(result, order); err != nil {
		order.Status = "submission_uncertain"
		if saveErr := oc.storageService.SaveOrder(order); saveErr != nil {
			oc.logger.WithError(saveErr).Warn("Failed to record uncertain broker result")
		}
		return nil, err
	}
	applyOrderResult(order, result)
	if err := oc.storageService.SaveOrder(order); err != nil {
		order.Status = "submission_uncertain"
		oc.logger.WithError(err).Error("Failed to persist buy order after broker submission")
		return nil, &services.SubmissionUncertainError{Err: fmt.Errorf("buy order persistence is unresolved: %w", err)}
	}

	oc.logger.WithField("orderID", result.OrderID).Info("Buy order placed successfully")
	return result, nil
}

// Sell executes a sell order
func (oc *OrderController) Sell(ctx context.Context, req SellRequest) (*interfaces.OrderResult, error) {
	oc.submissionMu.Lock()
	defer oc.submissionMu.Unlock()
	if oc.ExecutionBlocked() {
		return nil, fmt.Errorf("execution is blocked pending startup/order reconciliation")
	}
	// Set defaults
	if req.Type == "" {
		req.Type = "market"
	}
	if req.TimeInForce == "" {
		req.TimeInForce = "day"
	}

	oc.logger.WithFields(logrus.Fields{
		"symbol": req.Symbol,
		"qty":    req.Qty,
		"type":   req.Type,
	}).Info("Processing sell order")

	clientOrderID := strings.TrimSpace(req.ClientOrderID)
	if clientOrderID == "" {
		return nil, fmt.Errorf("client_order_id is required; retries must reuse the original identity")
	}
	if err := oc.prepareClientOrderID(ctx, clientOrderID, &interfaces.Order{
		Symbol: req.Symbol, Qty: req.Qty, Side: "sell", Type: req.Type, TimeInForce: req.TimeInForce,
		LimitPrice: req.LimitPrice, StopPrice: req.StopPrice, Purpose: "close",
	}); err != nil {
		return nil, err
	}

	order := &interfaces.Order{
		ClientOrderID: clientOrderID,
		Symbol:        req.Symbol,
		Qty:           req.Qty,
		Side:          "sell",
		Type:          req.Type,
		TimeInForce:   req.TimeInForce,
		LimitPrice:    req.LimitPrice,
		StopPrice:     req.StopPrice,
		Status:        "pending",
		Purpose:       "close",
		SubmittedAt:   time.Now(),
	}
	if identityReader, ok := oc.storageService.(durableIdentityReader); ok {
		identity := identityReader.DurableIdentity()
		order.BrokerAccountID, order.PaperLive, order.TenantID, order.SandboxID = identity.BrokerAccountID, identity.PaperLive, identity.TenantID, identity.SandboxID
	}
	// A retry is a lifecycle update to the durable intent, not a new order.
	// Reload the complete server-owned row after identity preparation so its
	// revision and planned-session lifecycle cannot be replaced by zero values.
	if existing, lookupErr := oc.storageService.GetOrderByClientOrderID(clientOrderID); lookupErr != nil {
		return nil, fmt.Errorf("cannot reload client order identity: %w", lookupErr)
	} else if existing != nil {
		if !orderRequestMatches(existing, order) {
			return nil, fmt.Errorf("client order ID %q is already bound to a different order request", clientOrderID)
		}
		order = existing
	}

	if err := oc.storageService.SaveOrder(order); err != nil {
		oc.logger.WithError(err).Error("Failed to persist sell order intent")
		return nil, err
	}

	result, err := oc.tradingService.PlaceOrder(ctx, order)
	if refreshErr := oc.refreshOrderRevision(order); refreshErr != nil {
		return nil, &services.SubmissionUncertainError{Err: fmt.Errorf("sell order state could not be reloaded after submission attempt: %w", refreshErr)}
	}
	if err != nil {
		var closedErr *services.MarketClosedError
		if errors.As(err, &closedErr) {
			if planErr := oc.persistPlannedOrder(order, closedErr); planErr != nil {
				return nil, &services.SubmissionUncertainError{Err: fmt.Errorf("closed-session intent persistence failed: %w", planErr)}
			}
			return oc.plannedOrderResult(order, closedErr), nil
		}
		if services.IsPreSubmissionRejection(err) {
			order.Status = "rejected_before_submission"
		} else {
			order.Status = "submit_failed"
		}
		if services.IsSubmissionUncertain(err) {
			order.Status = "submission_uncertain"
		}
		if saveErr := oc.storageService.SaveOrder(order); saveErr != nil {
			oc.logger.WithError(saveErr).Warn("Failed to record sell order submission failure")
		}
		oc.logger.WithError(err).Error("Failed to place sell order")
		return nil, err
	}

	if err := validateBrokerResultForConsumer(result, order); err != nil {
		order.Status = "submission_uncertain"
		if saveErr := oc.storageService.SaveOrder(order); saveErr != nil {
			oc.logger.WithError(saveErr).Warn("Failed to record uncertain broker result")
		}
		return nil, err
	}
	applyOrderResult(order, result)
	if err := oc.storageService.SaveOrder(order); err != nil {
		order.Status = "submission_uncertain"
		oc.logger.WithError(err).Error("Failed to persist sell order after broker submission")
		return nil, &services.SubmissionUncertainError{Err: fmt.Errorf("sell order persistence is unresolved: %w", err)}
	}

	oc.logger.WithField("orderID", result.OrderID).Info("Sell order placed successfully")
	return result, nil
}

// QuickBuy executes a simple market buy order
func (oc *OrderController) QuickBuy(symbol string, qty float64) (*interfaces.OrderResult, error) {
	if oc.ExecutionBlocked() {
		return nil, fmt.Errorf("execution is blocked pending startup/order reconciliation")
	}
	return oc.Buy(context.Background(), BuyRequest{
		Symbol: symbol,
		Qty:    qty,
		Type:   "market",
	})
}

// QuickSell executes a simple market sell order
func (oc *OrderController) QuickSell(symbol string, qty float64) (*interfaces.OrderResult, error) {
	if oc.ExecutionBlocked() {
		return nil, fmt.Errorf("execution is blocked pending startup/order reconciliation")
	}
	return oc.Sell(context.Background(), SellRequest{
		Symbol: symbol,
		Qty:    qty,
		Type:   "market",
	})
}

// CancelOrder cancels an existing order
// CancelOrder requires the server-owned operator capability. Internal risk
// management cancels through the trading service directly and never uses this
// externally exposed controller boundary.
func (oc *OrderController) CancelOrder(orderID string) error {
	return fmt.Errorf("cancel rejected: operator authorization is required")
}

func (oc *OrderController) CancelOrderWithCapability(orderID, capability string) error {
	configured := strings.TrimSpace(configuredOperatorToken())
	provided := strings.TrimSpace(capability)
	if configured == "" || provided == "" || subtle.ConstantTimeCompare([]byte(configured), []byte(provided)) != 1 {
		return fmt.Errorf("cancel rejected: operator authorization is required")
	}
	return oc.cancelOrder(orderID)
}

// WithdrawPlannedIntentWithCapability changes only the durable local intent.
// It deliberately never consults or calls the broker.
func (oc *OrderController) WithdrawPlannedIntentWithCapability(clientOrderID, capability string) (*interfaces.Order, error) {
	configured := strings.TrimSpace(configuredOperatorToken())
	provided := strings.TrimSpace(capability)
	if configured == "" || provided == "" || subtle.ConstantTimeCompare([]byte(configured), []byte(provided)) != 1 {
		return nil, fmt.Errorf("planned intent withdrawal rejected: operator authorization is required")
	}
	clientOrderID = strings.TrimSpace(clientOrderID)
	if clientOrderID == "" {
		return nil, fmt.Errorf("client_order_id is required")
	}
	order, err := oc.storageService.GetOrderByClientOrderID(clientOrderID)
	if err != nil {
		return nil, fmt.Errorf("planned intent lookup failed: %w", err)
	}
	if order == nil {
		return nil, &services.PlannedIntentNotFoundError{ClientOrderID: clientOrderID}
	}
	if order.Status != "planned_for_next_session" || strings.TrimSpace(order.ID) != "" || order.SubmissionAttempted {
		return nil, &services.PlannedIntentWithdrawalConflictError{ClientOrderID: clientOrderID, Status: order.Status}
	}
	order.Status = "withdrawn"
	if err := oc.storageService.SaveOrder(order); err != nil {
		return nil, fmt.Errorf("planned intent withdrawal persistence failed: %w", err)
	}
	return order, nil
}

func configuredOperatorToken() string {
	// Keep the controller independently safe when called without the HTTP
	// router; the router remains responsible for transport identity checks.
	return strings.TrimSpace(os.Getenv("TRADING_BOT_OPERATOR_TOKEN"))
}

type durableIdentityReader interface {
	DurableIdentity() models.DurableIdentity
}

// optionsResponseWithIdentity is the single response boundary for options
// order outcomes. Provider/caller identity is never echoed: the values come
// from the persisted intent, with the storage runtime identity as the only
// fallback while that intent is being written or reloaded.
func (oc *OrderController) optionsResponseWithIdentity(intent *interfaces.Order, result *interfaces.OrderResult, status, message string) *interfaces.OrderResult {
	if result == nil {
		result = &interfaces.OrderResult{}
	}
	if intent != nil {
		result.ClientOrderID = intent.ClientOrderID
		result.BrokerAccountID = intent.BrokerAccountID
		result.PaperLive = intent.PaperLive
		result.TenantID = intent.TenantID
		result.SandboxID = intent.SandboxID
	}
	if reader, ok := oc.storageService.(durableIdentityReader); ok {
		identity := reader.DurableIdentity()
		if result.BrokerAccountID == "" {
			result.BrokerAccountID = identity.BrokerAccountID
		}
		if result.PaperLive == "" {
			result.PaperLive = identity.PaperLive
		}
		if result.TenantID == "" {
			result.TenantID = identity.TenantID
		}
		if result.SandboxID == "" {
			result.SandboxID = identity.SandboxID
		}
	}
	if status != "" {
		result.Status = status
	}
	if message != "" {
		result.Message = message
	}
	return result
}

func (oc *OrderController) cancelOrder(orderID string) error {
	identityReader, ok := oc.storageService.(durableIdentityReader)
	if !ok {
		return fmt.Errorf("cancel rejected: server-owned execution identity is unavailable")
	}
	currentIdentity := identityReader.DurableIdentity()
	if strings.TrimSpace(currentIdentity.BrokerAccountID) == "" ||
		(currentIdentity.PaperLive != "paper" && currentIdentity.PaperLive != "live") ||
		strings.TrimSpace(currentIdentity.TenantID) == "" ||
		strings.TrimSpace(currentIdentity.SandboxID) == "" {
		return fmt.Errorf("cancel rejected: server-owned execution identity is incomplete")
	}
	ctx := context.Background()
	var persistedOrder *interfaces.Order
	var lookupErr error
	if strings.HasPrefix(orderID, "op-") {
		persistedOrder, lookupErr = oc.storageService.GetOrderByClientOrderID(orderID)
	} else {
		persistedOrder, lookupErr = oc.storageService.GetOrder(orderID)
		if errors.Is(lookupErr, gorm.ErrRecordNotFound) {
			brokerLookupErr := lookupErr
			persistedOrder, lookupErr = oc.storageService.GetOrderByClientOrderID(orderID)
			if lookupErr != nil || persistedOrder == nil {
				lookupErr = brokerLookupErr
			}
		}
	}
	if lookupErr != nil {
		return fmt.Errorf("cancel ownership lookup failed: %w", lookupErr)
	}
	if persistedOrder == nil {
		return fmt.Errorf("cancel rejected: local order %q is not owned by this runtime", orderID)
	}
	if persistedOrder.ID != orderID && persistedOrder.ClientOrderID != orderID {
		return fmt.Errorf("cancel rejected: order identity mismatch")
	}
	if persistedOrder.BrokerAccountID != currentIdentity.BrokerAccountID ||
		persistedOrder.PaperLive != currentIdentity.PaperLive ||
		persistedOrder.TenantID != currentIdentity.TenantID ||
		persistedOrder.SandboxID != currentIdentity.SandboxID {
		return fmt.Errorf("cancel rejected: order belongs to a different execution identity")
	}
	if strings.TrimSpace(persistedOrder.ID) == "" && !persistedOrder.SubmissionAttempted {
		if strings.EqualFold(strings.TrimSpace(persistedOrder.Status), "planned_for_next_session") {
			return &services.PlannedIntentConflictError{ClientOrderID: persistedOrder.ClientOrderID}
		}
		return &services.LocalIntentNotBrokerVisibleError{ClientOrderID: persistedOrder.ClientOrderID}
	}
	if oc.ExecutionBlocked() {
		return &services.ExecutionBlockedError{}
	}

	if err := oc.tradingService.CancelOrder(ctx, orderID); err != nil {
		var uncertain *services.SubmissionUncertainError
		if errors.As(err, &uncertain) && uncertain.Result != nil && uncertain.Result.FilledQty > 0 {
			// A cancellation readback can be the first authoritative fill
			// observation. Persist it before surfacing uncertainty so a retry
			// cannot erase the fill or submit a replacement blindly.
			if evidenceErr := services.ValidateCancellationFillEvidence(uncertain.Result, persistedOrder, currentIdentity); evidenceErr != nil {
				oc.logger.WithError(evidenceErr).Error("Rejected cancellation fill evidence")
				return err
			}
			applyOrderResult(persistedOrder, uncertain.Result)
			if saveErr := oc.storageService.SaveOrder(persistedOrder); saveErr != nil {
				return &services.SubmissionUncertainError{Err: fmt.Errorf("cancel fill evidence persistence is unresolved: %w", saveErr), Result: uncertain.Result}
			}
		}
		oc.logger.WithError(err).Error("Failed to cancel order")
		return err
	}

	// Update the locally owned order only after broker cancellation succeeds.
	order := persistedOrder
	order.Status = "canceled"
	now := time.Now()
	order.CanceledAt = &now
	if saveErr := oc.storageService.SaveOrder(order); saveErr != nil {
		order.Status = "submission_uncertain"
		return &services.SubmissionUncertainError{Err: fmt.Errorf("cancel persistence is unresolved: %w", saveErr)}
	}

	oc.logger.WithField("orderID", orderID).Info("Order canceled successfully")
	return nil
}

// GetPositions retrieves current positions
func (oc *OrderController) GetPositions() ([]*interfaces.Position, error) {
	if oc.tradingService == nil {
		return nil, fmt.Errorf("broker service unavailable in inert mode")
	}
	ctx := context.Background()
	return oc.tradingService.GetPositions(ctx)
}

// GetAccount retrieves account information
func (oc *OrderController) GetAccount() (*interfaces.Account, error) {
	if oc.tradingService == nil {
		return nil, fmt.Errorf("broker service unavailable in inert mode")
	}
	ctx := context.Background()
	return oc.tradingService.GetAccount(ctx)
}

// HTTP Handlers for Gin framework

// HandleBuy handles HTTP buy requests
func (oc *OrderController) HandleBuy(c *gin.Context) {
	if oc.rejectIfExecutionBlocked(c) {
		return
	}
	var req BuyRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}

	result, err := oc.Buy(c.Request.Context(), req)
	if err != nil {
		var preSubmission *services.PreSubmissionRejectionError
		if errors.As(err, &preSubmission) {
			c.JSON(http.StatusConflict, gin.H{"error": "rejected_before_submission", "category": "risk_blocked", "details": preSubmission.Error(), "retryable": false})
			return
		}
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}

	status := http.StatusOK
	if result != nil && result.Status == "planned_for_next_session" {
		status = http.StatusAccepted
	}
	c.JSON(status, result)
}

// HandleSell handles HTTP sell requests
func (oc *OrderController) HandleSell(c *gin.Context) {
	if oc.rejectIfExecutionBlocked(c) {
		return
	}
	var req SellRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}

	result, err := oc.Sell(c.Request.Context(), req)
	if err != nil {
		var preSubmission *services.PreSubmissionRejectionError
		if errors.As(err, &preSubmission) {
			c.JSON(http.StatusConflict, gin.H{"error": "rejected_before_submission", "category": "risk_blocked", "details": preSubmission.Error(), "retryable": false})
			return
		}
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}

	status := http.StatusOK
	if result != nil && result.Status == "planned_for_next_session" {
		status = http.StatusAccepted
	}
	c.JSON(status, result)
}

// HandleCancelOrder handles HTTP cancel order requests
func (oc *OrderController) HandleCancelOrder(c *gin.Context) {
	orderID := c.Param("id")
	if orderID == "" {
		c.JSON(400, gin.H{"error": "order ID required"})
		return
	}

	if err := oc.CancelOrderWithCapability(orderID, c.GetHeader("X-OpenProphet-Operator-Token")); err != nil {
		var plannedConflict *services.PlannedIntentConflictError
		if errors.As(err, &plannedConflict) {
			c.JSON(http.StatusConflict, gin.H{"error": "planned_intent_not_broker_visible", "category": "planned_intent_conflict", "details": plannedConflict.Error(), "retryable": false})
			return
		}
		var localIntent *services.LocalIntentNotBrokerVisibleError
		if errors.As(err, &localIntent) {
			c.JSON(http.StatusConflict, gin.H{"error": "planned_intent_not_broker_visible", "category": "local_intent_not_broker_visible", "details": localIntent.Error(), "retryable": false})
			return
		}
		var blocked *services.ExecutionBlockedError
		if errors.As(err, &blocked) {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": blocked.Error()})
			return
		}
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}

	c.JSON(200, gin.H{"message": "Order canceled successfully"})
}

// HandleWithdrawPlannedIntent withdraws a local planned intent without a broker call.
func (oc *OrderController) HandleWithdrawPlannedIntent(c *gin.Context) {
	clientOrderID := c.Param("client_order_id")
	if clientOrderID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"status": "validation_error", "error": "client_order_id is required"})
		return
	}
	order, err := oc.WithdrawPlannedIntentWithCapability(clientOrderID, c.GetHeader("X-OpenProphet-Operator-Token"))
	if err != nil {
		var notFound *services.PlannedIntentNotFoundError
		if errors.As(err, &notFound) {
			c.JSON(http.StatusNotFound, gin.H{"status": "not_found", "error": "planned_intent_not_found", "client_order_id": clientOrderID})
			return
		}
		var conflict *services.PlannedIntentWithdrawalConflictError
		if errors.As(err, &conflict) {
			c.JSON(http.StatusConflict, gin.H{"status": "conflict", "error": "planned_intent_withdrawal_conflict", "client_order_id": clientOrderID, "details": conflict.Error()})
			return
		}
		if strings.Contains(err.Error(), "authorization") {
			c.JSON(http.StatusForbidden, gin.H{"status": "forbidden", "error": err.Error()})
			return
		}
		if strings.Contains(err.Error(), "client_order_id is required") {
			c.JSON(http.StatusBadRequest, gin.H{"status": "validation_error", "error": err.Error()})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"status": "error", "error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "withdrawn", "client_order_id": order.ClientOrderID, "order": order})
}

// HandleGetPositions handles HTTP get positions requests
func (oc *OrderController) HandleGetPositions(c *gin.Context) {
	positions, err := oc.GetPositions()
	if err != nil {
		status := http.StatusInternalServerError
		if oc.tradingService == nil {
			status = http.StatusServiceUnavailable
		}
		c.JSON(status, gin.H{"error": err.Error()})
		return
	}

	c.JSON(200, positions)
}

// HandleGetAccount handles HTTP get account requests
func (oc *OrderController) HandleGetAccount(c *gin.Context) {
	account, err := oc.GetAccount()
	if err != nil {
		status := http.StatusInternalServerError
		if oc.tradingService == nil {
			status = http.StatusServiceUnavailable
		}
		c.JSON(status, gin.H{"error": err.Error()})
		return
	}

	c.JSON(200, account)
}

type marketClockService interface {
	GetMarketClock(context.Context) (*interfaces.MarketClock, error)
}

// HandleGetMarketClock returns the broker-authoritative session state without
// mutating account or order state.
func (oc *OrderController) HandleGetMarketClock(c *gin.Context) {
	service, ok := oc.tradingService.(marketClockService)
	if !ok {
		c.JSON(503, gin.H{"error": "broker market clock is unavailable"})
		return
	}
	clock, err := service.GetMarketClock(c.Request.Context())
	if err != nil {
		c.JSON(503, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, clock)
}

func orderIdentityKeys(order *interfaces.Order) []string {
	if order == nil {
		return nil
	}
	keys := make([]string, 0, 2)
	if order.ClientOrderID != "" {
		keys = append(keys, "client:"+order.ClientOrderID)
	}
	if order.ID != "" {
		keys = append(keys, "broker:"+order.ID)
	}
	if len(keys) == 0 {
		keys = append(keys, "local:"+order.Symbol+":"+order.SubmittedAt.UTC().Format(time.RFC3339Nano))
	}
	return keys
}

func mergeBrokerOrder(local, broker *interfaces.Order) *interfaces.Order {
	if local == nil && broker == nil {
		return nil
	}
	if local == nil {
		copy := *broker
		return &copy
	}
	merged := *local
	if broker == nil {
		return &merged
	}
	if broker.ID != "" {
		merged.ID = broker.ID
	}
	if broker.ClientOrderID != "" {
		merged.ClientOrderID = broker.ClientOrderID
	}
	if broker.Status != "" {
		merged.Status = broker.Status
	}
	if broker.FilledQty > 0 || merged.FilledQty == 0 {
		merged.FilledQty = broker.FilledQty
	}
	if broker.FilledAvgPrice != nil {
		merged.FilledAvgPrice = broker.FilledAvgPrice
	}
	if !broker.SubmittedAt.IsZero() {
		merged.SubmittedAt = broker.SubmittedAt
	}
	if broker.FilledAt != nil {
		merged.FilledAt = broker.FilledAt
	}
	if broker.CanceledAt != nil {
		merged.CanceledAt = broker.CanceledAt
	}
	return &merged
}

func orderMatchesStatus(order *interfaces.Order, status string) bool {
	return status == "" || strings.EqualFold(status, "all") || (order != nil && strings.EqualFold(order.Status, status))
}

func brokerOrderHistoryStatus(status string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "open":
		return "open"
	case "closed":
		return "closed"
	case "all":
		return "all"
	default:
		return "all"
	}
}

func (oc *OrderController) listVisibleOrders(ctx context.Context, status string) ([]*interfaces.Order, bool, error) {
	if oc.tradingService == nil {
		return nil, false, fmt.Errorf("broker order history is unavailable in inert mode")
	}
	localOrders, err := oc.storageService.GetOrders("")
	if err != nil {
		return nil, false, err
	}
	brokerOrders, brokerErr := oc.tradingService.ListOrders(ctx, brokerOrderHistoryStatus(status))
	brokerAvailable := brokerErr == nil
	if brokerErr != nil {
		// Planned intents remain useful when the broker is temporarily unavailable.
		// Do not claim broker completeness; return only locally known records.
		oc.logger.WithError(brokerErr).Warn("ListOrders: broker history unavailable; returning local order records")
		brokerOrders = nil
	}

	byKey := make(map[string]*interfaces.Order)
	for _, local := range localOrders {
		if !orderMatchesStatus(local, status) {
			continue
		}
		for _, key := range orderIdentityKeys(local) {
			byKey[key] = local
		}
	}
	for _, broker := range brokerOrders {
		if !orderMatchesStatus(broker, status) {
			continue
		}
		var local *interfaces.Order
		for _, key := range orderIdentityKeys(broker) {
			if candidate := byKey[key]; candidate != nil {
				local = candidate
				break
			}
		}
		merged := mergeBrokerOrder(local, broker)
		for _, key := range orderIdentityKeys(merged) {
			byKey[key] = merged
		}
	}

	unique := make(map[*interfaces.Order]struct{})
	orders := make([]*interfaces.Order, 0, len(byKey))
	for _, order := range byKey {
		if _, seen := unique[order]; seen {
			continue
		}
		unique[order] = struct{}{}
		orders = append(orders, order)
	}
	sort.SliceStable(orders, func(i, j int) bool {
		return orders[i].SubmittedAt.After(orders[j].SubmittedAt)
	})
	return orders, brokerAvailable, nil
}

// HandleGetOrders handles HTTP get orders requests
func (oc *OrderController) HandleGetOrders(c *gin.Context) {
	status := c.Query("status")

	ctx := context.Background()
	orders, brokerAvailable, err := oc.listVisibleOrders(ctx, status)
	if err != nil {
		if oc.tradingService == nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": err.Error(), "complete": false})
		} else {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error(), "complete": false})
		}
		return
	}

	c.JSON(200, gin.H{
		"orders":       orders,
		"complete":     brokerAvailable,
		"broker_state": map[bool]string{true: "available", false: "unavailable"}[brokerAvailable],
	})
}

// HandleGetQuote handles HTTP get quote requests
// GET /api/v1/market/quote/:symbol
func (oc *OrderController) HandleGetQuote(c *gin.Context) {
	symbol := c.Param("symbol")
	if symbol == "" {
		c.JSON(400, gin.H{"error": "symbol required"})
		return
	}
	if oc.dataService == nil {
		c.JSON(503, gin.H{"error": "market data is unavailable in inert mode"})
		return
	}

	ctx := context.Background()
	quote, err := oc.dataService.GetLatestQuote(ctx, symbol)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}

	c.JSON(200, quote)
}

// HandleGetBar handles HTTP get latest bar requests
// GET /api/v1/market/bar/:symbol
func (oc *OrderController) HandleGetBar(c *gin.Context) {
	symbol := c.Param("symbol")
	if symbol == "" {
		c.JSON(400, gin.H{"error": "symbol required"})
		return
	}
	if oc.dataService == nil {
		c.JSON(503, gin.H{"error": "market data is unavailable in inert mode"})
		return
	}

	ctx := context.Background()
	bar, err := oc.dataService.GetLatestBar(ctx, symbol)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}

	c.JSON(200, bar)
}

// HandleGetBars handles HTTP get historical bars requests
// GET /api/v1/market/bars/:symbol?start=2025-01-01&end=2025-01-10&timeframe=1D
func (oc *OrderController) HandleGetBars(c *gin.Context) {
	symbol := c.Param("symbol")
	if symbol == "" {
		c.JSON(400, gin.H{"error": "symbol required"})
		return
	}
	if oc.dataService == nil {
		c.JSON(503, gin.H{"error": "market data is unavailable in inert mode"})
		return
	}

	// Parse query parameters
	startStr := c.Query("start")
	endStr := c.Query("end")
	timeframe := c.DefaultQuery("timeframe", "1D")

	// Default to last 30 days if not specified
	end := time.Now()
	start := end.AddDate(0, 0, -30)

	if startStr != "" {
		if t, err := time.Parse("2006-01-02", startStr); err == nil {
			start = t
		}
	}

	if endStr != "" {
		if t, err := time.Parse("2006-01-02", endStr); err == nil {
			end = t
		}
	}

	ctx := context.Background()
	bars, err := oc.dataService.GetHistoricalBars(ctx, symbol, start, end, timeframe)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}

	c.JSON(200, gin.H{
		"symbol":    symbol,
		"start":     start,
		"end":       end,
		"timeframe": timeframe,
		"count":     len(bars),
		"bars":      bars,
	})
}

// OptionsOrderRequest represents an options order request
type OptionsOrderRequest struct {
	ClientOrderID         string                              `json:"client_order_id"`
	Symbol                string                              `json:"symbol" binding:"required"`
	Underlying            string                              `json:"underlying" binding:"required"`
	Qty                   float64                             `json:"qty" binding:"required,gt=0"`
	Side                  string                              `json:"side" binding:"required,oneof=buy sell"`
	PositionIntent        string                              `json:"position_intent" binding:"required,oneof=buy_to_open buy_to_close sell_to_open sell_to_close"`
	Type                  string                              `json:"type"`          // "market", "limit"
	TimeInForce           string                              `json:"time_in_force"` // options require "day"
	LimitPrice            *float64                            `json:"limit_price,omitempty"`
	MarketScannerFeatures any                                 `json:"market_scanner_features,omitempty"`
	StrategyType          string                              `json:"strategy_type,omitempty"`
	AssessmentLegs        []interfaces.AlphaDeskAssessmentLeg `json:"legs,omitempty"`
	MaxLoss               *float64                            `json:"max_loss,omitempty"`
	Greeks                map[string]float64                  `json:"greeks,omitempty"`
	MarketEvidenceAt      time.Time                           `json:"market_evidence_at,omitempty"`
	ObservedAt            time.Time                           `json:"observed_at,omitempty"`
	ExpiresAt             time.Time                           `json:"expires_at,omitempty"`
}

func optionalFloatEqual(a, b *float64) bool {
	if a == nil || b == nil {
		return a == b
	}
	return math.Abs(*a-*b) < 1e-9
}

func plannedOptionsMatch(existing *interfaces.Order, req OptionsOrderRequest) bool {
	return existing != nil && strings.EqualFold(existing.Symbol, req.Symbol) &&
		strings.EqualFold(existing.Underlying, req.Underlying) &&
		existing.Qty == req.Qty && existing.Side == req.Side &&
		existing.PositionIntent == req.PositionIntent && existing.Type == req.Type &&
		existing.TimeInForce == req.TimeInForce && optionalFloatEqual(existing.LimitPrice, req.LimitPrice)
}

func (oc *OrderController) findLocalOrderByClientID(clientOrderID string) (*interfaces.Order, error) {
	return oc.storageService.GetOrderByClientOrderID(clientOrderID)
}

// plannedIntentState checks eligibility before expiry. At the exact eligible
// boundary the intent remains eligible; an intent is stale only once its
// explicit expiry has been reached after eligibility has been considered.
func (oc *OrderController) plannedIntentState(order *interfaces.Order, now time.Time) (eligible bool, expired bool) {
	if order == nil || order.Status != "planned_for_next_session" {
		return false, false
	}
	if order.NextEligibleAt != nil && now.Before(*order.NextEligibleAt) {
		return false, false
	}
	if order.ExpiresAt != nil && !now.Before(*order.ExpiresAt) {
		return false, true
	}
	return true, false
}

// PlaceOptionsOrder handles POST /api/options/order
func (oc *OrderController) PlaceOptionsOrder(c *gin.Context) {
	if oc.rejectIfExecutionBlocked(c) {
		return
	}
	var req OptionsOrderRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, oc.optionsResponseWithIdentity(nil, nil, "validation_error", err.Error()))
		return
	}
	oc.optionsIntentMu.Lock()
	defer oc.optionsIntentMu.Unlock()

	// Set defaults. Options orders are regular-session day orders only.
	if req.Type == "" {
		req.Type = "market"
	}
	if req.TimeInForce == "" {
		req.TimeInForce = "day"
	}
	clientOrderID := strings.TrimSpace(req.ClientOrderID)
	if clientOrderID == "" {
		c.JSON(400, oc.optionsResponseWithIdentity(nil, nil, "validation_error", "client_order_id is required; retries must reuse the original identity"))
		return
	}
	if clientOrderID != req.ClientOrderID {
		c.JSON(400, oc.optionsResponseWithIdentity(nil, nil, "validation_error", "client_order_id must not contain leading or trailing whitespace"))
		return
	}

	order := &interfaces.OptionsOrder{
		ClientOrderID:         clientOrderID,
		Symbol:                req.Symbol,
		Underlying:            req.Underlying,
		Qty:                   req.Qty,
		Side:                  req.Side,
		PositionIntent:        req.PositionIntent,
		Type:                  req.Type,
		TimeInForce:           req.TimeInForce,
		LimitPrice:            req.LimitPrice,
		MarketScannerFeatures: req.MarketScannerFeatures,
		StrategyType:          req.StrategyType,
		AssessmentLegs:        req.AssessmentLegs,
		AssessmentMaxLoss:     req.MaxLoss,
		AssessmentGreeks:      req.Greeks,
		MarketEvidenceAt:      req.MarketEvidenceAt,
		ObservedAt:            req.ObservedAt,
		AssessmentExpiresAt:   req.ExpiresAt,
	}
	if err := services.ValidateOptionsOrder(order); err != nil {
		c.JSON(400, oc.optionsResponseWithIdentity(nil, nil, "validation_error", err.Error()))
		return
	}

	var existing *interfaces.Order
	var err error
	existing, err = oc.findLocalOrderByClientID(clientOrderID)
	if err != nil {
		oc.logger.WithError(err).Error("Failed to load existing options intent")
		c.JSON(500, oc.optionsResponseWithIdentity(nil, nil, "submission_uncertain", err.Error()))
		return
	}
	if existing != nil {
		if existing.Status != "planned_for_next_session" {
			c.JSON(409, oc.optionsResponseWithIdentity(existing, nil, existing.Status, "client_order_id is not an unresolved planned intent; reconcile before any retry"))
			return
		}
		if !plannedOptionsMatch(existing, req) {
			c.JSON(409, oc.optionsResponseWithIdentity(existing, nil, "validation_error", "retry request does not match the persisted options intent"))
			return
		}
		now := time.Now()
		eligible, expired := oc.plannedIntentState(existing, now)
		if !eligible && !expired {
			c.JSON(409, oc.optionsResponseWithIdentity(existing, &interfaces.OrderResult{NextEligibleAt: existing.NextEligibleAt}, "planned_for_next_session", "planned options intent is not yet eligible for submission"))
			return
		}
		if expired {
			existing.Status = "expired"
			if saveErr := oc.storageService.SaveOrder(existing); saveErr != nil {
				c.JSON(500, oc.optionsResponseWithIdentity(existing, nil, "submission_uncertain", fmt.Sprintf("stale planned intent could not be marked expired: %v", saveErr)))
				return
			}
			c.JSON(409, oc.optionsResponseWithIdentity(existing, nil, "expired", "planned options intent has expired"))
			return
		}
	}
	intent := &interfaces.Order{
		ClientOrderID:  clientOrderID,
		Symbol:         req.Symbol,
		Underlying:     req.Underlying,
		AssetClass:     "us_option",
		PositionIntent: req.PositionIntent,
		Qty:            req.Qty,
		Side:           req.Side,
		Type:           req.Type,
		TimeInForce:    req.TimeInForce,
		LimitPrice:     req.LimitPrice,
		Status:         "pending",
		Purpose: func() string {
			if strings.HasSuffix(req.PositionIntent, "_to_close") {
				return "close"
			}
			return "entry"
		}(),
		SubmittedAt: time.Now(),
	}
	var auditMetadata string
	order.AssessmentAuditSink = func(a *interfaces.AlphaDeskAssessment) error {
		metadata, marshalErr := json.Marshal(a)
		if marshalErr != nil {
			return marshalErr
		}
		intent.Metadata = string(metadata)
		auditMetadata = intent.Metadata
		return oc.storageService.SaveOrder(intent)
	}
	if existing != nil {
		intent.NextEligibleAt = existing.NextEligibleAt
		intent.ExpiresAt = existing.ExpiresAt
		intent.Revision = existing.Revision
	}

	if err := oc.storageService.SaveOrder(intent); err != nil {
		oc.logger.WithError(err).Error("Failed to persist options order intent")
		c.JSON(500, oc.optionsResponseWithIdentity(intent, nil, "submission_uncertain", err.Error()))
		return
	}
	// Resolve the durable identity from the server-owned persisted intent. Never
	// derive result identity from caller-supplied options fields.
	persistedIntent, err := oc.storageService.GetOrderByClientOrderID(clientOrderID)
	if err != nil || persistedIntent == nil {
		c.JSON(500, oc.optionsResponseWithIdentity(intent, nil, "submission_uncertain", "options order identity could not be verified"))
		return
	}
	intent.BrokerAccountID = persistedIntent.BrokerAccountID
	intent.PaperLive = persistedIntent.PaperLive
	intent.TenantID = persistedIntent.TenantID
	intent.SandboxID = persistedIntent.SandboxID
	intent.Revision = persistedIntent.Revision
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	result, err := oc.tradingService.PlaceOptionsOrder(ctx, order)
	if intent.Metadata == "" {
		intent.Metadata = auditMetadata
	}
	if refreshErr := oc.refreshOrderRevision(intent); refreshErr != nil {
		c.JSON(500, oc.optionsResponseWithIdentity(intent, nil, "submission_uncertain", fmt.Sprintf("options order state could not be reloaded after submission attempt: %v", refreshErr)))
		return
	}
	if err != nil {
		var closedErr *services.MarketClosedError
		if errors.As(err, &closedErr) {
			if intent.Purpose == "entry" && intent.LimitPrice == nil {
				intent.Status = "rejected_before_submission"
				_ = oc.storageService.SaveOrder(intent)
				c.JSON(http.StatusConflict, oc.optionsResponseWithIdentity(intent, nil, "risk_blocked", "opening market intent cannot be planned without a bounded executable price"))
				return
			}
			intent.Status = "planned_for_next_session"
			if !closedErr.NextOpen.IsZero() {
				nextOpen := closedErr.NextOpen
				expires := nextOpen.Add(24 * time.Hour)
				intent.NextEligibleAt = &nextOpen
				intent.ExpiresAt = &expires
			}
			if saveErr := oc.storageService.SaveOrder(intent); saveErr != nil {
				oc.logger.WithError(saveErr).Error("Failed to durably record planned options intent")
				c.JSON(500, oc.optionsResponseWithIdentity(intent, nil, "submission_uncertain", fmt.Sprintf("market is closed and planned intent persistence failed: %v", saveErr)))
				return
			}
			persisted, readErr := oc.storageService.GetOrderByClientOrderID(clientOrderID)
			if readErr != nil || persisted == nil || persisted.Status != "planned_for_next_session" {
				c.JSON(500, oc.optionsResponseWithIdentity(intent, nil, "submission_uncertain", "market is closed but the planned intent could not be verified as durable"))
				return
			}
			result = oc.optionsResponseWithIdentity(intent, &interfaces.OrderResult{
				Status:         intent.Status,
				Message:        err.Error(),
				ClientOrderID:  clientOrderID,
				NextEligibleAt: intent.NextEligibleAt,
			}, intent.Status, err.Error())
			c.JSON(202, result)
			return
		}

		intent.Status = "submit_failed"
		if services.IsSubmissionUncertain(err) {
			intent.Status = "submission_uncertain"
		}
		if saveErr := oc.storageService.SaveOrder(intent); saveErr != nil {
			oc.logger.WithError(saveErr).Warn("Failed to record options order submission failure")
		}
		oc.logger.WithError(err).Error("Failed to place options order")
		if services.IsPreSubmissionRejection(err) {
			intent.Status = "rejected_before_submission"
			_ = oc.storageService.SaveOrder(intent)
			c.JSON(http.StatusConflict, oc.optionsResponseWithIdentity(intent, nil, "risk_blocked", err.Error()))
			return
		}
		c.JSON(502, oc.optionsResponseWithIdentity(intent, nil, intent.Status, err.Error()))
		return
	}
	if result == nil {
		result = oc.optionsResponseWithIdentity(intent, nil, "submission_uncertain", "No broker result was returned; execution is not confirmed.")
	}
	expectedResultOrder := &interfaces.Order{
		BrokerAccountID: intent.BrokerAccountID,
		PaperLive:       intent.PaperLive,
		TenantID:        intent.TenantID,
		SandboxID:       intent.SandboxID,
		ClientOrderID:   clientOrderID,
		Symbol:          order.Symbol,
		Qty:             order.Qty,
		Side:            order.Side,
		Type:            order.Type,
		TimeInForce:     order.TimeInForce,
		LimitPrice:      order.LimitPrice,
		PositionIntent:  order.PositionIntent,
		Purpose:         map[bool]string{true: "entry", false: "close"}[strings.HasSuffix(order.PositionIntent, "_to_open")],
	}
	if err := validateBrokerResultForConsumer(result, expectedResultOrder); err != nil {
		intent.Status = "submission_uncertain"
		result.ClientOrderID = clientOrderID
		if saveErr := oc.storageService.SaveOrder(intent); saveErr != nil {
			oc.logger.WithError(saveErr).Warn("Failed to record uncertain options broker result")
		}
		c.JSON(502, oc.optionsResponseWithIdentity(intent, result, intent.Status, err.Error()))
		return
	}
	result.ClientOrderID = clientOrderID
	result = oc.optionsResponseWithIdentity(intent, result, result.Status, result.Message)
	applyOrderResult(intent, result)
	if auditMetadata != "" {
		intent.Metadata = auditMetadata
	}
	if err := oc.storageService.SaveOrder(intent); err != nil {
		intent.Status = "submission_uncertain"
		oc.logger.WithError(err).Error("Failed to persist options order after broker submission")
		c.JSON(502, oc.optionsResponseWithIdentity(intent, result, intent.Status, "options order persistence is unresolved"))
		return
	}

	c.JSON(200, result)
}

// AssessOptionsStrategy is assessment-only; it never authorizes or submits a broker order.
func (oc *OrderController) AssessOptionsStrategy(c *gin.Context) {
	var req OptionsOrderRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": "invalid options assessment request"})
		return
	}
	assessor, ok := oc.tradingService.(interface {
		AssessOptionsStrategy(context.Context, *interfaces.OptionsOrder, any) (*interfaces.AlphaDeskAssessment, error)
	})
	if !ok {
		oc.logger.WithFields(oc.auditIdentityFields()).Warn("AlphaDesk assessment unavailable")
		c.JSON(503, gin.H{"error": "AlphaDesk assessment is unavailable"})
		return
	}
	order := &interfaces.OptionsOrder{Symbol: req.Symbol, Underlying: req.Underlying, Qty: req.Qty, Side: req.Side, PositionIntent: req.PositionIntent, Type: req.Type, TimeInForce: req.TimeInForce, LimitPrice: req.LimitPrice, StrategyType: req.StrategyType, AssessmentLegs: req.AssessmentLegs, AssessmentMaxLoss: req.MaxLoss, AssessmentGreeks: req.Greeks, MarketEvidenceAt: req.MarketEvidenceAt, ObservedAt: req.ObservedAt, AssessmentExpiresAt: req.ExpiresAt}
	a, err := assessor.AssessOptionsStrategy(c.Request.Context(), order, req.MarketScannerFeatures)
	if err != nil {
		var unavailable *services.AlphaDeskUnavailableError
		if errors.As(err, &unavailable) {
			assessment := &interfaces.AlphaDeskAssessment{Decision: "UNAVAILABLE", QualificationStatus: "unavailable", Fingerprint: ""}
			oc.logger.WithFields(oc.auditIdentityFields()).WithError(err).Warn("AlphaDesk assessment unavailable")
			c.JSON(200, assessment)
			return
		}
		var validation *services.AlphaDeskValidationError
		if errors.As(err, &validation) {
			oc.logger.WithFields(oc.auditIdentityFields()).WithError(err).Warn("AlphaDesk rejected assessment validation")
			c.JSON(validation.Status, gin.H{"status": "invalid_request", "category": "provider_validation", "error": err.Error()})
			return
		}
		var configuration *services.AlphaDeskConfigurationError
		if errors.As(err, &configuration) {
			c.JSON(503, gin.H{"status": "unavailable", "category": "configuration", "error": configuration.Error()})
			return
		}
		oc.logger.WithFields(oc.auditIdentityFields()).WithError(err).Warn("AlphaDesk assessment failed")
		c.JSON(503, gin.H{"status": "unavailable", "category": "provider_unavailable", "error": "AlphaDesk assessment is unavailable"})
		return
	}
	if a == nil {
		oc.logger.WithFields(oc.auditIdentityFields()).Warn("AlphaDesk assessment returned no decision")
		c.JSON(503, gin.H{"error": "AlphaDesk hard gate is disabled"})
		return
	}
	oc.logger.WithFields(oc.auditIdentityFields()).WithFields(logrus.Fields{"assessment_id": a.AssessmentID, "decision": a.Decision, "fingerprint": a.Fingerprint}).Info("AlphaDesk assessment decision")
	c.JSON(200, a)
}

func (oc *OrderController) auditIdentityFields() logrus.Fields {
	fields := logrus.Fields{}
	if reader, ok := oc.storageService.(durableIdentityReader); ok {
		identity := reader.DurableIdentity()
		fields["broker_account_id"] = identity.BrokerAccountID
		fields["sandbox_id"] = identity.SandboxID
		fields["paper_live"] = identity.PaperLive
	}
	return fields
}

// GetOptionsPosition handles GET /api/options/position/:symbol
func (oc *OrderController) GetOptionsPosition(c *gin.Context) {
	if oc.tradingService == nil {
		c.JSON(503, gin.H{"error": "options broker service is unavailable in inert mode"})
		return
	}
	symbol := c.Param("symbol")

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	position, err := oc.tradingService.GetOptionsPosition(ctx, symbol)
	if err != nil {
		c.JSON(404, gin.H{"error": err.Error()})
		return
	}

	c.JSON(200, position)
}

// ListOptionsPositions handles GET /api/options/positions
func (oc *OrderController) ListOptionsPositions(c *gin.Context) {
	if oc.tradingService == nil {
		c.JSON(503, gin.H{"error": "options broker service is unavailable in inert mode"})
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	positions, err := oc.tradingService.ListOptionsPositions(ctx)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}

	c.JSON(200, positions)
}

// GetOptionsChain handles GET /api/options/chain/:symbol?expiration=2025-11-22&delta_min=0.4&delta_max=0.6&min_bid=0.1
func (oc *OrderController) GetOptionsChain(c *gin.Context) {
	if oc.tradingService == nil {
		c.JSON(503, gin.H{"error": "options broker service is unavailable in inert mode"})
		return
	}
	symbol := c.Param("symbol")
	if symbol == "" {
		c.JSON(400, gin.H{"error": "symbol required"})
		return
	}

	// Get expiration date from query parameter
	expirationStr := c.Query("expiration")
	var expiration time.Time
	var err error

	if expirationStr != "" {
		expiration, err = time.Parse("2006-01-02", expirationStr)
		if err != nil {
			c.JSON(400, gin.H{"error": "invalid expiration date format, use YYYY-MM-DD"})
			return
		}
	} else {
		// Default to next Friday (typical weekly options expiration)
		expiration = getNextFriday()
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	chain, err := oc.tradingService.GetOptionsChain(ctx, symbol, expiration)
	if err != nil {
		oc.logger.WithFields(oc.auditIdentityFields()).WithError(err).Error("Failed to get options chain")
		diagnostic := gin.H{"status": "unavailable", "category": "provider_unavailable", "endpoint": "options_chain", "error": "options chain is unavailable"}
		var providerErr *services.ProviderError
		if errors.As(err, &providerErr) {
			diagnostic["endpoint"] = providerErr.Endpoint
			diagnostic["upstream_status"] = providerErr.Status
			diagnostic["attempts"] = providerErr.Attempts
			diagnostic["retryable"] = providerErr.Retryable
		}
		c.JSON(503, diagnostic)
		return
	}
	// An empty pre-open snapshot is not an empty trading opportunity. Consult
	// the broker clock so callers can distinguish market-closed/unavailable
	// from a valid post-open empty result; never fabricate contracts or fall
	// back to equities for an options request.
	if len(chain) == 0 {
		if clockService, ok := oc.tradingService.(marketClockService); ok {
			clock, clockErr := clockService.GetMarketClock(c.Request.Context())
			if clockErr != nil {
				oc.logger.WithError(clockErr).Warn("Options chain empty and broker clock unavailable")
				c.JSON(503, gin.H{"status": "unavailable", "category": "market_state_unavailable", "endpoint": "options_chain", "error": "options chain availability could not be determined"})
				return
			}
			if clock != nil && !clock.IsOpen {
				c.JSON(503, gin.H{"status": "market_closed", "category": "market_closed", "endpoint": "options_chain", "next_open": clock.NextOpen, "error": "options chain is unavailable while the regular market is closed"})
				return
			}
		}
	}

	// Apply filters for token efficiency
	filtered := make([]*interfaces.OptionContract, 0)

	// Filter by delta range (absolute value for puts)
	deltaMinStr := c.Query("delta_min")
	deltaMaxStr := c.Query("delta_max")
	minBidStr := c.Query("min_bid")
	optionType := c.Query("type")

	// Parse filter values
	var deltaMin, deltaMax, minBid float64
	var hasMin, hasMax, hasMinBid bool

	if deltaMinStr != "" {
		if val, err := strconv.ParseFloat(deltaMinStr, 64); err == nil {
			deltaMin = val
			hasMin = true
		}
	}
	if deltaMaxStr != "" {
		if val, err := strconv.ParseFloat(deltaMaxStr, 64); err == nil {
			deltaMax = val
			hasMax = true
		}
	}
	if minBidStr != "" {
		if val, err := strconv.ParseFloat(minBidStr, 64); err == nil {
			minBid = val
			hasMinBid = true
		}
	}

	// Apply all filters in one pass
	for _, contract := range chain {
		// Skip contracts with zero Greeks (invalid/stale data)
		if contract.Delta == 0 && contract.Gamma == 0 && contract.Theta == 0 {
			continue
		}

		absDelta := math.Abs(contract.Delta)

		// Apply delta filters
		if hasMin && absDelta < deltaMin {
			continue
		}
		if hasMax && absDelta > deltaMax {
			continue
		}

		// Apply bid filter
		if hasMinBid && contract.Bid <= minBid {
			continue
		}

		// Apply option type filter
		if optionType == "call" && contract.Delta <= 0 {
			continue
		}
		if optionType == "put" && contract.Delta >= 0 {
			continue
		}

		filtered = append(filtered, contract)
	}

	c.JSON(200, gin.H{
		"status":     "available",
		"symbol":     symbol,
		"expiration": expiration.Format("2006-01-02"),
		"total":      len(chain),
		"filtered":   len(filtered),
		"contracts":  filtered,
	})
}

// getNextFriday returns the date of the next Friday
func getNextFriday() time.Time {
	now := time.Now()
	daysUntilFriday := (int(time.Friday) - int(now.Weekday()) + 7) % 7
	if daysUntilFriday == 0 {
		daysUntilFriday = 7 // If today is Friday, get next Friday
	}
	return now.AddDate(0, 0, daysUntilFriday)
}
