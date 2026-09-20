package services

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"prophet-trader/database"
	"prophet-trader/interfaces"
	"prophet-trader/models"
	"strings"
	"sync"
	"time"

	"github.com/sirupsen/logrus"
)

func newClientOrderID() (string, error) {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}

	return "op-" + hex.EncodeToString(bytes), nil
}

func validateManagedOrderResult(result *interfaces.OrderResult, order *interfaces.Order) error {
	if order == nil {
		return fmt.Errorf("managed order is required")
	}
	if order.BrokerAccountID == "" && order.PaperLive == "" && order.TenantID == "" && order.SandboxID == "" {
		identity := runtimeManagedIdentity()
		order.BrokerAccountID, order.PaperLive, order.TenantID, order.SandboxID = identity.BrokerAccountID, identity.PaperLive, identity.TenantID, identity.SandboxID
	}
	if err := ValidateOrderResultIdentity(result, order.ClientOrderID, order.Symbol, order.Side, order.Qty, order.Type, order.TimeInForce, order.LimitPrice, order.StopPrice, order.PositionIntent, order.Purpose); err != nil {
		return err
	}
	return ValidateOrderResultIdentityForExecution(result, models.DurableIdentity{BrokerAccountID: order.BrokerAccountID, PaperLive: order.PaperLive, TenantID: order.TenantID, SandboxID: order.SandboxID})
}

func runtimeManagedIdentity() models.DurableIdentity {
	paperLive := ""
	if strings.EqualFold(os.Getenv("ALPACA_PAPER"), "true") {
		paperLive = "paper"
	}
	if strings.EqualFold(os.Getenv("ALPACA_PAPER"), "false") {
		paperLive = "live"
	}
	return models.DurableIdentity{BrokerAccountID: strings.TrimSpace(os.Getenv("ALPACA_ACCOUNT_ID")), PaperLive: paperLive, TenantID: strings.TrimSpace(os.Getenv("OPENPROPHET_TENANT_ID")), SandboxID: strings.TrimSpace(os.Getenv("OPENPROPHET_SANDBOX_ID"))}
}

func (pm *PositionManager) bindManagedOrderIdentity(order *interfaces.Order) {
	if order == nil || pm.storageService == nil {
		return
	}
	identity := pm.storageService.DurableIdentity()
	order.BrokerAccountID, order.PaperLive, order.TenantID, order.SandboxID = identity.BrokerAccountID, identity.PaperLive, identity.TenantID, identity.SandboxID
}

func applyManagedOrderResult(order *interfaces.Order, result *interfaces.OrderResult) {
	order.ID = result.OrderID
	order.Status = result.Status
	if result.FilledQty >= order.FilledQty {
		order.FilledQty = result.FilledQty
		if result.FilledAvgPrice != nil || result.FilledQty == 0 {
			order.FilledAvgPrice = result.FilledAvgPrice
		}
	}
	order.SubmittedAt = result.SubmittedAt
	order.FilledAt = result.FilledAt
	order.CanceledAt = result.CanceledAt
	order.BrokerAccountID = result.BrokerAccountID
	order.PaperLive = result.PaperLive
	order.TenantID = result.TenantID
	order.SandboxID = result.SandboxID
}

type ManagedPosition struct {
	models.DurableIdentity
	ID       string `json:"id"`
	Revision int64  `json:"revision"`
	Symbol   string `json:"symbol"`
	Side     string `json:"side"`     // "buy" or "sell"
	Strategy string `json:"strategy"` // "SWING_TRADE", "LONG_TERM", "DAY_TRADE"

	// Entry details
	Quantity           float64            `json:"quantity"`
	EntryRemainingQty  float64            `json:"entry_remaining_qty,omitempty"`
	EntryPrice         float64            `json:"entry_price"`
	EntryOrderID       string             `json:"entry_order_id"`
	EntryClientOrderID string             `json:"entry_client_order_id"`
	ExitOrderID        string             `json:"exit_order_id,omitempty"`
	ExitClientOrderID  string             `json:"exit_client_order_id,omitempty"`
	ExitFilledQty      float64            `json:"exit_filled_qty,omitempty"`
	ExitFillWatermarks map[string]float64 `json:"exit_fill_watermarks,omitempty"`
	EntryOrderType     string             `json:"entry_order_type"` // "market", "limit"
	AllocationDollars  float64            `json:"allocation_dollars"`

	// Risk management
	StopLossPrice         float64 `json:"stop_loss_price"`
	StopLossPercent       float64 `json:"stop_loss_percent"`
	StopLossOrderID       string  `json:"stop_loss_order_id,omitempty"`
	StopLossClientOrderID string  `json:"stop_loss_client_order_id,omitempty"`
	TrailingStop          bool    `json:"trailing_stop"`
	TrailingPercent       float64 `json:"trailing_percent,omitempty"`

	// Profit targets
	TakeProfitPrice         float64 `json:"take_profit_price"`
	TakeProfitPercent       float64 `json:"take_profit_percent"`
	TakeProfitOrderID       string  `json:"take_profit_order_id,omitempty"`
	TakeProfitClientOrderID string  `json:"take_profit_client_order_id,omitempty"`

	// Partial exit strategy
	PartialExit              *PartialExitConfig `json:"partial_exit,omitempty"`
	PartialExitOrders        []string           `json:"partial_exit_orders,omitempty"`
	PartialExitClientOrderID string             `json:"partial_exit_client_order_id,omitempty"`
	ProtectionFillWatermarks map[string]float64 `json:"protection_fill_watermarks,omitempty"`

	// Status tracking
	Status         string  `json:"status"` // "PENDING", "ACTIVE", "PARTIAL", "CLOSED", "STOPPED_OUT", "FAILED"
	CurrentPrice   float64 `json:"current_price"`
	UnrealizedPL   float64 `json:"unrealized_pl"`
	UnrealizedPLPC float64 `json:"unrealized_pl_percent"`
	RemainingQty   float64 `json:"remaining_qty"`

	// Metadata
	CreatedAt time.Time  `json:"created_at"`
	UpdatedAt time.Time  `json:"updated_at"`
	ClosedAt  *time.Time `json:"closed_at,omitempty"`
	Notes     string     `json:"notes,omitempty"`
	Tags      []string   `json:"tags,omitempty"`
}

type PositionCloseCapability interface {
	positionCloseIdentity() models.DurableIdentity
}

type operatorPositionCloseCapability struct{ identity models.DurableIdentity }

func (c operatorPositionCloseCapability) positionCloseIdentity() models.DurableIdentity {
	return c.identity
}

func NewPositionCloseCapability(provided string, identity models.DurableIdentity) (PositionCloseCapability, error) {
	expected := strings.TrimSpace(os.Getenv("TRADING_BOT_OPERATOR_TOKEN"))
	if expected == "" || provided == "" || subtle.ConstantTimeCompare([]byte(expected), []byte(provided)) != 1 {
		return nil, fmt.Errorf("position close capability is invalid")
	}
	return operatorPositionCloseCapability{identity: identity}, nil
}

func (pm *PositionManager) OperatorPositionCloseCapability(provided string) (PositionCloseCapability, error) {
	if pm.storageService == nil {
		return nil, fmt.Errorf("position close capability is unavailable")
	}
	return NewPositionCloseCapability(provided, pm.storageService.DurableIdentity())
}

func managedIdentityComplete(identity models.DurableIdentity) bool {
	return strings.TrimSpace(identity.BrokerAccountID) != "" && (identity.PaperLive == "paper" || identity.PaperLive == "live") && strings.TrimSpace(identity.TenantID) != "" && strings.TrimSpace(identity.SandboxID) != ""
}
func managedIdentityMatches(left, right models.DurableIdentity) bool {
	return left.BrokerAccountID == right.BrokerAccountID && left.PaperLive == right.PaperLive && left.TenantID == right.TenantID && left.SandboxID == right.SandboxID
}

// PartialExitConfig defines partial profit taking strategy
type PartialExitConfig struct {
	Enabled       bool    `json:"enabled"`
	Percent       float64 `json:"percent"`        // % of position to exit
	TargetPercent float64 `json:"target_percent"` // % gain to trigger partial exit
	TargetPrice   float64 `json:"target_price"`   // Calculated target price
}

// PlaceManagedPositionRequest represents request to open a managed position
type PlaceManagedPositionRequest struct {
	ClientOrderID     string  `json:"client_order_id"`
	Symbol            string  `json:"symbol" binding:"required"`
	Side              string  `json:"side" binding:"required"` // "buy" or "sell"
	Strategy          string  `json:"strategy"`                // "SWING_TRADE", "LONG_TERM", "DAY_TRADE"
	AllocationDollars float64 `json:"allocation_dollars" binding:"required,gt=0"`

	// Entry configuration
	EntryStrategy string   `json:"entry_strategy"`        // "market", "limit"
	EntryPrice    *float64 `json:"entry_price,omitempty"` // Required for limit orders

	// Risk management (one of these required)
	StopLossPrice   *float64 `json:"stop_loss_price,omitempty"`
	StopLossPercent *float64 `json:"stop_loss_percent,omitempty"`
	TrailingStop    bool     `json:"trailing_stop"`
	TrailingPercent float64  `json:"trailing_percent,omitempty"`

	// Profit targets (one of these required)
	TakeProfitPrice   *float64 `json:"take_profit_price,omitempty"`
	TakeProfitPercent *float64 `json:"take_profit_percent,omitempty"`

	// Partial exit (optional)
	PartialExit *PartialExitConfig `json:"partial_exit,omitempty"`

	// Metadata
	Notes string   `json:"notes,omitempty"`
	Tags  []string `json:"tags,omitempty"`
}

// PositionManager handles automated position management
type PositionManager struct {
	tradingService interfaces.TradingService
	dataService    interfaces.DataService
	storageService *database.LocalStorage

	positions            map[string]*ManagedPosition // position_id -> position
	closeInFlight        map[string]bool
	mu                   sync.RWMutex
	logger               *logrus.Logger
	initializationErr    error
	executionBlocked     bool
	executionBlockReason string

	ctx    context.Context
	cancel context.CancelFunc
}

// NewPositionManager creates a new position manager
func NewPositionManager(
	tradingService interfaces.TradingService,
	dataService interfaces.DataService,
	storageService *database.LocalStorage,
) *PositionManager {
	logger := logrus.New()
	logger.SetFormatter(&logrus.TextFormatter{
		FullTimestamp: true,
	})

	ctx, cancel := context.WithCancel(context.Background())

	pm := &PositionManager{
		tradingService: tradingService,
		dataService:    dataService,
		storageService: storageService,
		positions:      make(map[string]*ManagedPosition),
		closeInFlight:  make(map[string]bool),
		logger:         logger,
		ctx:            ctx,
		cancel:         cancel,
	}

	if storageService == nil {
		pm.initializationErr = fmt.Errorf("storage service is unavailable; position management remains disabled")
		logger.Error(pm.initializationErr)
		return pm
	}
	if markerService, ok := tradingService.(interface{ SetSubmissionMarker(func(string) error) }); ok {
		markerService.SetSubmissionMarker(func(clientOrderID string) error {
			order, err := storageService.GetOrderByClientOrderID(clientOrderID)
			if err != nil {
				return err
			}
			if order == nil {
				return fmt.Errorf("submission intent %q is not durable", clientOrderID)
			}
			order.SubmissionAttempted = true
			return storageService.SaveOrder(order)
		})
	}
	if markerService, ok := tradingService.(interface {
		SetManagedSubmissionMarker(func(string, string, string) error)
	}); ok {
		markerService.SetManagedSubmissionMarker(func(clientOrderID, positionID, role string) error {
			return storageService.MarkManagedSubmissionAttempted(clientOrderID, positionID, role)
		})
	}
	// Load existing positions from database
	if err := pm.loadPositionsFromDB(); err != nil {
		pm.initializationErr = fmt.Errorf("position state initialization failed: %w", err)
		logger.WithError(pm.initializationErr).Error("Failed to load positions from database")
	}

	return pm
}

func (pm *PositionManager) SetExecutionBlocked(blocked bool) {
	pm.mu.Lock()
	pm.executionBlocked = blocked
	if blocked {
		pm.executionBlockReason = "startup-reconciliation"
	} else {
		pm.executionBlockReason = ""
	}
	pm.mu.Unlock()
}

func (pm *PositionManager) blockExecution(reason string) {
	pm.mu.Lock()
	pm.executionBlocked = true
	pm.executionBlockReason = reason
	pm.mu.Unlock()
}

func (pm *PositionManager) clearExecutionBlockIfSafe() {
	pm.mu.Lock()
	defer pm.mu.Unlock()
	if pm.initializationErr != nil || !pm.executionBlocked {
		return
	}
	for _, position := range pm.positions {
		if position == nil || position.Status == "CLOSED" || position.Status == "STOPPED_OUT" {
			continue
		}
		if position.Status != "ACTIVE" || !hasExactlyOneExecutableProtectionLeg(position) {
			return
		}
	}
	pm.executionBlocked = false
	pm.executionBlockReason = ""
}

// hasExactlyOneExecutableProtectionLeg is the fail-closed protection
// readiness contract. A position may have exactly one stop-loss, take-profit,
// or approved partial-exit identity; planned/multiple/malformed legs are not
// executable protection.
func hasExactlyOneExecutableProtectionLeg(position *ManagedPosition) bool {
	if position == nil || position.Status == "PROTECTION_BLOCKED" {
		return false
	}
	legs := 0
	if strings.TrimSpace(position.StopLossOrderID) != "" || strings.TrimSpace(position.StopLossClientOrderID) != "" {
		if strings.TrimSpace(position.StopLossOrderID) == "" && strings.TrimSpace(position.StopLossClientOrderID) == "" {
			return false
		}
		legs++
	}
	if strings.TrimSpace(position.TakeProfitOrderID) != "" || strings.TrimSpace(position.TakeProfitClientOrderID) != "" {
		if strings.TrimSpace(position.TakeProfitOrderID) == "" && strings.TrimSpace(position.TakeProfitClientOrderID) == "" {
			return false
		}
		legs++
	}
	if len(position.PartialExitOrders) > 0 || strings.TrimSpace(position.PartialExitClientOrderID) != "" {
		if len(position.PartialExitOrders) > 1 {
			return false
		}
		if len(position.PartialExitOrders) == 1 && strings.TrimSpace(position.PartialExitOrders[0]) == "" {
			return false
		}
		if len(position.PartialExitOrders) == 0 && strings.TrimSpace(position.PartialExitClientOrderID) == "" {
			return false
		}
		legs++
	}
	return legs == 1
}

