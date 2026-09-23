package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"prophet-trader/interfaces"
	"prophet-trader/models"
	"strings"
	"sync"
	"time"

	"github.com/alpacahq/alpaca-trade-api-go/v3/alpaca"
	"github.com/alpacahq/alpaca-trade-api-go/v3/marketdata"
	"github.com/shopspring/decimal"
	"github.com/sirupsen/logrus"
)

// AlpacaTradingService implements TradingService using Alpaca API
type AlpacaTradingService struct {
	client                  *alpaca.Client
	dataClient              *marketdata.Client
	clockReader             MarketClockReader
	placeOrderFn            func(alpaca.PlaceOrderRequest) (*alpaca.Order, error)
	apiKey                  string
	apiSecret               string
	logger                  *logrus.Logger
	executionMu             sync.RWMutex
	executionBlocked        bool
	policy                  *TradingPolicy
	expectedAccountID       string
	expectedPaper           bool
	expectedTenantID        string
	expectedSandboxID       string
	localOrderProvider      func(context.Context) ([]*interfaces.Order, error)
	openingReservationMu    sync.Mutex
	openingReservationPath  string
	submissionMarker        func(string) error
	managedSubmissionMarker func(string, string, string) error
	alphaDesk               *AlphaDeskClient
	optionsChainProvider    func(context.Context, string, time.Time) ([]*interfaces.OptionContract, error)
}

func (s *AlpacaTradingService) SetAlphaDeskClient(client *AlphaDeskClient) { s.alphaDesk = client }
func (s *AlpacaTradingService) AssessOptionsStrategy(ctx context.Context, order *interfaces.OptionsOrder, features any) (*interfaces.AlphaDeskAssessment, error) {
	if s.alphaDesk == nil || !s.alphaDesk.Enabled {
		return nil, nil
	}
	if order == nil {
		return nil, &AlphaDeskUnavailableError{Reason: "options assessment order is unavailable"}
	}
	if len(order.AssessmentLegs) == 0 {
		if err := s.enrichOptionsAssessment(ctx, order); err != nil {
			return nil, err
		}
	}
	return s.alphaDesk.AssessForTrade(ctx, models.DurableIdentity{BrokerAccountID: s.expectedAccountID, PaperLive: map[bool]string{true: "paper", false: "live"}[s.expectedPaper], TenantID: s.expectedTenantID, SandboxID: s.expectedSandboxID}, order, features)
}

func (s *AlpacaTradingService) enrichOptionsAssessment(ctx context.Context, order *interfaces.OptionsOrder) error {
	if len(order.AssessmentLegs) > 1 {
		return &AlphaDeskUnavailableError{Reason: "multi-leg option evidence is unavailable; only single-leg orders are supported"}
	}
	if order.LimitPrice == nil || *order.LimitPrice <= 0 || order.Qty < 1 || order.Qty > 10 || math.Trunc(order.Qty) != order.Qty {
		return &AlphaDeskUnavailableError{Reason: "valid limit price and integer quantity are required for market evidence"}
	}
	_, expiration, _, _, ok := parseOCCOptionSymbol(order.Symbol)
	if !ok {
		return &AlphaDeskUnavailableError{Reason: "option contract evidence is unavailable"}
	}
	chain, err := s.GetOptionsChain(ctx, order.Underlying, expiration)
	if err != nil {
		return &AlphaDeskUnavailableError{Reason: "broker option evidence is unavailable", Err: err}
	}
	var contract *interfaces.OptionContract
	for _, candidate := range chain {
		if strings.EqualFold(candidate.Symbol, order.Symbol) {
			contract = candidate
			break
		}
	}
	if contract == nil || contract.Ask <= 0 || contract.Bid < 0 || contract.QuoteTimestamp.IsZero() || contract.BidSize <= 0 || contract.AskSize <= 0 {
		return &AlphaDeskUnavailableError{Reason: "fresh broker quote evidence is unavailable"}
	}
	quoteSize := float64(contract.AskSize)
	if strings.EqualFold(order.Side, "sell") {
		quoteSize = float64(contract.BidSize)
	}
	leg := interfaces.AlphaDeskAssessmentLeg{Symbol: contract.Symbol, Side: strings.ToLower(order.Side), Quantity: int(order.Qty), Price: *order.LimitPrice, Bid: contract.Bid, Ask: contract.Ask, QuoteSize: quoteSize, QuotedAt: contract.QuoteTimestamp, Delta: &contract.Delta, Gamma: &contract.Gamma, Theta: &contract.Theta, Vega: &contract.Vega}
	order.AssessmentLegs = []interfaces.AlphaDeskAssessmentLeg{leg}
	order.StrategyType = "SINGLE_LEG_OPTION"
	order.AssessmentGreeks = map[string]float64{"delta": contract.Delta * order.Qty, "gamma": contract.Gamma * order.Qty, "theta": contract.Theta * order.Qty, "vega": contract.Vega * order.Qty}
	if strings.HasSuffix(strings.ToLower(order.PositionIntent), "_to_open") && strings.EqualFold(order.Side, "buy") {
		loss := *order.LimitPrice * order.Qty * 100
		order.AssessmentMaxLoss = &loss
	} else {
		return &AlphaDeskUnavailableError{Reason: "maximum loss cannot be established truthfully for this option intent"}
	}
	now := time.Now()
	order.MarketEvidenceAt, order.ObservedAt, order.AssessmentExpiresAt = contract.QuoteTimestamp, now, now.Add(2*time.Minute)
	return nil
}

// SetLocalOrderProvider binds the durable local order store to the broker risk snapshot.
func (s *AlpacaTradingService) SetLocalOrderProvider(provider func(context.Context) ([]*interfaces.Order, error)) {
	s.localOrderProvider = provider
}

// SetSubmissionMarker installs the durable transition used immediately before
// an SDK submission. The marker must return an error without calling the
// provider when the transition cannot be persisted.
func (s *AlpacaTradingService) SetSubmissionMarker(marker func(string) error) {
	s.submissionMarker = marker
}

// SetManagedSubmissionMarker installs the managed-order boundary marker. The
// position and role identify the projection that must advance with the generic
// order before the SDK is called.
func (s *AlpacaTradingService) SetManagedSubmissionMarker(marker func(string, string, string) error) {
	s.managedSubmissionMarker = marker
}

