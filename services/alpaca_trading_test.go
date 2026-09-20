package services

import (
	"testing"

	"github.com/alpacahq/alpaca-trade-api-go/v3/alpaca"
)

func TestOrderHistoryRequiresOrderIDCursorForFullSDKPage(t *testing.T) {
	if orderHistoryRequiresOrderIDCursor(make([]alpaca.Order, alpacaOrdersPageLimit-1)) {
		t.Fatal("short page must be considered complete by the SDK path")
	}
	if !orderHistoryRequiresOrderIDCursor(make([]alpaca.Order, alpacaOrdersPageLimit)) {
		t.Fatal("full page must fail closed without an order-ID cursor")
	}
}
