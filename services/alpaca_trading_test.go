package services

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/alpacahq/alpaca-trade-api-go/v3/alpaca"
)

func TestPositionReadsUseTotalUnrealizedPLPC(t *testing.T) {
	var positionReads atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v2/account":
			_, _ = w.Write([]byte(`{"id":"bound-account"}`))
		case "/v2/positions":
			positionReads.Add(1)
			_, _ = w.Write([]byte(`[
				{"symbol":"AAPL","asset_class":"us_equity","side":"long","qty":"2","avg_entry_price":"100","market_value":"220","cost_basis":"200","unrealized_pl":"20","unrealized_plpc":"0.10","unrealized_intraday_plpc":"0","current_price":"110"},
				{"symbol":"AAPL261016C00100000","asset_class":"us_option","side":"long","qty":"1","avg_entry_price":"10","market_value":"12","cost_basis":"10","unrealized_pl":"2","unrealized_plpc":"0.20","unrealized_intraday_plpc":"0","current_price":"12"},
				{"symbol":"AAPL261016P00100000","asset_class":"us_option","side":"short","qty":"-1","avg_entry_price":"10","market_value":"-8","cost_basis":"-10","unrealized_pl":"2","unrealized_plpc":"-0.20","unrealized_intraday_plpc":"0.05","current_price":"8"}
			]`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	service := &AlpacaTradingService{
		client:            alpaca.NewClient(alpaca.ClientOpts{APIKey: "test", APISecret: "test", BaseURL: server.URL, HTTPClient: server.Client()}),
		expectedAccountID: "bound-account", expectedPaper: true, expectedTenantID: "tenant", expectedSandboxID: "sandbox",
	}
	check := func(symbol string, pl, plpc float64, side string, gotPL, gotPLPC float64, gotSide, account, paper, tenant, sandbox string) {
		t.Helper()
		if gotPL != pl || gotPLPC != plpc || gotSide != side || account != "bound-account" || paper != "paper" || tenant != "tenant" || sandbox != "sandbox" {
			t.Errorf("%s: PL=%v PLPC=%v side=%s binding=%s/%s/%s/%s; want %v/%v %s and bound identity", symbol, gotPL, gotPLPC, gotSide, account, paper, tenant, sandbox, pl, plpc, side)
		}
	}
	ctx := context.Background()
	positions, err := service.GetPositions(ctx)
	if err != nil || len(positions) != 3 {
		t.Fatalf("GetPositions: count=%d err=%v", len(positions), err)
	}
	for i, want := range []struct {
		pl, plpc float64
		side     string
	}{{20, 0.10, "long"}, {2, 0.20, "long"}, {2, -0.20, "short"}} {
		p := positions[i]
		check(p.Symbol, want.pl, want.plpc, want.side, p.UnrealizedPL, p.UnrealizedPLPC, p.Side, p.BrokerAccountID, p.PaperLive, p.TenantID, p.SandboxID)
	}
	options, err := service.ListOptionsPositions(ctx)
	if err != nil || len(options) != 2 {
		t.Fatalf("ListOptionsPositions: count=%d err=%v", len(options), err)
	}
	for i, want := range []struct {
		pl, plpc float64
		side     string
	}{{2, 0.20, "long"}, {2, -0.20, "short"}} {
		p := options[i]
		check(p.Symbol, want.pl, want.plpc, want.side, p.UnrealizedPL, p.UnrealizedPLPC, p.Side, p.BrokerAccountID, p.PaperLive, p.TenantID, p.SandboxID)
		one, err := service.GetOptionsPosition(ctx, p.Symbol)
		if err != nil {
			t.Fatalf("GetOptionsPosition(%s): %v", p.Symbol, err)
		}
		check(one.Symbol, want.pl, want.plpc, want.side, one.UnrealizedPL, one.UnrealizedPLPC, one.Side, one.BrokerAccountID, one.PaperLive, one.TenantID, one.SandboxID)
	}
	service.expectedAccountID = "other-account"
	before := positionReads.Load()
	if _, err := service.GetPositions(ctx); err == nil {
		t.Fatal("GetPositions accepted a mismatched broker account")
	}
	if _, err := service.ListOptionsPositions(ctx); err == nil {
		t.Fatal("ListOptionsPositions accepted a mismatched broker account")
	}
	if _, err := service.GetOptionsPosition(ctx, options[0].Symbol); err == nil {
		t.Fatal("GetOptionsPosition accepted a mismatched broker account")
	}
	if got := positionReads.Load(); got != before {
		t.Fatalf("account mismatch read positions %d times, want %d", got, before)
	}
}

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