func (s *AlpacaTradingService) markSubmissionBoundary(order *interfaces.Order) error {
	if strings.TrimSpace(order.ManagedPositionID) != "" || strings.TrimSpace(order.ManagedRole) != "" {
		if s.managedSubmissionMarker == nil {
			return fmt.Errorf("durable managed submission marker is not configured")
		}
		if err := s.managedSubmissionMarker(order.ClientOrderID, order.ManagedPositionID, order.ManagedRole); err != nil {
			return fmt.Errorf("failed to durably mark managed submission boundary: %w", err)
		}
		return nil
	}
	if s.submissionMarker == nil {
		return fmt.Errorf("durable submission marker is not configured")
	}
	if err := s.submissionMarker(order.ClientOrderID); err != nil {
		return fmt.Errorf("failed to durably mark submission boundary: %w", err)
	}
	return nil
}

func (s *AlpacaTradingService) SetOpeningReservationLock(path string) {
	s.openingReservationPath = strings.TrimSpace(path)
}

func (s *AlpacaTradingService) lockOpeningReservation(opening bool) (func(), error) {
	if !opening || !s.openingCapsActive() {
		return func() {}, nil
	}
	s.openingReservationMu.Lock()
	if s.openingReservationPath == "" {
		s.openingReservationMu.Unlock()
		return nil, fmt.Errorf("durable account reservation lock is not configured")
	}
	releaseFile, err := acquireAccountReservationLock(s.openingReservationPath)
	if err != nil {
		s.openingReservationMu.Unlock()
		return nil, err
	}
	return func() {
		releaseFile()
		s.openingReservationMu.Unlock()
	}, nil
}

// NewAlpacaTradingService creates a new Alpaca trading service
func NewAlpacaTradingService(apiKey, secretKey, baseURL string, isPaper bool) (*AlpacaTradingService, error) {
	parsedBaseURL, err := url.Parse(baseURL)
	if err != nil || parsedBaseURL.Host == "" || strings.ToLower(parsedBaseURL.Scheme) != "https" || parsedBaseURL.Port() != "" && parsedBaseURL.Port() != "443" {
		return nil, fmt.Errorf("invalid Alpaca base URL: HTTPS with no arbitrary port is required")
	}
	host := strings.ToLower(parsedBaseURL.Hostname())
	expectedHost := "api.alpaca.markets"
	if isPaper {
		expectedHost = "paper-api.alpaca.markets"
	}
	if host != expectedHost {
		return nil, fmt.Errorf("Alpaca endpoint %q is not the approved %s endpoint", host, map[bool]string{true: "paper", false: "live"}[isPaper])
	}
	expectedAccountID := strings.TrimSpace(os.Getenv("ALPACA_ACCOUNT_ID"))
	if expectedAccountID == "" {
		return nil, fmt.Errorf("ALPACA_ACCOUNT_ID is required for account isolation")
	}
	expectedTenantID := strings.TrimSpace(os.Getenv("OPENPROPHET_TENANT_ID"))
	expectedSandboxID := strings.TrimSpace(os.Getenv("OPENPROPHET_SANDBOX_ID"))
	if expectedTenantID == "" || expectedSandboxID == "" {
		return nil, fmt.Errorf("OPENPROPHET_TENANT_ID and OPENPROPHET_SANDBOX_ID are required for identity isolation")
	}
	client := alpaca.NewClient(alpaca.ClientOpts{
		APIKey:    apiKey,
		APISecret: secretKey,
		BaseURL:   baseURL,
	})

	// Create data client
	dataClient := marketdata.NewClient(marketdata.ClientOpts{
		APIKey:    apiKey,
		APISecret: secretKey,
	})

	logger := logrus.New()
	logger.SetFormatter(&logrus.TextFormatter{
		FullTimestamp: true,
	})

	return &AlpacaTradingService{
		client:            client,
		dataClient:        dataClient,
		clockReader:       client,
		placeOrderFn:      client.PlaceOrder,
		apiKey:            apiKey,
		apiSecret:         secretKey,
		logger:            logger,
		policy:            TradingPolicyFromEnv(isPaper),
		expectedAccountID: expectedAccountID,
		expectedPaper:     isPaper,
		expectedTenantID:  strings.TrimSpace(os.Getenv("OPENPROPHET_TENANT_ID")),
		expectedSandboxID: strings.TrimSpace(os.Getenv("OPENPROPHET_SANDBOX_ID")),
	}, nil
}

func (s *AlpacaTradingService) SetExecutionBlocked(blocked bool) {
	s.executionMu.Lock()
	s.executionBlocked = blocked
	s.executionMu.Unlock()
}

func (s *AlpacaTradingService) ExecutionBlocked() bool {
	s.executionMu.RLock()
	defer s.executionMu.RUnlock()
	return s.executionBlocked
}

func (s *AlpacaTradingService) ensureExecutionAllowed() error {
	if s.ExecutionBlocked() {
		return fmt.Errorf("execution is blocked pending startup/order reconciliation")
	}
	return nil
}

func (s *AlpacaTradingService) brokerRiskSnapshot(ctx context.Context, excludeClientOrderID string) (BrokerRiskSnapshot, error) {
	account, err := s.GetAccount(ctx)
	if err != nil {
		return BrokerRiskSnapshot{}, err
	}
	positions, err := s.GetPositions(ctx)
	if err != nil {
		return BrokerRiskSnapshot{}, err
	}
	pendingOrders, err := s.ListOrders(ctx, "open")
	if err != nil {
		return BrokerRiskSnapshot{}, err
	}
	if s.localOrderProvider != nil {
		localOrders, providerErr := s.localOrderProvider(ctx)
		if providerErr != nil {
			return BrokerRiskSnapshot{}, fmt.Errorf("local reservation snapshot unavailable: %w", providerErr)
		}
		for _, localOrder := range localOrders {
			if IsRiskRelevantLocalOrder(localOrder) {
				pendingOrders = append(pendingOrders, localOrder)
			}
		}
	}
	if excludeClientOrderID != "" {
		filtered := pendingOrders[:0]
		for _, pending := range pendingOrders {
			if pending == nil || pending.ClientOrderID != excludeClientOrderID {
				filtered = append(filtered, pending)
			}
		}
		pendingOrders = filtered
	}
	return BrokerRiskSnapshot{Account: account, Positions: positions, PendingOrders: pendingOrders}, nil
}

func (s *AlpacaTradingService) openingCapsActive() bool {
	return s.policy != nil && (s.policy.MaxOrderValue > 0 || s.policy.MaxPositionPct > 0 || s.policy.MaxDeployedPct > 0 || s.policy.MaxOpenPositions > 0 || s.policy.MaxDailyLoss > 0)
}

