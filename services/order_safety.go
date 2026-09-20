package services

import (
	"errors"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/alpacahq/alpaca-trade-api-go/v3/alpaca"
	"github.com/shopspring/decimal"
	"prophet-trader/interfaces"
	"prophet-trader/models"
)

var occOptionSymbolPattern = regexp.MustCompile(`^([A-Za-z0-9. ]{1,6})([0-9]{6})([CPcp])([0-9]{8})$`)

func parseOCCOptionSymbol(symbol string) (root string, expiry time.Time, optionType string, strike float64, ok bool) {
	matches := occOptionSymbolPattern.FindStringSubmatch(strings.TrimSpace(symbol))
	if len(matches) != 5 {
		return "", time.Time{}, "", 0, false
	}
	expiry, err := time.ParseInLocation("060102", matches[2], time.UTC)
	if err != nil {
		return "", time.Time{}, "", 0, false
	}
	strikeInt, err := strconv.ParseInt(matches[4], 10, 64)
	if err != nil {
		return "", time.Time{}, "", 0, false
	}
	return strings.TrimSpace(matches[1]), expiry, strings.ToUpper(matches[3]), float64(strikeInt) / 1000, true
}

// MarketClockReader is the broker-authoritative clock dependency used before
// submitting regular-session-only options orders.
type MarketClockReader interface {
	GetClock() (*alpaca.Clock, error)
}

type OrderLookupError struct {
	ClientOrderID string
	NotFound      bool
	Err           error
}

func (e *OrderLookupError) Error() string {
	if e == nil || e.Err == nil {
		return "order lookup failed"
	}
	return e.Err.Error()
}

func (e *OrderLookupError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Err
}

func IsOrderNotFound(err error) bool {
	var lookupErr *OrderLookupError
	return errors.As(err, &lookupErr) && lookupErr.NotFound
}

type SubmissionUncertainError struct {
	Err error
	// Result carries authoritative broker evidence across the service boundary
	// when the broker outcome is terminal but cancellation/submission remains
	// unresolved. Callers must durably reconcile it before retrying.
	Result *interfaces.OrderResult
}

func (e *SubmissionUncertainError) Error() string {
	if e == nil || e.Err == nil {
		return "submission_uncertain: broker submission result is unknown"
	}
	return "submission_uncertain: broker submission result is unknown: " + e.Err.Error()
}

func (e *SubmissionUncertainError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Err
}

func IsSubmissionUncertain(err error) bool {
	var uncertain *SubmissionUncertainError
	return errors.As(err, &uncertain)
}

// MarketClosedError is returned without submitting a broker order. The caller
// may persist the request as an application-level intent for the next session.
type MarketClosedError struct {
	NextOpen time.Time
}

func (e *MarketClosedError) Error() string {
	if e == nil || e.NextOpen.IsZero() {
		return "market_closed: the regular options session is closed; order was not submitted"
	}
	return fmt.Sprintf("market_closed: the regular options session is closed; order was not submitted; next eligible session: %s", e.NextOpen.UTC().Format(time.RFC3339))
}

// IsOCCOptionSymbol identifies the compact OCC option-symbol form used by the
// order API. Generic equity routes must not accept these symbols.
func IsOCCOptionSymbol(symbol string) bool {
	_, _, _, _, ok := parseOCCOptionSymbol(symbol)
	return ok
}

func optionRoot(symbol string) string {
	root, _, _, _, ok := parseOCCOptionSymbol(symbol)
	if !ok {
		return ""
	}
	return root
}

// ValidateOptionsOrder validates the fields that must be correct before any
// clock lookup or broker call. Position intent is deliberately required rather
// than inferred because buy/sell alone does not distinguish opening from closing.
func ValidateOptionsOrder(order *interfaces.OptionsOrder) error {
	return validateOptionsOrder(order)
}