func (pm *PositionManager) ExecutionBlocked() bool {
	pm.mu.RLock()
	defer pm.mu.RUnlock()
	return pm.executionBlocked || pm.initializationErr != nil
}

func (pm *PositionManager) ensureReady() error {
	pm.mu.RLock()
	defer pm.mu.RUnlock()
	if pm.executionBlocked {
		return fmt.Errorf("managed execution is blocked until startup order reconciliation succeeds")
	}
	if pm.initializationErr != nil {
		return pm.initializationErr
	}
	return nil
}

func (pm *PositionManager) prepareManagedOrderIdentity(ctx context.Context, clientOrderID string) error {
	if strings.TrimSpace(clientOrderID) == "" {
		return fmt.Errorf("managed order client order ID is required")
	}
	existing, err := pm.storageService.GetOrderByClientOrderID(clientOrderID)
	if err != nil {
		return fmt.Errorf("cannot verify managed order identity: %w", err)
	}
	if existing == nil {
		return nil
	}
	if existing.SubmissionAttempted {
		return &SubmissionUncertainError{Err: fmt.Errorf("managed order client order ID %q already crossed the broker submission boundary; reconcile before retrying", clientOrderID)}
	}
	brokerOrder, brokerErr := pm.tradingService.GetOrderByClientOrderID(ctx, clientOrderID)
	if brokerErr == nil && brokerOrder != nil {
		return fmt.Errorf("managed order client order ID %q is already broker-visible as %q; reconcile before retrying", clientOrderID, brokerOrder.Status)
	}
	if brokerErr != nil && !IsOrderNotFound(brokerErr) {
		return &SubmissionUncertainError{Err: fmt.Errorf("managed order identity %q could not be reconciled: %w", clientOrderID, brokerErr)}
	}
	status := strings.ToLower(existing.Status)
	if status != "pending" && status != "submit_failed" && status != "submission_uncertain" {
		return fmt.Errorf("managed order client order ID %q already has terminal local status %q", clientOrderID, existing.Status)
	}
	return nil
}

func (pm *PositionManager) refreshManagedOrderRevision(order *interfaces.Order) error {
	if order == nil || strings.TrimSpace(order.ClientOrderID) == "" {
		return fmt.Errorf("managed order identity is required")
	}
	persisted, err := pm.storageService.GetOrderByClientOrderID(order.ClientOrderID)
	if err != nil {
		return err
	}
	if persisted == nil {
		return fmt.Errorf("managed order %q is not durable", order.ClientOrderID)
	}
	order.Revision = persisted.Revision
	order.SubmissionAttempted = persisted.SubmissionAttempted
	return nil
}

func bindRecoveredManagedBrokerID(position *ManagedPosition, lookupID, brokerID string) bool {
	if position == nil || strings.TrimSpace(lookupID) == "" || strings.TrimSpace(brokerID) == "" || lookupID == brokerID {
		return false
	}
	switch lookupID {
	case position.EntryClientOrderID:
		position.EntryOrderID = brokerID
	case position.StopLossClientOrderID:
		position.StopLossOrderID = brokerID
	case position.TakeProfitClientOrderID:
		position.TakeProfitOrderID = brokerID
	case position.ExitClientOrderID:
		position.ExitOrderID = brokerID
	case position.PartialExitClientOrderID:
		if len(position.PartialExitOrders) == 0 {
			position.PartialExitOrders = []string{brokerID}
		} else {
			position.PartialExitOrders[0] = brokerID
		}
	default:
		return false
	}
	return true
}
func (pm *PositionManager) persistedManagedOrderQuantity(orderID string) float64 {
	if strings.TrimSpace(orderID) == "" {
		return 0
	}
	if local, err := pm.storageService.GetOrder(orderID); err == nil && local != nil && local.Qty > 0 {
		return local.Qty
	}
	if local, err := pm.storageService.GetOrderByClientOrderID(orderID); err == nil && local != nil && local.Qty > 0 {
		return local.Qty
	}
	return 0
}
func (pm *PositionManager) ensureCloseReady() error {
	pm.mu.RLock()
	defer pm.mu.RUnlock()
	if pm.initializationErr != nil {
		return pm.initializationErr
	}
	if pm.executionBlocked && pm.executionBlockReason != "protection" {
		return fmt.Errorf("managed close is blocked until unresolved broker state is reconciled")
	}
	return nil
}

// PlaceManagedPosition opens a new managed position with automated risk management
func (pm *PositionManager) PlaceManagedPosition(ctx context.Context, req *PlaceManagedPositionRequest) (*ManagedPosition, error) {

	if req == nil {
		return nil, fmt.Errorf("managed position request is required")
	}
	if err := pm.ensureReady(); err != nil {
		return nil, err
	}
	if strings.TrimSpace(req.ClientOrderID) == "" {
		return nil, fmt.Errorf("client_order_id is required for managed entries so retries can be reconciled")
	}
	pm.mu.RLock()
	for _, existing := range pm.positions {
		if existing.EntryClientOrderID == req.ClientOrderID {
			pm.mu.RUnlock()
			return nil, fmt.Errorf("managed client_order_id %q is already bound to position %s", req.ClientOrderID, existing.ID)
		}
	}
	pm.mu.RUnlock()
	pm.logger.WithFields(logrus.Fields{
		"symbol":     req.Symbol,
		"side":       req.Side,
		"allocation": req.AllocationDollars,
	}).Info("Placing managed position")

	// Validate request
	if err := pm.validateRequest(req); err != nil {
		return nil, fmt.Errorf("invalid request: %w", err)
	}

	// Get current price for calculations
	currentPrice, err := pm.getCurrentPrice(ctx, req.Symbol)
	if err != nil {
		return nil, fmt.Errorf("failed to get current price: %w", err)
	}

	// Calculate position parameters
	entryPrice := currentPrice
	if req.EntryPrice != nil {
		entryPrice = *req.EntryPrice
	}

	quantity := pm.calculateQuantity(req.AllocationDollars, entryPrice)

	// Calculate stop loss only when the configured protection leg is stop-based.
	stopLossPrice := 0.0
	stopLossPercent := 0.0
	if req.StopLossPrice != nil || req.StopLossPercent != nil {
		stopLossPrice = pm.calculateStopLoss(entryPrice, req.StopLossPrice, req.StopLossPercent, req.Side)
		stopLossPercent = math.Abs((stopLossPrice - entryPrice) / entryPrice * 100)
	}

	// Calculate take profit only when the configured protection leg is limit-based.
	takeProfitPrice := 0.0
	takeProfitPercent := 0.0
	if req.TakeProfitPrice != nil || req.TakeProfitPercent != nil {
		takeProfitPrice = pm.calculateTakeProfit(entryPrice, req.TakeProfitPrice, req.TakeProfitPercent, req.Side)
		takeProfitPercent = math.Abs((takeProfitPrice - entryPrice) / entryPrice * 100)
	}

	// Calculate partial exit if configured
	if req.PartialExit != nil && req.PartialExit.Enabled {
		req.PartialExit.TargetPrice = pm.calculatePartialExitPrice(entryPrice, req.PartialExit.TargetPercent, req.Side)
	}

	// Create managed position
	position := &ManagedPosition{
		DurableIdentity:    pm.storageService.DurableIdentity(),
		ID:                 pm.generatePositionID(),
		Symbol:             req.Symbol,
		Side:               req.Side,
		Strategy:           req.Strategy,
		Quantity:           quantity,
		EntryPrice:         entryPrice,
		EntryClientOrderID: req.ClientOrderID,
		EntryOrderType:     req.EntryStrategy,
		AllocationDollars:  req.AllocationDollars,
		StopLossPrice:      stopLossPrice,
		StopLossPercent:    stopLossPercent,
		TrailingStop:       req.TrailingStop,
		TrailingPercent:    req.TrailingPercent,
		TakeProfitPrice:    takeProfitPrice,
		TakeProfitPercent:  takeProfitPercent,
		PartialExit:        req.PartialExit,
		Status:             "PENDING",
		CurrentPrice:       currentPrice,
		RemainingQty:       quantity,
		CreatedAt:          time.Now(),
		UpdatedAt:          time.Now(),
		Notes:              req.Notes,
		Tags:               req.Tags,
	}

	// Persist the position-to-client identity before any broker submission.
	position.EntryOrderID = position.EntryClientOrderID
	if err := pm.savePositionToDB(position); err != nil {
		return nil, fmt.Errorf("failed to persist managed position intent: %w", err)
	}

	// Place entry order
	if err := pm.placeEntryOrder(ctx, position); err != nil {
		_ = pm.savePositionToDB(position)
		return nil, fmt.Errorf("failed to place entry order: %w", err)
	}

	// Store position
	pm.mu.Lock()
	pm.positions[position.ID] = position
	pm.mu.Unlock()

	// Save to database
	if err := pm.savePositionToDB(position); err != nil {
		pm.logger.WithError(err).Error("Failed to save position after broker entry; blocking managed execution")
		pm.blockExecution("persistence")
		return nil, fmt.Errorf("broker entry is unresolved because position persistence failed: %w", err)
	}

	pm.logger.WithFields(logrus.Fields{
		"position_id":       position.ID,
		"entry_order_id":    position.EntryOrderID,
		"quantity":          quantity,
		"entry_price":       entryPrice,
		"stop_loss":         stopLossPrice,
		"take_profit":       takeProfitPrice,
		"risk_reward_ratio": takeProfitPercent / stopLossPercent,
	}).Info("Managed position created")

	return position, nil
}

func (pm *PositionManager) saveManagedOrderProjection(positionID, role string, order *interfaces.Order, lifecycle string) error {
	if pm.storageService == nil || order == nil {
		return fmt.Errorf("managed order projection storage is unavailable")
	}
	order.ManagedPositionID = positionID
	order.ManagedRole = role
	projection, err := pm.storageService.GetManagedOrder(order.ClientOrderID)
	if err != nil {
		return err
	}
	if projection == nil {
		projection = &models.DBManagedOrder{
			PositionID:    positionID,
			Role:          role,
			Purpose:       order.Purpose,
			ClientOrderID: order.ClientOrderID,
			Revision:      0,
		}
	}
	projection.BrokerOrderID = order.ID
	projection.DurableIdentity = pm.storageService.DurableIdentity()
	projection.Symbol = order.Symbol
	projection.Side = order.Side
	projection.AssetClass = order.AssetClass
	projection.Underlying = order.Underlying
	projection.PositionIntent = order.PositionIntent
	projection.OrderType = order.Type
	projection.TimeInForce = order.TimeInForce
	projection.RequestedQty = order.Qty
	projection.FilledQty = order.FilledQty
	projection.FilledAvgPrice = order.FilledAvgPrice
	if order.FilledQty > projection.FillWatermark {
		projection.FillWatermark = order.FilledQty
	}
	projection.LimitPrice = order.LimitPrice
	projection.StopPrice = order.StopPrice
	projection.Lifecycle = lifecycle
	projection.SubmissionAttempted = order.SubmissionAttempted
	projection.SubmittedAt = &order.SubmittedAt
	projection.FilledAt = order.FilledAt
	projection.CanceledAt = order.CanceledAt
	return pm.storageService.SaveManagedOrder(projection)
}

// placeEntryOrder places the initial entry order
func (pm *PositionManager) placeEntryOrder(ctx context.Context, position *ManagedPosition) error {
	orderType := "market"
	if position.EntryOrderType == "limit" {
		orderType = "limit"
	}

	clientOrderID := strings.TrimSpace(position.EntryClientOrderID)
	if clientOrderID == "" {
		return fmt.Errorf("managed entry client order ID is required")
	}
	if err := pm.prepareManagedOrderIdentity(ctx, clientOrderID); err != nil {
		return err
	}

	order := &interfaces.Order{
		ClientOrderID: clientOrderID,
		Symbol:        position.Symbol,
		Qty:           position.Quantity,
		Side:          position.Side,
		Type:          orderType,
		TimeInForce:   "gtc",
		Status:        "pending",
		Purpose:       "entry",
		SubmittedAt:   time.Now(),
	}

	if orderType == "limit" {
		order.LimitPrice = &position.EntryPrice
	}

	if err := pm.storageService.SaveOrder(order); err != nil {
		pm.logger.WithError(err).Error("Failed to persist managed position entry order intent")
		return err
	}
	if err := pm.saveManagedOrderProjection(position.ID, "entry", order, "planned"); err != nil {
		pm.logger.WithError(err).Error("Failed to persist managed entry projection")
		return err
	}
	position.EntryOrderID = clientOrderID

	if err := pm.saveManagedOrderProjection(position.ID, "entry", order, "submitting"); err != nil {
		return err
	}
	pm.bindManagedOrderIdentity(order)
	result, err := pm.tradingService.PlaceOrder(ctx, order)
	if refreshErr := pm.refreshManagedOrderRevision(order); refreshErr != nil {
		return &SubmissionUncertainError{Err: fmt.Errorf("managed entry state could not be reloaded after submission attempt: %w", refreshErr)}
	}
	if err != nil {
		order.Status = "submit_failed"
		if IsSubmissionUncertain(err) {
			order.Status = "submission_uncertain"
		}
		if saveErr := pm.storageService.SaveOrder(order); saveErr != nil {
			pm.logger.WithError(saveErr).Warn("Failed to record managed position entry submission failure")
		}
		_ = pm.saveManagedOrderProjection(position.ID, "entry", order, order.Status)
		return err
	}

	if resultErr := validateManagedOrderResult(result, order); resultErr != nil {
		order.Status = "submission_uncertain"
		if saveErr := pm.storageService.SaveOrder(order); saveErr != nil {
			pm.logger.WithError(saveErr).Warn("Failed to record uncertain managed order result")
		}
		_ = pm.saveManagedOrderProjection(position.ID, "entry", order, order.Status)
		return resultErr
	}
	applyManagedOrderResult(order, result)
	if err := pm.storageService.SaveOrder(order); err != nil {
		pm.logger.WithError(err).Error("Failed to update managed position entry order after submission")
		pm.blockExecution("persistence")
		return fmt.Errorf("managed entry persistence is unresolved: %w", err)
	}
	if err := pm.saveManagedOrderProjection(position.ID, "entry", order, order.Status); err != nil {
		pm.blockExecution("persistence")
		return fmt.Errorf("managed entry projection is unresolved: %w", err)
	}

	position.EntryOrderID = result.OrderID
	position.Status = "PENDING"

	return nil
}