func quoteTimestampFresh(timestamp time.Time) bool {
	if timestamp.IsZero() {
		return false
	}
	age := time.Since(timestamp)
	return age >= 0 && age <= 2*time.Minute
}

func (s *AlpacaTradingService) validateEquityPolicy(ctx context.Context, order *interfaces.Order) error {
	if s.policy == nil {
		return nil
	}
	candidate := *order
	opening := order.Purpose == "entry"
	if opening && s.openingCapsActive() && s.localOrderProvider == nil {
		return fmt.Errorf("durable local order provider is required for opening-risk enforcement")
	}
	if opening && candidate.LimitPrice == nil && candidate.StopPrice == nil && s.openingCapsActive() {
		return fmt.Errorf("opening market order requires an explicit limit or stop price while risk caps are active")
	}
	if opening && candidate.LimitPrice == nil && candidate.StopPrice == nil {
		if s.dataClient == nil {
			return fmt.Errorf("stock quote unavailable for final risk-policy evaluation")
		}
		quote, err := s.dataClient.GetLatestQuote(candidate.Symbol, marketdata.GetLatestQuoteRequest{})
		if err != nil || quote == nil {
			if err == nil {
				err = fmt.Errorf("empty stock quote")
			}
			return fmt.Errorf("stock quote unavailable for final risk-policy evaluation: %w", err)
		}
		if s.openingCapsActive() && !quoteTimestampFresh(quote.Timestamp) {
			return fmt.Errorf("stock quote is stale or missing a timestamp for final risk-policy evaluation")
		}
		price := quote.AskPrice
		if candidate.Side == "sell" {
			price = quote.BidPrice
		}
		if !isPositiveFinite(price) {
			return fmt.Errorf("stock quote has no positive executable price")
		}
		candidate.LimitPrice = &price
	}
	snapshot, err := s.brokerRiskSnapshot(ctx, order.ClientOrderID)
	if err != nil {
		return fmt.Errorf("broker risk snapshot unavailable: %w", err)
	}
	if _, err := s.policy.ValidateOrder(&candidate, snapshot); err != nil {
		return &PreSubmissionRejectionError{Err: fmt.Errorf("broker trading policy rejected order: %w", err)}
	}
	return nil
}

func (s *AlpacaTradingService) validateOptionsPolicy(ctx context.Context, order *interfaces.OptionsOrder) error {
	if s.policy == nil {
		return nil
	}
	candidate := *order
	opening := strings.HasSuffix(candidate.PositionIntent, "_to_open")
	if opening && s.openingCapsActive() && s.localOrderProvider == nil {
		return fmt.Errorf("durable local order provider is required for opening-risk enforcement")
	}
	if opening && candidate.LimitPrice == nil && s.openingCapsActive() {
		return fmt.Errorf("opening options market order requires an explicit limit price while risk caps are active")
	}
	if opening && candidate.LimitPrice == nil {
		quote, err := s.GetOptionsQuote(ctx, candidate.Symbol)
		if err != nil || quote == nil {
			if err == nil {
				err = fmt.Errorf("empty options quote")
			}
			return fmt.Errorf("options quote unavailable for final risk-policy evaluation: %w", err)
		}
		if s.openingCapsActive() && !quoteTimestampFresh(quote.Timestamp) {
			return fmt.Errorf("options quote is stale or missing a timestamp for final risk-policy evaluation")
		}
		price := quote.AskPrice
		if candidate.Side == "sell" {
			price = quote.BidPrice
		}
		if !isPositiveFinite(price) {
			return fmt.Errorf("options quote has no positive executable price")
		}
		candidate.LimitPrice = &price
	}
	snapshot, err := s.brokerRiskSnapshot(ctx, order.ClientOrderID)
	if err != nil {
		return fmt.Errorf("broker risk snapshot unavailable: %w", err)
	}
	if _, err := s.policy.ValidateOptionsOrder(&candidate, snapshot); err != nil {
		return &PreSubmissionRejectionError{Err: fmt.Errorf("broker trading policy rejected options order: %w", err)}
	}
	return nil
}

// GetMarketClock returns the broker-authoritative regular-session clock.
func (s *AlpacaTradingService) GetMarketClock(ctx context.Context) (*interfaces.MarketClock, error) {
	clock, err := s.clockReader.GetClock()
	if err != nil {
		return nil, fmt.Errorf("failed to get broker market clock: %w", err)
	}
	if clock == nil {
		return nil, fmt.Errorf("failed to get broker market clock: empty response")
	}
	return &interfaces.MarketClock{
		Timestamp: clock.Timestamp,
		IsOpen:    clock.IsOpen,
		NextOpen:  clock.NextOpen,
		NextClose: clock.NextClose,
	}, nil
}