func validateOptionsOrder(order *interfaces.OptionsOrder) error {
	if order == nil {
		return fmt.Errorf("options order is required")
	}
	if !IsOCCOptionSymbol(order.Symbol) {
		return fmt.Errorf("symbol must be a valid OCC options symbol")
	}
	if strings.TrimSpace(order.Underlying) == "" {
		return fmt.Errorf("underlying is required")
	}
	if !strings.EqualFold(optionRoot(order.Symbol), strings.TrimSpace(order.Underlying)) {
		return fmt.Errorf("underlying %q does not match option symbol root %q", order.Underlying, optionRoot(order.Symbol))
	}
	if order.Qty <= 0 || math.Trunc(order.Qty) != order.Qty {
		return fmt.Errorf("quantity must be a positive whole number of contracts")
	}
	if order.Side != "buy" && order.Side != "sell" {
		return fmt.Errorf("side must be buy or sell")
	}
	validIntents := map[string]bool{
		"buy_to_open":   true,
		"buy_to_close":  true,
		"sell_to_open":  true,
		"sell_to_close": true,
	}
	if !validIntents[order.PositionIntent] {
		return fmt.Errorf("position_intent is required and must be one of buy_to_open, buy_to_close, sell_to_open, sell_to_close")
	}
	if strings.HasPrefix(order.PositionIntent, "buy_") && order.Side != "buy" {
		return fmt.Errorf("position_intent %q must match side %q", order.PositionIntent, order.Side)
	}
	if strings.HasPrefix(order.PositionIntent, "sell_") && order.Side != "sell" {
		return fmt.Errorf("position_intent %q must match side %q", order.PositionIntent, order.Side)
	}
	if order.Type != "market" && order.Type != "limit" {
		return fmt.Errorf("options order type must be market or limit")
	}
	if order.TimeInForce != "day" {
		return fmt.Errorf("options time_in_force must be day")
	}
	if order.Type == "limit" && (order.LimitPrice == nil || !isPositiveFinite(*order.LimitPrice)) {
		return fmt.Errorf("limit price must be positive")
	}
	if order.LimitPrice != nil && !isPositiveFinite(*order.LimitPrice) {
		return fmt.Errorf("limit price must be positive")
	}
	return nil
}

func isPositiveFinite(value float64) bool {
	return value > 0 && !math.IsNaN(value) && !math.IsInf(value, 0)
}

func buildAlpacaOptionsOrderRequest(order *interfaces.OptionsOrder) (alpaca.PlaceOrderRequest, error) {
	if err := validateOptionsOrder(order); err != nil {
		return alpaca.PlaceOrderRequest{}, err
	}
	qty := decimal.NewFromFloat(order.Qty)
	req := alpaca.PlaceOrderRequest{
		Symbol:         order.Symbol,
		Qty:            &qty,
		Side:           alpaca.Side(order.Side),
		Type:           alpaca.OrderType(order.Type),
		TimeInForce:    alpaca.TimeInForce(order.TimeInForce),
		PositionIntent: alpaca.PositionIntent(order.PositionIntent),
	}
	if order.ClientOrderID != "" {
		req.ClientOrderID = order.ClientOrderID
	}
	if order.LimitPrice != nil {
		limitPrice := decimal.NewFromFloat(*order.LimitPrice)
		req.LimitPrice = &limitPrice
	}
	return req, nil
}

func checkRegularSession(reader MarketClockReader) error {
	if reader == nil {
		return fmt.Errorf("market clock unavailable: order blocked fail-closed")
	}
	clock, err := reader.GetClock()
	if err != nil {
		return fmt.Errorf("market clock unavailable: order blocked fail-closed: %w", err)
	}
	if clock == nil {
		return fmt.Errorf("market clock unavailable: empty broker response; order blocked fail-closed")
	}
	if !clock.IsOpen {
		return &MarketClosedError{NextOpen: clock.NextOpen}
	}
	return nil
}