// MonitorPositions monitors all active positions and manages risk
func (pm *PositionManager) ReconcilePersistedPositions(ctx context.Context) int {
	pm.mu.RLock()
	initializationErr := pm.initializationErr
	pm.mu.RUnlock()
	if initializationErr != nil {
		return 1
	}
	pm.mu.RLock()
	positions := make([]*ManagedPosition, 0, len(pm.positions))
	for _, position := range pm.positions {
		positions = append(positions, position)
	}
	pm.mu.RUnlock()

	skipped := 0
	for _, position := range positions {
		if position.Status == "CLOSED" || position.Status == "CANCELLED" {
			continue
		}
		valid := true
		type recoveredManagedOrder struct {
			identifier string
			clientID   string
			purpose    string
			exit       bool
		}
		orders := []recoveredManagedOrder{{
			identifier: preferredManagedOrderID(position.EntryOrderID, position.EntryClientOrderID),
			clientID:   position.EntryClientOrderID,
			purpose:    "entry",
		}}
		{
			protectionCount := 0
			if position.StopLossOrderID != "" || position.StopLossClientOrderID != "" {
				protectionCount++
				orders = append(orders, recoveredManagedOrder{preferredManagedOrderID(position.StopLossOrderID, position.StopLossClientOrderID), position.StopLossClientOrderID, "protection", true})
			}
			if position.TakeProfitOrderID != "" || position.TakeProfitClientOrderID != "" {
				protectionCount++
				orders = append(orders, recoveredManagedOrder{preferredManagedOrderID(position.TakeProfitOrderID, position.TakeProfitClientOrderID), position.TakeProfitClientOrderID, "protection", true})
			}
			if len(position.PartialExitOrders) > 0 || position.PartialExitClientOrderID != "" {
				protectionCount++
				identifier := ""
				if len(position.PartialExitOrders) > 0 {
					identifier = position.PartialExitOrders[0]
				}
				if identifier == "" {
					identifier = position.PartialExitClientOrderID
				}
				orders = append(orders, recoveredManagedOrder{identifier, position.PartialExitClientOrderID, "protection", true})
			}
			if protectionCount > 0 && protectionCount != 1 {
				valid = false
			}
			if position.ExitOrderID != "" || position.ExitClientOrderID != "" {
				orders = append(orders, recoveredManagedOrder{preferredManagedOrderID(position.ExitOrderID, position.ExitClientOrderID), position.ExitClientOrderID, "close", true})
			}
		}
		for _, recovered := range orders {
			if recovered.identifier == "" || recovered.clientID == "" {
				valid = false
				break
			}
			projection, projectionErr := pm.storageService.GetManagedOrder(recovered.clientID)
			if projectionErr != nil || projection == nil || projection.PositionID != position.ID || projection.Role == "" || projection.Purpose != recovered.purpose || projection.ClientOrderID != recovered.clientID || projection.Symbol != position.Symbol || projection.RequestedQty <= 0 {
				valid = false
				break
			}
			brokerOrder, err := pm.getManagedOrder(ctx, recovered.identifier)
			if err != nil || brokerOrder == nil {
				valid = false
				break
			}
			if err := validateManagedOrderProjection(projection, brokerOrder); err != nil {
				valid = false
				break
			}
			projection.BrokerOrderID = brokerOrder.ID
			projection.FilledQty = math.Max(projection.FilledQty, brokerOrder.FilledQty)
			projection.FillWatermark = math.Max(projection.FillWatermark, brokerOrder.FilledQty)
			projection.Lifecycle = strings.ToLower(brokerOrder.Status)
			if brokerOrder.FilledAvgPrice != nil {
				projection.FilledAvgPrice = brokerOrder.FilledAvgPrice
			}
			if saveProjectionErr := pm.storageService.SaveManagedOrder(projection); saveProjectionErr != nil {
				valid = false
				break
			}
			if brokerOrder.ID != "" && bindRecoveredManagedBrokerID(position, recovered.identifier, brokerOrder.ID) {
				if saveErr := pm.savePositionToDB(position); saveErr != nil {
					valid = false
					break
				}
			}
		}
		if position.Status == "PENDING" && position.EntryRemainingQty <= 0 && position.StopLossOrderID == "" && position.StopLossClientOrderID == "" && position.TakeProfitOrderID == "" && position.TakeProfitClientOrderID == "" && len(position.PartialExitOrders) == 0 && position.PartialExitClientOrderID == "" {
			valid = false
		}
		if !valid {
			skipped++
		}
	}
	return skipped
}

func (pm *PositionManager) MonitorPositions(ctx context.Context) {
	if err := pm.ensureReady(); err != nil {
		pm.logger.WithError(err).Error("Managed position monitoring disabled")
		return
	}
	ticker := time.NewTicker(10 * time.Second) // Check every 10 seconds
	defer ticker.Stop()

	pm.logger.Info("Position monitoring started")

	for {
		select {
		case <-ctx.Done():
			pm.logger.Info("Position monitoring stopped")
			return
		case <-ticker.C:
			pm.checkPositions(ctx)
		}
	}
}

// checkPositions checks all positions and manages their risk orders
func (pm *PositionManager) checkPositions(ctx context.Context) {
	pm.mu.RLock()
	positions := make([]*ManagedPosition, 0, len(pm.positions))
	for _, pos := range pm.positions {
		positions = append(positions, pos)
	}
	pm.mu.RUnlock()
	for _, position := range positions {
		if !pm.beginPositionOperation(position.ID) {
			continue
		}
		pm.processPosition(ctx, position)
		pm.endPositionOperation(position.ID)
	}
}

func (pm *PositionManager) beginPositionOperation(positionID string) bool {
	pm.mu.Lock()
	defer pm.mu.Unlock()
	if pm.closeInFlight[positionID] {
		return false
	}
	pm.closeInFlight[positionID] = true
	return true
}

func (pm *PositionManager) endPositionOperation(positionID string) {
	pm.mu.Lock()
	delete(pm.closeInFlight, positionID)
	pm.mu.Unlock()
}

func (pm *PositionManager) processPosition(ctx context.Context, position *ManagedPosition) {
	if position.Status == "CLOSED" || position.Status == "STOPPED_OUT" {
		return
	}
	if position.Status == "CLOSING" {
		pm.reconcileClosingPosition(ctx, position)
		return
	}
	if position.Status == "PROTECTION_BLOCKED" {
		if position.RemainingQty <= 0 {
			position.Status = "CLOSED"
			_ = pm.savePositionToDB(position)
			return
		}
		if position.StopLossOrderID != "" || position.TakeProfitOrderID != "" || len(position.PartialExitOrders) > 0 {
			if err := pm.reconcileSiblingExitOrders(ctx, position); err != nil {
				pm.logger.WithError(err).Error("Protection recovery could not reconcile existing sibling orders")
				return
			}
			if position.StopLossOrderID != "" || position.TakeProfitOrderID != "" || len(position.PartialExitOrders) > 0 {
				_ = pm.savePositionToDB(position)
				return
			}
		}
		if err := pm.placeRiskOrders(ctx, position); err != nil {
			pm.logger.WithError(err).Error("Protection recovery remains blocked")
			return
		}
		position.Status = "ACTIVE"
		if err := pm.savePositionToDB(position); err != nil {
			pm.logger.WithError(err).Error("Failed to persist recovered protection")
		}
		pm.clearExecutionBlockIfSafe()
		return
	}
	if position.Status == "PENDING" {
		// A partially filled entry can already have executable protection. Reconcile
		// that protection before polling the entry again so fills cannot be lost.
		if position.StopLossOrderID != "" || position.TakeProfitOrderID != "" || len(position.PartialExitOrders) > 0 {
			pm.manageRiskOrders(ctx, position)
		}
		pm.checkEntryOrder(ctx, position)
		return
	}
	if err := pm.updatePositionPrice(ctx, position); err != nil {
		pm.logger.WithError(err).WithField("symbol", position.Symbol).Error("Failed to update position price")
		return
	}
	if position.Status == "ACTIVE" {
		pm.manageRiskOrders(ctx, position)
	}
	if position.TrailingStop {
		pm.updateTrailingStop(ctx, position)
	}
}

func clearProtectionIdentity(position *ManagedPosition, orderID string) {
	if position.StopLossOrderID == orderID || position.StopLossClientOrderID == orderID {
		position.StopLossOrderID = ""
		position.StopLossClientOrderID = ""
	}
	if position.TakeProfitOrderID == orderID || position.TakeProfitClientOrderID == orderID {
		position.TakeProfitOrderID = ""
		position.TakeProfitClientOrderID = ""
	}
	if position.PartialExitClientOrderID == orderID {
		position.PartialExitClientOrderID = ""
	}
	for _, partialID := range position.PartialExitOrders {
		if partialID == orderID {
			position.PartialExitClientOrderID = ""
			break
		}
	}
}

func managedOrderIdentityMatches(order *interfaces.Order, brokerOrderID, clientOrderID string) bool {
	if order == nil {
		return false
	}
	if brokerOrderID != "" && strings.TrimSpace(order.ID) != strings.TrimSpace(brokerOrderID) {
		return false
	}
	if clientOrderID != "" && strings.TrimSpace(order.ClientOrderID) != strings.TrimSpace(clientOrderID) {
		return false
	}
	return brokerOrderID != "" || clientOrderID != ""
}

func validateManagedBrokerOrder(position *ManagedPosition, order *interfaces.Order, expectedClientOrderID string, exit bool, expectedPurpose string) error {
	if position == nil || order == nil {
		return fmt.Errorf("managed broker order is missing")
	}
	if strings.TrimSpace(expectedClientOrderID) == "" {
		return fmt.Errorf("managed broker client order identity is unavailable")
	}
	if !strings.EqualFold(strings.TrimSpace(position.Symbol), strings.TrimSpace(order.Symbol)) {
		return fmt.Errorf("managed broker symbol mismatch: got %q want %q", order.Symbol, position.Symbol)
	}
	if expectedClientOrderID != "" && order.ClientOrderID != expectedClientOrderID {
		return fmt.Errorf("managed broker client order ID mismatch")
	}
	if strings.TrimSpace(order.Purpose) != expectedPurpose {
		return fmt.Errorf("managed broker purpose mismatch: got %q want %q", order.Purpose, expectedPurpose)
	}
	orderType := strings.ToLower(strings.TrimSpace(order.Type))
	timeInForce := strings.ToLower(strings.TrimSpace(order.TimeInForce))
	switch expectedPurpose {
	case "entry":
		if strings.TrimSpace(position.EntryOrderType) != "" && orderType != strings.ToLower(strings.TrimSpace(position.EntryOrderType)) {
			return fmt.Errorf("managed entry order type mismatch: got %q want %q", order.Type, position.EntryOrderType)
		}
		if timeInForce != "gtc" {
			return fmt.Errorf("managed entry time-in-force mismatch: got %q want gtc", order.TimeInForce)
		}
		if orderType == "limit" && (order.LimitPrice == nil || math.Abs(*order.LimitPrice-position.EntryPrice) > 1e-9) {
			return fmt.Errorf("managed entry limit price mismatch")
		}
	case "protection":
		if orderType != "stop" && orderType != "limit" {
			return fmt.Errorf("managed protection order type %q is not executable protection", order.Type)
		}
		if timeInForce != "gtc" {
			return fmt.Errorf("managed protection time-in-force mismatch: got %q want gtc", order.TimeInForce)
		}
		if orderType == "stop" && (order.StopPrice == nil || math.Abs(*order.StopPrice-position.StopLossPrice) > 1e-9) {
			return fmt.Errorf("managed stop-loss price mismatch")
		}
		if orderType == "limit" && (order.LimitPrice == nil || (position.TakeProfitPrice <= 0 && (position.PartialExit == nil || position.PartialExit.TargetPrice <= 0))) {
			return fmt.Errorf("managed limit protection price is unavailable")
		}
		if orderType == "limit" && position.TakeProfitPrice > 0 && math.Abs(*order.LimitPrice-position.TakeProfitPrice) > 1e-9 && (position.PartialExit == nil || position.PartialExit.TargetPrice <= 0 || math.Abs(*order.LimitPrice-position.PartialExit.TargetPrice) > 1e-9) {
			return fmt.Errorf("managed limit protection price mismatch")
		}
	case "close":
		if orderType != "market" || timeInForce != "day" {
			return fmt.Errorf("managed close contract mismatch: type=%q time_in_force=%q", order.Type, order.TimeInForce)
		}
	}
	expectedSide := strings.ToLower(strings.TrimSpace(position.Side))
	if expectedSide == "long" {
		expectedSide = "buy"
	} else if expectedSide == "short" {
		expectedSide = "sell"
	}
	if exit {
		if expectedSide == "buy" {
			expectedSide = "sell"
		} else if expectedSide == "sell" {
			expectedSide = "buy"
		}
	}
	if strings.ToLower(strings.TrimSpace(order.Side)) != expectedSide {
		return fmt.Errorf("managed broker side mismatch: got %q want %q", order.Side, expectedSide)
	}
	if order.Qty <= 0 || order.Qty > position.Quantity+1e-9 {
		return fmt.Errorf("managed broker quantity %.4f is outside position quantity %.4f", order.Qty, position.Quantity)
	}
	if err := ValidateBrokerOrderState(order, order.Qty); err != nil {
		return fmt.Errorf("managed broker lifecycle validation failed: %w", err)
	}
	return nil
}

// validateManagedOrderProjection is the single recovery/readback contract for
// managed orders. Position fields are only a convenience projection; the
// role-specific durable row owns quantity and the immutable order contract.
func validateManagedOrderProjection(projection *models.DBManagedOrder, order *interfaces.Order) error {
	if projection == nil || order == nil {
		return fmt.Errorf("managed order projection or broker order is missing")
	}
	if strings.TrimSpace(projection.ClientOrderID) == "" || order.ClientOrderID != projection.ClientOrderID {
		return fmt.Errorf("managed broker client order identity mismatch")
	}
	if projection.BrokerOrderID != "" && order.ID != projection.BrokerOrderID {
		return fmt.Errorf("managed broker order identity mismatch")
	}
	if order.ID == "" || order.Symbol != projection.Symbol || order.Side != projection.Side ||
		order.Qty != projection.RequestedQty || order.Type != projection.OrderType ||
		order.TimeInForce != projection.TimeInForce || order.Purpose != projection.Purpose ||
		order.AssetClass != projection.AssetClass || order.Underlying != projection.Underlying ||
		order.PositionIntent != projection.PositionIntent {
		return fmt.Errorf("managed broker order contract identity mismatch")
	}
	if !managedFloatEqual(order.LimitPrice, projection.LimitPrice) || !managedFloatEqual(order.StopPrice, projection.StopPrice) {
		return fmt.Errorf("managed broker order price identity mismatch")
	}
	identity := models.DurableIdentity{BrokerAccountID: order.BrokerAccountID, PaperLive: order.PaperLive, TenantID: order.TenantID, SandboxID: order.SandboxID}
	if identity != projection.DurableIdentity {
		return fmt.Errorf("managed broker order durable identity mismatch")
	}
	if err := ValidateBrokerOrderState(order, projection.RequestedQty); err != nil {
		return fmt.Errorf("managed broker lifecycle validation failed: %w", err)
	}
	return nil
}