// PlaceOrder places a new equity order. OCC option symbols must use the
// explicit options route so intent and options permissions cannot be bypassed.
func (s *AlpacaTradingService) PlaceOrder(ctx context.Context, order *interfaces.Order) (*interfaces.OrderResult, error) {
	if err := s.ensureExecutionAllowed(); err != nil {
		return nil, err
	}
	if order == nil {
		return nil, fmt.Errorf("order is required")
	}
	if IsOCCOptionSymbol(order.Symbol) {
		return nil, fmt.Errorf("option symbol %q must use place_options_order; generic equity order rejected", order.Symbol)
	}
	if strings.TrimSpace(order.ClientOrderID) == "" {
		return nil, fmt.Errorf("client order ID is required at broker boundary")
	}
	if strings.TrimSpace(order.Purpose) != "entry" && strings.TrimSpace(order.Purpose) != "close" && strings.TrimSpace(order.Purpose) != "protection" {
		return nil, fmt.Errorf("order purpose is required and must be entry, close, or protection")
	}
	if err := checkRegularSession(s.clockReader); err != nil {
		return nil, err
	}
	releaseReservation, lockErr := s.lockOpeningReservation(order.Purpose == "entry")
	if lockErr != nil {
		return nil, lockErr
	}
	defer releaseReservation()
	if err := s.validateEquityPolicy(ctx, order); err != nil {
		return nil, err
	}

	qty := decimal.NewFromFloat(order.Qty)
	req := alpaca.PlaceOrderRequest{
		Symbol:      order.Symbol,
		Qty:         &qty,
		Side:        alpaca.Side(order.Side),
		Type:        alpaca.OrderType(order.Type),
		TimeInForce: alpaca.TimeInForce(order.TimeInForce),
	}
	if order.ClientOrderID != "" {
		req.ClientOrderID = order.ClientOrderID
	}

	if order.LimitPrice != nil {
		limitPrice := decimal.NewFromFloat(*order.LimitPrice)
		req.LimitPrice = &limitPrice
	}

	if order.StopPrice != nil {
		stopPrice := decimal.NewFromFloat(*order.StopPrice)
		req.StopPrice = &stopPrice
	}

	s.logger.WithFields(logrus.Fields{
		"symbol": order.Symbol,
		"side":   order.Side,
		"qty":    order.Qty,
		"type":   order.Type,
	}).Info("Placing order")

	placeOrder := s.placeOrderFn
	if placeOrder == nil && s.client != nil {
		placeOrder = s.client.PlaceOrder
	}
	if placeOrder == nil {
		return nil, fmt.Errorf("broker order submission is unavailable")
	}
	if err := s.markSubmissionBoundary(order); err != nil {
		return nil, err
	}
	alpacaOrder, err := placeOrder(req)
	if err != nil {
		// Startup reconciliation is handled by OrderController.ReconcileOpenOrders.
		s.logger.WithError(err).Error("Failed to place order")
		return nil, &SubmissionUncertainError{Err: fmt.Errorf("failed to place order with client_order_id %s: %w", order.ClientOrderID, err)}
	}

	result := orderResultFromAlpacaOrder(&req, alpacaOrder, models.DurableIdentity{BrokerAccountID: s.expectedAccountID, PaperLive: map[bool]string{true: "paper", false: "live"}[s.expectedPaper], TenantID: s.expectedTenantID, SandboxID: s.expectedSandboxID})
	result.Purpose = order.Purpose
	result.AssetClass = order.AssetClass
	if result.AssetClass == "" {
		result.AssetClass = "us_equity"
	}
	if err := ValidateOrderResultIdentity(result, order.ClientOrderID, order.Symbol, order.Side, order.Qty, order.Type, order.TimeInForce, order.LimitPrice, order.StopPrice, order.PositionIntent, order.Purpose); err != nil {
		return nil, &SubmissionUncertainError{Err: err}
	}
	if err := ValidateOrderResultIdentityForExecution(result, models.DurableIdentity{BrokerAccountID: s.expectedAccountID, PaperLive: map[bool]string{true: "paper", false: "live"}[s.expectedPaper], TenantID: s.expectedTenantID, SandboxID: s.expectedSandboxID}); err != nil {
		return nil, &SubmissionUncertainError{Err: err}
	}
	return result, nil
}

func (s *AlpacaTradingService) resolveBrokerOrderID(ctx context.Context, orderID string) (string, error) {
	orderID = strings.TrimSpace(orderID)
	if orderID == "" {
		return "", fmt.Errorf("order ID is required")
	}
	clientOrder, clientErr := s.GetOrderByClientOrderID(ctx, orderID)
	if clientErr == nil && clientOrder != nil && clientOrder.ID != "" {
		return clientOrder.ID, nil
	}
	if clientErr != nil && !IsOrderNotFound(clientErr) {
		return "", &SubmissionUncertainError{Err: fmt.Errorf("could not resolve order identity %s before cancellation: %w", orderID, clientErr)}
	}
	brokerOrder, brokerErr := s.GetOrder(ctx, orderID)
	if brokerErr != nil {
		return "", &SubmissionUncertainError{Err: fmt.Errorf("could not verify order identity %s before cancellation: %w", orderID, brokerErr)}
	}
	if brokerOrder == nil || strings.TrimSpace(brokerOrder.ID) == "" {
		return "", fmt.Errorf("order identity %s is unavailable", orderID)
	}
	return brokerOrder.ID, nil
}

func classifyCancellationReadback(orderID string, brokerOrder *alpaca.Order, readErr error, identities ...models.DurableIdentity) error {
	if readErr != nil || brokerOrder == nil {
		if readErr == nil {
			readErr = fmt.Errorf("empty broker order response")
		}
		return &SubmissionUncertainError{Err: fmt.Errorf("cancel readback failed for %s: %w", orderID, readErr)}
	}
	converted := convertAlpacaOrderStatic(brokerOrder)
	if converted == nil {
		return &SubmissionUncertainError{Err: fmt.Errorf("cancel readback returned no order for %s", orderID)}
	}
	status := strings.ToLower(converted.Status)
	if converted.FilledQty > 0 || status == "filled" || status == "partially_filled" {
		var identity models.DurableIdentity
		if len(identities) == 1 {
			identity = identities[0]
		}
		return &SubmissionUncertainError{
			Err: fmt.Errorf("order %s filled or partially filled before cancellation", orderID),
			// This is the server-owned execution identity. Never infer identity
			// from the provider readback or from the cancellation caller.
			Result: orderResultFromAlpacaOrder(nil, brokerOrder, identity),
		}
	}
	if status == "canceled" || status == "cancelled" || status == "expired" || status == "done_for_day" {
		return nil
	}
	if status == "replaced" {
		return &SubmissionUncertainError{Err: fmt.Errorf("order %s was replaced; replacement chain requires reconciliation", orderID)}
	}
	return &SubmissionUncertainError{Err: fmt.Errorf("order %s remains in broker status %s after cancellation", orderID, converted.Status)}
}

// CancelOrder cancels an existing order and always reads back its broker state.
func (s *AlpacaTradingService) CancelOrder(ctx context.Context, orderID string) error {
	if err := s.ensureExecutionAllowed(); err != nil {
		return err
	}
	resolvedID, resolveErr := s.resolveBrokerOrderID(ctx, orderID)
	if resolveErr != nil {
		return resolveErr
	}
	s.logger.WithField("orderID", orderID).Info("Canceling order")
	for hop := 0; hop < 8; hop++ {
		cancelErr := s.client.CancelOrder(resolvedID)
		brokerOrder, readErr := s.client.GetOrder(resolvedID)
		if readErr == nil && brokerOrder != nil && brokerOrder.ReplacedBy != nil && strings.TrimSpace(*brokerOrder.ReplacedBy) != "" {
			resolvedID = strings.TrimSpace(*brokerOrder.ReplacedBy)
			continue
		}
		if cancelErr != nil {
			if readErr != nil {
				return &SubmissionUncertainError{Err: fmt.Errorf("cancel failed and identity-bound readback failed for %s: cancel=%v readback=%w", orderID, cancelErr, readErr)}
			}
			if classifyErr := classifyCancellationReadback(orderID, brokerOrder, nil, s.cancellationIdentity()); classifyErr == nil {
				return &SubmissionUncertainError{Err: fmt.Errorf("cancel API failed for %s but readback is canceled; reconcile local state before retrying: %w", orderID, cancelErr)}
			} else {
				return classifyErr
			}
		}
		return classifyCancellationReadback(orderID, brokerOrder, readErr, s.cancellationIdentity())
	}
	return &SubmissionUncertainError{Err: fmt.Errorf("order %s replacement chain exceeded reconciliation limit", orderID)}
}