var recognizedOrderStatuses = map[string]struct{}{
	"new": {}, "partially_filled": {}, "filled": {}, "done_for_day": {},
	"canceled": {}, "expired": {}, "replaced": {}, "pending_cancel": {},
	"pending_replace": {}, "accepted": {}, "pending_new": {}, "pending": {}, "open": {},
	"accepted_for_bidding": {}, "stopped": {}, "rejected": {},
	"suspended": {}, "calculated": {}, "held": {},
}

func ValidateBrokerOrderState(order *interfaces.Order, requestedQty float64) error {
	if order == nil || strings.TrimSpace(order.ID) == "" {
		return fmt.Errorf("broker order identity is missing")
	}
	status := strings.ToLower(strings.TrimSpace(order.Status))
	if _, ok := recognizedOrderStatuses[status]; !ok {
		return fmt.Errorf("broker order status %q is unrecognized", order.Status)
	}
	if order.Qty <= 0 || math.IsNaN(order.Qty) || math.IsInf(order.Qty, 0) {
		return fmt.Errorf("broker requested quantity is missing or invalid")
	}
	if requestedQty > 0 && math.Abs(order.Qty-requestedQty) > 1e-9 {
		return fmt.Errorf("broker requested quantity %.4f does not match requested %.4f", order.Qty, requestedQty)
	}
	if math.IsNaN(order.FilledQty) || math.IsInf(order.FilledQty, 0) || order.FilledQty < 0 {
		return fmt.Errorf("broker filled quantity is invalid")
	}
	if requestedQty > 0 && order.FilledQty > requestedQty+1e-9 {
		return fmt.Errorf("broker filled quantity exceeds requested quantity")
	}
	if (status == "filled" || status == "partially_filled") && order.FilledQty <= 0 {
		return fmt.Errorf("broker status %q has no filled quantity", status)
	}
	if order.FilledQty > 0 && (status == "new" || status == "accepted" || status == "pending_new" || status == "open") {
		return fmt.Errorf("broker status %q conflicts with positive filled quantity", status)
	}
	if order.FilledAvgPrice != nil && (math.IsNaN(*order.FilledAvgPrice) || math.IsInf(*order.FilledAvgPrice, 0) || *order.FilledAvgPrice <= 0) {
		return fmt.Errorf("broker average fill price is invalid")
	}
	if order.FilledQty > 0 && order.FilledAvgPrice == nil {
		return fmt.Errorf("broker filled quantity has no average fill price")
	}
	if status == "filled" && requestedQty > 0 && math.Abs(order.FilledQty-requestedQty) > 1e-9 {
		return fmt.Errorf("broker filled status is not complete")
	}
	return nil
}

func ValidateOrderResult(result *interfaces.OrderResult, requestedQty float64) error {
	if result == nil || strings.TrimSpace(result.OrderID) == "" {
		return fmt.Errorf("broker order identity is missing")
	}
	status := strings.ToLower(strings.TrimSpace(result.Status))
	if _, ok := recognizedOrderStatuses[status]; !ok {
		return fmt.Errorf("broker result status %q is unrecognized", result.Status)
	}
	if result.Qty <= 0 || math.IsNaN(result.Qty) || math.IsInf(result.Qty, 0) {
		return fmt.Errorf("broker result requested quantity is missing or invalid")
	}
	if requestedQty > 0 && math.Abs(result.Qty-requestedQty) > 1e-9 {
		return fmt.Errorf("broker result requested quantity does not match request")
	}
	if math.IsNaN(result.FilledQty) || math.IsInf(result.FilledQty, 0) || result.FilledQty < 0 {
		return fmt.Errorf("broker result filled quantity is invalid")
	}
	if requestedQty > 0 && result.FilledQty > requestedQty+1e-9 {
		return fmt.Errorf("broker result filled quantity exceeds requested quantity")
	}
	if (status == "filled" || status == "partially_filled") && result.FilledQty <= 0 {
		return fmt.Errorf("broker result status %q has no filled quantity", status)
	}
	if result.FilledQty > 0 && (status == "new" || status == "accepted" || status == "pending_new" || status == "open") {
		return fmt.Errorf("broker result status %q conflicts with positive filled quantity", status)
	}
	if result.FilledAvgPrice != nil && (math.IsNaN(*result.FilledAvgPrice) || math.IsInf(*result.FilledAvgPrice, 0) || *result.FilledAvgPrice <= 0) {
		return fmt.Errorf("broker result average fill price is invalid")
	}
	if result.FilledQty > 0 && result.FilledAvgPrice == nil {
		return fmt.Errorf("broker result filled quantity has no average fill price")
	}
	if status == "filled" && requestedQty > 0 && math.Abs(result.FilledQty-requestedQty) > 1e-9 {
		return fmt.Errorf("broker result filled status is not complete")
	}
	return nil
}