func managedFloatEqual(left, right *float64) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return math.Abs(*left-*right) <= 1e-9
}

func (pm *PositionManager) getManagedOrder(ctx context.Context, identifier string) (*interfaces.Order, error) {
	if strings.TrimSpace(identifier) == "" {
		return nil, fmt.Errorf("managed order identity is required")
	}
	clientOrder, clientErr := pm.tradingService.GetOrderByClientOrderID(ctx, identifier)
	if clientErr == nil && clientOrder != nil {
		return clientOrder, nil
	}
	if clientErr != nil && !IsOrderNotFound(clientErr) {
		return nil, clientErr
	}
	return pm.tradingService.GetOrder(ctx, identifier)
}

func preferredManagedOrderID(brokerOrderID, clientOrderID string) string {
	if strings.TrimSpace(brokerOrderID) != "" {
		return brokerOrderID
	}
	return strings.TrimSpace(clientOrderID)
}

func (pm *PositionManager) reconcileSiblingExitOrders(ctx context.Context, position *ManagedPosition) error {
	ids := []string{}
	appendUnique := func(id string) {
		if id == "" {
			return
		}
		for _, existing := range ids {
			if existing == id {
				return
			}
		}
		ids = append(ids, id)
	}
	appendUnique(preferredManagedOrderID(position.StopLossOrderID, position.StopLossClientOrderID))
	appendUnique(preferredManagedOrderID(position.TakeProfitOrderID, position.TakeProfitClientOrderID))
	for _, orderID := range position.PartialExitOrders {
		appendUnique(orderID)
	}
	appendUnique(position.PartialExitClientOrderID)
	remainingIDs := make([]string, 0, len(ids))
	stopRemaining, takeRemaining := "", ""
	for _, orderID := range ids {
		order, err := pm.getManagedOrder(ctx, orderID)
		if err != nil || order == nil {
			return fmt.Errorf("protection order %s is unresolved: %w", orderID, err)
		}
		expectedClientOrderID := ""
		if orderID == position.StopLossOrderID || orderID == position.StopLossClientOrderID {
			expectedClientOrderID = position.StopLossClientOrderID
		} else if orderID == position.TakeProfitOrderID || orderID == position.TakeProfitClientOrderID {
			expectedClientOrderID = position.TakeProfitClientOrderID
		} else if orderID == position.PartialExitClientOrderID {
			expectedClientOrderID = position.PartialExitClientOrderID
		}
		brokerOrderID := ""
		if expectedClientOrderID == "" {
			brokerOrderID = orderID
		} else if orderID == position.StopLossOrderID || orderID == position.TakeProfitOrderID {
			brokerOrderID = orderID
		}
		if !managedOrderIdentityMatches(order, brokerOrderID, expectedClientOrderID) {
			return fmt.Errorf("protection order %s returned mismatched broker/client identity", orderID)
		}
		if err := validateManagedBrokerOrder(position, order, expectedClientOrderID, true, "protection"); err != nil {
			return fmt.Errorf("protection order %s failed identity validation: %w", orderID, err)
		}
		status := strings.ToLower(order.Status)
		terminal := status == "filled" || status == "canceled" || status == "cancelled" || status == "rejected" || status == "expired" || status == "done_for_day" || status == "replaced"
		if !terminal {
			if orderID == position.StopLossOrderID || orderID == position.StopLossClientOrderID {
				stopRemaining = orderID
			} else if orderID == position.TakeProfitOrderID || orderID == position.TakeProfitClientOrderID {
				takeRemaining = orderID
			} else {
				remainingIDs = append(remainingIDs, orderID)
			}
			continue
		}
		clearProtectionIdentity(position, orderID)
		fillDelta := pm.applyProtectionFillWatermark(position, order)
		if fillDelta > 0 {
			position.RemainingQty = math.Max(0, position.RemainingQty-fillDelta)
			position.ExitFilledQty += fillDelta
		}
	}
	position.StopLossOrderID = stopRemaining
	position.TakeProfitOrderID = takeRemaining
	position.PartialExitOrders = remainingIDs
	if position.RemainingQty < 0.000001 {
		position.RemainingQty = 0
	}
	return nil
}

// reconcileClosingPosition resolves a close after an accepted or ambiguous submission.
func (pm *PositionManager) reconcileClosingPosition(ctx context.Context, position *ManagedPosition) {
	if position.ExitOrderID == "" {
		hadSiblingOrders := position.StopLossOrderID != "" || position.TakeProfitOrderID != "" || len(position.PartialExitOrders) > 0
		if hadSiblingOrders {
			if err := pm.reconcileSiblingExitOrders(ctx, position); err != nil {
				_ = pm.savePositionToDB(position)
				return
			}
			if len(position.PartialExitOrders) > 0 {
				_ = pm.savePositionToDB(position)
				return
			}
			if position.RemainingQty > 0 {
				position.Status = "PROTECTION_BLOCKED"
				pm.blockExecution("protection")
				_ = pm.savePositionToDB(position)
				return
			}
			position.Status = "CLOSED"
			position.ClosedAt = func() *time.Time { now := time.Now(); return &now }()
			_ = pm.savePositionToDB(position)
			return
		}
		if position.EntryOrderID == "" {
			if position.RemainingQty > 0 {
				position.Status = "PROTECTION_BLOCKED"
				pm.blockExecution("protection")
				_ = pm.savePositionToDB(position)
			}
			return
		}
		entry, entryErr := pm.getManagedOrder(ctx, position.EntryOrderID)
		if entryErr != nil || entry == nil {
			return
		}
		if err := validateManagedBrokerOrder(position, entry, position.EntryClientOrderID, false, "entry"); err != nil {
			pm.logger.WithError(err).Error("Managed entry identity validation failed during close reconciliation")
			return
		}
		status := strings.ToLower(entry.Status)
		if status == "filled" || status == "partially_filled" {
			position.Status = "ACTIVE"
			position.RemainingQty = entry.FilledQty
			position.EntryRemainingQty = math.Max(0, entry.Qty-entry.FilledQty)
			position.StopLossOrderID, position.TakeProfitOrderID = "", ""
			position.PartialExitOrders = nil
			if err := pm.savePositionToDB(position); err == nil {
				pm.placeRiskOrders(ctx, position)
				_ = pm.savePositionToDB(position)
			}
		} else if status == "canceled" || status == "cancelled" || status == "rejected" || status == "expired" || status == "done_for_day" || status == "replaced" {
			if entry.FilledQty > 0 {
				position.Status = "ACTIVE"
				position.RemainingQty = entry.FilledQty
				position.EntryRemainingQty = 0
				position.StopLossOrderID, position.TakeProfitOrderID = "", ""
				position.PartialExitOrders = nil
				if err := pm.savePositionToDB(position); err == nil {
					pm.placeRiskOrders(ctx, position)
					_ = pm.savePositionToDB(position)
				}
			} else {
				position.Status, position.RemainingQty = "CLOSED", 0
				position.EntryRemainingQty = 0
				position.StopLossOrderID, position.TakeProfitOrderID = "", ""
				position.PartialExitOrders = nil
				now := time.Now()
				position.ClosedAt = &now
				_ = pm.savePositionToDB(position)
			}
		}
		return
	}
	order, err := pm.getManagedOrder(ctx, position.ExitOrderID)
	if err != nil || order == nil {
		return
	}
	if err := validateManagedBrokerOrder(position, order, position.ExitClientOrderID, true, "close"); err != nil {
		pm.logger.WithError(err).Error("Managed exit identity validation failed")
		return
	}
	if position.ExitFillWatermarks == nil {
		position.ExitFillWatermarks = make(map[string]float64)
	}
	previousExitFill := position.ExitFillWatermarks[position.ExitOrderID]
	newExitFill := math.Max(0, order.FilledQty-previousExitFill)
	position.ExitFillWatermarks[position.ExitOrderID] = math.Max(previousExitFill, order.FilledQty)
	switch strings.ToLower(order.Status) {
	case "filled":
		position.ExitFilledQty += newExitFill
		position.RemainingQty = math.Max(0, position.RemainingQty-newExitFill)
		position.Status = "CLOSED"
		position.StopLossOrderID = ""
		position.TakeProfitOrderID = ""
		position.PartialExitOrders = nil
		now := time.Now()
		position.ClosedAt = &now
		if err := pm.savePositionToDB(position); err != nil {
			pm.logger.WithError(err).Error("Failed to persist reconciled close")
		}
	case "partially_filled":
		position.ExitFilledQty += newExitFill
		position.RemainingQty = math.Max(0, position.RemainingQty-newExitFill)
		if position.RemainingQty == 0 {
			position.Status = "CLOSED"
			position.StopLossOrderID = ""
			position.TakeProfitOrderID = ""
			position.PartialExitOrders = nil
			now := time.Now()
			position.ClosedAt = &now
			if err := pm.savePositionToDB(position); err != nil {
				pm.logger.WithError(err).Error("Failed to persist completed partial close")
			}
		} else if err := pm.savePositionToDB(position); err != nil {
			pm.logger.WithError(err).Error("Failed to persist partial close")
		}
		return
	case "canceled", "cancelled", "rejected", "expired", "done_for_day", "replaced":
		position.ExitFilledQty += newExitFill
		position.RemainingQty = math.Max(0, position.RemainingQty-newExitFill)
		if position.RemainingQty == 0 {
			position.Status = "CLOSED"
			position.StopLossOrderID = ""
			position.TakeProfitOrderID = ""
			position.PartialExitOrders = nil
			position.ExitOrderID = ""
			now := time.Now()
			position.ClosedAt = &now
		} else {
			position.Status = "ACTIVE"
			if position.RemainingQty < position.Quantity {
				position.Status = "PARTIAL"
			}
			position.ExitOrderID = ""
			position.ExitClientOrderID = ""
			position.StopLossOrderID = ""
			position.TakeProfitOrderID = ""
			position.PartialExitOrders = nil
			if err := pm.savePositionToDB(position); err == nil {
				pm.placeRiskOrders(ctx, position)
				if err := pm.savePositionToDB(position); err != nil {
					pm.logger.WithError(err).Error("Failed to persist recreated protection")
				}
			} else {
				pm.logger.WithError(err).Error("Failed to persist reopened position")
			}
			return
		}
		if err := pm.savePositionToDB(position); err != nil {
			pm.logger.WithError(err).Error("Failed to persist reconciled close")
		}
	}
}

func (pm *PositionManager) resizeProtectionForEntry(ctx context.Context, position *ManagedPosition) error {
	orderID := position.StopLossOrderID
	clientID := position.StopLossClientOrderID
	if orderID == "" {
		orderID = position.TakeProfitOrderID
		clientID = position.TakeProfitClientOrderID
	}
	if orderID == "" && len(position.PartialExitOrders) > 0 {
		orderID = position.PartialExitOrders[0]
		clientID = position.PartialExitClientOrderID
	}
	if orderID == "" {
		return nil
	}
	order, err := pm.storageService.GetOrder(orderID)
	if err != nil || order == nil {
		return fmt.Errorf("cannot verify persisted protection quantity for %s", orderID)
	}
	if order.Qty >= position.RemainingQty {
		return nil
	}
	if err := pm.tradingService.CancelOrder(ctx, orderID); err != nil {
		return fmt.Errorf("failed to cancel undersized protection %s: %w", orderID, err)
	}
	brokerOrder, err := pm.tradingService.GetOrder(ctx, orderID)
	if err != nil || brokerOrder == nil {
		return fmt.Errorf("cannot verify cancellation of undersized protection %s", orderID)
	}
	switch strings.ToLower(brokerOrder.Status) {
	case "canceled", "cancelled", "rejected", "expired", "done_for_day", "replaced":
	default:
		return fmt.Errorf("undersized protection %s remains non-terminal after cancellation", orderID)
	}
	if position.StopLossOrderID == orderID || position.StopLossClientOrderID == clientID {
		position.StopLossOrderID, position.StopLossClientOrderID = "", ""
	}
	if position.TakeProfitOrderID == orderID || position.TakeProfitClientOrderID == clientID {
		position.TakeProfitOrderID, position.TakeProfitClientOrderID = "", ""
	}
	position.PartialExitOrders = nil
	position.PartialExitClientOrderID = ""
	return nil
}

// checkEntryOrder checks if entry order has filled
func (pm *PositionManager) checkEntryOrder(ctx context.Context, position *ManagedPosition) {
	order, err := pm.getManagedOrder(ctx, position.EntryOrderID)
	if err != nil || order == nil {
		return
	}
	if err := validateManagedBrokerOrder(position, order, position.EntryClientOrderID, false, "entry"); err != nil {
		pm.logger.WithError(err).Error("Managed entry identity validation failed")
		return
	}
	status := strings.ToLower(order.Status)
	if status == "filled" || status == "partially_filled" || status == "canceled" || status == "cancelled" || status == "rejected" || status == "expired" || status == "done_for_day" || status == "replaced" {
		filledQty := math.Max(0, math.Min(position.Quantity, order.FilledQty))
		if filledQty > 0 {
			position.EntryRemainingQty = math.Max(0, order.Qty-order.FilledQty)
			position.Status = "ACTIVE"
			if position.EntryRemainingQty > 0 && status == "partially_filled" {
				position.Status = "PENDING"
			}
			position.RemainingQty = filledQty
			if order.FilledAvgPrice != nil {
				position.EntryPrice = *order.FilledAvgPrice
			}
			position.UpdatedAt = time.Now()
			if err := pm.resizeProtectionForEntry(ctx, position); err != nil {
				position.Status = "PROTECTION_BLOCKED"
				pm.blockExecution("protection")
				_ = pm.savePositionToDB(position)
				return
			}
			if err := pm.placeRiskOrders(ctx, position); err != nil {
				position.Status = "PROTECTION_BLOCKED"
				pm.blockExecution("protection")
			}
			if err := pm.savePositionToDB(position); err != nil {
				pm.logger.WithError(err).Error("Failed to persist reconciled entry")
			}
		} else if status != "partially_filled" {
			position.Status, position.RemainingQty = "CLOSED", 0
			now := time.Now()
			position.ClosedAt = &now
			if err := pm.savePositionToDB(position); err != nil {
				pm.logger.WithError(err).Error("Failed to persist canceled entry")
			}
		}
	}
}