func (s *AlpacaTradingService) cancellationIdentity() models.DurableIdentity {
	return models.DurableIdentity{BrokerAccountID: s.expectedAccountID, PaperLive: map[bool]string{true: "paper", false: "live"}[s.expectedPaper], TenantID: s.expectedTenantID, SandboxID: s.expectedSandboxID}
}

// GetOrder retrieves a specific order
func (s *AlpacaTradingService) GetOrder(ctx context.Context, orderID string) (*interfaces.Order, error) {
	if _, err := s.GetAccount(ctx); err != nil {
		return nil, fmt.Errorf("broker account binding could not be verified before order read: %w", err)
	}
	alpacaOrder, err := s.client.GetOrder(orderID)
	if err != nil {
		return nil, fmt.Errorf("failed to get order: %w", err)
	}

	if alpacaOrder == nil {
		return nil, fmt.Errorf("broker returned no order payload for %q", orderID)
	}
	return s.convertAlpacaOrder(alpacaOrder), nil
}

// GetOrderByClientOrderID retrieves an order by its client order ID.
func (s *AlpacaTradingService) GetOrderByClientOrderID(ctx context.Context, clientOrderID string) (*interfaces.Order, error) {
	if _, err := s.GetAccount(ctx); err != nil {
		return nil, &OrderLookupError{ClientOrderID: clientOrderID, NotFound: false, Err: fmt.Errorf("broker account binding could not be verified before client-order read: %w", err)}
	}
	alpacaOrder, err := s.client.GetOrderByClientOrderID(clientOrderID)
	if err != nil {
		var apiErr *alpaca.APIError
		notFound := errors.As(err, &apiErr) && apiErr.StatusCode == 404
		return nil, &OrderLookupError{ClientOrderID: clientOrderID, NotFound: notFound, Err: err}
	}
	if alpacaOrder == nil {
		return nil, &OrderLookupError{ClientOrderID: clientOrderID, NotFound: false, Err: fmt.Errorf("broker returned no order payload")}
	}

	return s.convertAlpacaOrder(alpacaOrder), nil
}

// ListOrders retrieves orders with optional status filter
const alpacaOrdersPageLimit = 500

// The installed SDK exposes only timestamp-based pagination. Alpaca's order
// history API uses an order-ID cursor, so a full SDK page is ambiguous: do not
// advance by timestamp and silently omit orders sharing a timestamp.
func orderHistoryRequiresOrderIDCursor(page []alpaca.Order) bool {
	return len(page) >= alpacaOrdersPageLimit
}

func (s *AlpacaTradingService) ListOrders(ctx context.Context, status string) ([]*interfaces.Order, error) {
	if _, err := s.GetAccount(ctx); err != nil {
		return nil, fmt.Errorf("broker account binding could not be verified before order history read: %w", err)
	}
	orders := make([]*interfaces.Order, 0, 500)
	req := alpaca.GetOrdersRequest{Limit: alpacaOrdersPageLimit, Status: "all", Direction: "asc"}
	if status != "" {
		req.Status = status
	}
	alpacaOrders, err := s.client.GetOrders(req)
	if err != nil {
		return nil, fmt.Errorf("failed to list orders page 1: %w", err)
	}
	for i := range alpacaOrders {
		order := alpacaOrders[i]
		orders = append(orders, s.convertAlpacaOrder(&order))
	}
	if orderHistoryRequiresOrderIDCursor(alpacaOrders) {
		return nil, fmt.Errorf("broker order history is incomplete: installed Alpaca SDK lacks documented after_order_id pagination")
	}
	return orders, nil
}

// GetPositions retrieves all current positions
func (s *AlpacaTradingService) GetPositions(ctx context.Context) ([]*interfaces.Position, error) {
	if _, err := s.GetAccount(ctx); err != nil {
		return nil, fmt.Errorf("broker account binding could not be verified before position read: %w", err)
	}
	alpacaPositions, err := s.client.GetPositions()
	if err != nil {
		return nil, fmt.Errorf("failed to get positions: %w", err)
	}

	positions := make([]*interfaces.Position, len(alpacaPositions))
	for i, ap := range alpacaPositions {
		positions[i] = &interfaces.Position{
			BrokerAccountID: s.expectedAccountID,
			PaperLive:       map[bool]string{true: "paper", false: "live"}[s.expectedPaper],
			TenantID:        s.expectedTenantID,
			SandboxID:       s.expectedSandboxID,
			Symbol:          ap.Symbol,
			Qty:             ap.Qty.InexactFloat64(),
			AvgEntryPrice:   ap.AvgEntryPrice.InexactFloat64(),
			MarketValue:     ap.MarketValue.InexactFloat64(),
			CostBasis:       ap.CostBasis.InexactFloat64(),
			UnrealizedPL:    ap.UnrealizedPL.InexactFloat64(),
			UnrealizedPLPC:  ap.UnrealizedIntradayPLPC.InexactFloat64(),
			CurrentPrice:    ap.CurrentPrice.InexactFloat64(),
			Side:            string(ap.Side),
		}
	}

	return positions, nil
}

// GetAccount retrieves account information
func (s *AlpacaTradingService) GetAccount(ctx context.Context) (*interfaces.Account, error) {
	alpacaAccount, err := s.client.GetAccount()
	if err != nil {
		return nil, fmt.Errorf("failed to get account: %w", err)
	}

	if alpacaAccount == nil || strings.TrimSpace(alpacaAccount.ID) == "" {
		return nil, fmt.Errorf("broker returned no account identity")
	}
	if strings.TrimSpace(s.expectedAccountID) == "" || !strings.EqualFold(strings.TrimSpace(alpacaAccount.ID), s.expectedAccountID) {
		return nil, fmt.Errorf("authenticated Alpaca account identity mismatch")
	}
	equity := alpacaAccount.Equity.InexactFloat64()
	lastEquity := alpacaAccount.LastEquity.InexactFloat64()
	dailyPnLValid := isPositiveFinite(equity) && isPositiveFinite(lastEquity)
	dailyPnL := 0.0
	dailyPnLPercent := 0.0
	if dailyPnLValid {
		dailyPnL = equity - lastEquity
		dailyPnLPercent = dailyPnL / lastEquity * 100
	}

	return &interfaces.Account{
		BrokerAccountID:  alpacaAccount.ID,
		PaperLive:        map[bool]string{true: "paper", false: "live"}[s.expectedPaper],
		TenantID:         s.expectedTenantID,
		SandboxID:        s.expectedSandboxID,
		ID:               alpacaAccount.ID,
		Equity:           equity,
		Cash:             alpacaAccount.Cash.InexactFloat64(),
		PortfolioValue:   alpacaAccount.PortfolioValue.InexactFloat64(),
		BuyingPower:      alpacaAccount.BuyingPower.InexactFloat64(),
		DayTradeCount:    int(alpacaAccount.DaytradeCount),
		PatternDayTrader: alpacaAccount.PatternDayTrader,
		LastEquity:       lastEquity,
		DailyPnL:         dailyPnL,
		DailyPnLPercent:  dailyPnLPercent,
		DailyPnLValid:    dailyPnLValid,
	}, nil
}

