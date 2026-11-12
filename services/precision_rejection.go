package services

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"prophet-trader/interfaces"
)

// Evidence-checked resolution of orders that Alpaca refused with its two-decimal limit price validation
// (HTTP 422 / code 42210000) before OP2 recognised that response as a definite rejection. Such records were stored
// as submission_uncertain and block the trading backend at startup until they are resolved.
//
// The resolution never submits, cancels, deletes or replays anything. It keeps the order's identity and its original
// failure evidence, and only changes the status to rejected when ALL of these hold: the record is uncertain, has no
// broker order ID, has no fill, carries the exact stored 422 / 42210000 two-decimal evidence, and the caller has
// separately confirmed that the broker has no order with that client_order_id.

const (
	PrecisionResolutionRule    = "alpaca_422_42210000_price_precision"
	precisionReasonStatusText  = "http 422, code 42210000"
	precisionReasonMessageText = "limit price must be limited to 2 decimal places"
)

// PrecisionFailureReason reads the stored failure reason (op2_failure.reason) from order metadata.
func PrecisionFailureReason(metadata string) string {
	if strings.TrimSpace(metadata) == "" {
		return ""
	}
	var doc map[string]json.RawMessage
	if err := json.Unmarshal([]byte(metadata), &doc); err != nil {
		return ""
	}
	raw, ok := doc["op2_failure"]
	if !ok {
		return ""
	}
	var failure struct {
		Reason string `json:"reason"`
	}
	if err := json.Unmarshal(raw, &failure); err != nil {
		return ""
	}
	return failure.Reason
}

// HasPrecisionRejectionEvidence reports whether a stored order is an unacknowledged, unfilled uncertain submission
// whose stored evidence is exactly Alpaca's two-decimal limit price validation. It does not look at the broker.
func HasPrecisionRejectionEvidence(order *interfaces.Order) bool {
	if order == nil || order.Status != "submission_uncertain" || strings.TrimSpace(order.ID) != "" || order.FilledQty != 0 ||
		strings.TrimSpace(order.ClientOrderID) == "" || !strings.EqualFold(order.PaperLive, "paper") {
		return false
	}
	reason := strings.ToLower(PrecisionFailureReason(order.Metadata))
	return strings.Contains(reason, precisionReasonStatusText) && strings.Contains(reason, precisionReasonMessageText)
}

// MarkPrecisionRejected sets the order to rejected, keeping every field, and records who resolved it and why.
// The caller must have confirmed HasPrecisionRejectionEvidence and a broker not-found lookup first.
func MarkPrecisionRejected(order *interfaces.Order, by string) error {
	if !HasPrecisionRejectionEvidence(order) {
		return fmt.Errorf("order does not carry the two-decimal limit price rejection evidence")
	}
	doc := map[string]json.RawMessage{}
	if strings.TrimSpace(order.Metadata) != "" {
		if err := json.Unmarshal([]byte(order.Metadata), &doc); err != nil || doc == nil {
			return fmt.Errorf("stored metadata is not readable")
		}
	}
	resolution, err := json.Marshal(map[string]string{
		"by": by, "at": time.Now().UTC().Format(time.RFC3339), "rule": PrecisionResolutionRule,
		"broker_lookup": "not_found", "previous_status": order.Status,
	})
	if err != nil {
		return err
	}
	doc["resolution"] = resolution
	metadata, err := json.Marshal(doc)
	if err != nil {
		return err
	}
	order.Metadata = string(metadata)
	order.Status = "rejected"
	return nil
}