// placeRiskOrders places exactly one executable protection leg. Alpaca does not
// provide a durable OCO reservation for these independent legs, so submitting
// stop, take-profit, and partial exits concurrently could over-execute a position.
// The monitor may replace the leg only after cancellation is confirmed.
func (pm *PositionManager) placeRiskOrders(ctx context.Context, position *ManagedPosition) error {
	configuredLegs := 0
	if position.StopLossPrice > 0 {
		configuredLegs++
	}
	if position.TakeProfitPrice > 0 {
		configuredLegs++
	}
	if configuredLegs > 1 {
		return fmt.Errorf("managed position requires exactly one executable protection leg; durable OCO is unavailable")
	}
	if position.StopLossOrderID != "" || position.TakeProfitOrderID != "" || len(position.PartialExitOrders) > 0 {
		return nil
	}

	var place func(context.Context, *ManagedPosition) error
	switch {
	case position.StopLossPrice > 0:
		place = pm.placeStopLossOrder
	case position.TakeProfitPrice > 0:
		place = pm.placeTakeProfitOrder
	case position.PartialExit != nil && position.PartialExit.Enabled:
		place = pm.placePartialExitOrder
	default:
		return fmt.Errorf("managed position has no executable protection leg")
	}
	if err := place(ctx, position); err != nil {
		pm.logger.WithError(err).Error("Failed to place managed protection leg")
		pm.blockExecution("protection")
		position.Status = "PROTECTION_BLOCKED"
		_ = pm.savePositionToDB(position)
		return err
	}
	return nil
}

// placeStopLossOrder places or updates stop loss order
func (pm *PositionManager) placeStopLossOrder(ctx context.Context, position *ManagedPosition) error {
	exitSide := "sell"
	if position.Side == "sell" {
		exitSide = "buy"
	}

	clientOrderID := strings.TrimSpace(position.StopLossClientOrderID)
	if clientOrderID == "" {
		var err error
		clientOrderID, err = newClientOrderID()
		if err != nil {
			return fmt.Errorf("failed to generate stop-loss client order ID: %w", err)
		}
		position.StopLossClientOrderID = clientOrderID
		if err := pm.savePositionToDB(position); err != nil {
			return fmt.Errorf("failed to persist stop-loss identity: %w", err)
		}
	}
	if err := pm.prepareManagedOrderIdentity(ctx, clientOrderID); err != nil {
		return err
	}
	order := &interfaces.Order{
		ClientOrderID: clientOrderID,
		Symbol:        position.Symbol,
		Qty:           position.RemainingQty,
		Side:          exitSide,
		Type:          "stop",
		TimeInForce:   "gtc",
		StopPrice:     &position.StopLossPrice,
		Status:        "pending",
		Purpose:       "protection",
		SubmittedAt:   time.Now(),
	}

	if err := pm.storageService.SaveOrder(order); err != nil {
		pm.logger.WithError(err).Error("Failed to persist stop loss order intent before submit")
		pm.blockExecution("persistence")
		return err
	}
	if err := pm.saveManagedOrderProjection(position.ID, "protection", order, "planned"); err != nil {
		pm.blockExecution("persistence")
		return err
	}

	if err := pm.saveManagedOrderProjection(position.ID, "protection", order, "submitting"); err != nil {
		pm.blockExecution("persistence")
		return err
	}
	pm.bindManagedOrderIdentity(order)
	result, err := pm.tradingService.PlaceOrder(ctx, order)
	if refreshErr := pm.refreshManagedOrderRevision(order); refreshErr != nil {
		return &SubmissionUncertainError{Err: fmt.Errorf("managed stop-loss state could not be reloaded after submission attempt: %w", refreshErr)}
	}
	if err != nil {
		order.Status = "submit_failed"
		if IsSubmissionUncertain(err) {
			order.Status = "submission_uncertain"
		}
		if saveErr := pm.storageService.SaveOrder(order); saveErr != nil {
			pm.logger.WithError(saveErr).Warn("Failed to record stop loss submission failure")
		}
		_ = pm.saveManagedOrderProjection(position.ID, "protection", order, order.Status)
		return err
	}

	if resultErr := validateManagedOrderResult(result, order); resultErr != nil {
		order.Status = "submission_uncertain"
		if saveErr := pm.storageService.SaveOrder(order); saveErr != nil {
			pm.logger.WithError(saveErr).Warn("Failed to record uncertain managed order result")
		}
		_ = pm.saveManagedOrderProjection(position.ID, "protection", order, order.Status)
		return resultErr
	}
	applyManagedOrderResult(order, result)
	if err := pm.storageService.SaveOrder(order); err != nil {
		pm.logger.WithError(err).Error("Failed to save stop loss order")
		pm.blockExecution("persistence")
		return err
	}
	if err := pm.saveManagedOrderProjection(position.ID, "protection", order, order.Status); err != nil {
		pm.blockExecution("persistence")
		return err
	}

	position.StopLossOrderID = result.OrderID
	pm.logger.WithFields(logrus.Fields{
		"position_id": position.ID,
		"order_id":    result.OrderID,
		"stop_price":  position.StopLossPrice,
	}).Info("Stop loss order placed")

	return nil
}

// placeTakeProfitOrder places take profit limit order
func (pm *PositionManager) placeTakeProfitOrder(ctx context.Context, position *ManagedPosition) error {
	exitSide := "sell"
	if position.Side == "sell" {
		exitSide = "buy"
	}

	clientOrderID := strings.TrimSpace(position.TakeProfitClientOrderID)
	if clientOrderID == "" {
		var err error
		clientOrderID, err = newClientOrderID()
		if err != nil {
			return fmt.Errorf("failed to generate take-profit client order ID: %w", err)
		}
		position.TakeProfitClientOrderID = clientOrderID
		if err := pm.savePositionToDB(position); err != nil {
			return fmt.Errorf("failed to persist take-profit identity: %w", err)
		}
	}
	if err := pm.prepareManagedOrderIdentity(ctx, clientOrderID); err != nil {
		return err
	}

	order := &interfaces.Order{
		ClientOrderID: clientOrderID,
		Symbol:        position.Symbol,
		Qty:           position.RemainingQty,
		Side:          exitSide,
		Type:          "limit",
		TimeInForce:   "gtc",
		LimitPrice:    &position.TakeProfitPrice,
		Status:        "pending",
		Purpose:       "protection",
		SubmittedAt:   time.Now(),
	}

	if err := pm.storageService.SaveOrder(order); err != nil {
		pm.logger.WithError(err).Error("Failed to persist take profit order intent before submit")
		pm.blockExecution("persistence")
		return err
	}
	if err := pm.saveManagedOrderProjection(position.ID, "protection", order, "planned"); err != nil {
		pm.blockExecution("persistence")
		return err
	}

	if err := pm.saveManagedOrderProjection(position.ID, "protection", order, "submitting"); err != nil {
		pm.blockExecution("persistence")
		return err
	}
	pm.bindManagedOrderIdentity(order)
	result, err := pm.tradingService.PlaceOrder(ctx, order)
	if refreshErr := pm.refreshManagedOrderRevision(order); refreshErr != nil {
		return &SubmissionUncertainError{Err: fmt.Errorf("managed take-profit state could not be reloaded after submission attempt: %w", refreshErr)}
	}
	if err != nil {
		order.Status = "submit_failed"
		if IsSubmissionUncertain(err) {
			order.Status = "submission_uncertain"
		}
		if saveErr := pm.storageService.SaveOrder(order); saveErr != nil {
			pm.logger.WithError(saveErr).Warn("Failed to record take profit submission failure")
		}
		_ = pm.saveManagedOrderProjection(position.ID, "protection", order, order.Status)
		return err
	}

	if resultErr := validateManagedOrderResult(result, order); resultErr != nil {
		order.Status = "submission_uncertain"
		if saveErr := pm.storageService.SaveOrder(order); saveErr != nil {
			pm.logger.WithError(saveErr).Warn("Failed to record uncertain managed order result")
		}
		_ = pm.saveManagedOrderProjection(position.ID, "protection", order, order.Status)
		return resultErr
	}
	applyManagedOrderResult(order, result)
	if err := pm.storageService.SaveOrder(order); err != nil {
		pm.logger.WithError(err).Error("Failed to save take profit order")
		pm.blockExecution("persistence")
		return err
	}
	if err := pm.saveManagedOrderProjection(position.ID, "protection", order, order.Status); err != nil {
		pm.blockExecution("persistence")
		return err
	}

	position.TakeProfitOrderID = result.OrderID
	pm.logger.WithFields(logrus.Fields{
		"position_id": position.ID,
		"order_id":    result.OrderID,
		"limit_price": position.TakeProfitPrice,
	}).Info("Take profit order placed")

	return nil
}

// placePartialExitOrder places partial exit order
func (pm *PositionManager) placePartialExitOrder(ctx context.Context, position *ManagedPosition) error {
	exitSide := "sell"
	if position.Side == "sell" {
		exitSide = "buy"
	}

	partialQty := math.Min(position.RemainingQty, position.Quantity*(position.PartialExit.Percent/100.0))

	clientOrderID := strings.TrimSpace(position.PartialExitClientOrderID)
	if clientOrderID == "" {
		var err error
		clientOrderID, err = newClientOrderID()
		if err != nil {
			return fmt.Errorf("failed to generate partial-exit client order ID: %w", err)
		}
		position.PartialExitClientOrderID = clientOrderID
		if err := pm.savePositionToDB(position); err != nil {
			return fmt.Errorf("failed to persist partial-exit identity: %w", err)
		}
	}
	if err := pm.prepareManagedOrderIdentity(ctx, clientOrderID); err != nil {
		return err
	}

	order := &interfaces.Order{
		ClientOrderID: clientOrderID,
		Symbol:        position.Symbol,
		Qty:           partialQty,
		Side:          exitSide,
		Type:          "limit",
		TimeInForce:   "gtc",
		LimitPrice:    &position.PartialExit.TargetPrice,
		Status:        "pending",
		Purpose:       "protection",
		SubmittedAt:   time.Now(),
	}

	if err := pm.storageService.SaveOrder(order); err != nil {
		pm.logger.WithError(err).Error("Failed to persist partial exit order intent before submit")
		pm.blockExecution("persistence")
		return err
	}
	if err := pm.saveManagedOrderProjection(position.ID, "protection", order, "planned"); err != nil {
		pm.blockExecution("persistence")
		return err
	}

	if err := pm.saveManagedOrderProjection(position.ID, "protection", order, "submitting"); err != nil {
		pm.blockExecution("persistence")
		return err
	}
	pm.bindManagedOrderIdentity(order)
	result, err := pm.tradingService.PlaceOrder(ctx, order)
	if refreshErr := pm.refreshManagedOrderRevision(order); refreshErr != nil {
		return &SubmissionUncertainError{Err: fmt.Errorf("managed partial-exit state could not be reloaded after submission attempt: %w", refreshErr)}
	}
	if err != nil {
		order.Status = "submit_failed"
		if IsSubmissionUncertain(err) {
			order.Status = "submission_uncertain"
		}
		if saveErr := pm.storageService.SaveOrder(order); saveErr != nil {
			pm.logger.WithError(saveErr).Warn("Failed to record partial exit submission failure")
		}
		_ = pm.saveManagedOrderProjection(position.ID, "protection", order, order.Status)
		return err
	}

	if resultErr := validateManagedOrderResult(result, order); resultErr != nil {
		order.Status = "submission_uncertain"
		if saveErr := pm.storageService.SaveOrder(order); saveErr != nil {
			pm.logger.WithError(saveErr).Warn("Failed to record uncertain managed order result")
		}
		_ = pm.saveManagedOrderProjection(position.ID, "protection", order, order.Status)
		return resultErr
	}
	applyManagedOrderResult(order, result)
	if err := pm.storageService.SaveOrder(order); err != nil {
		pm.logger.WithError(err).Error("Failed to save partial exit order")
		pm.blockExecution("persistence")
		return err
	}
	if err := pm.saveManagedOrderProjection(position.ID, "protection", order, order.Status); err != nil {
		pm.blockExecution("persistence")
		return err
	}

	position.PartialExitOrders = append(position.PartialExitOrders, result.OrderID)
	pm.logger.WithFields(logrus.Fields{
		"position_id": position.ID,
		"order_id":    result.OrderID,
		"quantity":    partialQty,
		"limit_price": position.PartialExit.TargetPrice,
	}).Info("Partial exit order placed")

	return nil
}

// cancelSiblingExitOrders prevents a filled risk order from leaving other exits live.
func (pm *PositionManager) cancelSiblingExitOrders(ctx context.Context, position *ManagedPosition, filledOrderID string) error {
	orderIDs := append([]string{position.StopLossOrderID, position.TakeProfitOrderID}, position.PartialExitOrders...)
	var firstErr error
	for _, orderID := range orderIDs {
		if orderID == "" || orderID == filledOrderID {
			continue
		}
		cancellation, bindErr := pm.bindCancellationEvidence(position, orderID)
		if bindErr != nil {
			if firstErr == nil {
				firstErr = bindErr
			}
			continue
		}
		if err := pm.tradingService.CancelOrder(ctx, orderID); err != nil {
			if persistErr := pm.persistCancellationEvidence(cancellation, err); persistErr != nil {
				firstErr = fmt.Errorf("failed to persist sibling cancellation evidence: %v: %w", persistErr, err)
			}
			pm.logger.WithError(err).WithField("order_id", orderID).Warn("Failed to cancel sibling risk order")
			if firstErr == nil {
				firstErr = err
			}
		}
	}
	return firstErr
}

func isTerminalManagedStatus(status string) bool {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "filled", "canceled", "cancelled", "rejected", "expired", "done_for_day", "replaced", "stopped":
		return true
	default:
		return false
	}
}

func terminalFilledOrder(order *interfaces.Order) bool {
	if order == nil || order.FilledQty <= 0 {
		return false
	}
	switch strings.ToLower(order.Status) {
	case "filled", "partially_filled", "canceled", "cancelled", "rejected", "expired", "done_for_day", "replaced", "stopped":
		return true
	default:
		return false
	}
}