// Helper function to convert Alpaca order to our interface
func (s *AlpacaTradingService) convertAlpacaOrder(ao *alpaca.Order) *interfaces.Order {
	order := convertAlpacaOrderStatic(ao)
	if order == nil {
		return nil
	}
	order.BrokerAccountID = s.expectedAccountID
	order.PaperLive = map[bool]string{true: "paper", false: "live"}[s.expectedPaper]
	order.TenantID = s.expectedTenantID
	order.SandboxID = s.expectedSandboxID
	return order
}

func convertAlpacaOrderStatic(ao *alpaca.Order) *interfaces.Order {
	if ao == nil {
		return nil
	}
	order := &interfaces.Order{
		ID:             ao.ID,
		ClientOrderID:  ao.ClientOrderID,
		Symbol:         ao.Symbol,
		Side:           string(ao.Side),
		Type:           string(ao.Type),
		TimeInForce:    string(ao.TimeInForce),
		Status:         string(ao.Status),
		SubmittedAt:    ao.SubmittedAt,
		AssetClass:     string(ao.AssetClass),
		PositionIntent: string(ao.PositionIntent),
	}
	intent := strings.ToLower(order.PositionIntent)
	if strings.HasSuffix(intent, "_to_open") {
		order.Purpose = "entry"
	} else if strings.HasSuffix(intent, "_to_close") {
		order.Purpose = "close"
	}
	if ao.Qty != nil {
		order.Qty = ao.Qty.InexactFloat64()
	}
	if ao.LimitPrice != nil {
		val := ao.LimitPrice.InexactFloat64()
		order.LimitPrice = &val
	}
	if ao.StopPrice != nil {
		val := ao.StopPrice.InexactFloat64()
		order.StopPrice = &val
	}
	if !ao.FilledQty.IsZero() {
		order.FilledQty = ao.FilledQty.InexactFloat64()
	}
	if ao.FilledAvgPrice != nil {
		val := ao.FilledAvgPrice.InexactFloat64()
		order.FilledAvgPrice = &val
	}
	if ao.FilledAt != nil {
		order.FilledAt = ao.FilledAt
	}
	if ao.CanceledAt != nil {
		order.CanceledAt = ao.CanceledAt
	}
	if ao.ReplacedBy != nil {
		order.ReplacedBy = strings.TrimSpace(*ao.ReplacedBy)
	}
	if IsOCCOptionSymbol(ao.Symbol) {
		order.AssetClass = "us_option"
		order.Underlying = optionRoot(ao.Symbol)
	}
	if err := ValidateBrokerOrderState(order, order.Qty); err != nil {
		order.Status = "submission_uncertain"
	}
	return order
}

// PlaceOptionsOrder validates the request and checks the broker-authoritative
// regular-session clock before submitting. A closed session returns a
// MarketClosedError and never calls PlaceOrder.
func (s *AlpacaTradingService) PlaceOptionsOrder(ctx context.Context, order *interfaces.OptionsOrder) (*interfaces.OrderResult, error) {
	if err := s.ensureExecutionAllowed(); err != nil {
		return nil, err
	}
	if order == nil || strings.TrimSpace(order.ClientOrderID) == "" {
		return nil, fmt.Errorf("client order ID is required at broker boundary")
	}
	if err := validateOptionsOrder(order); err != nil {
		return nil, fmt.Errorf("invalid options order: %w", err)
	}
	releaseReservation, lockErr := s.lockOpeningReservation(strings.HasSuffix(order.PositionIntent, "_to_open"))
	if lockErr != nil {
		return nil, lockErr
	}
	defer releaseReservation()
	if err := checkRegularSession(s.clockReader); err != nil {
		return nil, err
	}
	if err := s.validateOptionsPolicy(ctx, order); err != nil {
		return nil, err
	}
	req, err := buildAlpacaOptionsOrderRequest(order)
	if err != nil {
		return nil, err
	}
	// This is the authorization boundary: fetch and validate fresh server-side
	// evidence after all local checks and immediately before broker submission.
	if strings.HasSuffix(order.PositionIntent, "_to_open") && s.alphaDesk != nil && s.alphaDesk.Enabled {
		if err := s.enrichOptionsAssessment(ctx, order); err != nil {
			return nil, err
		}
		assessment, err := s.alphaDesk.AssessAndValidateWithAudit(ctx, models.DurableIdentity{BrokerAccountID: s.expectedAccountID, PaperLive: map[bool]string{true: "paper", false: "live"}[s.expectedPaper], TenantID: s.expectedTenantID, SandboxID: s.expectedSandboxID}, order, order.MarketScannerFeatures, order.AssessmentAuditSink)
		if err != nil {
			return nil, err
		}
		order.AlphaDeskAssessment = assessment
	}

	s.logger.WithFields(logrus.Fields{
		"symbol":          order.Symbol,
		"side":            order.Side,
		"qty":             order.Qty,
		"type":            order.Type,
		"position_intent": order.PositionIntent,
	}).Info("Placing options order")

	placeOrder := s.placeOrderFn
	if placeOrder == nil && s.client != nil {
		placeOrder = s.client.PlaceOrder
	}
	if placeOrder == nil {
		return nil, fmt.Errorf("broker order submission is unavailable")
	}
	if err := s.markSubmissionBoundary(&interfaces.Order{ClientOrderID: order.ClientOrderID}); err != nil {
		return nil, err
	}
	alpacaOrder, err := placeOrder(req)
	if err != nil {
		s.logger.WithError(err).Error("Failed to place options order")
		return nil, &SubmissionUncertainError{Err: fmt.Errorf("failed to place options order with client_order_id %s: %w", order.ClientOrderID, err)}
	}
	result := orderResultFromAlpacaOrder(&req, alpacaOrder, models.DurableIdentity{BrokerAccountID: s.expectedAccountID, PaperLive: map[bool]string{true: "paper", false: "live"}[s.expectedPaper], TenantID: s.expectedTenantID, SandboxID: s.expectedSandboxID})
	result.Purpose = map[bool]string{true: "entry", false: "close"}[strings.HasSuffix(order.PositionIntent, "_to_open")]
	result.AssetClass = "us_option"
	if err := ValidateOrderResultIdentity(result, order.ClientOrderID, order.Symbol, order.Side, order.Qty, order.Type, order.TimeInForce, order.LimitPrice, nil, order.PositionIntent, result.Purpose); err != nil {
		return nil, &SubmissionUncertainError{Err: err}
	}
	if err := ValidateOrderResultIdentityForExecution(result, models.DurableIdentity{BrokerAccountID: s.expectedAccountID, PaperLive: map[bool]string{true: "paper", false: "live"}[s.expectedPaper], TenantID: s.expectedTenantID, SandboxID: s.expectedSandboxID}); err != nil {
		return nil, &SubmissionUncertainError{Err: err}
	}
	return result, nil
}