func optionalFloatEqual(left, right *float64) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return math.Abs(*left-*right) <= 1e-9
}

func ValidateOrderResultIdentity(result *interfaces.OrderResult, clientOrderID, symbol, side string, qty float64, orderType, timeInForce string, limitPrice, stopPrice *float64, positionIntent, purpose string) error {
	if err := ValidateOrderResult(result, qty); err != nil {
		return err
	}
	if strings.TrimSpace(result.BrokerAccountID) == "" || (result.PaperLive != "paper" && result.PaperLive != "live") || strings.TrimSpace(result.TenantID) == "" || strings.TrimSpace(result.SandboxID) == "" {
		return fmt.Errorf("broker result durable identity is incomplete")
	}
	if result.ClientOrderID != clientOrderID || result.Symbol != symbol || result.Side != side ||
		math.Abs(result.Qty-qty) > 1e-9 || result.Type != orderType || result.TimeInForce != timeInForce {
		return fmt.Errorf("broker result identity does not match submitted order")
	}
	if !optionalFloatEqual(result.LimitPrice, limitPrice) || !optionalFloatEqual(result.StopPrice, stopPrice) {
		return fmt.Errorf("broker result price identity does not match submitted order")
	}
	if positionIntent != "" && result.PositionIntent != positionIntent {
		return fmt.Errorf("broker result position intent does not match submitted order")
	}
	if purpose != "" && result.Purpose != purpose {
		return fmt.Errorf("broker result purpose is missing or does not match submitted order")
	}
	return nil
}

func ValidateOrderResultIdentityForExecution(result *interfaces.OrderResult, expected models.DurableIdentity) error {
	if result == nil {
		return fmt.Errorf("broker result is required")
	}
	if strings.TrimSpace(result.BrokerAccountID) == "" || (result.PaperLive != "paper" && result.PaperLive != "live") || strings.TrimSpace(result.TenantID) == "" || strings.TrimSpace(result.SandboxID) == "" {
		return fmt.Errorf("broker result durable identity is incomplete")
	}
	if result.BrokerAccountID != expected.BrokerAccountID || result.PaperLive != expected.PaperLive || result.TenantID != expected.TenantID || result.SandboxID != expected.SandboxID {
		return fmt.Errorf("broker result durable identity does not match server-owned execution identity")
	}
	return nil
}

// ValidateCancellationFillEvidence binds a positive cancellation readback to
// the already-persisted local order. The readback is evidence only; it cannot
// establish or replace the local execution identity.
func ValidateCancellationFillEvidence(result *interfaces.OrderResult, order *interfaces.Order, expected models.DurableIdentity) error {
	if result == nil || order == nil {
		return fmt.Errorf("cancellation fill evidence is incomplete")
	}
	if err := ValidateOrderResultIdentityForExecution(result, expected); err != nil {
		return err
	}
	if order.BrokerAccountID != expected.BrokerAccountID || order.PaperLive != expected.PaperLive || order.TenantID != expected.TenantID || order.SandboxID != expected.SandboxID {
		return fmt.Errorf("persisted order durable identity does not match server-owned execution identity")
	}
	if strings.TrimSpace(result.OrderID) == "" || result.OrderID != order.ID {
		return fmt.Errorf("cancellation fill evidence broker order identity does not match persisted order")
	}
	if strings.TrimSpace(order.ClientOrderID) != "" && result.ClientOrderID != order.ClientOrderID {
		return fmt.Errorf("cancellation fill evidence client order identity does not match persisted order")
	}
	if result.FilledQty <= 0 || math.IsNaN(result.FilledQty) || math.IsInf(result.FilledQty, 0) || result.FilledQty > order.Qty {
		return fmt.Errorf("cancellation fill evidence quantity is invalid")
	}
	return nil
}