func validManagedProtectionFill(position *ManagedPosition, order *interfaces.Order) bool {
	if position == nil || !terminalFilledOrder(order) || strings.TrimSpace(order.ID) == "" || order.Symbol != position.Symbol || order.Qty <= 0 || order.FilledQty > order.Qty || order.FilledAvgPrice == nil || *order.FilledAvgPrice <= 0 {
		return false
	}
	if strings.EqualFold(position.Side, "buy") && !strings.EqualFold(order.Side, "sell") {
		return false
	}
	if strings.EqualFold(position.Side, "sell") && !strings.EqualFold(order.Side, "buy") {
		return false
	}
	return true
}

func (pm *PositionManager) applyProtectionFillWatermark(position *ManagedPosition, order *interfaces.Order) float64 {
	if !validManagedProtectionFill(position, order) {
		return 0
	}
	if position.ProtectionFillWatermarks == nil {
		position.ProtectionFillWatermarks = make(map[string]float64)
	}
	previous := position.ProtectionFillWatermarks[order.ID]
	// The durable managed-order projection is authoritative across restarts;
	// the position watermark is only an in-memory compatibility projection.
	var projection *models.DBManagedOrder
	if strings.TrimSpace(order.ClientOrderID) != "" && pm.storageService != nil {
		loaded, err := pm.storageService.GetManagedOrder(order.ClientOrderID)
		if err != nil {
			return 0
		}
		projection = loaded
		if projection != nil && projection.FillWatermark > previous {
			previous = projection.FillWatermark
		}
	}
	if order.FilledQty <= previous {
		return 0
	}
	delta := order.FilledQty - previous
	position.ProtectionFillWatermarks[order.ID] = order.FilledQty
	if projection != nil {
		projection.FilledQty = math.Max(projection.FilledQty, order.FilledQty)
		projection.FillWatermark = math.Max(projection.FillWatermark, order.FilledQty)
		projection.FilledAvgPrice = order.FilledAvgPrice
		projection.Lifecycle = strings.ToLower(order.Status)
		if err := pm.storageService.SaveManagedOrder(projection); err != nil {
			return 0
		}
	}
	return delta
}

// cancelProtectionResidual cancels an open partially-filled protection order,
// then reads it back so fills reported by cancellation are not lost.
func (pm *PositionManager) cancelProtectionResidual(ctx context.Context, position *ManagedPosition, order *interfaces.Order) (float64, error) {
	if order == nil || strings.ToLower(order.Status) != "partially_filled" {
		return 0, nil
	}
	if err := pm.tradingService.CancelOrder(ctx, order.ID); err != nil {
		cancellation := managedCancellation{positionID: position.ID, providerID: order.ID, clientID: order.ClientOrderID, role: "protection", purpose: "protection"}
		if persistErr := pm.persistCancellationEvidence(cancellation, err); persistErr != nil {
			return 0, fmt.Errorf("partial protection cancellation evidence unresolved: %w: %v", err, persistErr)
		}
		return 0, err
	}
	readback, err := pm.tradingService.GetOrder(ctx, order.ID)
	if err != nil || readback == nil {
		return 0, fmt.Errorf("cannot verify partial protection cancellation %s", order.ID)
	}
	if !managedOrderIdentityMatches(readback, order.ID, order.ClientOrderID) {
		return 0, fmt.Errorf("partial protection cancellation identity mismatch for %s", order.ID)
	}
	status := strings.ToLower(readback.Status)
	switch status {
	case "canceled", "cancelled", "rejected", "expired", "done_for_day", "replaced", "stopped":
	default:
		return 0, fmt.Errorf("partial protection %s remains non-terminal after cancellation", order.ID)
	}
	return pm.applyProtectionFillWatermark(position, readback), nil
}

func (pm *PositionManager) manageRiskOrders(ctx context.Context, position *ManagedPosition) {
	// Check stop loss order status
	if position.StopLossOrderID != "" {
		order, err := pm.tradingService.GetOrder(ctx, position.StopLossOrderID)
		if err == nil && managedOrderIdentityMatches(order, position.StopLossOrderID, position.StopLossClientOrderID) {
			fillDelta := pm.applyProtectionFillWatermark(position, order)
			if fillDelta == 0 && isTerminalManagedStatus(order.Status) {
				position.Status = "PROTECTION_BLOCKED"
				pm.blockExecution("protection")
				_ = pm.savePositionToDB(position)
				return
			}
			if fillDelta > 0 {
				residualDelta, cancelErr := pm.cancelProtectionResidual(ctx, position, order)
				if cancelErr != nil {
					position.Status = "PROTECTION_BLOCKED"
					pm.blockExecution("protection")
					_ = pm.savePositionToDB(position)
					return
				}
				fillDelta += residualDelta
				if cancelErr := pm.cancelSiblingExitOrders(ctx, position, position.StopLossOrderID); cancelErr != nil {
					position.Status = "PROTECTION_BLOCKED"
					pm.blockExecution("protection")
					_ = pm.savePositionToDB(position)
					return
				}
				position.RemainingQty = math.Max(0, position.RemainingQty-fillDelta)
				position.ExitFilledQty += fillDelta
				position.StopLossOrderID = ""
				position.StopLossClientOrderID = ""
				position.TakeProfitOrderID = ""
				position.TakeProfitClientOrderID = ""
				position.PartialExitOrders = nil
				position.PartialExitClientOrderID = ""
				if position.RemainingQty == 0 {
					position.Status = "STOPPED_OUT"
					now := time.Now()
					position.ClosedAt = &now
				} else {
					position.Status = "PARTIAL"
				}
				pm.savePositionToDB(position)
				if position.RemainingQty > 0 {
					if err := pm.placeRiskOrders(ctx, position); err != nil {
						position.Status = "PROTECTION_BLOCKED"
					}
					_ = pm.savePositionToDB(position)
				}
				return
			}
		}
	}

	// Check take profit order status
	if position.TakeProfitOrderID != "" {
		order, err := pm.tradingService.GetOrder(ctx, position.TakeProfitOrderID)
		if err == nil && managedOrderIdentityMatches(order, position.TakeProfitOrderID, position.TakeProfitClientOrderID) {
			fillDelta := pm.applyProtectionFillWatermark(position, order)
			if fillDelta == 0 && isTerminalManagedStatus(order.Status) {
				position.Status = "PROTECTION_BLOCKED"
				pm.blockExecution("protection")
				_ = pm.savePositionToDB(position)
				return
			}
			if fillDelta > 0 {
				residualDelta, cancelErr := pm.cancelProtectionResidual(ctx, position, order)
				if cancelErr != nil {
					position.Status = "PROTECTION_BLOCKED"
					pm.blockExecution("protection")
					_ = pm.savePositionToDB(position)
					return
				}
				fillDelta += residualDelta
				if cancelErr := pm.cancelSiblingExitOrders(ctx, position, position.TakeProfitOrderID); cancelErr != nil {
					position.Status = "PROTECTION_BLOCKED"
					pm.blockExecution("protection")
					_ = pm.savePositionToDB(position)
					return
				}
				position.RemainingQty = math.Max(0, position.RemainingQty-fillDelta)
				position.ExitFilledQty += fillDelta
				position.StopLossOrderID = ""
				position.StopLossClientOrderID = ""
				position.TakeProfitOrderID = ""
				position.TakeProfitClientOrderID = ""
				position.PartialExitOrders = nil
				position.PartialExitClientOrderID = ""
				if position.RemainingQty == 0 {
					position.Status = "CLOSED"
					now := time.Now()
					position.ClosedAt = &now
				} else {
					position.Status = "PARTIAL"
				}
				pm.savePositionToDB(position)
				if position.RemainingQty > 0 {
					if err := pm.placeRiskOrders(ctx, position); err != nil {
						position.Status = "PROTECTION_BLOCKED"
					}
					_ = pm.savePositionToDB(position)
				}
				return
			}
		}
	}

	// Check partial exit orders
	filledPartialQty := 0.0
	filledPartialID := ""
	for _, orderID := range position.PartialExitOrders {
		order, err := pm.tradingService.GetOrder(ctx, orderID)
		if err == nil && managedOrderIdentityMatches(order, orderID, position.PartialExitClientOrderID) {
			fillDelta := pm.applyProtectionFillWatermark(position, order)
			if fillDelta == 0 && isTerminalManagedStatus(order.Status) {
				position.Status = "PROTECTION_BLOCKED"
				pm.blockExecution("protection")
				_ = pm.savePositionToDB(position)
				return
			}
			if fillDelta > 0 {
				residualDelta, cancelErr := pm.cancelProtectionResidual(ctx, position, order)
				if cancelErr != nil {
					position.Status = "PROTECTION_BLOCKED"
					pm.blockExecution("protection")
					_ = pm.savePositionToDB(position)
					return
				}
				fillDelta += residualDelta
				filledPartialQty += fillDelta
				filledPartialID = orderID
			}
		}
	}
	if filledPartialQty > 0 {
		if cancelErr := pm.cancelSiblingExitOrders(ctx, position, filledPartialID); cancelErr != nil {
			position.Status = "PROTECTION_BLOCKED"
			pm.blockExecution("protection")
			_ = pm.savePositionToDB(position)
			return
		}
		position.ExitFilledQty += filledPartialQty
		position.RemainingQty = math.Max(0, position.Quantity-position.ExitFilledQty)
		if position.RemainingQty == 0 {
			position.Status = "CLOSED"
			position.StopLossOrderID, position.TakeProfitOrderID = "", ""
			position.PartialExitOrders = nil
			position.PartialExitClientOrderID = ""
			now := time.Now()
			position.ClosedAt = &now
		} else {
			position.Status = "PARTIAL"
		}
		pm.logger.WithFields(logrus.Fields{
			"position_id":   position.ID,
			"filled_qty":    filledPartialQty,
			"remaining_qty": position.RemainingQty,
		}).Info("Partial exit fills reconciled")
		pm.savePositionToDB(position)
		if position.RemainingQty > 0 {
			position.StopLossOrderID, position.TakeProfitOrderID = "", ""
			position.PartialExitOrders = nil
			position.PartialExitClientOrderID = ""
			if err := pm.placeRiskOrders(ctx, position); err != nil {
				position.Status = "PROTECTION_BLOCKED"
				pm.blockExecution("protection")
			}
			if err := pm.savePositionToDB(position); err != nil {
				pm.logger.WithError(err).Error("Failed to persist recreated partial protection")
			}
		}
	}
}

// updateTrailingStop updates trailing stop loss based on current price
func (pm *PositionManager) updateTrailingStop(ctx context.Context, position *ManagedPosition) {
	if position.Side == "buy" {
		// For long positions, raise stop as price rises
		newStopPrice := position.CurrentPrice * (1 - position.TrailingPercent/100.0)
		if newStopPrice > position.StopLossPrice {
			// Cancel old stop loss order
			if position.StopLossOrderID != "" {
				if err := pm.tradingService.CancelOrder(ctx, position.StopLossOrderID); err != nil {
					position.Status = "CLOSING"
					pm.blockExecution("protection")
					_ = pm.savePositionToDB(position)
					return
				}
				position.StopLossOrderID = ""
				position.StopLossClientOrderID = ""
			}

			// Update stop price and place new order
			position.StopLossPrice = newStopPrice
			if err := pm.placeStopLossOrder(ctx, position); err != nil {
				position.Status = "PROTECTION_BLOCKED"
				pm.blockExecution("protection")
				_ = pm.savePositionToDB(position)
				return
			}

			pm.logger.WithFields(logrus.Fields{
				"position_id":    position.ID,
				"new_stop_price": newStopPrice,
			}).Info("Trailing stop updated")
		}
	} else {
		// For short positions, lower stop as price falls
		newStopPrice := position.CurrentPrice * (1 + position.TrailingPercent/100.0)
		if newStopPrice < position.StopLossPrice {
			if position.StopLossOrderID != "" {
				if err := pm.tradingService.CancelOrder(ctx, position.StopLossOrderID); err != nil {
					position.Status = "CLOSING"
					pm.blockExecution("protection")
					_ = pm.savePositionToDB(position)
					return
				}
				position.StopLossOrderID = ""
				position.StopLossClientOrderID = ""
			}

			position.StopLossPrice = newStopPrice
			if err := pm.placeStopLossOrder(ctx, position); err != nil {
				position.Status = "PROTECTION_BLOCKED"
				pm.blockExecution("protection")
				_ = pm.savePositionToDB(position)
				return
			}

			pm.logger.WithFields(logrus.Fields{
				"position_id":    position.ID,
				"new_stop_price": newStopPrice,
			}).Info("Trailing stop updated")
		}
	}
}

// updatePositionPrice updates current price and unrealized P&L
func (pm *PositionManager) updatePositionPrice(ctx context.Context, position *ManagedPosition) error {
	currentPrice, err := pm.getCurrentPrice(ctx, position.Symbol)
	if err != nil {
		return err
	}

	position.CurrentPrice = currentPrice

	if position.Side == "buy" {
		position.UnrealizedPL = (currentPrice - position.EntryPrice) * position.RemainingQty
		position.UnrealizedPLPC = ((currentPrice - position.EntryPrice) / position.EntryPrice) * 100
	} else {
		position.UnrealizedPL = (position.EntryPrice - currentPrice) * position.RemainingQty
		position.UnrealizedPLPC = ((position.EntryPrice - currentPrice) / position.EntryPrice) * 100
	}

	position.UpdatedAt = time.Now()

	return nil
}

// GetManagedPosition retrieves a managed position by ID
func (pm *PositionManager) GetManagedPosition(positionID string) (*ManagedPosition, error) {
	pm.mu.RLock()
	defer pm.mu.RUnlock()

	position, exists := pm.positions[positionID]
	if !exists {
		return nil, fmt.Errorf("position not found: %s", positionID)
	}

	return position, nil
}

// ListManagedPositions returns all managed positions
// Filters out PENDING positions older than 24 hours (stale orders)
func (pm *PositionManager) ListManagedPositions(status string) []*ManagedPosition {
	pm.mu.RLock()
	defer pm.mu.RUnlock()

	positions := make([]*ManagedPosition, 0)
	now := time.Now()

	for _, pos := range pm.positions {
		// Filter out stale PENDING orders (>24 hours old)
		if pos.Status == "PENDING" {
			age := now.Sub(pos.CreatedAt)
			if age > 24*time.Hour {
				pm.logger.WithFields(logrus.Fields{
					"position_id": pos.ID,
					"symbol":      pos.Symbol,
					"age_hours":   age.Hours(),
				}).Debug("Skipping stale PENDING position")
				continue
			}
		}

		if status == "" || pos.Status == status {
			positions = append(positions, pos)
		}
	}

	return positions
}