// alpacaOptionsSnapshot represents the response from Alpaca options snapshots API
type alpacaOptionSnapshotData struct {
	LatestQuote struct {
		Ask     float64   `json:"ap"`
		AskSize int       `json:"as"`
		Bid     float64   `json:"bp"`
		BidSize int       `json:"bs"`
		T       time.Time `json:"t"`
	} `json:"latestQuote"`
	LatestTrade struct {
		Price float64   `json:"p"`
		Size  int       `json:"s"`
		T     time.Time `json:"t"`
	} `json:"latestTrade"`
	Greeks struct {
		Delta float64 `json:"delta"`
		Gamma float64 `json:"gamma"`
		Theta float64 `json:"theta"`
		Vega  float64 `json:"vega"`
		Rho   float64 `json:"rho"`
	} `json:"greeks"`
	ImpliedVolatility float64 `json:"impliedVolatility"`
}

type alpacaOptionsSnapshot struct {
	Snapshots     map[string]alpacaOptionSnapshotData `json:"snapshots"`
	NextPageToken string                              `json:"next_page_token"`
}

// GetOptionsChain retrieves the options chain for an underlying symbol
func (s *AlpacaTradingService) GetOptionsChain(ctx context.Context, underlying string, expiration time.Time) ([]*interfaces.OptionContract, error) {
	if s.optionsChainProvider != nil {
		return s.optionsChainProvider(ctx, underlying, expiration)
	}
	s.logger.WithFields(logrus.Fields{
		"underlying": underlying,
		"expiration": expiration,
	}).Info("Getting options chain")

	expirationStr := expiration.Format("2006-01-02")
	allSnapshots := make(map[string]alpacaOptionSnapshotData)
	pageToken := ""
	for page := 0; page < 20; page++ {
		endpoint := fmt.Sprintf("https://data.alpaca.markets/v1beta1/options/snapshots/%s?expiration_date=%s&limit=1000", underlying, url.QueryEscape(expirationStr))
		if pageToken != "" {
			endpoint += "&page_token=" + url.QueryEscape(pageToken)
		}
		body, _, requestErr := DoProviderRequest(ctx, &http.Client{Timeout: 30 * time.Second}, endpoint, true, func(reqCtx context.Context) (*http.Request, error) {
			retryReq, retryErr := http.NewRequestWithContext(reqCtx, http.MethodGet, endpoint, nil)
			if retryErr != nil {
				return nil, retryErr
			}
			retryReq.Header.Set("APCA-API-KEY-ID", s.apiKey)
			retryReq.Header.Set("APCA-API-SECRET-KEY", s.apiSecret)
			retryReq.Header.Set("Accept", "application/json")
			return retryReq, nil
		})
		if requestErr != nil {
			return nil, fmt.Errorf("failed to fetch options chain: %w", requestErr)
		}
		var pageSnapshot alpacaOptionsSnapshot
		if err := json.Unmarshal(body, &pageSnapshot); err != nil {
			return nil, fmt.Errorf("failed to parse response: %w", err)
		}
		for symbol, data := range pageSnapshot.Snapshots {
			allSnapshots[symbol] = data
		}
		if pageSnapshot.NextPageToken == "" {
			pageToken = ""
			break
		}
		if pageSnapshot.NextPageToken == pageToken {
			return nil, fmt.Errorf("options chain pagination repeated page token")
		}
		pageToken = pageSnapshot.NextPageToken
		if page == 19 {
			return nil, fmt.Errorf("options chain pagination exceeded safety limit")
		}
	}

	// Convert to our OptionContract format
	contracts := make([]*interfaces.OptionContract, 0, len(allSnapshots))
	for symbol, data := range allSnapshots {
		if !quoteTimestampFresh(data.LatestQuote.T) || data.LatestQuote.Ask <= 0 || data.LatestQuote.Bid < 0 {
			continue
		}
		root, parsedExpiration, optionType, strike, ok := parseOCCOptionSymbol(symbol)
		if !ok || !strings.EqualFold(root, strings.TrimSpace(underlying)) {
			continue
		}
		if parsedExpiration.IsZero() {
			parsedExpiration = expiration
		}
		contractType := "put"
		if optionType == "C" {
			contractType = "call"
		}
		dte := int(time.Until(parsedExpiration).Hours() / 24)
		if dte < 0 {
			dte = 0
		}
		contract := &interfaces.OptionContract{
			Symbol:            symbol,
			UnderlyingSymbol:  underlying,
			ContractType:      contractType,
			StrikePrice:       strike,
			Bid:               data.LatestQuote.Bid,
			Ask:               data.LatestQuote.Ask,
			BidSize:           int64(data.LatestQuote.BidSize),
			AskSize:           int64(data.LatestQuote.AskSize),
			QuoteTimestamp:    data.LatestQuote.T,
			Premium:           data.LatestTrade.Price,
			Volume:            int64(data.LatestTrade.Size),
			ImpliedVolatility: data.ImpliedVolatility,
			Delta:             data.Greeks.Delta,
			Gamma:             data.Greeks.Gamma,
			Theta:             data.Greeks.Theta,
			Vega:              data.Greeks.Vega,
			ExpirationDate:    parsedExpiration,
			DTE:               dte,
		}
		contracts = append(contracts, contract)
	}

	s.logger.WithField("count", len(contracts)).Info("Fetched options chain")
	return contracts, nil
}

