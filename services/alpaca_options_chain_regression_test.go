package services

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"prophet-trader/interfaces"

	"github.com/sirupsen/logrus"
)

func TestAlpacaChainJSONOpenInterestMappingReachesAlphaDeskLeg(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"option_contracts":[
{"symbol":"TSLA251219C00400000","underlying_symbol":"TSLA","expiration_date":"2099-01-01","open_interest":17},
{"symbol":"TSLA251219C00410000","underlying_symbol":"TSLA","expiration_date":"2099-01-01","open_interest":0},
{"symbol":"TSLA251219C00420000","underlying_symbol":"TSLA","expiration_date":"2099-01-01","open_interest":null}
]}`))
	}))
	defer ts.Close()
	data := &AlpacaOptionsDataService{baseURL: ts.URL, client: ts.Client(), logger: logrus.New()}
	chain, err := data.GetOptionChain(context.Background(), "TSLA", time.Date(2099, 1, 1, 0, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}

	for _, tc := range []struct {
		name       string
		mappedName string
		want       *int64
	}{
		{name: "positive", mappedName: "TSLA251219C00400000", want: int64Ptr(17)},
		{name: "zero", mappedName: "TSLA251219C00410000", want: int64Ptr(0)},
		{name: "null", mappedName: "TSLA251219C00420000", want: nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			mapped := chain[tc.mappedName]
			if mapped == nil || mapped.OpenInterestPresent != (tc.want != nil) || (tc.want != nil && mapped.OpenInterest != *tc.want) {
				t.Fatalf("chain contract=%#v, want OI=%v present=%v", mapped, tc.want, tc.want != nil)
			}
			service := &AlpacaTradingService{optionsChainProvider: func(context.Context, string, time.Time) ([]*interfaces.OptionContract, error) {
				return []*interfaces.OptionContract{{Symbol: mapped.Symbol, Bid: 1, Ask: 1.2, BidSize: 2, AskSize: 3, OpenInterest: mapped.OpenInterest, OpenInterestPresent: mapped.OpenInterestPresent, QuoteTimestamp: time.Now().Add(-time.Second)}}, nil
			}}
			order := &interfaces.OptionsOrder{Symbol: mapped.Symbol, Underlying: "TSLA", Qty: 1, Side: "buy", PositionIntent: "buy_to_open", Type: "limit", TimeInForce: "day", LimitPrice: floatPtr(1)}
			if err := service.enrichOptionsAssessment(context.Background(), order); err != nil {
				t.Fatal(err)
			}
			got := order.AssessmentLegs[0].OpenInterest
			if (got == nil) != (tc.want == nil) || got != nil && *got != *tc.want {
				t.Fatalf("AlphaDesk leg OI=%v, want %v", got, tc.want)
			}
		})
	}
}