// CloseManagedPosition manually closes a managed position
func (pm *PositionManager) CloseManagedPosition(ctx context.Context, positionID string, capabilities ...PositionCloseCapability) error {
	if len(capabilities) != 1 || capabilities[0] == nil {
		return fmt.Errorf("position close capability is required")
	}
	return pm.closeManagedPosition(ctx, positionID, capabilities[0])
}

func (pm *PositionManager) CloseManagedPositionWithCapability(ctx context.Context, positionID string, capability PositionCloseCapability) error {
	return pm.closeManagedPosition(ctx, positionID, capability)
}

func (pm *PositionManager) closeManagedPosition(ctx context.Context, positionID string, capability PositionCloseCapability) error {
	if err := pm.ensureCloseReady(); err != nil {
		return err
	}
	pm.mu.Lock()
	position, exists := pm.positions[positionID]
	if !exists {
		pm.mu.Unlock()
		return fmt.Errorf("position not found: %s", positionID)
	}
	identity := capability.positionCloseIdentity()
	if !managedIdentityComplete(identity) || !managedIdentityComplete(position.DurableIdentity) || !managedIdentityMatches(identity, position.DurableIdentity) || !managedIdentityMatches(position.DurableIdentity, pm.storageService.DurableIdentity()) {
		pm.mu.Unlock()
		return fmt.Errorf("position close rejected: capability and position execution identity do not match")
	}
	if position.Status == "CLOSING" {
		pm.mu.Unlock()
		return fmt.Errorf("position close is already unresolved: %s", positionID)
	}
	if position.Status != "ACTIVE" && position.Status != "PARTIAL" && position.Status != "PENDING" {
		pm.mu.Unlock()
		return fmt.Errorf("position %s cannot be closed from status %q", positionID, position.Status)
	}
	if pm.closeInFlight[positionID] {
		pm.mu.Unlock()
		return fmt.Errorf("close already in progress for position: %s", positionID)
	}
	pm.closeInFlight[positionID] = true
	pm.mu.Unlock()
	defer func() { pm.mu.Lock(); delete(pm.closeInFlight, positionID); pm.mu.Unlock() }()

	wasOpen := position.Status == "ACTIVE" || position.Status == "PARTIAL"
	wasPending := position.Status == "PENDING"
	cancellations, err := pm.boundManagedCancellations(position)
	if err != nil {
		return err
	}
	position.Status = "CLOSING"
	if err := pm.savePositionToDB(position); err != nil {
		return fmt.Errorf("failed to persist closing state: %w", err)
	}

	// Cancel all open orders before placing a replacement exit. Any cancellation
	// failure leaves the position unresolved and blocks the replacement.
	var cancellationErr error

	for _, cancellation := range cancellations {
		err := pm.tradingService.CancelOrder(ctx, cancellation.providerID)
		if err != nil {
			if persistErr := pm.persistCancellationEvidence(cancellation, err); persistErr != nil {
				pm.logger.WithError(persistErr).Error("Failed to persist cancellation fill evidence")
			}
			pm.logger.WithError(err).Warn("Failed to cancel entry order (may already be filled/cancelled)")
			if cancellationErr == nil {
				cancellationErr = err
			}
		} else {
			pm.logger.WithField("order_id", cancellation.providerID).Info("Cancelled managed order")
		}
	}

	if cancellationErr != nil {
		position.Status = "PROTECTION_BLOCKED"
		pm.blockExecution("protection")
		if saveErr := pm.savePositionToDB(position); saveErr != nil {
			return fmt.Errorf("order cancellation unresolved: %w; failed to persist protection-blocked state: %v", cancellationErr, saveErr)
		}
		return fmt.Errorf("order cancellation unresolved; replacement exit blocked: %w", cancellationErr)
	}

	// Place market order to close remaining position
	if wasOpen {
		if position.RemainingQty > 0 {
			exitSide := "sell"
			if position.Side == "sell" {
				exitSide = "buy"
			}

			clientOrderID := strings.TrimSpace(position.ExitClientOrderID)
			if clientOrderID == "" {
				var err error
				clientOrderID, err = newClientOrderID()
				if err != nil {
					return fmt.Errorf("failed to generate exit client order ID: %w", err)
				}
				position.ExitClientOrderID = clientOrderID
			}
			if err := pm.prepareManagedOrderIdentity(ctx, clientOrderID); err != nil {
				return err
			}

			order := &interfaces.Order{
				ClientOrderID: clientOrderID,
				Symbol:        position.Symbol,
				Qty:           position.RemainingQty,
				Side:          exitSide,
				Type:          "market",
				TimeInForce:   "day",
				Status:        "pending",
				Purpose:       "close",
				SubmittedAt:   time.Now(),
			}
			position.ExitOrderID = clientOrderID
			if err := pm.savePositionToDB(position); err != nil {
				return fmt.Errorf("failed to persist exit identity: %w", err)
			}
			if err := pm.storageService.SaveOrder(order); err != nil {
				pm.logger.WithError(err).Error("Failed to persist market exit order intent before submit")
				pm.blockExecution("persistence")
				return fmt.Errorf("failed to persist market exit order intent: %w", err)
			}
			if err := pm.saveManagedOrderProjection(position.ID, "close", order, "planned"); err != nil {
				pm.blockExecution("persistence")
				return err
			}

			if err := pm.saveManagedOrderProjection(position.ID, "close", order, "submitting"); err != nil {
				pm.blockExecution("persistence")
				return err
			}
			pm.bindManagedOrderIdentity(order)
			result, err := pm.tradingService.PlaceOrder(ctx, order)
			if refreshErr := pm.refreshManagedOrderRevision(order); refreshErr != nil {
				return &SubmissionUncertainError{Err: fmt.Errorf("managed close state could not be reloaded after submission attempt: %w", refreshErr)}
			}
			if err != nil {
				order.Status = "submit_failed"
				if IsSubmissionUncertain(err) {
					order.Status = "submission_uncertain"
				}
				if saveErr := pm.storageService.SaveOrder(order); saveErr != nil {
					pm.logger.WithError(saveErr).Warn("Failed to record market exit submission failure")
				}
				_ = pm.saveManagedOrderProjection(position.ID, "close", order, order.Status)
				pm.logger.WithError(err).Error("Failed to place exit order (market may be closed)")
				position.Status = "CLOSING"
				pm.savePositionToDB(position)
				return fmt.Errorf("failed to place market exit order: %w", err)
			} else {
				if resultErr := validateManagedOrderResult(result, order); resultErr != nil {
					order.Status = "submission_uncertain"
					if saveErr := pm.storageService.SaveOrder(order); saveErr != nil {
						pm.logger.WithError(saveErr).Warn("Failed to record uncertain managed order result")
					}
					_ = pm.saveManagedOrderProjection(position.ID, "close", order, order.Status)
					return resultErr
				}
				order.ID = result.OrderID
				position.ExitOrderID = result.OrderID
				order.Status = result.Status
				if strings.ToLower(result.Status) == "filled" {
					filledQty := position.RemainingQty
					position.ExitFilledQty += filledQty
					if position.ExitFillWatermarks == nil {
						position.ExitFillWatermarks = make(map[string]float64)
					}
					position.ExitFillWatermarks[result.OrderID] = filledQty
					position.RemainingQty = 0
					position.StopLossOrderID = ""
					position.TakeProfitOrderID = ""
					position.PartialExitOrders = nil
				}
				if err := pm.storageService.SaveOrder(order); err != nil {
					pm.logger.WithError(err).Error("Failed to save market exit order")
					pm.blockExecution("protection")
					position.Status = "CLOSING"
					_ = pm.savePositionToDB(position)
					return fmt.Errorf("market exit persistence is unresolved: %w", err)
				}
				if err := pm.saveManagedOrderProjection(position.ID, "close", order, order.Status); err != nil {
					pm.blockExecution("persistence")
					position.Status = "CLOSING"
					_ = pm.savePositionToDB(position)
					return fmt.Errorf("market exit projection is unresolved: %w", err)
				}
				pm.logger.WithField("quantity", position.RemainingQty).Info("Placed market exit order")
				if strings.ToLower(result.Status) != "filled" {
					if saveErr := pm.savePositionToDB(position); saveErr != nil {
						return saveErr
					}
					return fmt.Errorf("exit order accepted but not filled; position remains CLOSING")
				}
			}
		}
	} else if wasPending {
		if position.EntryOrderID != "" {
			entry, err := pm.tradingService.GetOrder(ctx, position.EntryOrderID)
			if err != nil || entry == nil {
				return fmt.Errorf("entry order status is unresolved; position remains CLOSING")
			}
			switch strings.ToLower(entry.Status) {
			case "filled":
				position.Status = "ACTIVE"
				if entry.FilledQty > 0 {
					position.RemainingQty = entry.FilledQty
				}
				position.ExitOrderID = ""
				pm.placeRiskOrders(ctx, position)
				if err := pm.savePositionToDB(position); err != nil {
					return err
				}
				return fmt.Errorf("entry filled while close was pending; position remains ACTIVE")
			case "canceled", "cancelled", "rejected", "expired", "done_for_day", "replaced":
				// Safe to close: the entry did not create exposure.
			default:
				return fmt.Errorf("entry order status %q is unresolved; position remains CLOSING", entry.Status)
			}
		}
		pm.logger.WithField("position_id", position.ID).Info("Closed pending position (entry order was never filled)")
	}

	position.Status = "CLOSED"
	position.RemainingQty = 0
	position.StopLossOrderID, position.TakeProfitOrderID = "", ""
	position.PartialExitOrders = nil
	position.ExitOrderID = ""
	now := time.Now()
	position.ClosedAt = &now

	// Save to database
	if err := pm.savePositionToDB(position); err != nil {
		return fmt.Errorf("failed to persist closed position: %w", err)
	}

	pm.logger.WithField("position_id", positionID).Info("Position manually closed")

	return nil
}

type managedCancellation struct {
	positionID string
	providerID string
	clientID   string
	role       string
	purpose    string
}

func (pm *PositionManager) persistCancellationEvidence(cancellation managedCancellation, cancelErr error) error {
	var uncertain *SubmissionUncertainError
	if !errors.As(cancelErr, &uncertain) || uncertain.Result == nil || uncertain.Result.FilledQty <= 0 {
		return nil
	}
	if strings.TrimSpace(cancellation.positionID) == "" || strings.TrimSpace(cancellation.role) == "" || strings.TrimSpace(cancellation.purpose) == "" {
		return fmt.Errorf("cancellation evidence binding is incomplete")
	}
	order, err := pm.storageService.GetOrder(cancellation.providerID)
	if err != nil || order == nil {
		if cancellation.clientID == "" {
			return fmt.Errorf("cancellation evidence order lookup failed: %w", err)
		}
		order, err = pm.storageService.GetOrderByClientOrderID(cancellation.clientID)
	}
	if err != nil || order == nil {
		return fmt.Errorf("cancellation evidence order lookup failed: %w", err)
	}
	projection, projectionErr := pm.storageService.GetManagedOrder(cancellation.clientID)
	if projectionErr != nil || projection == nil || projection.PositionID != cancellation.positionID ||
		projection.Role != cancellation.role || projection.Purpose != cancellation.purpose ||
		projection.BrokerOrderID != cancellation.providerID ||
		!managedIdentityMatches(projection.DurableIdentity, pm.storageService.DurableIdentity()) {
		return fmt.Errorf("cancellation evidence managed position binding rejected")
	}
	if order.ID != cancellation.providerID || order.ClientOrderID != cancellation.clientID {
		return fmt.Errorf("cancellation evidence order identity rejected")
	}
	if err := ValidateCancellationFillEvidence(uncertain.Result, order, pm.storageService.DurableIdentity()); err != nil {
		return fmt.Errorf("cancellation evidence durable identity rejected: %w", err)
	}
	if uncertain.Result.ClientOrderID != projection.ClientOrderID || uncertain.Result.OrderID != projection.BrokerOrderID {
		return fmt.Errorf("cancellation evidence projection identity rejected")
	}
	order.ManagedPositionID = projection.PositionID
	order.ManagedRole = projection.Role
	applyManagedOrderResult(order, uncertain.Result)
	if err := pm.storageService.SaveOrder(order); err != nil {
		return err
	}
	if cancellation.clientID != "" {
		order.ClientOrderID = cancellation.clientID
	}
	return pm.saveManagedOrderProjection(cancellation.positionID, cancellation.role, order, strings.ToLower(order.Status))
}

func (pm *PositionManager) bindCancellationEvidence(position *ManagedPosition, providerID string) (managedCancellation, error) {
	if position == nil || strings.TrimSpace(position.ID) == "" || strings.TrimSpace(providerID) == "" {
		return managedCancellation{}, fmt.Errorf("managed cancellation binding is incomplete")
	}
	projection, err := pm.storageService.GetManagedOrderByBrokerOrderID(providerID)
	if err != nil || projection == nil || projection.PositionID != position.ID || projection.Role != "protection" || projection.Purpose != "protection" ||
		!managedIdentityMatches(projection.DurableIdentity, position.DurableIdentity) || !managedIdentityMatches(projection.DurableIdentity, pm.storageService.DurableIdentity()) || projection.BrokerOrderID != providerID || projection.ClientOrderID == "" {
		return managedCancellation{}, fmt.Errorf("managed cancellation binding rejected for order identity")
	}
	return managedCancellation{positionID: position.ID, providerID: providerID, clientID: projection.ClientOrderID, role: projection.Role, purpose: projection.Purpose}, nil
}