func uncertainOrderResult(message string) *interfaces.OrderResult {
	return &interfaces.OrderResult{
		Status:  "submission_uncertain",
		Message: message + "; execution is not confirmed",
	}
}

func decimalToFloat(value *decimal.Decimal) *float64 {
	if value == nil {
		return nil
	}
	v := value.InexactFloat64()
	return &v
}

func decimalPointersEqual(left, right *decimal.Decimal) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return left.Equal(*right)
}

func validateBrokerOrderIdentity(request *alpaca.PlaceOrderRequest, order *alpaca.Order) error {
	if order == nil {
		return fmt.Errorf("broker order identity payload is missing")
	}
	if request == nil {
		return nil
	}
	if strings.TrimSpace(request.ClientOrderID) == "" {
		return fmt.Errorf("submitted client order ID is required")
	}
	if order.ClientOrderID != request.ClientOrderID {
		return fmt.Errorf("broker client order ID %q does not match submitted ID %q", order.ClientOrderID, request.ClientOrderID)
	}
	if order.Symbol != request.Symbol {
		return fmt.Errorf("broker symbol %q does not match submitted symbol %q", order.Symbol, request.Symbol)
	}
	if order.Side != request.Side {
		return fmt.Errorf("broker side %q does not match submitted side %q", order.Side, request.Side)
	}
	if order.Type != request.Type {
		return fmt.Errorf("broker order type %q does not match submitted type %q", order.Type, request.Type)
	}
	if order.TimeInForce != request.TimeInForce {
		return fmt.Errorf("broker time-in-force %q does not match submitted value %q", order.TimeInForce, request.TimeInForce)
	}
	if request.Qty != nil {
		if order.Qty == nil || !order.Qty.Equal(*request.Qty) {
			return fmt.Errorf("broker quantity does not match submitted quantity")
		}
	}
	if !decimalPointersEqual(request.LimitPrice, order.LimitPrice) {
		return fmt.Errorf("broker limit price does not match submitted limit price")
	}
	if !decimalPointersEqual(request.StopPrice, order.StopPrice) {
		return fmt.Errorf("broker stop price does not match submitted stop price")
	}
	if request.PositionIntent != "" && order.PositionIntent != request.PositionIntent {
		return fmt.Errorf("broker position intent %q does not match submitted intent %q", order.PositionIntent, request.PositionIntent)
	}
	return nil
}

