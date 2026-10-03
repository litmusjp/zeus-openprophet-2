package services

import (
	"errors"
	"testing"

	"github.com/alpacahq/alpaca-trade-api-go/v3/alpaca"
)

func TestClassifyBrokerSubmissionErrorOnlyTerminalTypedRejections(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want bool
	}{
		{"wash trade rejection", &alpaca.APIError{StatusCode: 403, Code: 40310000, Message: "potential wash trade detected"}, true},
		{"validation rejection", &alpaca.APIError{StatusCode: 422, Code: 42210000, Message: "client_order_id must be unique"}, false},
		{"conflict", &alpaca.APIError{StatusCode: 409, Code: 40910000, Message: "conflict"}, false},
		{"route not found", &alpaca.APIError{StatusCode: 404, Code: 40410000, Message: "not found"}, false},
		{"request timeout", &alpaca.APIError{StatusCode: 408, Code: 40810000, Message: "timeout"}, false},
		{"unknown 400 code", &alpaca.APIError{StatusCode: 400, Code: 0, Message: "bad request"}, false},
		{"unsupported 40010001 remains uncertain", &alpaca.APIError{StatusCode: 400, Code: 40010001, Message: "invalid request"}, false},
		{"unsupported 40010002 remains uncertain", &alpaca.APIError{StatusCode: 400, Code: 40010002, Message: "invalid request"}, false},
		{"unsupported 42210001 remains uncertain", &alpaca.APIError{StatusCode: 422, Code: 42210001, Message: "invalid quantity"}, false},
		{"unsupported 42210002 remains uncertain", &alpaca.APIError{StatusCode: 422, Code: 42210002, Message: "invalid request"}, false},
		{"server error", &alpaca.APIError{StatusCode: 500, Code: 50010000, Message: "server error"}, false},
		{"wrapped network error", errors.New("dial tcp: timeout"), false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := classifyBrokerSubmissionError(tt.err)
			if (got != nil) != tt.want {
				t.Fatalf("classifyBrokerSubmissionError() = %v, want terminal=%v", got, tt.want)
			}
		})
	}
}

func TestOrderHistoryRequiresOrderIDCursorForFullSDKPage(t *testing.T) {
	if orderHistoryRequiresOrderIDCursor(make([]alpaca.Order, alpacaOrdersPageLimit-1)) {
		t.Fatal("short page must be considered complete by the SDK path")
	}
	if !orderHistoryRequiresOrderIDCursor(make([]alpaca.Order, alpacaOrdersPageLimit)) {
		t.Fatal("full page must fail closed without an order-ID cursor")
	}
}