func (pm *PositionManager) boundManagedCancellations(position *ManagedPosition) ([]managedCancellation, error) {
	type target struct{ brokerID, clientID, role, purpose string }
	targets := make([]target, 0, 4+len(position.PartialExitOrders))
	add := func(brokerID, clientID, role, purpose string) {
		if strings.TrimSpace(brokerID) != "" || strings.TrimSpace(clientID) != "" {
			targets = append(targets, target{brokerID, clientID, role, purpose})
		}
	}
	add(position.EntryOrderID, position.EntryClientOrderID, "entry", "entry")
	add(position.StopLossOrderID, position.StopLossClientOrderID, "protection", "protection")
	add(position.TakeProfitOrderID, position.TakeProfitClientOrderID, "protection", "protection")
	for i, brokerID := range position.PartialExitOrders {
		clientID := ""
		if len(position.PartialExitOrders) == 1 || i == 0 {
			clientID = position.PartialExitClientOrderID
		}
		add(brokerID, clientID, "protection", "protection")
	}
	if len(position.PartialExitOrders) == 0 {
		add("", position.PartialExitClientOrderID, "protection", "protection")
	}

	bound := make([]managedCancellation, 0, len(targets))
	seen := map[string]bool{}
	for _, wanted := range targets {
		var projection *models.DBManagedOrder
		var err error
		if wanted.clientID != "" {
			projection, err = pm.storageService.GetManagedOrder(wanted.clientID)
		} else {
			projection, err = pm.storageService.GetManagedOrderByBrokerOrderID(wanted.brokerID)
		}
		if err != nil {
			return nil, fmt.Errorf("managed cancellation binding rejected: %w", err)
		}
		if projection == nil || projection.PositionID != position.ID || projection.Role != wanted.role || projection.Purpose != wanted.purpose ||
			!managedIdentityMatches(projection.DurableIdentity, position.DurableIdentity) ||
			!managedIdentityMatches(projection.DurableIdentity, pm.storageService.DurableIdentity()) ||
			(wanted.clientID != "" && projection.ClientOrderID != wanted.clientID) ||
			(wanted.brokerID != "" && projection.BrokerOrderID != wanted.brokerID) {
			return nil, fmt.Errorf("managed cancellation binding rejected for order identity")
		}
		providerID := projection.BrokerOrderID
		if providerID == "" {
			providerID = projection.ClientOrderID
		}
		if providerID == "" || seen[providerID] {
			return nil, fmt.Errorf("managed cancellation binding is stale or ambiguous")
		}
		seen[providerID] = true
		bound = append(bound, managedCancellation{positionID: position.ID, providerID: providerID, clientID: projection.ClientOrderID, role: projection.Role, purpose: projection.Purpose})
	}
	return bound, nil
}

// Helper functions

func (pm *PositionManager) validateRequest(req *PlaceManagedPositionRequest) error {
	if req.Side != "buy" && req.Side != "sell" {
		return fmt.Errorf("side must be 'buy' or 'sell'")
	}
	if req.EntryStrategy != "limit" {
		return fmt.Errorf("managed entry_strategy must be 'limit' until market-order notional caps are supported")
	}
	if req.EntryPrice == nil || !positiveFinite(*req.EntryPrice) {
		return fmt.Errorf("entry_price must be positive for limit orders")
	}
	if req.EntryPrice != nil && !positiveFinite(*req.EntryPrice) {
		return fmt.Errorf("entry_price must be positive")
	}

	protectionLegs := 0
	if req.StopLossPrice != nil || req.StopLossPercent != nil {
		protectionLegs++
	}
	if req.TakeProfitPrice != nil || req.TakeProfitPercent != nil {
		protectionLegs++
	}
	if req.TrailingStop {
		if req.StopLossPrice == nil && req.StopLossPercent == nil {
			return fmt.Errorf("trailing_stop requires a durable stop-loss leg")
		}
		protectionLegs++
	}
	if req.PartialExit != nil && req.PartialExit.Enabled {
		protectionLegs++
	}
	if protectionLegs != 1 {
		return fmt.Errorf("exactly one executable protection leg is required until durable OCO coordination is available")
	}
	if req.StopLossPrice != nil && !positiveFinite(*req.StopLossPrice) {
		return fmt.Errorf("stop_loss_price must be positive")
	}
	if req.TakeProfitPrice != nil && !positiveFinite(*req.TakeProfitPrice) {
		return fmt.Errorf("take_profit_price must be positive")
	}
	if req.StopLossPercent != nil && !positiveFinite(*req.StopLossPercent) {
		return fmt.Errorf("stop_loss_percent must be positive")
	}
	if req.TakeProfitPercent != nil && !positiveFinite(*req.TakeProfitPercent) {
		return fmt.Errorf("take_profit_percent must be positive")
	}
	if req.TrailingStop && !positiveFinite(req.TrailingPercent) {
		return fmt.Errorf("trailing_percent must be positive when trailing_stop is enabled")
	}
	if req.PartialExit != nil && req.PartialExit.Enabled {
		if !positiveFinite(req.PartialExit.Percent) || req.PartialExit.Percent >= 100 {
			return fmt.Errorf("partial_exit.percent must be between 0 and 100")
		}
		if !positiveFinite(req.PartialExit.TargetPercent) {
			return fmt.Errorf("partial_exit.target_percent must be positive")
		}
	}
	if req.EntryPrice != nil && req.StopLossPrice != nil && req.TakeProfitPrice != nil {
		if req.Side == "buy" && !(*req.StopLossPrice < *req.EntryPrice && *req.TakeProfitPrice > *req.EntryPrice) {
			return fmt.Errorf("buy stop loss must be below entry and take profit above entry")
		}
		if req.Side == "sell" && !(*req.StopLossPrice > *req.EntryPrice && *req.TakeProfitPrice < *req.EntryPrice) {
			return fmt.Errorf("sell stop loss must be above entry and take profit below entry")
		}
	}
	return nil
}

func positiveFinite(value float64) bool {
	return value > 0 && !math.IsNaN(value) && !math.IsInf(value, 0)
}

func (pm *PositionManager) getCurrentPrice(ctx context.Context, symbol string) (float64, error) {
	quote, err := pm.dataService.GetLatestQuote(ctx, symbol)
	if err != nil {
		return 0, err
	}

	if quote.AskPrice > 0 {
		return quote.AskPrice, nil
	}

	return quote.BidPrice, nil
}

func (pm *PositionManager) calculateQuantity(allocation, price float64) float64 {
	return math.Floor(allocation / price)
}

func (pm *PositionManager) calculateStopLoss(entryPrice float64, stopPrice *float64, stopPercent *float64, side string) float64 {
	if stopPrice != nil {
		return *stopPrice
	}

	if side == "buy" {
		return entryPrice * (1 - *stopPercent/100.0)
	}

	return entryPrice * (1 + *stopPercent/100.0)
}

func (pm *PositionManager) calculateTakeProfit(entryPrice float64, profitPrice *float64, profitPercent *float64, side string) float64 {
	if profitPrice != nil {
		return *profitPrice
	}

	if side == "buy" {
		return entryPrice * (1 + *profitPercent/100.0)
	}

	return entryPrice * (1 - *profitPercent/100.0)
}

func (pm *PositionManager) calculatePartialExitPrice(entryPrice, targetPercent float64, side string) float64 {
	if side == "buy" {
		return entryPrice * (1 + targetPercent/100.0)
	}

	return entryPrice * (1 - targetPercent/100.0)
}

func (pm *PositionManager) generatePositionID() string {
	return fmt.Sprintf("pos_%d", time.Now().UnixNano())
}

// Stop stops the position manager
func (pm *PositionManager) Stop() {
	pm.cancel()
}

// loadPositionsFromDB loads all active positions from database on startup
func (pm *PositionManager) loadPositionsFromDB() error {
	// Load all non-closed positions
	dbPositions, err := pm.storageService.GetAllManagedPositions("")
	if err != nil {
		return err
	}

	loaded := 0
	for _, dbPos := range dbPositions {
		// Skip closed positions
		if dbPos.Status == "CLOSED" || dbPos.Status == "STOPPED_OUT" {
			continue
		}

		// Convert DB position to managed position
		position := pm.dbToManagedPosition(dbPos)

		// Store in memory
		pm.positions[position.ID] = position
		loaded++
	}

	pm.logger.WithField("count", loaded).Info("Loaded managed positions from database")
	return nil
}

// savePositionToDB saves a managed position to database
func (pm *PositionManager) savePositionToDB(position *ManagedPosition) error {
	dbPosition := pm.managedPositionToDB(position)
	if err := pm.storageService.SaveManagedPosition(dbPosition); err != nil {
		return err
	}
	position.Revision = dbPosition.Revision
	return nil
}

// managedPositionToDB converts ManagedPosition to DBManagedPosition
func (pm *PositionManager) managedPositionToDB(pos *ManagedPosition) *models.DBManagedPosition {
	// Convert partial exit orders to JSON
	partialExitOrdersJSON, _ := json.Marshal(pos.PartialExitOrders)
	protectionFillWatermarksJSON, _ := json.Marshal(pos.ProtectionFillWatermarks)
	exitFillWatermarksJSON, _ := json.Marshal(pos.ExitFillWatermarks)

	// Convert tags to JSON
	tagsJSON, _ := json.Marshal(pos.Tags)

	dbPos := &models.DBManagedPosition{
		DurableIdentity:          pos.DurableIdentity,
		PositionID:               pos.ID,
		Revision:                 pos.Revision,
		Symbol:                   pos.Symbol,
		Side:                     pos.Side,
		Strategy:                 pos.Strategy,
		Quantity:                 pos.Quantity,
		EntryRemainingQty:        pos.EntryRemainingQty,
		EntryPrice:               pos.EntryPrice,
		EntryOrderID:             pos.EntryOrderID,
		EntryClientOrderID:       pos.EntryClientOrderID,
		ExitOrderID:              pos.ExitOrderID,
		ExitClientOrderID:        pos.ExitClientOrderID,
		ExitFilledQty:            pos.ExitFilledQty,
		ExitFillWatermarks:       string(exitFillWatermarksJSON),
		EntryOrderType:           pos.EntryOrderType,
		AllocationDollars:        pos.AllocationDollars,
		StopLossPrice:            pos.StopLossPrice,
		StopLossPercent:          pos.StopLossPercent,
		StopLossOrderID:          pos.StopLossOrderID,
		StopLossClientOrderID:    pos.StopLossClientOrderID,
		TrailingStop:             pos.TrailingStop,
		TrailingPercent:          pos.TrailingPercent,
		TakeProfitPrice:          pos.TakeProfitPrice,
		TakeProfitPercent:        pos.TakeProfitPercent,
		TakeProfitOrderID:        pos.TakeProfitOrderID,
		TakeProfitClientOrderID:  pos.TakeProfitClientOrderID,
		Status:                   pos.Status,
		CurrentPrice:             pos.CurrentPrice,
		UnrealizedPL:             pos.UnrealizedPL,
		UnrealizedPLPC:           pos.UnrealizedPLPC,
		RemainingQty:             pos.RemainingQty,
		Notes:                    pos.Notes,
		Tags:                     string(tagsJSON),
		PartialExitOrders:        string(partialExitOrdersJSON),
		PartialExitClientOrderID: pos.PartialExitClientOrderID,
		ProtectionFillWatermarks: string(protectionFillWatermarksJSON),
		ClosedAt:                 pos.ClosedAt,
	}

	if pos.PartialExit != nil {
		dbPos.PartialExitEnabled = pos.PartialExit.Enabled
		dbPos.PartialExitPercent = pos.PartialExit.Percent
		dbPos.PartialExitTargetPercent = pos.PartialExit.TargetPercent
		dbPos.PartialExitTargetPrice = pos.PartialExit.TargetPrice
	}

	return dbPos
}

// dbToManagedPosition converts DBManagedPosition to ManagedPosition
func (pm *PositionManager) dbToManagedPosition(dbPos *models.DBManagedPosition) *ManagedPosition {
	// Parse partial exit orders from JSON
	var partialExitOrders []string
	if dbPos.PartialExitOrders != "" {
		json.Unmarshal([]byte(dbPos.PartialExitOrders), &partialExitOrders)
	}
	var protectionFillWatermarks map[string]float64
	if dbPos.ProtectionFillWatermarks != "" {
		json.Unmarshal([]byte(dbPos.ProtectionFillWatermarks), &protectionFillWatermarks)
	}
	var exitFillWatermarks map[string]float64
	if dbPos.ExitFillWatermarks != "" {
		json.Unmarshal([]byte(dbPos.ExitFillWatermarks), &exitFillWatermarks)
	}

	// Parse tags from JSON
	var tags []string
	if dbPos.Tags != "" {
		json.Unmarshal([]byte(dbPos.Tags), &tags)
	}

	pos := &ManagedPosition{
		DurableIdentity:          dbPos.DurableIdentity,
		ID:                       dbPos.PositionID,
		Revision:                 dbPos.Revision,
		Symbol:                   dbPos.Symbol,
		Side:                     dbPos.Side,
		Strategy:                 dbPos.Strategy,
		Quantity:                 dbPos.Quantity,
		EntryRemainingQty:        dbPos.EntryRemainingQty,
		EntryPrice:               dbPos.EntryPrice,
		EntryOrderID:             dbPos.EntryOrderID,
		EntryClientOrderID:       dbPos.EntryClientOrderID,
		ExitOrderID:              dbPos.ExitOrderID,
		ExitClientOrderID:        dbPos.ExitClientOrderID,
		ExitFilledQty:            dbPos.ExitFilledQty,
		ExitFillWatermarks:       exitFillWatermarks,
		EntryOrderType:           dbPos.EntryOrderType,
		AllocationDollars:        dbPos.AllocationDollars,
		StopLossPrice:            dbPos.StopLossPrice,
		StopLossPercent:          dbPos.StopLossPercent,
		StopLossOrderID:          dbPos.StopLossOrderID,
		StopLossClientOrderID:    dbPos.StopLossClientOrderID,
		TrailingStop:             dbPos.TrailingStop,
		TrailingPercent:          dbPos.TrailingPercent,
		TakeProfitPrice:          dbPos.TakeProfitPrice,
		TakeProfitPercent:        dbPos.TakeProfitPercent,
		TakeProfitOrderID:        dbPos.TakeProfitOrderID,
		TakeProfitClientOrderID:  dbPos.TakeProfitClientOrderID,
		Status:                   dbPos.Status,
		CurrentPrice:             dbPos.CurrentPrice,
		UnrealizedPL:             dbPos.UnrealizedPL,
		UnrealizedPLPC:           dbPos.UnrealizedPLPC,
		RemainingQty:             dbPos.RemainingQty,
		Notes:                    dbPos.Notes,
		Tags:                     tags,
		PartialExitOrders:        partialExitOrders,
		PartialExitClientOrderID: dbPos.PartialExitClientOrderID,
		ProtectionFillWatermarks: protectionFillWatermarks,
		CreatedAt:                dbPos.CreatedAt,
		UpdatedAt:                dbPos.UpdatedAt,
		ClosedAt:                 dbPos.ClosedAt,
	}

	if dbPos.PartialExitEnabled {
		pos.PartialExit = &PartialExitConfig{
			Enabled:       dbPos.PartialExitEnabled,
			Percent:       dbPos.PartialExitPercent,
			TargetPercent: dbPos.PartialExitTargetPercent,
			TargetPrice:   dbPos.PartialExitTargetPrice,
		}
	}

	return pos
}