func orderResultFromAlpacaOrder(request *alpaca.PlaceOrderRequest, order *alpaca.Order, identities ...models.DurableIdentity) *interfaces.OrderResult {
	var identity models.DurableIdentity
	if len(identities) == 1 {
		identity = identities[0]
	}
	if order == nil {
		return uncertainOrderResult("Broker returned no order payload")
	}
	if err := validateBrokerOrderIdentity(request, order); err != nil {
		return uncertainOrderResult(err.Error())
	}
	status := strings.ToLower(strings.TrimSpace(order.Status))
	if strings.TrimSpace(order.ID) == "" {
		return uncertainOrderResult("Broker returned an order without an ID")
	}
	if _, ok := recognizedOrderStatuses[status]; !ok {
		return uncertainOrderResult(fmt.Sprintf("Broker returned unrecognized order status %q", order.Status))
	}

	filledQty := order.FilledQty.InexactFloat64()
	if math.IsNaN(filledQty) || math.IsInf(filledQty, 0) || filledQty < 0 {
		return uncertainOrderResult("Broker returned an invalid filled quantity")
	}
	requestedQty := 0.0
	if order.Qty != nil {
		requestedQty = order.Qty.InexactFloat64()
	}
	if requestedQty <= 0 || math.IsNaN(requestedQty) || math.IsInf(requestedQty, 0) {
		return uncertainOrderResult("Broker returned a missing or invalid requested quantity")
	}
	if requestedQty > 0 && filledQty > requestedQty {
		return uncertainOrderResult(fmt.Sprintf("Broker filled quantity %.4f exceeds requested quantity %.4f", filledQty, requestedQty))
	}
	if (status == "filled" || status == "partially_filled") && filledQty <= 0 {
		return uncertainOrderResult(fmt.Sprintf("Broker status %q conflicts with zero filled quantity", status))
	}
	if status == "filled" && requestedQty > 0 && filledQty != requestedQty {
		return uncertainOrderResult(fmt.Sprintf("Broker status filled conflicts with %.4f of %.4f filled", filledQty, requestedQty))
	}
	if filledQty > 0 && (status == "new" || status == "accepted" || status == "pending_new" || status == "open") {
		return uncertainOrderResult(fmt.Sprintf("Broker status %q conflicts with positive filled quantity", status))
	}

	var filledAvgPrice *float64
	if order.FilledAvgPrice != nil {
		value := order.FilledAvgPrice.InexactFloat64()
		if math.IsNaN(value) || math.IsInf(value, 0) || value < 0 || (filledQty > 0 && value == 0) {
			return uncertainOrderResult("Broker returned an invalid filled average price")
		}
		filledAvgPrice = &value
	}
	if filledQty > 0 && filledAvgPrice == nil {
		return uncertainOrderResult("Broker reported filled quantity without an average fill price")
	}

	executionConfirmed := filledQty > 0
	fullyFilled := executionConfirmed && (requestedQty <= 0 || math.Abs(filledQty-requestedQty) < 1e-9)
	message := fmt.Sprintf("Broker acknowledged order %s with status %s; execution is not confirmed.", order.ID, status)
	if executionConfirmed {
		if fullyFilled {
			message = fmt.Sprintf("Broker confirmed full execution: %.4f filled at the reported average price; final status %s.", filledQty, status)
		} else {
			message = fmt.Sprintf("Broker confirmed %.4f filled with final status %s; not fully filled (partial-fill state).", filledQty, status)
		}
	}
	clientOrderID := strings.TrimSpace(order.ClientOrderID)
	if clientOrderID == "" && request != nil {
		clientOrderID = strings.TrimSpace(request.ClientOrderID)
	}
	return &interfaces.OrderResult{
		BrokerAccountID:    identity.BrokerAccountID,
		PaperLive:          identity.PaperLive,
		TenantID:           identity.TenantID,
		SandboxID:          identity.SandboxID,
		OrderID:            order.ID,
		ClientOrderID:      clientOrderID,
		Status:             status,
		Message:            message,
		FilledQty:          filledQty,
		FilledAvgPrice:     filledAvgPrice,
		SubmittedAt:        order.SubmittedAt,
		FilledAt:           order.FilledAt,
		CanceledAt:         order.CanceledAt,
		Symbol:             order.Symbol,
		Side:               string(order.Side),
		Qty:                requestedQty,
		Type:               string(order.Type),
		TimeInForce:        string(order.TimeInForce),
		LimitPrice:         decimalToFloat(order.LimitPrice),
		StopPrice:          decimalToFloat(order.StopPrice),
		PositionIntent:     string(order.PositionIntent),
		ExecutionConfirmed: executionConfirmed,
		FullyFilled:        fullyFilled,
	}
}