// GetOptionsQuote retrieves a quote for a specific options contract
func (s *AlpacaTradingService) GetOptionsQuote(ctx context.Context, symbol string) (*interfaces.OptionsQuote, error) {
	root, _, _, _, ok := parseOCCOptionSymbol(symbol)
	if !ok {
		return nil, fmt.Errorf("invalid OCC option symbol %q", symbol)
	}
	endpoint := fmt.Sprintf("https://data.alpaca.markets/v1beta1/options/snapshots/%s?symbols=%s", root, url.QueryEscape(strings.TrimSpace(symbol)))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create options quote request: %w", err)
	}
	req.Header.Set("APCA-API-KEY-ID", s.apiKey)
	req.Header.Set("APCA-API-SECRET-KEY", s.apiSecret)
	req.Header.Set("Accept", "application/json")
	resp, err := (&http.Client{Timeout: 15 * time.Second}).Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch options quote: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("options quote API error (HTTP %d): %s", resp.StatusCode, string(body))
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read options quote response: %w", err)
	}
	var snapshot alpacaOptionsSnapshot
	if err := json.Unmarshal(body, &snapshot); err != nil {
		return nil, fmt.Errorf("failed to parse options quote response: %w", err)
	}
	var data struct {
		LatestQuote struct {
			Ask     float64   `json:"ap"`
			AskSize int       `json:"as"`
			Bid     float64   `json:"bp"`
			BidSize int       `json:"bs"`
			T       time.Time `json:"t"`
		} `json:"latestQuote"`
		LatestTrade struct {
			Price float64   `json:"p"`
			Size  int       `json:"s"`
			T     time.Time `json:"t"`
		} `json:"latestTrade"`
	}
	var found bool
	for key, candidate := range snapshot.Snapshots {
		if strings.EqualFold(key, strings.TrimSpace(symbol)) {
			data.LatestQuote.Ask = candidate.LatestQuote.Ask
			data.LatestQuote.AskSize = candidate.LatestQuote.AskSize
			data.LatestQuote.Bid = candidate.LatestQuote.Bid
			data.LatestQuote.BidSize = candidate.LatestQuote.BidSize
			data.LatestQuote.T = candidate.LatestQuote.T
			data.LatestTrade.Price = candidate.LatestTrade.Price
			data.LatestTrade.Size = candidate.LatestTrade.Size
			data.LatestTrade.T = candidate.LatestTrade.T
			found = true
			break
		}
	}
	if !found {
		return nil, fmt.Errorf("options quote not found for %s", symbol)
	}
	timestamp := data.LatestQuote.T
	if timestamp.IsZero() {
		timestamp = data.LatestTrade.T
	}
	if !quoteTimestampFresh(timestamp) || data.LatestQuote.Ask <= 0 || data.LatestQuote.Bid < 0 {
		return nil, fmt.Errorf("options quote is stale or invalid for %s", symbol)
	}
	return &interfaces.OptionsQuote{
		Symbol:    symbol,
		BidPrice:  data.LatestQuote.Bid,
		BidSize:   int64(data.LatestQuote.BidSize),
		AskPrice:  data.LatestQuote.Ask,
		AskSize:   int64(data.LatestQuote.AskSize),
		LastPrice: data.LatestTrade.Price,
		Volume:    int64(data.LatestTrade.Size),
		Timestamp: timestamp,
	}, nil
}

// GetOptionsPosition retrieves a specific options position
func (s *AlpacaTradingService) GetOptionsPosition(ctx context.Context, symbol string) (*interfaces.OptionsPosition, error) {
	if _, err := s.GetAccount(ctx); err != nil {
		return nil, fmt.Errorf("broker account binding could not be verified before options position read: %w", err)
	}
	positions, err := s.client.GetPositions()
	if err != nil {
		return nil, fmt.Errorf("failed to get positions: %w", err)
	}

	for _, pos := range positions {
		if pos.Symbol == symbol && pos.AssetClass == "us_option" {
			return &interfaces.OptionsPosition{
				BrokerAccountID: s.expectedAccountID,
				PaperLive:       map[bool]string{true: "paper", false: "live"}[s.expectedPaper],
				TenantID:        s.expectedTenantID,
				SandboxID:       s.expectedSandboxID,
				Symbol:          pos.Symbol,
				Qty:             pos.Qty.InexactFloat64(),
				AvgEntryPrice:   pos.AvgEntryPrice.InexactFloat64(),
				MarketValue:     pos.MarketValue.InexactFloat64(),
				CostBasis:       pos.CostBasis.InexactFloat64(),
				UnrealizedPL:    pos.UnrealizedPL.InexactFloat64(),
				UnrealizedPLPC:  pos.UnrealizedIntradayPLPC.InexactFloat64(),
				CurrentPrice:    pos.CurrentPrice.InexactFloat64(),
				Side:            string(pos.Side),
			}, nil
		}
	}

	return nil, fmt.Errorf("options position not found: %s", symbol)
}

// ListOptionsPositions retrieves all options positions
func (s *AlpacaTradingService) ListOptionsPositions(ctx context.Context) ([]*interfaces.OptionsPosition, error) {
	if _, err := s.GetAccount(ctx); err != nil {
		return nil, fmt.Errorf("broker account binding could not be verified before options positions read: %w", err)
	}
	positions, err := s.client.GetPositions()
	if err != nil {
		return nil, fmt.Errorf("failed to get positions: %w", err)
	}

	optionsPositions := []*interfaces.OptionsPosition{}
	for _, pos := range positions {
		if pos.AssetClass == "us_option" {
			optionsPositions = append(optionsPositions, &interfaces.OptionsPosition{
				BrokerAccountID: s.expectedAccountID,
				PaperLive:       map[bool]string{true: "paper", false: "live"}[s.expectedPaper],
				TenantID:        s.expectedTenantID,
				SandboxID:       s.expectedSandboxID,
				Symbol:          pos.Symbol,
				Qty:             pos.Qty.InexactFloat64(),
				AvgEntryPrice:   pos.AvgEntryPrice.InexactFloat64(),
				MarketValue:     pos.MarketValue.InexactFloat64(),
				CostBasis:       pos.CostBasis.InexactFloat64(),
				UnrealizedPL:    pos.UnrealizedPL.InexactFloat64(),
				UnrealizedPLPC:  pos.UnrealizedIntradayPLPC.InexactFloat64(),
				CurrentPrice:    pos.CurrentPrice.InexactFloat64(),
				Side:            string(pos.Side),
			})
		}
	}

	return optionsPositions, nil
}
